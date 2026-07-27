#!/usr/bin/env node
'use strict';
// Tests for lib/gardener.js — the second brain's upkeep pass. The Connector only ever ADDS, so
// without this the graph accumulates stale guesses and duplicates forever and its similarity bar
// never moves. What must hold:
//   1. CONFIRMED things are never decayed or pruned. The user said yes; that does not expire.
//   2. A PRUNED thing stays pruned — rejection is permanent, including through a merge.
//   3. MERGING REWIRES. A naive merge orphans the loser's edges and silently shrinks the graph.
//   4. The threshold controller only moves on real evidence, in the right direction, and clamps.
// planGardening is pure (injected clock + cosine), so all of this runs with no store and no network.
// Wired into `npm run verify`.
//   node scripts/test-gardener.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-gardener-'));
const { planGardening, apply, garden, DEFAULTS } = require('../lib/gardener');
const brainLib = require('../lib/brain');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const DAY = 864e5;
const T = 1_700_000_000_000;
const node = (id, o = {}) => ({ id, type: 'memory', label: id, ref: id, text: '', status: 'confirmed', importance: 1, createdAt: T, updatedAt: T, ...o });
const edge = (id, from, to, o = {}) => ({ id, from, to, type: 'relates-to', status: 'proposed', confidence: 0.8, createdAt: T, updatedAt: T, ...o });

// ---- DECAY ----
{
  const edges = [
    edge('fresh', 'a', 'b', { updatedAt: T }),
    edge('aging', 'a', 'c', { updatedAt: T - 30 * DAY }),          // one half-life → 0.8 → 0.4
    edge('ancient', 'a', 'd', { updatedAt: T - 200 * DAY }),        // far below the floor
    edge('blessed', 'a', 'e', { status: 'confirmed', confidence: 0.8, updatedAt: T - 400 * DAY }),
    edge('dead', 'a', 'f', { status: 'pruned', updatedAt: T - 400 * DAY }),
  ];
  const p = planGardening({ nodes: [], edges }, { now: T });

  ok(!p.decay.some((d) => d.id === 'fresh') && !p.prune.some((x) => x.id === 'fresh'), 'decay: a fresh proposal is untouched');
  const aging = p.decay.find((d) => d.id === 'aging');
  ok(aging && Math.abs(aging.confidence - 0.4) < 0.01, 'decay: one half-life halves the confidence');
  ok(p.prune.some((x) => x.id === 'ancient'), 'decay: a proposal decayed below the floor is pruned');
  ok(p.prune.find((x) => x.id === 'ancient').reason.includes('unconfirmed'), 'decay: the prune records WHY');

  // The two that matter most.
  ok(!p.decay.some((d) => d.id === 'blessed') && !p.prune.some((x) => x.id === 'blessed'),
    'decay: a CONFIRMED edge is never decayed or pruned, at any age (the user said yes)');
  ok(!p.decay.some((d) => d.id === 'dead') && !p.prune.some((x) => x.id === 'dead'),
    'decay: an already-pruned edge is left alone');

  const slow = planGardening({ nodes: [], edges }, { now: T, halfLifeDays: 3650 });
  ok(!slow.prune.some((x) => x.id === 'ancient'), 'decay: halfLifeDays is configurable');
}

