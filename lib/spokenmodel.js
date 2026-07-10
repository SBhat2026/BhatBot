'use strict';
// T5 — LEARNED SPOKEN-LENGTH model. depthmodel.js learns the ON-SCREEN reply size; this learns how
// long the SPOKEN summary should be — a density-conditioned compression of the written answer, trained
// on implicit feedback. The metric is spoken WORD count; the right length is a per-turn ratio that
// depends on how information-dense the answer is (a 5-number verdict compresses differently than a
// list of names), learned from three outcome labels the app already produces:
//   • interrupted@N — barge-in → RIGHT-CENSORED (true target ≤ N words); train on min(target,N) and
//     never predict above the running p75 of interrupt positions.
//   • under         — the next turn asked for more ("why/expand/more detail") → target was too LOW;
//     bias the effective target up.
//   • clean         — no barge-in, next turn is a new topic → the delivered length was RIGHT (positive).
//
// Same discipline as depthmodel: ridge regression (closed-form, pure JS, no deps, <50ms), residual-p90
// margin, falls back to null below MIN_ROWS / low fit so the caller keeps the 1–3 sentence heuristic.
// Artifact ~/.bhatbot/spoken-model.json (gitignored); dataset ~/.bhatbot/spoken.jsonl.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL_PATH = path.join(os.homedir(), '.bhatbot', 'spoken-model.json');
const DATASET = path.join(os.homedir(), '.bhatbot', 'spoken.jsonl');
// WARM-START: was 200 (dead until then — the loop never activated at organic rates). Lowered to 40 and
// backed by synthetic PRIOR anchors + size-adaptive shrinkage, so the model is well-conditioned and
// gives sane length predictions from the first few dozen real rows. Real data dominates as it grows.
const MIN_ROWS = 40;
const RETRAIN_EVERY = 80;
const MIN_R2 = 0.03;
const Z90 = 1.2816;
const WORD_MIN = 6, WORD_MAX = 90;      // spoken summary bounds (words)
const UNDER_BOOST = 1.5;                // an "under" row's true target was higher than delivered

// ---- features (order fixed + persisted) ----------------------------------
const FEATURES = ['screen_tokens', 'n_numbers', 'n_entities', 'n_code', 'n_list', 'n_urls', 'ttr',
  's_prose', 's_list', 's_code', 's_table', 's_mixed',
  'q_factoid', 'q_procedural', 'q_explanatory', 'q_decision', 'has_headline'];

