'use strict';
// LEARNED ROUTER — a text→tier classifier that learns to replace the brittle regex routing
// (chooseModel / looksComplexTool / looksHeavyTool in main.js). Same discipline as spokenmodel.js /
// depthmodel.js: pure JS, closed-form ridge (no deps), graceful fallback to null when cold or low-fit
// so main.js keeps the regex until the learned model earns trust.
//
// WHY it must learn FORWARD: router.jsonl historically logged only the DECISION (taskType/model), not
// the input text — no features to train on. So this module logs its own feature rows going forward and
// runs in SHADOW MODE (predict + log the suggestion; regex still decides) until cfg.routerLearned flips
// it live. The label is the tier that turned out RIGHT for the turn:
//   • regex picked simple/reasoning and the turn finished clean       → that tier was right
//   • the turn mid-escalated (complex-tool-upgrade / heavy-*-upgrade)  → regex UNDER-routed; true=escalated tier
//   • the user corrected / immediately re-asked                        → under-routed; bump one tier up
//
// One-vs-rest ridge over 3 tiers (simple/reasoning/heavy) + a separate fleet head; argmax = tier.
// Artifact ~/.bhatbot/router-model.json (gitignored); dataset ~/.bhatbot/router-train.jsonl.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL_PATH = path.join(os.homedir(), '.bhatbot', 'router-model.json');
const DATASET = path.join(os.homedir(), '.bhatbot', 'router-train.jsonl');
const TIERS = ['simple', 'reasoning', 'heavy'];
const MIN_ROWS = 60;            // learned router needs fewer rows than the length models (coarse 3-way label)
const RETRAIN_EVERY = 40;
const MIN_ACC = 0.55;           // below this held-out-ish accuracy → stay shadow, keep regex
const LAMBDA = 3.0;             // strong shrinkage: small n, keep it from overfitting early rows

// ---- features (order fixed + persisted) ----------------------------------
const FEATURES = ['wc', 'tool_verbs', 'sci_domain', 'multistep', 'code', 'data_analysis',
  'is_question', 'heavy_terms', 'app_terms', 'entities', 'imperative', 'conjunctions', 'build_thing'];

const RE = {
  toolVerb: /\b(build|create|make|run|open|play|search|find|write|send|schedule|deploy|generate|design|render|install|configure|automate|fetch|download|book|order|fill|read|add|check|reply|update|move|remove|list|show|get|draft|label)\b/g,
  sci: /\b(dna|rna|genom\w*|protein|molecul\w*|enzyme|cell(?:ular)?|biolog\w*|replication|transcription|physics|quantum|orbital|fluid|aerodynam\w*|thermodynam\w*|climate|epidemi\w*|kinetics|reaction)\b/g,
  multistep: /\b(then|after that|and then|next|finally|first|second|step ?\d|step.?by.?step|multi.?step)\b/g,
  code: /\b(script|code|python|javascript|function|refactor|debug|api|regex|compile|repo|commit|pipeline)\b/g,
  dataAnalysis: /\b(analy[sz]e|analysis|compare|forecast|predict|backtest|optimi[sz]e|plot|chart|graph|dashboard|benchmark|dataset|statistics?|correlat)\b/g,
  heavy: /\b(engine|solver|from scratch|end.?to.?end|n-?body|monte.?carlo|\bode\b|\bpde\b|\bcfd\b|\bfem\b|finite element|molecular dynamics|simulat\w*|high.?fidelity|rigorous|comprehensive)\b/g,
  app: /\b(email|e-mail|gmail|calendar|drive|browser|website|web ?page|login|sign ?in|notion|spotify|telegram|text|message|call)\b/g,
  thing: /\b(suit|device|machine|robot|drone|vehicle|car|plane|rocket|game|3d|scene|world|environment|creature|character|app|system|framework|model)\b/g,
  conj: /\b(and|plus|also|as well|along with)\b/g,
};
const count = (t, re) => { re.lastIndex = 0; return (t.match(re) || []).length; };