// ---- MERGE ----
{
  const cosine = brainLib.cosine;
  const V = [1, 0, 0, 0];
  const nodes = [
    node('dup-a', { embedding: V, text: 'the fuller version of this note', updatedAt: T }),
    node('dup-b', { embedding: [0.999, 0.001, 0, 0], text: 'short', updatedAt: T + 1000 }),
    node('other', { embedding: [0, 1, 0, 0], text: 'unrelated entirely' }),
    node('typed', { embedding: V, type: 'project', text: 'same vector, different type' }),
  ];
  const edges = [
    edge('e1', 'dup-b', 'other', { status: 'confirmed' }),
    edge('e2', 'other', 'dup-b'),
    edge('e3', 'dup-a', 'dup-b'),      // becomes a self-loop after the merge → must be dropped
  ];
  const p = planGardening({ nodes, edges }, { now: T, cosine });

  ok(p.merge.length === 1, 'merge: exactly one near-duplicate pair found');
  const m = p.merge[0];
  ok(m.drop === 'dup-b' && m.into === 'dup-a', 'merge: keeps the node with MORE text, not an arbitrary one');
  ok(!p.merge.some((x) => x.drop === 'typed' || x.into === 'typed'), 'merge: never merges across node types');
  ok(!p.merge.some((x) => x.drop === 'other'), 'merge: a genuinely different node is untouched');

  // THE important one — a merge that forgets to rewire silently deletes real connections.
  ok(m.rewire.length === 2, 'merge: REWIRES the dropped node\'s edges (a naive merge would orphan them)');
  ok(m.rewire.every((e) => e.from !== 'dup-b' && e.to !== 'dup-b'), 'merge: no rewired edge still points at the dropped node');
  ok(m.rewire.every((e) => e.from !== e.to), 'merge: an edge that would become a self-loop is dropped');
  ok(m.rewire.find((e) => e.id === 'e1').status === 'confirmed', 'merge: rewiring preserves confirmed status');

  ok(planGardening({ nodes, edges }, { now: T }).merge.length === 0, 'merge: no-op without a cosine fn (never guesses)');

  // A "similar but distinguishable" pair: cosine ≈ 0.98, so it merges at the 0.97 default but not at
  // a stricter bar. This is the knob that matters — merging is destructive, so the default is already
  // stricter than memmaint's 0.95 dedup, and it must be tightenable further.
  const near = [node('n1', { embedding: [1, 0.2, 0, 0], text: 'longer text' }), node('n2', { embedding: [1, 0, 0, 0], text: 'x' })];
  ok(Math.abs(cosine(near[0].embedding, near[1].embedding) - 0.98) < 0.01, 'merge: the fixture pair really is ~0.98 similar');
  ok(planGardening({ nodes: near, edges: [] }, { now: T, cosine }).merge.length === 1, 'merge: a ~0.98 pair merges at the default threshold');
  ok(planGardening({ nodes: near, edges: [] }, { now: T, cosine, mergeThreshold: 0.99 }).merge.length === 0,
    'merge: raising mergeThreshold suppresses it (the knob works, and defaults to strict)');
  ok(DEFAULTS.mergeThreshold > 0.95, 'merge: the default bar is stricter than memmaint\'s dedup (merging destroys a node)');
}

// ---- PROMOTE ----
{
  const nodes = [node('hub'), node('leaf'), node('x'), node('y'), node('z')];
  const edges = [
    edge('c1', 'hub', 'x', { status: 'confirmed' }),
    edge('c2', 'hub', 'y', { status: 'confirmed' }),
    edge('c3', 'hub', 'z', { status: 'confirmed' }),
    edge('p1', 'leaf', 'x'), edge('p2', 'leaf', 'y'), edge('p3', 'leaf', 'z'),   // proposed, not confirmed
  ];
  const p = planGardening({ nodes, edges }, { now: T });
  ok(p.promote.some((x) => x.id === 'hub'), 'promote: a node with 3 confirmed edges is promoted');
  ok(!p.promote.some((x) => x.id === 'leaf'), 'promote: PROPOSED edges do not count toward promotion');
  ok(p.promote.find((x) => x.id === 'hub').importance === 2, 'promote: importance rises with confirmed degree');

  const many = planGardening({
    nodes: [node('mega')],
    edges: Array.from({ length: 40 }, (_, i) => edge('m' + i, 'mega', 'n' + i, { status: 'confirmed' })),
  }, { now: T });
  ok(many.promote[0].importance <= DEFAULTS.maxImportance, 'promote: importance is capped');

  const already = planGardening({ nodes: [node('hub', { importance: 5 })], edges }, { now: T });
  ok(!already.promote.some((x) => x.id === 'hub'), 'promote: no churn when importance is already high enough');
}

