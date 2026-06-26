'use strict';
// Learned depth model (Phase 3, Deliverable #1). Replaces the p90+30% ceiling HEURISTIC (main.js
// depthCal) as the PRIMARY path for sizing per-turn max_tokens; the heuristic stays as the silent
// fallback. Trains on ~/.bhatbot/depth.jsonl — the honest record of what each turn actually needed.
//
// Model: ridge linear regression (closed-form, pure JS — no deps, no API) predicting OUTPUT TOKENS
// from cheap per-turn features, plus a residual-quantile margin so the ceiling targets ~p90 of need
// (same intent as the heuristic, but learned per feature-pattern instead of per-tier average).
//   ceiling = predicted_mean + Z90 * residualStd   (Z90 ≈ 1.2816)
//
// Hard requirements honored:
//   • runs locally, no network                 (matrix math below)
//   • < 50 ms in the hot path                   (load is cached; predict is a ~10-dim dot product)
//   • falls back when < MIN_ROWS records OR low confidence  → predict() returns null, caller keeps heuristic
//   • artifact in ~/.bhatbot/, NOT committed    (depth-model.json; see .gitignore)

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL_PATH = path.join(os.homedir(), '.bhatbot', 'depth-model.json');
const MIN_ROWS = 200;            // below this → not enough signal, stay on the heuristic
const RETRAIN_EVERY = 500;       // auto-retrain after this many NEW rows since last train
const MIN_R2 = 0.10;             // below this fit → low confidence, fall back
const Z90 = 1.2816;              // standard-normal 90th percentile → ceiling targets p90 of need
const TIERS = ['ack', 'conversational', 'detailed', 'deep'];

// ---- feature engineering -------------------------------------------------
// A row may be a rich Phase-3 record or a legacy {depth,alloc,out,clipped} row. Featurize tolerates
// missing fields (defaults 0). Order is fixed and persisted in the artifact for safety.
const FEATURES = [
  'qlen',        // query length in tokens (~chars/4)
  'f_ack', 'f_detail', 'f_deep',   // intent regex hits (binary)
  'position',    // conversation position (user-turn index), capped
  'priorOut',    // rolling mean of prior output tokens (scaled)
  't_ack', 't_conv', 't_detail', 't_deep',   // tier one-hot
  'correction',  // correction signal from reflectOnCorrection (binary)
];

function featurize(row) {
  const tier = row.depth || row.tier || 'conversational';
  return [
    Math.min((row.qlen != null ? row.qlen : 0), 4000) / 100,
    row.f_ack ? 1 : 0, row.f_detail ? 1 : 0, row.f_deep ? 1 : 0,
    Math.min(row.position || 0, 60),
    Math.min(row.priorOut || 0, 8192) / 100,
    tier === 'ack' ? 1 : 0, tier === 'conversational' ? 1 : 0,
    tier === 'detailed' ? 1 : 0, tier === 'deep' ? 1 : 0,
    row.correction ? 1 : 0,
  ];
}

// ---- linear algebra (tiny; dim ~= 12) ------------------------------------
function solveRidge(X, y, lambda) {
  const n = X.length, d = X[0].length;
  // A = XᵀX + λI  (d×d) ; b = Xᵀy  (d)
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 0; j < d; j++) A[j][j] += lambda;
  return gaussianSolve(A, b);
}
function gaussianSolve(A, b) {
  const d = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-9) continue;            // singular column → leave weight ~0
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col];
    for (let k = col; k <= d; k++) M[col][k] /= pv;
    for (let r = 0; r < d; r++) if (r !== col) { const f = M[r][col]; for (let k = col; k <= d; k++) M[r][k] -= f * M[col][k]; }
  }
  return M.map((r) => r[d]);
}

// ---- training ------------------------------------------------------------
// Bias is folded in as a constant feature appended to each row.
function train(rows) {
  const usable = rows.filter((r) => (r.out || 0) > 0);
  if (usable.length < MIN_ROWS) return { ok: false, reason: `only ${usable.length} usable rows (<${MIN_ROWS})`, n: usable.length };
  const X = usable.map((r) => [...featurize(r), 1]);       // + bias
  const y = usable.map((r) => r.out);
  const w = solveRidge(X, y, 1.0);
  // residuals + fit quality
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < y.length; i++) {
    const pred = X[i].reduce((s, xj, j) => s + xj * w[j], 0);
    ssRes += (y[i] - pred) ** 2; ssTot += (y[i] - meanY) ** 2;
  }
  const residStd = Math.sqrt(ssRes / Math.max(1, y.length - 1));
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { ok: true, w, residStd, r2, n: usable.length, features: FEATURES, trainedAt: Date.now() };
}

function trainFromLog({ logPath, force = false } = {}) {
  let rows = [];
  try { rows = fs.readFileSync(logPath || DEFAULT_LOG(), 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const m = train(rows);
  m.rowsSeen = rows.length;
  if (m.ok) { try { fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true }); fs.writeFileSync(MODEL_PATH, JSON.stringify(m)); } catch {} }
  _cache = m.ok ? m : null; _cacheAt = Date.now();
  return m;
}
function DEFAULT_LOG() { return path.join(os.homedir(), '.bhatbot', 'depth.jsonl'); }

// ---- inference (hot path) ------------------------------------------------
let _cache = undefined, _cacheAt = 0;
function loadModel() {
  if (_cache !== undefined && Date.now() - _cacheAt < 60000) return _cache;
  try { const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')); _cache = m.ok ? m : null; }
  catch { _cache = null; }
  _cacheAt = Date.now();
  return _cache;
}

// predict(featObj) → { maxTokens, confidence } when the model is trustworthy, else null (→ heuristic).
// featObj: { qlen, f_ack, f_detail, f_deep, position, priorOut, depth|tier, correction }
function predict(featObj) {
  const m = loadModel();
  if (!m || !m.ok || m.n < MIN_ROWS || m.r2 < MIN_R2) return null;
  const x = [...featurize(featObj || {}), 1];
  const mean = x.reduce((s, xj, j) => s + xj * (m.w[j] || 0), 0);
  if (!isFinite(mean) || mean <= 0) return null;
  const ceil = mean + Z90 * (m.residStd || 0);
  const maxTokens = Math.max(256, Math.min(Math.ceil(ceil / 128) * 128, 8192));
  // confidence blends fit quality and sample size into 0..1
  const confidence = Math.max(0, Math.min(1, m.r2)) * Math.min(1, m.n / 1000);
  return { maxTokens, confidence };
}

// Auto-retrain trigger: call after appending a row. Retrains when the log has grown by
// RETRAIN_EVERY since the artifact's last train. Cheap check (artifact carries rowsSeen).
function maybeRetrain({ logPath } = {}) {
  const m = loadModel();
  let lines = 0;
  try { lines = fs.readFileSync(logPath || DEFAULT_LOG(), 'utf8').trim().split('\n').length; } catch {}
  const seen = (m && m.rowsSeen) || 0;
  if (lines >= MIN_ROWS && (!m || lines - seen >= RETRAIN_EVERY)) {
    return trainFromLog({ logPath });
  }
  return null;
}

module.exports = { train, trainFromLog, predict, loadModel, featurize, maybeRetrain, FEATURES, MODEL_PATH, MIN_ROWS, RETRAIN_EVERY };