// Pure feature extraction from the user's message. No I/O — testable.
function extractFeatures(text) {
  const t = String(text || '').toLowerCase();
  const words = t.match(/[a-z0-9']+/g) || [];
  const entities = (String(text || '').match(/\b[A-Z][a-zA-Z]{2,}\b/g) || []).length;
  const firstWord = words[0] || '';
  const isQuestion = /^(what|when|where|who|which|is|are|does|did|do|can|could|would|should|how|why)\b/.test(t) || /\?\s*$/.test(t);
  const imperative = RE.toolVerb.test(firstWord) ? 1 : 0; RE.toolVerb.lastIndex = 0;
  return {
    wc: words.length,
    tool_verbs: count(t, RE.toolVerb),
    sci_domain: count(t, RE.sci),
    multistep: count(t, RE.multistep),
    code: count(t, RE.code),
    data_analysis: count(t, RE.dataAnalysis),
    is_question: isQuestion ? 1 : 0,
    heavy_terms: count(t, RE.heavy),
    app_terms: count(t, RE.app),
    entities,
    imperative,
    conjunctions: count(t, RE.conj),
    build_thing: count(t, RE.thing),
  };
}

function featurize(f) {
  f = f || {};
  return [
    Math.min(f.wc || 0, 120) / 20,
    Math.min(f.tool_verbs || 0, 8),
    Math.min(f.sci_domain || 0, 8),
    Math.min(f.multistep || 0, 6),
    Math.min(f.code || 0, 8),
    Math.min(f.data_analysis || 0, 8),
    f.is_question ? 1 : 0,
    Math.min(f.heavy_terms || 0, 8),
    Math.min(f.app_terms || 0, 6),
    Math.min(f.entities || 0, 12) / 3,
    f.imperative ? 1 : 0,
    Math.min(f.conjunctions || 0, 6),
    Math.min(f.build_thing || 0, 6),
  ];
}

// WARM-START PRIORS — a handful of synthetic anchors so the model is well-conditioned and its early
// predictions are sane before real rows accumulate. Blended in at low weight; real data dominates as
// it grows. Each anchor is a (features, tier) exemplar of an obvious routing case.
const PRIORS = [
  [{ wc: 4, is_question: 1 }, 'simple'],                                              // "what time is it"
  [{ wc: 3, tool_verbs: 1, app_terms: 1, imperative: 1 }, 'simple'],                  // "open spotify"
  [{ wc: 6, app_terms: 1, is_question: 1 }, 'simple'],                                // "any new emails?"
  [{ wc: 14, tool_verbs: 1, code: 1, imperative: 1 }, 'reasoning'],                   // "write a script that…"
  [{ wc: 16, data_analysis: 2, multistep: 1 }, 'reasoning'],                          // "analyze this and compare…"
  [{ wc: 18, tool_verbs: 2, app_terms: 2, multistep: 2, imperative: 1 }, 'reasoning'],// "read my email then add to calendar"
  [{ wc: 12, code: 2, tool_verbs: 1 }, 'reasoning'],                                  // "refactor + debug this"
  [{ wc: 20, sci_domain: 2, heavy_terms: 2, build_thing: 1, imperative: 1 }, 'heavy'],// "simulate DNA replication"
  [{ wc: 22, heavy_terms: 3, build_thing: 2 }, 'heavy'],                              // "build an N-body engine from scratch"
  [{ wc: 24, sci_domain: 1, heavy_terms: 2, data_analysis: 1, build_thing: 1 }, 'heavy'],
];
function priorRows() {
  return PRIORS.map(([f, tier]) => ({ f: extractFeaturesMerge(f), tier, _prior: true }));
}
// Priors specify only the nonzero features; fill the rest with 0 through featurize's defaults.
function extractFeaturesMerge(partial) { const base = {}; for (const k of FEATURES) base[k] = 0; return { ...base, ...partial }; }

// ---- ridge (shared shape with spokenmodel) --------------------------------
function solveRidge(X, y, lambda) {
  const n = X.length, d = X[0].length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) { b[j] += X[i][j] * y[i]; for (let k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k]; }
  for (let j = 0; j < d; j++) A[j][j] += lambda;
  return gaussianSolve(A, b);
}
function gaussianSolve(A, b) {
  const d = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-9) continue;
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col];
    for (let k = col; k <= d; k++) M[col][k] /= pv;
    for (let r = 0; r < d; r++) if (r !== col) { const f = M[r][col]; for (let k = col; k <= d; k++) M[r][k] -= f * M[col][k]; }
  }
  return M.map((r) => r[d]);
}

// The tier that turned out RIGHT for a logged turn (see header). Corrected rows bump one tier up.
function effectiveTier(r) {
  let idx = TIERS.indexOf(r.tier);
  if (idx < 0) idx = 0;
  if (r.corrected) idx = Math.min(TIERS.length - 1, idx + 1);
  return TIERS[idx];
}