// ---- THRESHOLD CONTROLLER (P4 "learning") ----
{
  const mk = (confirmed, pruned) => [
    ...Array.from({ length: confirmed }, (_, i) => edge('c' + i, 'a', 'b' + i, { status: 'confirmed' })),
    ...Array.from({ length: pruned }, (_, i) => edge('p' + i, 'a', 'x' + i, { status: 'pruned' })),
  ];

  ok(planGardening({ nodes: [], edges: mk(1, 2) }, { now: T, currentThreshold: 0.8 }).threshold === null,
    'threshold: does not move on a handful of curations');

  const low = planGardening({ nodes: [], edges: mk(2, 18) }, { now: T, currentThreshold: 0.8 });
  ok(low.threshold && low.threshold.to > 0.8, 'threshold: mostly REJECTED proposals → raise the bar');
  ok(/raising the bar/.test(low.threshold.reason), 'threshold: explains itself');

  const high = planGardening({ nodes: [], edges: mk(18, 2) }, { now: T, currentThreshold: 0.8 });
  ok(high.threshold && high.threshold.to < 0.8, 'threshold: mostly KEPT proposals → look wider');

  const mid = planGardening({ nodes: [], edges: mk(10, 10) }, { now: T, currentThreshold: 0.8 });
  ok(mid.threshold === null, 'threshold: a healthy 50% confirm rate → leave it alone');

  ok(planGardening({ nodes: [], edges: mk(2, 18) }, { now: T, currentThreshold: 0.92 }).threshold === null,
    'threshold: clamped at the ceiling (cannot ratchet to 1.0 and propose nothing ever again)');
  ok(planGardening({ nodes: [], edges: mk(18, 2) }, { now: T, currentThreshold: 0.74 }).threshold === null,
    'threshold: clamped at the floor (cannot collapse to 0 and propose everything)');
  ok(planGardening({ nodes: [], edges: mk(2, 18) }, { now: T }).threshold === null,
    'threshold: no currentThreshold supplied → no opinion');


  // Structural import edges must NOT count as curation evidence. They are born `confirmed` and no
  // human ever looks at them; counting them reads as a 100% approval rate on an unreviewed graph and
  // walks the bar down. Observed live before this filter existed: 30 repo `part-of` edges dragged the
  // threshold 0.80 → 0.78 on zero human input.
  const imports = Array.from({ length: 30 }, (_, i) => edge('i' + i, 'a', 'f' + i, { type: 'part-of', status: 'confirmed', createdBy: 'import' }));
  ok(planGardening({ nodes: [], edges: imports }, { now: T, currentThreshold: 0.8 }).threshold === null,
    'threshold: IGNORES structural import edges (they are not curation evidence)');
  ok(planGardening({ nodes: [], edges: imports }, { now: T, currentThreshold: 0.8 }).stats.decided === 0,
    'threshold: import edges do not count toward "decided"');
  ok(planGardening({ nodes: [], edges: [...imports, ...mk(2, 18)] }, { now: T, currentThreshold: 0.8 }).threshold.to > 0.8,
    'threshold: still learns from real connector proposals alongside imports');

  ok(planGardening({ nodes: [], edges: mk(2, 18) }, { now: T, currentThreshold: 0.8 }).stats.confirmRate === 0.1,
    'stats: reports the observed confirm rate');
}

// ---- apply() against a REAL brain ----
{
  const b = brainLib.createBrain({ dir: path.join(TMP, 'g1') });
  b.upsertNode({ type: 'memory', ref: 'keep', label: 'keep', text: 'a much longer body of text here', embedding: [1, 0, 0, 0] }, T);
  b.upsertNode({ type: 'memory', ref: 'dupe', label: 'dupe', text: 'tiny', embedding: [0.999, 0.001, 0, 0] }, T);
  b.upsertNode({ type: 'memory', ref: 'far', label: 'far', text: 'different', embedding: [0, 1, 0, 0] }, T);
  const keepId = b.nodes().find((n) => n.ref === 'keep').id;
  const dupeId = b.nodes().find((n) => n.ref === 'dupe').id;
  const farId = b.nodes().find((n) => n.ref === 'far').id;
  b.upsertEdge({ from: dupeId, to: farId, type: 'relates-to', confidence: 0.9, status: 'confirmed' }, T);
  b.upsertEdge({ from: keepId, to: farId, type: 'mentions', confidence: 0.9, status: 'proposed', updatedAt: T - 500 * DAY }, T - 500 * DAY);

  const before = b.stats();
  const r = garden(b, { cosine: brainLib.cosine, now: T, currentThreshold: 0.8 });

  ok(r.applied.merged === 1, 'apply: merged the duplicate node');
  ok(r.applied.rewired >= 1, 'apply: rewired the merged node\'s edges');
  ok(b.getNode(dupeId).status === 'pruned', 'apply: the dropped node is marked pruned');
  ok(b.getNode(keepId).status !== 'pruned', 'apply: the survivor is intact');
  ok((b.getNode(keepId).meta || {}).mergedFrom, 'apply: the survivor records what it absorbed (provenance)');

  // The rewired edge must genuinely exist and connect the survivor.
  const live = b.edges().filter((e) => e.status !== 'pruned');
  ok(live.some((e) => (e.from === keepId && e.to === farId) || (e.from === farId && e.to === keepId)),
    'apply: the merged node\'s connection now belongs to the survivor (not lost)');
  ok(b.stats().nodes === before.nodes - 1, 'apply: exactly one node left the live graph');

  // Re-running must be idempotent — this runs daily, forever.
  const again = garden(b, { cosine: brainLib.cosine, now: T, currentThreshold: 0.8 });
  ok(again.applied.merged === 0, 'apply: a second pass finds nothing left to merge (idempotent)');

  ok(fs.existsSync(path.join(TMP, 'g1', 'graph.json')), 'apply: persists the graph');
}

