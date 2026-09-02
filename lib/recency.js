'use strict';
// ── RECENCY + AUTOPRUNE — the second brain's grip on WHAT IS CURRENT ─────────────────────────────
//
// lib/gardener.js keeps the EDGES honest (decay unconfirmed guesses, merge duplicates, move the
// similarity bar). Nothing kept the NODES honest, and nodes are where the graph actually grows:
// hydrate() re-walks the filesystem on every cycle and upserts everything it finds, but it has no
// opinion about anything it does NOT find. Three consequences, all live before this module:
//
//   1. A file you deleted, renamed or moved keeps its node forever. It is still embedded (paid for),
//      still proposed as a connection, and still counted in its project's file total — so the second
//      brain confidently relates you to files that no longer exist.
//   2. A file you EDITED keeps its old vector forever. upsertNode carries `embedding` forward when
//      the incoming node has none (lib/brain.js), and hydrate never supplies one — so the text
//      updates and the vector does not. Every similarity judgement about that file is made against
//      what it used to say. Silent, permanent, and invisible in the stats.
//   3. Project importance was assigned once at import (3 for a curated project, 0.7 for a discovered
//      one) and never moved again, so the graph could not tell what you are working on THIS WEEK
//      from what you abandoned in April.
//
// This module fixes all three from signals that are free: filesystem mtime, and BhatBot's own audit
// log — which is a literal record of which files were interacted with, by the user and by the agent.
//
// planRecency() is PURE (no fs, no clock — both injected), so the whole policy is testable headless.

const DEFAULTS = {
  halfLifeDays: 14,        // recency weight halves over this long — a fortnight reads as "current"
  activeDays: 21,          // a file touched inside this window counts toward "recent files"
  orphanMinAgeDays: 30,    // never prune something we only just imported
  orphanMaxImportance: 1,  // load-bearing nodes (promoted by the Gardener) are never orphan-pruned
  maxImportance: 5,
  // SAFETY VALVE. If more than this fraction of file nodes appear to have vanished, something is
  // wrong with the WORLD, not the graph — an unmounted external drive, a permissions change, a home
  // directory that moved. Pruning would then delete most of the second brain in one silent pass, so
  // the vanish pass aborts instead and reports why. This is the single most important line here.
  maxVanishFraction: 0.25,
  minVanishToCheckFraction: 20,   // below this many, a high fraction is just a small sample

  // ── DORMANT PROJECTS (Siddhant's rule) ────────────────────────────────────────────────────────
  // "remove projects which were begun over 3 weeks ago and haven't had an update within the past
  // 3 days". Both halves are required: a project started last week is still new even if quiet, and a
  // long-running project touched yesterday is obviously live. It is the OLD AND QUIET intersection
  // that is dead weight in the graph.
  dormantEnabled: true,
  dormantStartedDays: 21,         // "begun over 3 weeks ago"
  dormantStaleDays: 3,            // "no update within the past 3 days"
  // SAFETY VALVE — and note what it is and is NOT for.
  //
  // A high dormant fraction is EXPECTED here, unlike in the vanish pass. A 3-day staleness window
  // is aggressive by design: measured on the live graph, 49 of 63 projects (78%) are genuinely
  // dormant by this definition, because most work sits idle for a week or two at a time. A
  // fraction-based valve tuned like the vanish one therefore fires on the rule working correctly,
  // which is how the first version of this matched nothing at all.
  //
  // What actually indicates a BROKEN signal is that NOTHING looks active — an empty audit log, an
  // unreadable filesystem, a clock that jumped. If even one project registers real recent activity,
  // the signal is working and the rule should be trusted. The fraction cap stays only as a backstop
  // for the pathological case.
  maxDormantFraction: 0.98,
  minDormantToCheckFraction: 5,
};

const day = 864e5;

