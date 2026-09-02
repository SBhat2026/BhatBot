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

  // ── AUTO-CURATION ─────────────────────────────────────────────────────────────────────────────
  // Measured live: 2,293 proposed edges against 58 confirmed. The inbox shows the top 30. Nobody is
  // ever going to review two thousand suggestions by hand, so "waiting for the user to decide" is
  // not a policy — it is a queue that grows forever and buries the good links in the bad.
  //
  // Two decisions the graph can make for itself, on evidence it already has:
  autoCurate: true,
  // CONFIRM: an edge carrying a model-written rationale has been checked by something that was
  // willing to say "NONE" and didn't (see explainEdges — a NONE verdict prunes the edge outright).
  // That is a genuine second opinion, not a restatement of the cosine score.
  autoConfirmMinConfidence: 0.88,
  autoConfirmGraceDays: 2,      // leave it in the inbox long enough to be seen first
  // ...but a VERY high similarity between two nodes of the SAME TYPE is not an insight, it is the
  // same thing stored twice. Observed on the live graph: the strongest auto-confirm candidates were
  // all pairs like "User: who's winning group A?" ↔ "User: who's winning group A?" — duplicate
  // memories at 0.94-0.95. Promoting those to confirmed links dresses up a storage problem as
  // knowledge. They belong to MERGE (or to decay), so auto-confirm declines them.
  autoConfirmDuplicateCeiling: 0.93,
  // PRUNE: keep the proposed backlog to a reviewable size. An un-rationalized proposal ranked
  // 400th by confidence has had no scrutiny and will never get any; it is weight, not information.
  maxProposedBacklog: 300,
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

  // ── AUTO-CURATION ───────────────────────────────────────────────────────────────────────────────
  // Decide what the user is never going to get to, on evidence already in hand. Runs after DECAY so
  // an edge already on its way out is not confirmed on its last day alive.
  const autoConfirm = [];
  let nearDuplicates = 0;
  const normLabel = (l) => String(l || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Two nodes of the same type whose labels agree for their first ~40 characters are the same thing
  // said twice. Full-string equality was too strict to be useful: the live duplicates were memories
  // of the SAME repeated question captured at different moments ("...winning group A? Assistant:
  // Mexico. Two wins..." vs "...winning group A? Assistant: Mexico are miles clear..."), which share
  // an opening but diverge. A link between those is not knowledge, it is the memory store echoing.
  const DUP_PREFIX = 40;
  const sameThing = (a, b) => {
    const [x, y] = [normLabel(a), normLabel(b)];
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.length < DUP_PREFIX || y.length < DUP_PREFIX) return false;
    return x.slice(0, DUP_PREFIX) === y.slice(0, DUP_PREFIX);
  };
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  if (o.autoCurate) {
    const decaying = new Set(prune.map((p) => p.id));
    const survivors = liveEdges.filter((e) => e.status === 'proposed' && !decaying.has(e.id) && !mergedAway.has(e.from) && !mergedAway.has(e.to));

    // ⚠ LOAD-BEARING — judge on the ORIGINAL similarity, not on `confidence`. DECAY rewrites it in place, so
    // by the time an edge is old enough to be worth auto-deciding, its confidence reflects HOW LONG
    // IT HAS BEEN IGNORED rather than how similar the two things are. Live, every rationalized edge
    // had decayed to ≤0.70 — a 0.88 bar against that matched nothing at all, while the un-decayed
    // scores actually ran 0.80–0.999. `provenance.score` is what the Connector measured and is never
    // rewritten; confidence is only the fallback for edges predating it.
    const similarityOf = (e) => (e.provenance && Number(e.provenance.score)) || e.confidence || 0;
    for (const e of survivors) {
      const ageDays = (now - (e.createdAt || now)) / 864e5;
      const vetted = typeof e.rationale === 'string' && e.rationale.trim().length > 12;
      const sim = similarityOf(e);
      if (!vetted || sim < o.autoConfirmMinConfidence || ageDays < o.autoConfirmGraceDays) continue;
      const A = nodeById.get(e.from), B = nodeById.get(e.to);
      // Same TYPE and effectively the same LABEL = one thing stored twice. A similarity ceiling alone
      // was not enough: the duplicates ran all the way down to 0.88, and the model's own rationale for
      // them opens "Both memories are duplicate records of...". Comparing labels catches them where a
      // score cannot, because it asks the question directly.
      if (A && B && A.type === B.type && (sim >= o.autoConfirmDuplicateCeiling || sameThing(A.label, B.label))) { nearDuplicates++; continue; }
      autoConfirm.push({ id: e.id, reason: `explained, ${Math.round(sim * 100)}% similar, unreviewed for ${Math.round(ageDays)}d` });
    }
    // Everything still merely proposed after that, ranked by confidence; anything past the horizon
    // goes. Rationalized edges are exempt — they cost a model call and carry a real explanation, so
    // they stay in the inbox on their merits rather than being culled by rank.
    const confirmedIds = new Set(autoConfirm.map((c) => c.id));
    const cullable = survivors
      .filter((e) => !confirmedIds.has(e.id) && !(typeof e.rationale === 'string' && e.rationale.trim()))
      .sort((a, b) => similarityOf(b) - similarityOf(a));
    for (const e of cullable.slice(o.maxProposedBacklog)) {
      prune.push({ kind: 'edge', id: e.id, auto: true, reason: `beyond the ${o.maxProposedBacklog}-link review horizon at ${Math.round(similarityOf(e) * 100)}% similarity` });
    }
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
  //   • ⚠ LOAD-BEARING — and NOT curated by us. Auto-confirmed and horizon-pruned edges are the Gardener's own
  //     output; counting them is the machine grading its own homework, and it moves the bar on zero
  //     human input. Exactly the failure the `createdBy` filter above already exists to prevent —
  //     30 import edges once dragged the threshold 0.80 → 0.78 with nobody having clicked anything.
  let threshold = null;
  const judged = allEdges.filter((e) => (e.createdBy || 'connector') === 'connector' && e.curatedBy !== 'auto');
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
    decay, prune, merge, promote, threshold, autoConfirm,
    stats: { liveNodes: liveNodes.length, liveEdges: liveEdges.length, decided, confirmRate: decided ? +(confirmedCount / decided).toFixed(3) : null,
      autoConfirmed: autoConfirm.length, autoPruned: prune.filter((p) => p.auto).length, nearDuplicates },
  };
}