// ---- a pruned node stays pruned through gardening ----
{
  const b = brainLib.createBrain({ dir: path.join(TMP, 'g2') });
  b.upsertNode({ type: 'memory', ref: 'a', label: 'a', text: 'xxxx', embedding: [1, 0] }, T);
  b.upsertNode({ type: 'memory', ref: 'b', label: 'b', text: 'x', embedding: [1, 0] }, T);
  const bId = b.nodes().find((n) => n.ref === 'b').id;
  b.prune('node', bId);
  const r = garden(b, { cosine: brainLib.cosine, now: T });
  ok(r.applied.merged === 0, 'gardening: a pruned node is not considered for merging');
  ok(b.getNode(bId).status === 'pruned', 'gardening: it stays pruned (rejection is permanent)');
}

// ---- threshold write-back ----
{
  const b = brainLib.createBrain({ dir: path.join(TMP, 'g3') });
  b.upsertNode({ type: 'memory', ref: 'a', label: 'a' }, T);
  for (let i = 0; i < 20; i++) {
    b.upsertNode({ type: 'memory', ref: 'n' + i, label: 'n' + i }, T);
    const nid = b.nodes().find((n) => n.ref === 'n' + i).id;
    const aid = b.nodes().find((n) => n.ref === 'a').id;
    b.upsertEdge({ from: aid, to: nid, type: 'relates-to', status: i < 18 ? 'pruned' : 'confirmed' }, T);
  }
  const r = garden(b, { cosine: brainLib.cosine, now: T, currentThreshold: 0.8 });
  ok(r.applied.thresholdMoved, 'threshold: applied when the evidence supports it');
  ok(Number(b.getMeta('connectThreshold')) > 0.8, 'threshold: persisted to graph meta for the Connector to read');
  ok(typeof b.getMeta('connectThresholdWhy') === 'string', 'threshold: the reason is persisted too');
}

// ---- degenerate inputs never throw ----
{
  ok(planGardening({}, {}).decay.length === 0, 'planGardening: empty input → an empty plan');
  ok(planGardening({ nodes: null, edges: null }, {}).stats.liveNodes === 0, 'planGardening: null input → no throw');
  ok(planGardening({ nodes: [node('a', { embedding: [1, 0] }), node('b', { embedding: [1, 0, 0] })] }, { cosine: brainLib.cosine, now: T }).merge.length === 0,
    'merge: mismatched embedding lengths are skipped, not compared');
  const b = brainLib.createBrain({ dir: path.join(TMP, 'g4') });
  ok(garden(b, { cosine: brainLib.cosine }).applied.merged === 0, 'garden: an empty brain is a clean no-op');
}

// ---- Electron-free ----
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gardener.js'), 'utf8');
  ok(!/require\(['"]electron['"]\)/.test(src), 'lib/gardener.js: never requires electron');
  // Scope to the function BODY — the module header legitimately mentions Date.now() in prose.
  const planBody = src.slice(src.indexOf('function planGardening'), src.indexOf('function apply'));
  ok(!/Date\.now\(\)/.test(planBody), 'planGardening: pure — no ambient clock in the planning half');
  ok(!/require\(/.test(planBody) && !/\bfs\./.test(planBody), 'planGardening: pure — no fs, no I/O');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