// Pure feature extraction from the FINISHED on-screen answer + the user's prompt. No I/O — testable.
function extractFeatures(screenText, userPrompt) {
  const s = String(screenText || '');
  const stripped = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const words = (stripped.toLowerCase().match(/[a-z0-9']+/g) || []);
  const uniq = new Set(words);
  const nCode = (s.match(/```/g) || []).length / 2 + (s.match(/`[^`]+`/g) || []).length;
  const nList = (s.match(/^\s*([-*•]|\d+\.)\s+/gm) || []).length;
  const nTableRows = (s.match(/^\s*\|.*\|\s*$/gm) || []).length;
  const nHeaders = (s.match(/^\s*#{1,6}\s+/gm) || []).length;
  const nUrls = (s.match(/https?:\/\/\S+/g) || []).length;
  const nNumbers = (stripped.match(/\b\d[\d,.]*\b/g) || []).length;
  const nEntities = (stripped.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || []).length;   // cheap proper-noun proxy
  // struct_type one-hot, with 'mixed' when ≥2 structural signals co-occur
  const sig = { code: nCode >= 1, list: nList >= 2, table: nTableRows >= 1 };
  const nSig = (sig.code ? 1 : 0) + (sig.list ? 1 : 0) + (sig.table ? 1 : 0);
  const struct = nSig >= 2 ? 'mixed' : sig.code ? 'code' : sig.table ? 'table' : sig.list ? 'list' : 'prose';
  const q = classifyQType(userPrompt);
  // has_headline: first sentence carries a number / proper noun / verdict word
  const firstSent = (stripped.trim().split(/[.!?]\s/)[0] || '').slice(0, 240);
  const headline = /\b\d/.test(firstSent) || /\b[A-Z][a-z]{2,}\b/.test(firstSent) || /\b(yes|no|should|best|recommend|winner|because|the answer)\b/i.test(firstSent);
  return {
    screen_tokens: Math.round(stripped.length / 4),
    n_numbers: nNumbers, n_entities: nEntities, n_code: nCode, n_list: nList, n_urls: nUrls,
    ttr: words.length ? uniq.size / words.length : 0,
    struct_type: struct, qtype: q, has_headline: headline,
    n_headers: nHeaders, n_table_rows: nTableRows,
  };
}

function classifyQType(prompt) {
  const t = String(prompt || '').toLowerCase();
  if (/\b(how (do|to|can|should)|steps?|set ?up|install|configure|walk me through)\b/.test(t)) return 'procedural';
  if (/\b(why|explain|how does|how come|what causes|reason)\b/.test(t)) return 'explanatory';
  if (/\b(should i|better|best|vs\.?|versus|recommend|which (is|one)|worth it|pros and cons|trade-?offs?)\b/.test(t)) return 'decision';
  if (/^(what|when|where|who|which|is|are|does|did|how many|how much)\b/.test(t)) return 'factoid';
  return 'explanatory';
}

function featurize(f) {
  f = f || {};
  const st = f.struct_type || 'prose', q = f.qtype || 'explanatory';
  return [
    Math.min(f.screen_tokens || 0, 6000) / 100,
    Math.min(f.n_numbers || 0, 60), Math.min(f.n_entities || 0, 80) / 4,
    Math.min(f.n_code || 0, 20), Math.min(f.n_list || 0, 40), Math.min(f.n_urls || 0, 20),
    Math.max(0, Math.min(1, f.ttr || 0)),
    st === 'prose' ? 1 : 0, st === 'list' ? 1 : 0, st === 'code' ? 1 : 0, st === 'table' ? 1 : 0, st === 'mixed' ? 1 : 0,
    q === 'factoid' ? 1 : 0, q === 'procedural' ? 1 : 0, q === 'explanatory' ? 1 : 0, q === 'decision' ? 1 : 0,
    f.has_headline ? 1 : 0,
  ];
}

// ---- outcome labeling (T6) — pure so the feedback loop is testable -------
// The next user turn tells us whether the last spoken length was right: a barge-in RIGHT-censors it
// (interrupted@N), an ask-for-more means it was too short (under), otherwise it was right (clean).
const MORE_RE = /^\s*(why\??|and\??|go on|keep going|continue|expand|elaborate|more detail|tell me more|in more detail|explain (more|further)|what else|go deeper)\b/i;
function labelOutcome({ bargedAt, nextUserText } = {}) {
  if (bargedAt != null) return { outcome: 'interrupted', interrupt_at: bargedAt };
  if (MORE_RE.test(String(nextUserText || ''))) return { outcome: 'under', interrupt_at: null };
  return { outcome: 'clean', interrupt_at: null };
}

// ---- linear algebra (dim ~18) --------------------------------------------
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

// The censored target used for training a single row (see header).
function effectiveTarget(r) {
  const delivered = r.spoken_words || 0;
  if (r.outcome === 'interrupted' && r.interrupt_at != null) return Math.min(delivered, r.interrupt_at);
  if (r.outcome === 'under') return Math.round(delivered * UNDER_BOOST);
  return delivered;
}
function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const pos = Math.max(0, Math.min(1, q)) * (sortedAsc.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

// WARM-START PRIORS — synthetic (features → spoken-word target) anchors encoding obvious length sense:
// a factoid/decision with a headline compresses to a short verdict; a list or dense explanation runs
// longer; a code answer speaks short ("it's on screen"). Blended into training so the model is
// well-conditioned and its early predictions are sane before real rows dominate. Fit (R2) is reported
// on REAL rows only so priors don't inflate the confidence gate.
const PRIORS = [
  [{ struct_type: 'prose', qtype: 'factoid', has_headline: true, n_numbers: 2 }, 14],
  [{ struct_type: 'prose', qtype: 'decision', has_headline: true }, 16],
  [{ struct_type: 'prose', qtype: 'explanatory', ttr: 0.6, screen_tokens: 300 }, 34],
  [{ struct_type: 'list', qtype: 'procedural', n_list: 5 }, 30],
  [{ struct_type: 'list', qtype: 'factoid', n_list: 6, n_entities: 8 }, 26],
  [{ struct_type: 'code', qtype: 'procedural', n_code: 2 }, 18],
  [{ struct_type: 'mixed', qtype: 'explanatory', n_list: 3, n_code: 1, screen_tokens: 600 }, 40],
  [{ struct_type: 'table', qtype: 'factoid', n_table_rows: 4, n_numbers: 8 }, 24],
];
function priorRows() { return PRIORS.map(([f, spoken_words]) => ({ f, spoken_words, outcome: 'clean', _prior: true })); }

// ---- training ------------------------------------------------------------
function train(rows) {
  const usable = rows.filter((r) => (r.spoken_words || 0) > 0 && (r.f || r.features));
  if (usable.length < MIN_ROWS) return { ok: false, reason: `only ${usable.length} usable rows (<${MIN_ROWS})`, n: usable.length };
  const priors = priorRows();
  const all = [...priors, ...usable];
  const X = all.map((r) => [...featurize(r.f || r.features), 1]);
  const y = all.map((r) => effectiveTarget(r));
  // size-adaptive shrinkage: strong when few real rows (lean on the priors), relaxing as data grows.
  const lambda = Math.max(1.0, 300 / usable.length);
  const w = solveRidge(X, y, lambda);
  // R2 on REAL rows only (priors would inflate it and falsely open the confidence gate).
  const yReal = usable.map((r) => effectiveTarget(r));
  const meanY = yReal.reduce((a, b) => a + b, 0) / yReal.length;
  let ssRes = 0, ssTot = 0;
  for (let i = priors.length; i < all.length; i++) {
    const pred = X[i].reduce((s, xj, j) => s + xj * w[j], 0);
    ssRes += (y[i] - pred) ** 2; ssTot += (y[i] - meanY) ** 2;
  }
  const residStd = Math.sqrt(ssRes / Math.max(1, yReal.length - 1));
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  // hard ceiling: never target above p75 of observed interrupt positions (predicting longer just gets barged)
  const interrupts = usable.filter((r) => r.outcome === 'interrupted' && r.interrupt_at != null).map((r) => r.interrupt_at).sort((a, b) => a - b);
  const interruptP75 = interrupts.length >= 5 ? Math.round(quantile(interrupts, 0.75)) : null;
  return { ok: true, w, residStd, r2, n: usable.length, interruptP75, features: FEATURES, trainedAt: Date.now() };
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

// ---- inference (hot path) ------------------------------------------------
let _cache = undefined, _cacheAt = 0;
function loadModel() {
  if (_cache !== undefined && Date.now() - _cacheAt < 60000) return _cache;
  try { const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')); _cache = m.ok ? m : null; } catch { _cache = null; }
  _cacheAt = Date.now();
  return _cache;
}

// predict(featObj) → { words, confidence } target spoken-word count, or null (→ heuristic).
function predict(featObj) {
  const m = loadModel();
  if (!m || !m.ok || m.n < MIN_ROWS || m.r2 < MIN_R2) return null;
  const x = [...featurize(featObj || {}), 1];
  const mean = x.reduce((s, xj, j) => s + xj * (m.w[j] || 0), 0);
  if (!isFinite(mean) || mean <= 0) return null;
  let ceil = mean + Z90 * (m.residStd || 0);
  if (m.interruptP75) ceil = Math.min(ceil, m.interruptP75);         // never target a length that gets barged
  const words = Math.max(WORD_MIN, Math.min(Math.round(ceil), WORD_MAX));
  const confidence = Math.max(0, Math.min(1, m.r2)) * Math.min(1, m.n / 1000);
  return { words, confidence };
}

function maybeRetrain({ logPath } = {}) {
  const m = loadModel();
  const lines = readRows(logPath).length;
  const seen = (m && m.rowsSeen) || 0;
  if (lines >= MIN_ROWS && (!m || lines - seen >= RETRAIN_EVERY)) return trainFromLog({ logPath });
  return null;
}

// THE dashboard metric: L = interrupt_rate + λ·underinform_rate over the last `window` spoken turns.
// The single number that says whether length calibration is improving (lower = better). Also the
// secondary quality signal median_spoken_to_next_turn_ms over clean turns.
function computeL(rows, { lambda = 1.0, window = 100 } = {}) {
  const recent = (rows || []).slice(-window).filter((r) => r.outcome);
  const n = recent.length;
  if (!n) return { L: null, n: 0, interrupt_rate: 0, underinform_rate: 0, median_spoken_to_next_ms: null };
  const interrupt_rate = recent.filter((r) => r.outcome === 'interrupted').length / n;
  const underinform_rate = recent.filter((r) => r.outcome === 'under').length / n;
  const cleanMs = recent.filter((r) => r.outcome === 'clean' && r.to_next_ms != null).map((r) => r.to_next_ms).sort((a, b) => a - b);
  return {
    L: +(interrupt_rate + lambda * underinform_rate).toFixed(4),
    n, interrupt_rate: +interrupt_rate.toFixed(3), underinform_rate: +underinform_rate.toFixed(3),
    median_spoken_to_next_ms: cleanMs.length ? Math.round(quantile(cleanMs, 0.5)) : null,
  };
}

module.exports = { extractFeatures, classifyQType, featurize, train, trainFromLog, predict, loadModel,
  maybeRetrain, computeL, readRows, effectiveTarget, labelOutcome, MORE_RE, FEATURES, MODEL_PATH, DATASET, MIN_ROWS, WORD_MIN, WORD_MAX };