/** Exponential recency weight in [0,1]: 1 = touched now, 0.5 = one half-life ago. */
function recencyWeight(ts, now, halfLifeDays) {
  if (!ts) return 0;
  const ageDays = Math.max(0, (now - ts) / day);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Decide what to prune, refresh and re-rank. Pure.
 *
 * @param {object} graph  { nodes, edges } straight from the brain
 * @param {object} opts
 *   now            {number}   current epoch ms (required for determinism)
 *   exists         {(path:string)=>boolean}  file-existence probe (injected fs)
 *   mtimeOf        {(path:string)=>number}   current mtime ms, 0 if unknown (injected fs)
 *   touches        {Map<string, number>}     absolute path → last interaction ms (see readTouches)
 * @returns {{ vanished, refresh, orphans, projects, stats }}
 */
function planRecency({ nodes = [], edges = [] } = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now || 0;
  const exists = typeof o.exists === 'function' ? o.exists : null;
  const mtimeOf = typeof o.mtimeOf === 'function' ? o.mtimeOf : () => 0;
  const touches = o.touches instanceof Map ? o.touches : new Map();

  const allNodes = Array.isArray(nodes) ? nodes : [];
  const allEdges = Array.isArray(edges) ? edges : [];

  // ⚠ LOAD-BEARING — normalize the project key. The two importers disagree on form: repoNodes()
  // keys a project by its ABSOLUTE PATH ("/Users/siddhantbhat/bhatbot") while fileindex keys by NAME
  // ("bhatbot"). lib/brain.js already carries this exact note for proposeConnections, where the
  // mismatch filled the graph with within-project noise.
  //
  // Here it was worse than noise. Every project node created by repoNodes failed to match its own
  // files, so its activity read as zero and its last update as "never recorded" — and the dormancy
  // rule below then proposed archiving `bhatbot` itself, 36 days old and being actively edited at
  // that moment. A rule that archives the project you are working in is worse than no rule.
  const groupKey = (v) => String(v || '').replace(/\/+$/, '').split('/').pop().toLowerCase();
  const projKeyOf = (n) => groupKey((n.meta && (n.meta.project || n.meta.repo || n.meta.root)) || n.ref);
  const live = (x) => x && x.status !== 'pruned';
  const liveNodes = allNodes.filter(live);
  const liveEdges = allEdges.filter(live);

  // ── degree, for the orphan test ────────────────────────────────────────────────────────────────
  const degree = new Map();
  for (const e of liveEdges) for (const side of [e.from, e.to]) degree.set(side, (degree.get(side) || 0) + 1);

  // ── 1. VANISHED + 2. STALE-VECTOR ─────────────────────────────────────────────────────────────
  const fileNodes = liveNodes.filter((n) => n.type === 'file' && n.meta && n.meta.path);
  const vanished = [], refresh = [];
  if (exists) {
    for (const n of fileNodes) {
      if (!exists(n.meta.path)) { vanished.push({ kind: 'node', id: n.id, ref: n.ref, reason: 'file no longer exists on disk' }); continue; }
      const cur = mtimeOf(n.meta.path) || 0;
      const known = Number(n.meta.mtime) || 0;
      // Only interesting if the file moved FORWARD and we hold a vector computed from the old text.
      if (cur > known + 1000 && Array.isArray(n.embedding) && n.embedding.length) {
        refresh.push({ id: n.id, ref: n.ref, path: n.meta.path, mtime: cur, wasMtime: known });
      }
    }
  }
  // The safety valve — see DEFAULTS.maxVanishFraction.
  let vanishAborted = null;
  if (fileNodes.length >= o.minVanishToCheckFraction && vanished.length / fileNodes.length > o.maxVanishFraction) {
    vanishAborted = `${vanished.length}/${fileNodes.length} file nodes looked missing (>${Math.round(o.maxVanishFraction * 100)}%) — treating this as an unreachable filesystem, not ${vanished.length} deletions`;
    vanished.length = 0;
  }
  const vanishedIds = new Set(vanished.map((v) => v.id));

  // ── 3. ORPHANS ────────────────────────────────────────────────────────────────────────────────
  // Deliberately conservative: connected to nothing, never promoted, old enough that it has had a
  // fair chance to be linked, and not a project (a project with no files yet is still a real project).
  const orphans = [];
  for (const n of liveNodes) {
    if (vanishedIds.has(n.id) || n.type === 'project') continue;
    if ((degree.get(n.id) || 0) > 0) continue;
    if ((n.importance || 1) > o.orphanMaxImportance) continue;
    const age = (now - (n.updatedAt || n.createdAt || now)) / day;
    if (age < o.orphanMinAgeDays) continue;
    if (n.meta && n.meta.path && touches.has(n.meta.path)) continue;     // recently used → keep
    orphans.push({ kind: 'node', id: n.id, reason: `no links, importance ${n.importance || 1}, untouched for ${Math.round(age)}d` });
  }

  // ── 4. PROJECT RECENCY ────────────────────────────────────────────────────────────────────────
  // Activity per project = recency-weighted evidence from its files. Two sources, deliberately
  // different in meaning: mtime says the file CHANGED, a touch says it was READ OR WRITTEN through
  // BhatBot. A file you asked about but did not edit is still a file you are working on, so touches
  // are weighted higher than a bare mtime.
  const byProject = new Map();
  for (const n of fileNodes) {
    if (vanishedIds.has(n.id)) continue;
    const proj = projKeyOf(n);
    if (!proj) continue;
    const rec = byProject.get(proj) || { files: 0, activity: 0, lastTouched: 0, recent: [] };
    const mt = Number(n.meta.mtime) || 0;
    const touch = touches.get(n.meta.path) || 0;
    const last = Math.max(mt, touch);
    rec.files++;
    rec.activity += recencyWeight(mt, now, o.halfLifeDays) + 2 * recencyWeight(touch, now, o.halfLifeDays);
    if (last > rec.lastTouched) rec.lastTouched = last;
    if (last && (now - last) / day <= o.activeDays) rec.recent.push({ ref: n.ref, at: last, viaAgent: touch >= mt && touch > 0 });
    byProject.set(proj, rec);
  }

  const projectNodes = liveNodes.filter((n) => n.type === 'project');
  const scored = [];
  for (const p of projectNodes) {
    const rec = byProject.get(projKeyOf(p)) || null;
    if (!rec) continue;
    rec.recent.sort((a, b) => b.at - a.at);
    scored.push({ id: p.id, ref: p.ref, label: p.label, activity: +rec.activity.toFixed(3), files: rec.files, lastTouched: rec.lastTouched, recentFiles: rec.recent.slice(0, 8) });
  }
  // Importance from RANK, not from the raw score: activity is unbounded and scales with how many
  // files a project happens to have, so a big dormant repo would outrank a small active one. Rank is
  // the question actually being asked — "which of my projects am I on right now".
  scored.sort((a, b) => b.activity - a.activity || b.lastTouched - a.lastTouched);
  const projects = scored.map((s, i) => ({
    ...s,
    rank: i + 1,
    // Top of the list is a 5; anything with no measurable activity floors at 1.
    importance: s.activity <= 0 ? 1 : Math.max(1, o.maxImportance - Math.floor(i * (o.maxImportance - 1) / Math.max(1, Math.min(scored.length, 8)))),
  }));

  // ── 5. DORMANT PROJECTS ───────────────────────────────────────────────────────────────────────
  // Archive (never delete) a project that both STARTED long ago and has not been touched recently.
  //
  // "Begun" is taken from the earliest file we know about, not from the node's createdAt: createdAt
  // records when SYNAPSE first indexed the project, which for a graph built last fortnight would
  // make every project look three days old and the rule would never fire. The earliest file mtime is
  // the closest free signal to when the work actually started; createdAt is the fallback when a
  // project has no files yet.
  const dormant = [];
  let dormantAborted = null;
  if (o.dormantEnabled) {
    const firstSeen = new Map();       // project key → earliest file mtime
    for (const n of fileNodes) {
      if (vanishedIds.has(n.id)) continue;
      const proj = projKeyOf(n);
      const mt = Number(n.meta.mtime) || 0;
      if (!proj || !mt) continue;
      if (!firstSeen.has(proj) || mt < firstSeen.get(proj)) firstSeen.set(proj, mt);
    }
    const startedCut = now - o.dormantStartedDays * day;
    const staleCut = now - o.dormantStaleDays * day;
    for (const p of projectNodes) {
      const key = projKeyOf(p);
      const rec = byProject.get(key) || null;
      const startedAt = firstSeen.get(key) || p.createdAt || 0;
      // ⚠ LOAD-BEARING — `p.updatedAt` is deliberately NOT consulted. hydrate() re-upserts every project node on
      // every cycle, so updatedAt is always "a few minutes ago" — it records when SYNAPSE last looked
      // at the project, not when the project was worked on. Including it made the rule match nothing
      // at all (0 of 63 projects, on a graph with genuinely dormant work in it). Only real activity
      // counts: a file changing on disk, or the file being read/written through BhatBot.
      const lastUpdate = Math.max((rec && rec.lastTouched) || 0, Number((p.meta || {}).lastTouched) || 0);
      // Unknown start date → not eligible. Guessing "very old" from a missing value is how a rule
      // like this quietly eats everything it cannot measure.
      if (!startedAt) continue;
      if (startedAt > startedCut) continue;                       // not old enough to count as begun long ago
      if (lastUpdate && lastUpdate > staleCut) continue;          // updated within the window → live
      dormant.push({
        kind: 'node', id: p.id, ref: p.ref, label: p.label,
        startedAt, lastUpdate, files: (rec && rec.files) || 0,
        reason: `begun ${Math.round((now - startedAt) / day)}d ago, last update ` +
          (lastUpdate ? `${Math.round((now - lastUpdate) / day)}d ago` : 'never recorded'),
      });
    }
    // The real "is the activity signal alive?" test: does ANY project show recent activity?
    const anyActive = projectNodes.some((p) => {
      const rec = byProject.get(projKeyOf(p)) || null;
      const last = Math.max((rec && rec.lastTouched) || 0, Number((p.meta || {}).lastTouched) || 0);
      return last > staleCut;
    });
    if (dormant.length && !anyActive) {
      dormantAborted = `not one project shows activity in the last ${o.dormantStaleDays}d — the activity signal looks dead (empty audit log? unreadable filesystem?), so ${dormant.length} archives were held back rather than trusted`;
      dormant.length = 0;
    } else if (projectNodes.length >= o.minDormantToCheckFraction && dormant.length / projectNodes.length > o.maxDormantFraction) {
      dormantAborted = `${dormant.length}/${projectNodes.length} projects looked dormant (>${Math.round(o.maxDormantFraction * 100)}%) — held back as a backstop`;
      dormant.length = 0;
    }
  }

  // ── 6. REVIVE ─────────────────────────────────────────────────────────────────────────────────
  // The other half of the dormancy rule, and it is not optional. `prune` is sticky by design —
  // upsertNode refuses to resurrect a pruned node without an explicit `_revive` — so without this a
  // project you come back to after a quiet fortnight would stay archived permanently, and hydrate
  // would silently decline to re-add it every cycle. Archiving is only safe because it is reversible
  // BY THE SAME SIGNAL that caused it.
  const revive = [];
  if (o.dormantEnabled) {
    const staleCut = now - o.dormantStaleDays * day;
    for (const n of allNodes) {
      if (!n || n.type !== 'project' || n.status !== 'pruned') continue;
      if (!(n.meta && n.meta.archivedBy === 'recency:dormant')) continue;   // only OUR archives
      const rec = byProject.get(projKeyOf(n)) || null;
      const last = Math.max((rec && rec.lastTouched) || 0, Number((n.meta || {}).lastTouched) || 0);
      if (last > staleCut) revive.push({ id: n.id, ref: n.ref, label: n.label, lastUpdate: last, reason: `worked on ${Math.round((now - last) / 36e5)}h ago` });
    }
  }

  return {
    vanished, refresh, orphans, projects, dormant, revive,
    stats: {
      liveNodes: liveNodes.length, fileNodes: fileNodes.length,
      vanished: vanished.length, refresh: refresh.length, orphans: orphans.length,
      dormant: dormant.length, revive: revive.length, dormantAborted,
      projectsRanked: projects.length, touches: touches.size, vanishAborted,
    },
  };
}

/**
 * Apply a plan to a live brain. Order matters: prune first so a refreshed node is never one we are
 * about to delete, and rank projects last so their file counts reflect the pruning.
 */
function apply(brain, plan, { now = Date.now() } = {}) {
  const out = { pruned: 0, refreshed: 0, reranked: 0, orphaned: 0, dormant: 0, revived: 0 };
  for (const v of plan.vanished || []) { if (brain.prune('node', v.id)) out.pruned++; }
  for (const o of plan.orphans || []) { if (brain.prune('node', o.id)) out.orphaned++; }

  // ARCHIVE, never delete. `prune` sets status and nothing on disk is touched — the project's files
  // stay exactly where they are, and the node can be revived. The reason is stamped on the node so
  // that months later it is answerable why something disappeared from the graph.
  for (const d of plan.dormant || []) {
    const n = brain.getNode(d.id);
    if (!n) continue;
    brain.upsertNode({ id: n.id, type: n.type, ref: n.ref,
      meta: { ...n.meta, archivedAt: now, archivedReason: d.reason, archivedBy: 'recency:dormant' } }, now);
    if (brain.prune('node', d.id)) out.dormant++;
  }

  // Bring an archived project back the moment it is worked on again.
  for (const r of plan.revive || []) {
    const n = brain.getNode(r.id);
    if (!n) continue;
    const meta = { ...n.meta }; delete meta.archivedAt; delete meta.archivedReason; delete meta.archivedBy;
    if (brain.upsertNode({ id: n.id, type: n.type, ref: n.ref, status: 'confirmed', _revive: true,
      meta: { ...meta, revivedAt: now, revivedReason: r.reason } }, now)) out.revived++;
  }

  // Refresh = drop the stale vector and record the new mtime. We do NOT re-embed here: embedding
  // costs money and belongs to the budgeted connect() pass, which picks up any node lacking a vector
  // on its next run. Clearing it is what puts the file back in that queue — without this the text
  // updates forever and the vector never does.
  for (const r of plan.refresh || []) {
    const n = brain.getNode(r.id);
    if (!n) continue;
    brain.upsertNode({ id: n.id, type: n.type, ref: n.ref, embedding: null, meta: { ...n.meta, mtime: r.mtime, revectorAt: now } }, now);
    const fresh = brain.getNode(r.id);
    if (fresh) fresh.embedding = null;             // upsertNode carries the old vector forward — clear it explicitly
    out.refreshed++;
  }

  for (const p of plan.projects || []) {
    const n = brain.getNode(p.id);
    if (!n) continue;
    const changed = (n.importance || 1) !== p.importance || (n.meta || {}).activity !== p.activity;
    brain.upsertNode({
      id: n.id, type: n.type, ref: n.ref, importance: p.importance,
      meta: { ...n.meta, activity: p.activity, activityRank: p.rank, lastTouched: p.lastTouched, recentFiles: p.recentFiles.map((f) => f.ref), liveFiles: p.files },
    }, now);
    if (changed) out.reranked++;
  }

  if (out.pruned || out.orphaned || out.refreshed || out.reranked || out.dormant || out.revived) brain.save();
  return out;
}

/**
 * Which files were most recently interacted with, from BhatBot's own tool ledger.
 *
 * ~/.bhatbot/audit.log is append-only JSONL with one entry per tool call; the file tools record
 * their path in `args` (itself a JSON string, redacted). Reading only the TAIL keeps this cheap on a
 * log that is hundreds of KB and only grows.
 *
 * @returns {Map<string, number>} absolute path → last interaction epoch ms
 */
function readTouches(auditPath, { fs = require('fs'), tailBytes = 512 * 1024, tools = ['read_file', 'write_file', 'edit_file', 'file_tools'] } = {}) {
  const out = new Map();
  let text = '';
  try {
    const size = fs.statSync(auditPath).size;
    const start = Math.max(0, size - tailBytes);
    const fd = fs.openSync(auditPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, tailBytes));
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return out; }
  // A tail read almost always starts mid-line; that fragment is not valid JSON, so drop it.
  if (text && text[0] !== '{') text = text.slice(text.indexOf('\n') + 1);
  const want = new Set(tools);
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || !want.has(e.tool)) continue;
    const ts = Date.parse(e.ts || '');
    if (!ts) continue;
    let args = e.args;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
    for (const p of [args && args.path, args && args.file, ...(Array.isArray(args && args.paths) ? args.paths : [])]) {
      if (typeof p !== 'string' || !p) continue;
      if (!out.has(p) || out.get(p) < ts) out.set(p, ts);
    }
  }
  return out;
}

/** Convenience: plan + apply against a live brain, with real fs probes. */
function reap(brain, { now = Date.now(), auditPath, fs = require('fs'), ...opts } = {}) {
  const touches = auditPath ? readTouches(auditPath, { fs }) : new Map();
  const plan = planRecency({ nodes: brain.nodes(), edges: brain.edges() }, {
    now, touches,
    exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
    mtimeOf: (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } },
    ...opts,
  });
  return { plan, applied: apply(brain, plan, { now }) };
}

module.exports = { planRecency, apply, reap, readTouches, recencyWeight, DEFAULTS };
