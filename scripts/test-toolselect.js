#!/usr/bin/env node
'use strict';
// Tests for lib/toolselect.js — two-stage tool retrieval that runs on EVERY turn (cosine top-k +
// always-present CORE). Key invariants: (1) graceful degradation — returns null ("use full catalog")
// with no embedding key / tiny catalog, so the agent is NEVER stranded; (2) CORE escape-hatches +
// self_reflect are always kept; (3) ranking returns a strict subset, preserves catalog order, keeps
// un-vectored tools. semantic is monkey-patched (same required object) for deterministic ranking.
// Temp $HOME isolates the vec cache. Wired into `npm run verify`.
//   node scripts/test-toolselect.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-toolsel-'));
process.env.HOME = TMP;
const semantic = require('../lib/semantic');
const ts = require('../lib/toolselect');

const hashOf = (str) => { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return h; };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- CORE invariants (locks the Phase-5 self_reflect-in-CORE + the escape hatches) ----
for (const n of ['save_memory', 'read_file', 'write_file', 'run_shell', 'notify_user', 'ask_ai', 'request_permissions', 'self_reflect'])
  ok(ts.CORE.includes(n), `CORE includes "${n}"`);

(async () => {
  // ---- graceful degradation (NO embedder of any kind available) ----
  // This used to assert `semantic.isReady() === false` and lean on the test machine having no OpenAI
  // key. That is no longer the right question: select() gates on embedderReady(), which also counts a
  // local Ollama — and on a dev box Ollama IS running, so the "no embedder" branch stopped being
  // exercised at all. Stub the gate rather than depend on the environment.
  const bigCatalog = Array.from({ length: 20 }, (_, i) => ({ name: 'tool_' + i, description: 'does thing ' + i }));
  const realEmbedderReady = semantic.embedderReady;
  semantic.embedderReady = async () => false;
  ok((await ts.select('anything', bigCatalog)) === null, 'select: no embedder at all → null (caller uses FULL catalog, never stranded)');
  semantic.embedderReady = realEmbedderReady;

  // ---- tiny catalog → null (retrieval not worth it) ----
  // (force-enable embeddings via monkey-patch so this isn't just the no-embedder path)
  semantic.isReady = () => true;
  semantic.embedderReady = async () => true;
  semantic.embedBatch = async (arr) => ({ vecs: arr.map((s) => ({ _text: s })) });
  semantic.cosine = (a, b) => {
    const wa = new Set(String(a._text || '').toLowerCase().match(/[a-z]+/g) || []);
    const wb = String(b._text || '').toLowerCase().match(/[a-z]+/g) || [];
    let s = 0; for (const w of wb) if (wa.has(w)) s++;
    return Math.min(1, s / 4);
  };
  ok((await ts.select('x', bigCatalog.slice(0, 10))) === null, 'select: catalog < MIN_CATALOG → null');

  // ---- ranking: relevant tools + CORE, strict subset, order preserved ----
  const catalog = [
    { name: 'web_search', description: 'search the web for news and pages online' },
    { name: 'browser_action', description: 'navigate click type on web pages browser' },
    { name: 'play_music', description: 'spotify music playback songs audio' },
    { name: 'send_email', description: 'compose and send email messages' },
    { name: 'ask_ai', description: 'ask another model a question' },          // CORE
    { name: 'save_memory', description: 'remember a fact for later' },          // CORE
    { name: 'self_reflect', description: 'introspect on desires and improvements' }, // CORE
    { name: 'generate_image', description: 'create an image from a text prompt' },
    { name: 'molecule', description: 'render a 3d molecule structure chemistry' },
    { name: 'maps', description: 'show a map location route geography' },
    { name: 'world_cup', description: 'soccer football world cup scores bracket' },
    { name: 'make_figure', description: 'plot a chart figure from data' },
    { name: 'simulate', description: 'run a physics chemistry simulation' },
    { name: 'manage_jobs', description: 'list and manage background jobs' },
    { name: 'read_file', description: 'read a file from disk' },               // CORE
    { name: 'notify_user', description: 'send a notification to the user' },    // CORE
    { name: 'transcribe', description: 'speech to text audio transcription' },
    { name: 'calendar', description: 'schedule events on the calendar' },
  ];
  const res = await ts.select('search the web for news online', catalog, { k: 4, minScore: 0.18 });
  ok(res && Array.isArray(res.tools), 'select: returns a result object with relevant query');
  ok(res.names.includes('web_search'), 'select: top match (web_search) is included');
  ok(res.names.length < catalog.length, 'select: returns a STRICT SUBSET (not the whole catalog)');
  for (const core of ['ask_ai', 'save_memory', 'self_reflect', 'read_file', 'notify_user'])
    ok(res.names.includes(core), `select: CORE "${core}" force-kept regardless of relevance`);
  ok(!res.names.includes('world_cup'), 'select: irrelevant tool (world_cup) excluded');
  // order preserved (catalog order, not score order)
  const idxWeb = res.names.indexOf('web_search'), idxAsk = res.names.indexOf('ask_ai');
  ok(idxWeb < idxAsk, 'select: preserves original catalog order in the subset');

  // ---- un-vectored tool is always kept (cache lag must not drop a new tool) ----
  const withNew = catalog.concat([{ name: 'brand_new_tool', description: 'just added, vector not cached yet' }]);
  // prime cache for the original catalog only, then add a tool whose vec we force-miss:
  const origEmbed = semantic.embedBatch;
  semantic.embedBatch = async (arr) => ({ vecs: arr.map((s) => (/just added/.test(s) ? null : { _text: s })) });
  const res2 = await ts.select('search the web', withNew, { k: 3 });
  ok(res2 && res2.names.includes('brand_new_tool'), 'select: un-vectored (cache-lagging) tool is always kept, never silently dropped');
  semantic.embedBatch = origEmbed;


  // ── THE CACHE IS KEYED ON THE EMBEDDER, NOT JUST THE CATALOG ────────────────────────────────────
  // Live state that prompted this: toolvecs.json held 768-d nomic vectors filed under the name
  // 'text-embedding-3-small', because the model tag was hardcoded at save time. Nothing in the
  // validity check looked at the model, so a cache built by one embedder is served to another —
  // every cosine is then between mismatched lengths, returns 0, and select() falls back to the FULL
  // catalog on every turn with nothing anywhere saying so.
  {
    const cachePath = path.join(TMP, '.bhatbot', 'toolvecs.json');
    const cat3 = catalog.slice();
    // Vectors must DIFFER per text, or every cosine is 1.0, the top-k covers the whole catalog and
    // select() correctly returns null for "selected everything" — which would look like the failure
    // this block is trying to detect.
    const vecFor = (dim) => async (arr) => ({
      vecs: arr.map((t) => { const v = new Array(dim).fill(0.01); v[Math.abs(hashOf(t)) % dim] = 1; return v; }),
      model: 'model-' + dim,
    });
    const saved = semantic.embedBatch;

    semantic.embedBatch = vecFor(768);
    await ts.select('search the web', cat3, { k: 3 });
    const c1 = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    ok(c1.model === 'model-768' && c1.dim === 768, 'the cache records the embedder that ACTUALLY ran, not a hardcoded name');

    // Now the embedder changes underneath it, as it does when a key expires or is restored.
    semantic.embedBatch = vecFor(1536);
    // minScore 0: this block is about surviving an embedder switch, not about the relevance bar.
    // Synthetic one-hot vectors score ~0.09, below the real 0.18 default, which would make select()
    // return null for a legitimate reason and mask the thing under test.
    const res = await ts.select('search the web', cat3, { k: 3, minScore: 0 });
    const c2 = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    ok(c2.dim === 1536, 'a different embedder invalidates the vectors instead of being served stale ones');
    ok(res && res.names.length, 'and retrieval still WORKS across the switch rather than silently sending everything');

    semantic.embedBatch = saved;
  }

  // ── ONE CHANGED TOOL DOES NOT RE-EMBED ALL 85 ──────────────────────────────────────────────────
  // The old validity test was a single hash over every description plus `length === tools.length`,
  // so connectors coming online (85 -> 90) or one edited description threw the whole cache away.
  // Measured on the real catalog that was ~13s of embedding, on the first turn's critical path, and
  // it recurred every time the connector count flapped.
  {
    const saved = semantic.embedBatch;
    let embedded = [];
    semantic.embedBatch = async (arr) => { embedded.push(...arr); return { vecs: arr.map(() => [1, 0, 0]), model: 'stable', }; };

    const base = catalog.slice();
    await ts.select('search the web', base, { k: 3 });      // prime
    embedded = [];
    await ts.select('search the web', base, { k: 3 });      // unchanged catalog
    ok(embedded.filter((t) => !/^search the web$/.test(t) && !/probe/.test(t)).length === 0,
      'an unchanged catalog re-embeds NOTHING');

    embedded = [];
    const plusOne = base.concat([{ name: 'mcp__conn__thing', description: 'a connector tool that has just come online and needs a vector' }]);
    await ts.select('search the web', plusOne, { k: 3 });
    const toolEmbeds = embedded.filter((t) => /^mcp__conn__thing:/.test(t));
    const otherEmbeds = embedded.filter((t) => /:/.test(t) && !/^mcp__conn__thing:/.test(t));
    ok(toolEmbeds.length === 1, 'a newly-connected tool is embedded');
    ok(otherEmbeds.length === 0, `...and ONLY it — the other ${base.length} keep their vectors (was: re-embed everything)`);

    embedded = [];
    const edited = plusOne.map((t) => (t.name === 'web_search' ? { ...t, description: t.description + ' now with an edited description' } : t));
    await ts.select('search the web', edited, { k: 3 });
    ok(embedded.filter((t) => /^web_search:/.test(t)).length === 1, 'an EDITED description re-embeds that tool');
    ok(embedded.filter((t) => /:/.test(t) && !/^web_search:/.test(t)).length === 0, '...and leaves every other vector alone');

    semantic.embedBatch = saved;
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