/**
 * apply(brain, plan) → what actually changed. Order matters: rewire BEFORE pruning the merged node,
 * or upsertEdge rejects the new edge because one endpoint is already gone.
 */
function apply(brain, plan) {
  const out = { decayed: 0, pruned: 0, merged: 0, rewired: 0, promoted: 0, autoConfirmed: 0, autoPruned: 0, thresholdMoved: null };
  const now = Date.now();

  for (const d of plan.decay || []) {
    const e = brain.edges().find((x) => x.id === d.id);
    if (e) { e.confidence = d.confidence; e.updatedAt = now; out.decayed++; }
  }
  for (const p of plan.prune || []) {
    // Stamp auto-decisions BEFORE pruning, so the threshold controller can exclude them next cycle
    // and so the reason survives for anyone asking why a link disappeared.
    if (p.auto && p.kind === 'edge') {
      const e = brain.edges().find((x) => x.id === p.id);
      if (e) { e.curatedBy = 'auto'; e.curatedReason = p.reason; }
    }
    if (brain.prune(p.kind, p.id)) { out.pruned++; if (p.auto) out.autoPruned++; }
  }

  for (const c of plan.autoConfirm || []) {
    const e = brain.edges().find((x) => x.id === c.id);
    if (!e) continue;
    if (brain.confirm('edge', c.id)) { e.curatedBy = 'auto'; e.curatedReason = c.reason; e.updatedAt = now; out.autoConfirmed++; }
  }

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

  const touched = out.decayed || out.pruned || out.merged || out.promoted || out.autoConfirmed || out.thresholdMoved;
  if (touched) brain.save();
  return out;
}

/** Convenience: plan + apply against a live brain. `cosine` comes from lib/brain.js. */
function garden(brain, opts = {}) {
  const plan = planGardening({ nodes: brain.nodes(), edges: brain.edges() }, { now: Date.now(), ...opts });
  return { plan, applied: apply(brain, plan) };
}

module.exports = { planGardening, apply, garden, DEFAULTS };
