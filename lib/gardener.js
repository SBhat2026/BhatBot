'use strict';
// ── GARDENER — the second brain's upkeep worker (SECOND_BRAIN_PLAN P2 + P4) ───────────────────────
// The Connector only ever ADDS. Left alone, the graph accumulates: stale low-confidence guesses that
// were never right, duplicate nodes from the same thing imported under two refs, and a similarity
// threshold that stays wherever it was hardcoded regardless of whether its proposals are any good.
// The Gardener is the counter-pressure — the thing that makes an always-on worker do genuine WORK on
// each cycle instead of just re-importing the same nodes forever.
//
// Four passes, mirroring lib/memmaint.js's split so this is testable with no store and no clock:
//   DECAY    — a `proposed` edge nobody confirmed loses confidence as it ages; past a floor it is
//              pruned. CONFIRMED edges are never decayed: the user said yes, and that does not expire.
//   MERGE    — two nodes of the same type whose embeddings are near-identical are the same thing
//              imported twice. Keep the richer one, rewire its edges, prune the other. Rewiring is the
//              part that matters — a naive merge orphans edges and quietly shrinks the graph.
//   PROMOTE  — a node with several confirmed edges is load-bearing; raise its importance so it sorts
//              higher in proposals and renders larger.
//   THRESHOLD — a proportional controller over the observed confirm/prune ratio. This is the whole
//              useful surface of "P4 learning": if you are rejecting most proposals the bar is too
//              low, so raise it; if you are accepting nearly all of them we are being too shy. ~15
//              lines, no model, no training data, and it cannot run away (hard clamps).
//
// planGardening() is PURE — no fs, no Date.now(), cosine injected. apply() does the mutating.

const DEFAULTS = {
  halfLifeDays: 30,        // a proposed edge loses half its confidence over this long, unconfirmed
  minConfidence: 0.35,     // decayed below this → pruned
  mergeThreshold: 0.97,    // deliberately stricter than memmaint's 0.95 dedup: merging is destructive
  promoteAtEdges: 3,       // confirmed edges needed before a node is "load-bearing"
  maxImportance: 5,
  thresholdFloor: 0.74,
  thresholdCeil: 0.92,
  thresholdStep: 0.02,
  minCurationsToLearn: 10, // don't move the bar on a handful of clicks
  lowConfirmRate: 0.3,     // rejecting most proposals → the bar is too low
  highConfirmRate: 0.7,    // accepting nearly all → too shy
};

/**
 * planGardening({ nodes, edges }, opts) → a plan. Pure: decides, never mutates.
 * Returns { decay:[{id,from,to,confidence}], prune:[{kind,id,reason}], merge:[{drop,into,rewire}],
 *           promote:[{id,importance}], threshold:{from,to,reason}, stats }
 */
