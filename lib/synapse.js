'use strict';
// ── SYNAPSE — the second brain's engine ───────────────────────────────────────────────────────────
// Hydrate / connect / suggest, lifted out of main.js so the second brain can run WITHOUT the GUI.
//
// This module exists because of a specific, verified failure: the "always-on" SYNAPSE worker shipped
// in d2b035e had never produced a single node. `~/.bhatbot/brain/` did not exist. The worker was
// correct — it just lived inside the Electron main process, so it only ran while a window was open,
// and the app had not been launched in over two weeks. lib/brain.js was already written to be
// Electron-free for exactly this reason; the orchestration around it was not. This closes that gap.
//
// Everything Electron-shaped is injected:
//   embedBatch   — lib/semantic.js (OpenAI embeddings). Missing/offline → embedding stops, links stay.
//   llm          — a text-in/text-out fn. In the GUI: main.js's anthropicRequest. Headless: lib/llm.js.
//   listProjects / getProject / notionPages — data sources, all already Electron-free.
//   onUpdate     — where a refreshed graph goes (the GUI pushes it to the renderer; a worker no-ops).
//   isIdle       — never spend money mid-turn (the GUI checks agentState; a worker is always idle).
//
// THE THREE PASSES, and why they're split that way:
//   hydrate  FREE. No network, no model, no key. Imports projects, semantic memories, ~ repos, and
//            Notion pages as nodes. This is the bulk of the value and it must run even when nothing
//            else can — a headless worker with no resolvable API key still builds the graph.
//   connect  PAID. Embeds nodes that lack a vector, then proposes cross-project links and writes a
//            one-line "why related" rationale for the strongest few.
//   suggest  PAID. One call that turns the strongest links into "what to move ahead on".
// A hard cumulative dollar cap (default $1) gates both paid passes, so an always-on worker cannot
// run away. The ledger is persistent, in graph meta — a restart must not reset the spend.

const fs = require('fs');
const os = require('os');
const path = require('path');
const brain = require('./brain');
const gardener = require('./gardener');
const recency = require('./recency');

// 2026 list rates, USD per token. Only used to ESTIMATE spend against the cap — deliberately
// conservative (over-counting costs nothing; under-counting defeats the cap).
const SY_PRICE = { embed: 0.02 / 1e6, sonnetIn: 3 / 1e6, sonnetOut: 15 / 1e6 };
const tok = (s) => Math.ceil(String(s || '').length / 4);   // ~4 chars/token

const RATIONALE_SYSTEM = 'In ONE sentence, say specifically how these two items from DIFFERENT projects are related or could inform each other. If not genuinely related, reply exactly "NONE".';
// The shape suggest() needs. Enforced via output_config.format where the backend supports it.
const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          why: { type: 'string' },
          next: { type: 'string' },
        },
        required: ['project', 'why', 'next'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
};

const SUGGEST_SYSTEM = 'You are the second brain surfacing what Siddhant should work on next. From his projects and the connections found, pick 3-5 concrete moves. Reply ONLY a JSON array: [{"project":"<name>","why":"<one grounded sentence, cite a connection if relevant>","next":"<one concrete next step>"}]. No prose outside the JSON.';

// Pull the raw semantic store. Records carry their embedding vectors, so memory nodes reuse them
// instead of paying to re-embed text that was already embedded.
function readSemanticRecords(storePath) {
  try {
    const s = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return (s.records || []).filter((r) => r && r.text);
  } catch { return []; }
}

// Discover the user's git repos directly under $HOME. Top-level only, README + a capped set of key
// files — this is a map of what he's working on, not a code index.
function scanRepos({ home = os.homedir(), max = 40, keyFileCap = 12 } = {}) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(home, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); }
  catch { return out; }
  for (const name of dirs) {
    if (out.length >= max) break;
    const root = path.join(home, name);
    try { if (!fs.existsSync(path.join(root, '.git'))) continue; } catch { continue; }
    let readme = '';
    for (const rn of ['README.md', 'readme.md', 'Readme.md']) {
      try { readme = fs.readFileSync(path.join(root, rn), 'utf8').slice(0, 6000); break; } catch {}
    }
    let all = [];
    try { all = fs.readdirSync(root).filter((f) => { try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; } }); } catch {}
    try { all = all.concat(fs.readdirSync(path.join(root, 'src')).map((f) => 'src/' + f)); } catch {}
    const files = [];
    for (const rel of brain.keyFilesFor(all, keyFileCap)) {
      try { files.push({ path: rel, text: fs.readFileSync(path.join(root, rel), 'utf8').slice(0, 4000) }); } catch {}
    }
    out.push({ name, path: root, readme, files });
  }
  return out;
}