// ---- training ------------------------------------------------------------
function train(rows) {
  const real = rows.filter((r) => (r.f || r.features) && r.tier);
  if (real.length < MIN_ROWS) return { ok: false, reason: `only ${real.length} real rows (<${MIN_ROWS})`, n: real.length };
  const all = [...priorRows(), ...real];
  const X = all.map((r) => [...featurize(r.f || r.features), 1]);
  const labels = all.map((r) => effectiveTier(r));
  // one-vs-rest ridge: one weight vector per tier, argmax of scores = predicted tier
  const W = {};
  for (const tier of TIERS) {
    const y = labels.map((l) => (l === tier ? 1 : 0));
    W[tier] = solveRidge(X, y, LAMBDA);
  }
  // in-sample accuracy on the REAL rows only (priors would inflate it)
  let correct = 0;
  for (let i = priorRows().length; i < all.length; i++) {
    const pred = argmaxTier(X[i], W);
    if (pred === labels[i]) correct++;
  }
  const acc = real.length ? correct / real.length : 0;
  return { ok: true, W, acc, n: real.length, features: FEATURES, tiers: TIERS, trainedAt: Date.now() };
}

function argmaxTier(xWith1, W) {
  let best = TIERS[0], bestScore = -Infinity;
  for (const tier of TIERS) {
    const w = W[tier];
    const s = xWith1.reduce((acc, xj, j) => acc + xj * (w[j] || 0), 0);
    if (s > bestScore) { bestScore = s; best = tier; }
  }
  return best;
}

function trainFromLog({ logPath } = {}) {
  const rows = readRows(logPath);
  const m = train(rows); m.rowsSeen = rows.length;
  if (m.ok) { try { fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true }); fs.writeFileSync(MODEL_PATH, JSON.stringify(m)); } catch {} }
  _cache = m.ok ? m : null; _cacheAt = Date.now();
  return m;
}
function readRows(logPath) {
  try { return fs.readFileSync(logPath || DATASET, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
// Append one feature+outcome row (called by main.js each turn). Bounded by log-rotation elsewhere.
function logRow(row) {
  try { fs.mkdirSync(path.dirname(DATASET), { recursive: true }); fs.appendFileSync(DATASET, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n'); } catch {}
}

// ---- inference (hot path) ------------------------------------------------
let _cache = undefined, _cacheAt = 0;
function loadModel() {
  if (_cache !== undefined && Date.now() - _cacheAt < 60000) return _cache;
  try { const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')); _cache = m.ok ? m : null; } catch { _cache = null; }
  _cacheAt = Date.now();
  return _cache;
}

// predict(text) → { tier, scores, confidence, source:'learned' } or null (→ regex fallback).
function predict(text) {
  const m = loadModel();
  if (!m || !m.ok || m.n < MIN_ROWS || m.acc < MIN_ACC) return null;
  const x = [...featurize(extractFeatures(text)), 1];
  const scores = {};
  for (const tier of TIERS) scores[tier] = +x.reduce((acc, xj, j) => acc + xj * (m.W[tier][j] || 0), 0).toFixed(3);
  const tier = TIERS.reduce((a, b) => (scores[b] > scores[a] ? b : a), TIERS[0]);
  // confidence: margin between top-2 scores, squashed, scaled by fit + data volume
  const sorted = Object.values(scores).sort((a, b) => b - a);
  const margin = Math.max(0, sorted[0] - (sorted[1] ?? 0));
  const confidence = +Math.min(1, margin * (m.acc || 0) * Math.min(1, m.n / 200)).toFixed(3);
  return { tier, scores, confidence, source: 'learned' };
}

function maybeRetrain({ logPath } = {}) {
  const m = loadModel();
  const lines = readRows(logPath).length;
  const seen = (m && m.rowsSeen) || 0;
  if (lines >= MIN_ROWS && (!m || lines - seen >= RETRAIN_EVERY)) return trainFromLog({ logPath });
  return null;
}

// Shadow-mode agreement metric: how often the learned tier matches the tier actually used. The number
// that says whether the learned router is ready to go live (high agreement + high acc → flip it on).
function shadowReport(rows) {
  const withShadow = (rows || []).filter((r) => r.shadowTier && r.tier);
  if (!withShadow.length) return { n: 0, agreement: null };
  const agree = withShadow.filter((r) => r.shadowTier === effectiveTier(r)).length;
  return { n: withShadow.length, agreement: +(agree / withShadow.length).toFixed(3) };
}

module.exports = { extractFeatures, featurize, train, trainFromLog, predict, loadModel, logRow, readRows,
  maybeRetrain, effectiveTier, argmaxTier, shadowReport, FEATURES, TIERS, MODEL_PATH, DATASET, MIN_ROWS, MIN_ACC };