function planGardening({ nodes = [], edges = [] } = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now || 0;
  const cosine = o.cosine;

  // Array.isArray, not the destructuring default: a default only covers `undefined`, and a caller
  // handing us an explicit null (an empty store, a failed read) would otherwise crash the worker.
  const allNodes = Array.isArray(nodes) ? nodes : [];
  const allEdges = Array.isArray(edges) ? edges : [];
  const live = (x) => x && x.status !== 'pruned';
  const liveNodes = allNodes.filter(live);
  const liveEdges = allEdges.filter(live);

  // ── DECAY ───────────────────────────────────────────────────────────────────────────────────────
  // Exponential half-life on UNCONFIRMED edges only. An edge the user confirmed is a fact about their
  // intent, not a guess with a shelf life.
  const decay = [], prune = [];
  for (const e of liveEdges) {
    if (e.status !== 'proposed') continue;
    const ageDays = (now - (e.updatedAt || e.createdAt || now)) / 864e5;
    if (ageDays <= 0) continue;
    const factor = Math.pow(0.5, ageDays / o.halfLifeDays);
    const next = +( (e.confidence != null ? e.confidence : 0.5) * factor ).toFixed(4);
    if (next < o.minConfidence) prune.push({ kind: 'edge', id: e.id, reason: `decayed to ${next.toFixed(2)} after ${Math.round(ageDays)}d unconfirmed` });
    else if (next < (e.confidence || 0)) decay.push({ id: e.id, from: e.from, to: e.to, confidence: next });
  }
  const pruningEdges = new Set(prune.map((p) => p.id));

  // ── MERGE ───────────────────────────────────────────────────────────────────────────────────────
  // Same type + near-identical embedding = the same thing imported twice (e.g. a repo indexed under
  // two refs, or a memory saved twice with different wording). Keep the one with more substance;
  // REWIRE its edges before pruning the loser, or the merge silently deletes real connections.
  const merge = [];
  if (typeof cosine === 'function') {
    const merged = new Set();
    const withVec = liveNodes.filter((n) => Array.isArray(n.embedding) && n.embedding.length);
    for (let i = 0; i < withVec.length; i++) {
      const a = withVec[i];
      if (merged.has(a.id)) continue;
      for (let j = i + 1; j < withVec.length; j++) {
        const b = withVec[j];
        if (merged.has(b.id) || a.type !== b.type || a.embedding.length !== b.embedding.length) continue;
        if (cosine(a.embedding, b.embedding) < o.mergeThreshold) continue;
        // Keep the richer node — more text, then more recently updated. An arbitrary pick would
        // discard the better label half the time.
        const score = (n) => [String(n.text || '').length, n.updatedAt || 0];
        const [sa, sb] = [score(a), score(b)];
        const keep = (sa[0] !== sb[0] ? sa[0] > sb[0] : sa[1] >= sb[1]) ? a : b;
        const drop = keep === a ? b : a;
        const rewire = liveEdges
          .filter((e) => !pruningEdges.has(e.id) && (e.from === drop.id || e.to === drop.id))
          .map((e) => ({
            id: e.id, type: e.type,
            from: e.from === drop.id ? keep.id : e.from,
            to: e.to === drop.id ? keep.id : e.to,
            confidence: e.confidence, rationale: e.rationale, status: e.status,
          }))
          .filter((e) => e.from !== e.to);   // an edge that becomes a self-loop is just dropped
        merge.push({ drop: drop.id, into: keep.id, rewire });
        merged.add(drop.id);
        if (drop === a) break;               // a is gone → stop pairing from it
      }
    }
  }
  const mergedAway = new Set(merge.map((m) => m.drop));

  // ── PROMOTE ─────────────────────────────────────────────────────────────────────────────────────
  const confirmedDegree = new Map();
  for (const e of liveEdges) {
    if (e.status !== 'confirmed') continue;
    for (const side of [e.from, e.to]) confirmedDegree.set(side, (confirmedDegree.get(side) || 0) + 1);
  }
  const promote = [];
  for (const n of liveNodes) {
    if (mergedAway.has(n.id)) continue;
    const deg = confirmedDegree.get(n.id) || 0;
    if (deg < o.promoteAtEdges) continue;
    const want = Math.min(o.maxImportance, 1 + Math.floor(deg / o.promoteAtEdges));
    if (want > (n.importance || 1)) promote.push({ id: n.id, importance: want, confirmedEdges: deg });
  }

  // ── THRESHOLD (P4 "learning") ───────────────────────────────────────────────────────────────────
  // Judge the Connector by what the user did with THE CONNECTOR'S OWN output.
  //
  // Two filters, both load-bearing:
  //   • createdBy === 'connector' — structural `part-of` edges from the repo/Notion importers are
  //     born `confirmed` and are never curated by anyone. Counting them reads as a 100% approval
  //     rate on a graph nobody has reviewed, and quietly walks the bar down. (Observed live: 30
  //     import edges dragged the threshold 0.80 → 0.78 on zero human input.)
  //   • decided only — an untouched proposal is not evidence either way.
  let threshold = null;
  const judged = allEdges.filter((e) => (e.createdBy || 'connector') === 'connector');
  const confirmedCount = judged.filter((e) => e.status === 'confirmed').length;
  const prunedCount = judged.filter((e) => e.status === 'pruned').length;
  const decided = confirmedCount + prunedCount;
  if (o.currentThreshold != null && decided >= o.minCurationsToLearn) {
    const rate = confirmedCount / decided;
    const cur = Number(o.currentThreshold);
    if (rate < o.lowConfirmRate && cur < o.thresholdCeil) {
      threshold = { from: cur, to: +Math.min(o.thresholdCeil, cur + o.thresholdStep).toFixed(3), reason: `only ${Math.round(rate * 100)}% of decided links kept — raising the bar` };
    } else if (rate > o.highConfirmRate && cur > o.thresholdFloor) {
      threshold = { from: cur, to: +Math.max(o.thresholdFloor, cur - o.thresholdStep).toFixed(3), reason: `${Math.round(rate * 100)}% of decided links kept — we can afford to look wider` };
    }
  }

  return {
    decay, prune, merge, promote, threshold,
    stats: { liveNodes: liveNodes.length, liveEdges: liveEdges.length, decided, confirmRate: decided ? +(confirmedCount / decided).toFixed(3) : null },
  };
}

/**
 * apply(brain, plan) → what actually changed. Order matters: rewire BEFORE pruning the merged node,
 * or upsertEdge rejects the new edge because one endpoint is already gone.
 */
function apply(brain, plan) {
  const out = { decayed: 0, pruned: 0, merged: 0, rewired: 0, promoted: 0, thresholdMoved: null };
  const now = Date.now();

  for (const d of plan.decay || []) {
    const e = brain.edges().find((x) => x.id === d.id);
    if (e) { e.confidence = d.confidence; e.updatedAt = now; out.decayed++; }
  }
  for (const p of plan.prune || []) { if (brain.prune(p.kind, p.id)) out.pruned++; }

  for (const m of plan.merge || []) {
    for (const e of m.rewire) {
      // _revive because the rewired edge may collide with a previously-pruned id; this is a merge, not
      // a re-proposal of something the user rejected.
      if (brain.upsertEdge({ ...e, id: undefined, _revive: true }, now)) out.rewired++;
    }
    const keep = brain.getNode(m.into), drop = brain.getNode(m.drop);
    if (keep && drop) {
      // Preserve provenance: the surviving node records what it absorbed.
      brain.upsertNode({ id: keep.id, type: keep.type, ref: keep.ref, meta: { ...keep.meta, mergedFrom: [...((keep.meta || {}).mergedFrom || []), drop.ref || drop.id] } }, now);
    }
    if (brain.prune('node', m.drop)) out.merged++;
  }

  for (const p of plan.promote || []) {
    const n = brain.getNode(p.id);
    if (n) { brain.upsertNode({ id: n.id, type: n.type, ref: n.ref, importance: p.importance }, now); out.promoted++; }
  }

  if (plan.threshold) {
    brain.setMeta('connectThreshold', plan.threshold.to);
    brain.setMeta('connectThresholdWhy', plan.threshold.reason);
    out.thresholdMoved = plan.threshold;
  }

  const touched = out.decayed || out.pruned || out.merged || out.promoted || out.thresholdMoved;
  if (touched) brain.save();
  return out;
}

/** Convenience: plan + apply against a live brain. `cosine` comes from lib/brain.js. */
function garden(brain, opts = {}) {
  const plan = planGardening({ nodes: brain.nodes(), edges: brain.edges() }, { now: Date.now(), ...opts });
  return { plan, applied: apply(brain, plan) };
}

module.exports = { planGardening, apply, garden, DEFAULTS };