function createSynapse({ dir, deps = {} } = {}) {
  const {
    embedBatch,                              // async (texts) → { vecs }
    llm,                                     // async ({ system, content, maxTokens }) → string
    listProjects = () => [],
    getProject = () => null,
    notionPages = null,                      // async ({limit}) → pages[]
    semanticStorePath,
    home = os.homedir(),
    loadConfig = () => ({}),
    now = () => Date.now(),
    log = () => {},
    onUpdate = () => {},
    isIdle = () => true,
  } = deps;

  const b = brain.createBrain({ dir });

  // ── cost governor ───────────────────────────────────────────────────────────────────────────────
  const budget = () => { const v = Number(loadConfig().synapseBudgetUsd); return Number.isFinite(v) && v > 0 ? v : 1; };
  const spent = () => { try { return Number(b.getMeta('spendUsd')) || 0; } catch { return 0; } };
  const left = () => Math.max(0, budget() - spent());
  const charge = (usd) => { try { b.setMeta('spendUsd', spent() + (Number(usd) || 0)); } catch {} };
  const push = () => { try { const g = b.graphView(); g.budget = { limit: budget(), spent: spent(), left: left() }; onUpdate(g); } catch {} };

  // ── FREE pass ───────────────────────────────────────────────────────────────────────────────────
  async function hydrate({ repos = true, memories = true, notion = true, files = true } = {}) {
    const ts = now();
    let added = 0;
    const add = (n) => { if (n) { b.upsertNode(n, ts); added++; } };
    const addBundle = (bundle) => {
      for (const n of (bundle.nodes || [])) add(n);
      for (const e of (bundle.edges || [])) b.upsertEdge(e, ts);
    };
    // Each source is independently guarded: one unavailable source must not cost us the others.
    try { for (const p of listProjects()) add(brain.projectNode(getProject(p.slug))); } catch (e) { log('[synapse] projects import failed: ' + e.message); }
    if (memories && semanticStorePath) {
      try { readSemanticRecords(semanticStorePath).slice(0, 600).forEach((m, i) => add(brain.memoryNode(m, i))); }
      catch (e) { log('[synapse] memory import failed: ' + e.message); }
    }
    if (repos) {
      try { for (const r of scanRepos({ home })) addBundle(brain.repoNodes(r)); }
      catch (e) { log('[synapse] repo scan failed: ' + e.message); }
    }
    // DEEP FILE INDEX. scanRepos above only reaches top-level git repos, their README, and ≤12 "key
    // files" from the root and src/ — 49 file nodes total, which is why "connections in my files"
    // had almost nothing to connect. lib/fileindex.js walks the tree properly (excluding conda /
    // venv / node_modules / media, capped per project so one vendored clone can't swamp the rest)
    // and attributes each file to a real project, descending through container dirs such as
    // ~/Desktop/Research Files so `protfunc` is a project rather than part of a "Desktop" blob.
    if (files) {
      try {
        const fileindex = require('./fileindex');
        const cfgFiles = ((loadConfig().secondBrain || {}).files) || {};
        const { files: found, stats } = fileindex.walk({ home, config: cfgFiles });
        // A file's part-of edge needs a project node to point AT. listProjects() only knows the 14
        // curated projects; the walk discovers directories like `Research Files/protfunc` that have
        // no curated entry. Create those — but ONLY when absent, because upsertNode would otherwise
        // overwrite a curated project's rich description with a bare directory name.
        for (const proj of Object.keys(stats.byProject)) {
          const pid = brain.nodeId('project', proj);
          if (!b.getNode(pid)) {
            b.upsertNode({ type: 'project', ref: proj, label: proj.split('/').pop(),
              text: `${proj}\nDiscovered from the filesystem (${stats.byProject[proj]} indexed files).`,
              importance: 0.7, meta: { source: 'fileindex', repo: proj, fileCount: stats.byProject[proj] } }, ts);
            added++;
          }
        }
        for (const f of found) {
          add(fileindex.fileNode(f));
          // Every file hangs off its project, so the Projects tab asks the graph ONE question
          // ("what is part-of this project?") instead of re-deriving structure from paths.
          b.upsertEdge({ from: brain.nodeId('file', f.rel), to: brain.nodeId('project', f.project), type: 'part-of', confidence: 1 }, ts);
        }
        log(`[synapse] file index: ${found.length} files across ${Object.keys(stats.byProject).length} projects` + (stats.truncated ? ' (hit cap)' : ''));
      } catch (e) { log('[synapse] file index failed: ' + e.message); }
    }
    if (notion && notionPages) {
      try { for (const pg of (await notionPages({ limit: 60 })) || []) addBundle(brain.notionNodes(pg)); }
      catch (e) { log('[synapse] notion import failed: ' + e.message); }
    }
    b.save(); push();
    return { added, ...b.stats() };
  }

  // ── GARDENING (free, no network) ────────────────────────────────────────────────────────────────
  // The Connector only ever adds; without this the graph accumulates stale guesses and duplicates
  // forever. Costs nothing, so it runs on every cycle rather than being gated behind the budget.
  function gardenPass(opts = {}) {
    try {
      const r = gardener.garden(b, { cosine: brain.cosine, currentThreshold: connectThreshold(), now: now(), ...opts });
      const a = r.applied;
      if (a.decayed || a.pruned || a.merged || a.promoted || a.thresholdMoved) {
        log(`[synapse] gardener: ${a.decayed} decayed, ${a.pruned} pruned, ${a.merged} merged (${a.rewired} edges rewired), ${a.promoted} promoted` +
          (a.thresholdMoved ? ` · threshold ${a.thresholdMoved.from}→${a.thresholdMoved.to} (${a.thresholdMoved.reason})` : ''));
        push();
      }
      return r;
    } catch (e) { log('[synapse] gardener failed: ' + e.message); return { error: e.message }; }
  }

  // ── RECENCY + AUTOPRUNE (free, no network) ──────────────────────────────────────────────────────
  // The counterpart to gardenPass: the Gardener keeps EDGES honest, this keeps NODES honest. Drops
  // file nodes whose file is gone, clears the stale vector of a file that changed since it was
  // embedded (hydrate updates the text but carries the OLD embedding forward — see lib/recency.js),
  // and re-ranks project importance from how recently their files were actually worked on.
  function recencyPass(opts = {}) {
    try {
      const r = recency.reap(b, {
        now: now(),
        auditPath: path.join(home, '.bhatbot', 'audit.log'),
        ...((loadConfig().secondBrain || {}).recency || {}),
        ...opts,
      });
      const a = r.applied, s = r.plan.stats;
      if (s.vanishAborted) log('[synapse] autoprune ABORTED — ' + s.vanishAborted);
      if (a.pruned || a.orphaned || a.refreshed || a.reranked) {
        const top = r.plan.projects.slice(0, 3).map((p) => p.label).join(', ');
        log(`[synapse] recency: ${a.pruned} vanished, ${a.orphaned} orphans pruned, ${a.refreshed} vectors invalidated, ${a.reranked} projects re-ranked` + (top ? ` · most active: ${top}` : ''));
        push();
      }
      return r;
    } catch (e) { log('[synapse] recency failed: ' + e.message); return { error: e.message }; }
  }

  // The Connector's similarity bar. Starts at the default and is nudged by the Gardener from the
  // user's own confirm/prune record, so it stops being a number someone guessed once.
  function connectThreshold() {
    const learned = Number(b.getMeta('connectThreshold'));
    return Number.isFinite(learned) && learned > 0 ? learned : 0.8;
  }

  // ── PAID pass: embed → propose → rationalize ────────────────────────────────────────────────────
  async function connect({ threshold, maxRationale = 8 } = {}) {
    if (threshold == null) threshold = connectThreshold();
    if (!embedBatch) { log('[synapse] no embedder injected — skipping connect'); return { proposed: 0, skipped: 'no-embedder', ...b.stats() }; }
    const need = b.nodes().filter((n) => n.status !== 'pruned' && (!Array.isArray(n.embedding) || !n.embedding.length));
    let embedded = 0;
    for (let i = 0; i < need.length; i += 64) {
      if (left() <= 0) { log('[synapse] budget exhausted — stopped embedding'); break; }
      const batch = need.slice(i, i + 64);
      const texts = batch.map((n) => (n.label + '. ' + (n.text || '')).slice(0, 2000));
      try {
        const { vecs } = await embedBatch(texts);
        charge(texts.reduce((s, t) => s + tok(t), 0) * SY_PRICE.embed);
        batch.forEach((n, k) => { if (vecs[k]) { b.upsertNode({ id: n.id, type: n.type, ref: n.ref, embedding: vecs[k] }, now()); embedded++; } });
      } catch (e) { log('[synapse] embed stopped: ' + e.message); break; }   // no key / offline → existing links stay
    }

    // Pruned pairs are included on purpose: a link the user rejected must never come back.
    const existingPairs = new Set(b.edges().map((e) => [e.from, e.to].sort().join('|')));
    const cands = brain.proposeConnections(b.nodes(), { threshold, maxPerNode: 3, existingPairs });
    cands.sort((a, c) => c.confidence - a.confidence);

    let rationalized = 0, rejected = 0, created = 0, updated = 0;
    for (let i = 0; i < cands.length; i++) {
      const e = cands[i];
      // Only the strongest few get prose — the rest commit bare. Every edge carries a confidence
      // either way; the rationale is what makes a link reviewable, so it goes where it matters most.
      if (llm && i < maxRationale && left() > 0) {
        try {
          const A = b.getNode(e.from), C = b.getNode(e.to);
          if (A && C) {
            const content = `A (${A.type}): ${A.label} — ${(A.text || '').slice(0, 400)}\n\nB (${C.type}): ${C.label} — ${(C.text || '').slice(0, 400)}`;
            const txt = String(await llm({ system: RATIONALE_SYSTEM, content, maxTokens: 90 }) || '').trim();
            charge(tok(content) * SY_PRICE.sonnetIn + tok(txt) * SY_PRICE.sonnetOut);
            if (/^none/i.test(txt)) { rejected++; continue; }   // the model says these aren't actually related
            e.rationale = txt.slice(0, 300);
            rationalized++;
          }
        } catch (err) { log('[synapse] rationale failed: ' + err.message); }
      }
      // Distinguish a genuinely NEW link from an idempotent re-write of one we already had. Reporting
      // "129 proposed" when nothing was actually added sent me on a forensic hunt for a bug that did
      // not exist — the count was candidates, not creations.
      const had = !!b.edges().find((x) => x.id === (e.id || brain.edgeId(e.from, e.to, e.type)));
      if (b.upsertEdge(e, now())) { if (had) updated++; else created++; }
    }
    b.save(); push();
    return { proposed: cands.length - rejected, created, updated, embedded, rationalized, rejected, ...b.stats() };
  }

  // ── PAID pass: what to move ahead on ────────────────────────────────────────────────────────────
  async function suggest() {
    if (!llm) return { suggestions: b.getMeta('suggestions') || [], skipped: 'no-llm' };
    if (left() <= 0) return { suggestions: b.getMeta('suggestions') || [], budgetExhausted: true };
    let projs = [];
    try { projs = listProjects().map((p) => ({ name: p.name, status: p.status })); } catch {}
    const links = b.edges().filter((e) => e.status !== 'pruned' && e.rationale)
      .sort((a, c) => (c.confidence || 0) - (a.confidence || 0)).slice(0, 14)
      .map((e) => { const A = b.getNode(e.from), C = b.getNode(e.to); return A && C ? `• ${A.label} ↔ ${C.label}: ${e.rationale}` : null; })
      .filter(Boolean);
    const ctx = `MY PROJECTS:\n${projs.map((p) => '- ' + p.name + (p.status ? ` (${p.status})` : '')).join('\n') || '(none)'}\n\nCROSS-PROJECT CONNECTIONS THE SECOND BRAIN FOUND:\n${links.join('\n') || '(none yet)'}`;
    let suggestions = [];
    try {
      // The schema is ENFORCED by the API (output_config.format) rather than fished out of the
      // reply afterwards. The old `txt.match(/\[[\s\S]*\]/)` failed whenever the model added a
      // preamble or a ```json fence, and a failed match degraded to "no suggestions" — which is
      // indistinguishable from the model genuinely having nothing to suggest.
      const txt = String(await llm({ system: SUGGEST_SYSTEM, content: ctx, maxTokens: 700, schema: SUGGEST_SCHEMA, schemaName: 'suggestions' }) || '').trim();
      charge(tok(ctx) * SY_PRICE.sonnetIn + tok(txt) * SY_PRICE.sonnetOut);
      // A schema-constrained reply parses directly. The regex remains only as the fallback for
      // backends that have no structured-output surface (the headless worker can run local models).
      try { const p = JSON.parse(txt); suggestions = Array.isArray(p) ? p : (p && p.suggestions) || []; }
      catch { const m = txt.match(/\[[\s\S]*\]/); if (m) suggestions = JSON.parse(m[0]); }
    } catch (e) { log('[synapse] suggest failed: ' + e.message); }
    if (Array.isArray(suggestions) && suggestions.length) {
      b.setMeta('suggestions', suggestions.slice(0, 5));
      b.setMeta('suggestedAt', now());
      b.save(); push();
    }
    return { suggestions: b.getMeta('suggestions') || [] };
  }

  // ── the worker cycle ────────────────────────────────────────────────────────────────────────────
  function workerConfig() {
    const c = loadConfig().synapse || {};
    return {
      worker: c.worker !== false,
      hydrateMin: Math.max(5, c.hydrateMin || 30),
      connectHours: Math.max(1, c.connectHours || 6),
      paid: c.paid !== false,
    };
  }

  let lastConnect = 0, lastGarden = 0;
  /** One cycle: always hydrate (free); run the paid pass only when idle, due, and in budget. */
  async function tick({ force = false } = {}) {
    const c = workerConfig();
    if (!c.worker && !force) return { skipped: 'disabled' };
    const out = { hydrated: null, gardened: null, reaped: null, connected: null, suggested: null };
    out.hydrated = await hydrate();
    // Recency runs on EVERY tick, immediately after hydrate, and deliberately not on the Gardener's
    // daily cadence. hydrate() has just re-walked the filesystem and re-upserted every file it found;
    // this is the only moment the graph and the disk are known to agree, so it is the right moment to
    // act on what hydrate could not see — the files that were NOT found, and the ones whose text it
    // just replaced while carrying the old vector forward. Deferring it would leave the graph
    // asserting stale similarities for up to a day, and it costs nothing.
    out.reaped = recencyPass();
    // Gardening is free and slow-moving, so it runs on its own daily cadence rather than every tick —
    // decaying a 30-day half-life 48 times a day is just noise on the same numbers.
    const gardenDue = force || (now() - lastGarden >= (Number(loadConfig().synapseGardenHours) || 24) * 3600 * 1000);
    if (gardenDue) { lastGarden = now(); out.gardened = gardenPass(); }
    const idle = !!isIdle();
    const due = force || (now() - lastConnect >= c.connectHours * 3600 * 1000);
    // Every skip reason is reported rather than swallowed — a worker that quietly does nothing is
    // exactly the failure this whole module exists to fix.
    if (!c.paid) out.paidSkipped = 'paid pass disabled';
    else if (!idle) out.paidSkipped = 'agent busy';
    else if (!due) out.paidSkipped = `not due (every ${c.connectHours}h)`;
    else if (left() <= 0.02) out.paidSkipped = `budget exhausted ($${spent().toFixed(3)}/$${budget().toFixed(2)})`;
    else {
      lastConnect = now();
      const before = spent();
      out.connected = await connect();
      out.suggested = await suggest();
      out.cost = +(spent() - before).toFixed(4);
      // Distinguish "ran and found nothing" from "could not run" — they look identical in a log
      // otherwise, and that ambiguity is how a half-dead worker goes unnoticed.
      const what = out.connected.skipped
        ? `could not connect (${out.connected.skipped})`
        : `${out.connected.created} new link(s), ${out.connected.updated} refreshed${out.connected.rejected ? `, ${out.connected.rejected} rejected` : ''}`;
      log(`[synapse] paid pass: +$${out.cost} (spent $${spent().toFixed(3)}/$${budget().toFixed(2)}) — ${what}`);
    }
    if (out.paidSkipped) log(`[synapse] hydrate only — ${out.paidSkipped}`);
    return out;
  }

  // ── INCREMENTAL PRIMITIVES (for lib/weaver.js) ──────────────────────────────────────────────────
  // connect() above is a batch: embed everything, link everything, explain the top few, in one call.
  // The always-on loop needs the same work in resumable slices — bounded per call, checkpointed by
  // the caller, and reporting exactly what it just created so the UI can show links appearing.
  // These share connect()'s pricing/charging and its "pruned pairs are never re-proposed" rule.

  /**
   * Nodes still needing an embedding — missing a vector, OR carrying one from a DIFFERENT model.
   *
   * The second condition is what makes an embedder switch survivable. Vectors from different models
   * live in different spaces and have different dimensions (OpenAI 1536 vs nomic 768); brain.cosine
   * returns 0 on a length mismatch, so a mixed store silently stops forming links between the old
   * half and the new half of the graph. Treating a stale-dimension vector as "unembedded" makes the
   * store migrate itself, one bounded slice per weaver tick, with no separate migration step.
   */
  function unembedded() {
    const dim = Number(b.getMeta('embedDim')) || 0;
    return b.nodes().filter((n) => {
      if (n.status === 'pruned') return false;
      if (!Array.isArray(n.embedding) || !n.embedding.length) return true;
      return dim > 0 && n.embedding.length !== dim;
    });
  }

  /**
   * Establish which dimension the CURRENT embedder produces, once, and remember it.
   *
   * Without this the store cannot notice it is on a stale embedder: every node already has a vector,
   * so unembedded() returns empty, so embedSome() never runs, so embedDim is never learned — a
   * deadlock that leaves 1536d OpenAI vectors sitting next to new 768d local ones, silently unable
   * to link to each other. One cheap probe breaks it.
   */
  async function ensureEmbedDim() {
    if (Number(b.getMeta('embedDim')) > 0) return Number(b.getMeta('embedDim'));
    if (!embedBatch) return 0;
    try {
      const { vecs } = await embedBatch(['dimension probe']);
      const d = (vecs && vecs[0] && vecs[0].length) || 0;
      if (d) { b.setMeta('embedDim', d); b.save(); log(`[synapse] current embedder produces ${d}-d vectors`); }
      return d;
    } catch { return 0; }
  }

  /** Embed at most `limit` nodes. Returns how many actually got a vector. */
  async function embedSome(limit = 24) {
    if (!embedBatch) return 0;
    if (left() <= 0) return 0;
    await ensureEmbedDim();
    const batch = unembedded().slice(0, limit);
    if (!batch.length) return 0;
    const texts = batch.map((n) => (n.label + '. ' + (n.text || '')).slice(0, 2000));
    let done = 0;
    try {
      const { vecs } = await embedBatch(texts);
      charge(texts.reduce((s, t) => s + tok(t), 0) * SY_PRICE.embed);
      batch.forEach((n, k) => { if (vecs[k]) { b.upsertNode({ id: n.id, type: n.type, ref: n.ref, embedding: vecs[k] }, now()); done++; } });
      // Record the dimension the CURRENT embedder produces. unembedded() uses it to spot vectors
      // left behind by a previous model and re-embed them.
      const firstVec = vecs.find((v) => Array.isArray(v) && v.length);
      if (firstVec) {
        const prev = Number(b.getMeta('embedDim')) || 0;
        if (prev !== firstVec.length) {
          log(`[synapse] embedding dimension ${prev || 'unset'} → ${firstVec.length} — older vectors will be re-embedded`);
          b.setMeta('embedDim', firstVec.length);
        }
      }
      if (done) { b.save(); push(); }
    } catch (e) { log('[synapse] embedSome stopped: ' + e.message); }
    return done;
  }

  /**
   * Propose links for a WINDOW of nodes starting at `from`. Cosine only — free and local, so this
   * can run often. Returns the edges actually created plus the next cursor (wrapping), which is what
   * makes the loop resumable across restarts.
   */
  function linkSlice({ from = 0, count = 120, threshold } = {}) {
    if (threshold == null) threshold = connectThreshold();
    const all = b.nodes().filter((n) => n.status !== 'pruned' && Array.isArray(n.embedding) && n.embedding.length);
    if (!all.length) return { created: [], nextCursor: 0, scanned: 0 };
    const start = ((from % all.length) + all.length) % all.length;
    const window = [];
    for (let i = 0; i < Math.min(count, all.length); i++) window.push(all[(start + i) % all.length]);

    // Candidates are proposed for the WINDOW against the FULL node set: a slice must still be able
    // to link to anything, otherwise links would only ever form inside a window.
    const existingPairs = new Set(b.edges().map((e) => [e.from, e.to].sort().join('|')));
    const seen = new Set(window.map((n) => n.id));
    const pool = [...window, ...all.filter((n) => !seen.has(n.id))];
    const cands = brain.proposeConnections(pool, { threshold, maxPerNode: 2, existingPairs })
      .filter((e) => seen.has(e.from));                       // only edges anchored in this window

    const created = [];
    for (const e of cands) {
      const had = !!b.edges().find((x) => x.id === (e.id || brain.edgeId(e.from, e.to, e.type)));
      if (b.upsertEdge(e, now()) && !had) {
        const A = b.getNode(e.from), C = b.getNode(e.to);
        created.push({ id: e.id || brain.edgeId(e.from, e.to, e.type), from: e.from, to: e.to,
          fromLabel: A ? A.label : e.from, toLabel: C ? C.label : e.to,
          fromType: A ? A.type : '', toType: C ? C.type : '',
          confidence: e.confidence });
      }
    }
    if (created.length) { b.save(); push(); }
    return { created, nextCursor: (start + window.length) % all.length, scanned: window.length };
  }

  /** The strongest links that have no "why related" sentence yet. */
  function unexplained(limit = 1) {
    return b.edges()
      .filter((e) => e.status !== 'pruned' && e.type === 'relates-to' && !e.rationale)
      .sort((a, c) => (c.confidence || 0) - (a.confidence || 0))
      .slice(0, limit);
  }

  /** Write one-sentence rationales. A "NONE" verdict PRUNES the edge — the model disagreeing that
   *  two things are related is a real signal, and keeping the link would launder a rejected guess. */
  async function explainEdges(edges = []) {
    if (!llm) return [];
    const out = [];
    for (const e of edges) {
      if (left() <= 0) break;
      const A = b.getNode(e.from), C = b.getNode(e.to);
      if (!A || !C) continue;
      try {
        const content = `A (${A.type}): ${A.label} — ${(A.text || '').slice(0, 400)}\n\nB (${C.type}): ${C.label} — ${(C.text || '').slice(0, 400)}`;
        const txt = String(await llm({ system: RATIONALE_SYSTEM, content, maxTokens: 90 }) || '').trim();
        charge(tok(content) * SY_PRICE.sonnetIn + tok(txt) * SY_PRICE.sonnetOut);
        if (/^none/i.test(txt)) { b.prune('edge', e.id); out.push({ id: e.id, pruned: true, fromLabel: A.label, toLabel: C.label }); continue; }
        b.upsertEdge({ ...e, rationale: txt.slice(0, 300) }, now());
        out.push({ id: e.id, rationale: txt.slice(0, 300), fromLabel: A.label, toLabel: C.label, fromType: A.type, toType: C.type, confidence: e.confidence });
      } catch (err) { log('[synapse] explain failed: ' + err.message); break; }
    }
    if (out.length) { b.save(); push(); }
    return out;
  }

  return {
    brain: b,
    hydrate, connect, suggest, tick, workerConfig,
    unembedded, embedSome, linkSlice, unexplained, explainEdges, ensureEmbedDim,
    garden: gardenPass, reap: recencyPass, connectThreshold,
    stats: () => b.stats(),
    graphView: () => { const g = b.graphView(); g.budget = { limit: budget(), spent: spent(), left: left() }; return g; },
    budget: () => ({ limit: budget(), spent: spent(), left: left() }),
    prune: (kind, id) => { const r = b.prune(kind, id); b.save(); push(); return r; },
    confirm: (kind, id) => { const r = b.confirm(kind, id); b.save(); push(); return r; },
    save: () => b.save(),
  };
}

module.exports = { createSynapse, scanRepos, readSemanticRecords, SY_PRICE, tok, RATIONALE_SYSTEM, SUGGEST_SYSTEM, SUGGEST_SCHEMA };
