#!/usr/bin/env node
'use strict';
// T1 — pace against live anthropic-ratelimit headers. Tests lib/rate.js: header parsing (numbers +
// RFC3339 resets), effectiveBudget prefers FRESH live axes, ignores STALE ones (past reset), and
// falls back cleanly when headers are absent. Pure — runs in node, in verify.
const { parseRateHeaders, effectiveBudget } = require('../lib/rate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const now = Date.parse('2026-07-02T12:00:00Z');
const soon = new Date(now + 30000).toISOString();   // resets in 30s → FRESH
const past = new Date(now - 30000).toISOString();    // reset 30s ago → STALE
const mk = (h) => (name) => (name in h ? h[name] : null);

// ---- parseRateHeaders ----
const full = parseRateHeaders(mk({
  'anthropic-ratelimit-input-tokens-limit': '450000',
  'anthropic-ratelimit-input-tokens-remaining': '120000',
  'anthropic-ratelimit-input-tokens-reset': soon,
  'anthropic-ratelimit-output-tokens-limit': '90000',
  'anthropic-ratelimit-output-tokens-remaining': '8000',
  'anthropic-ratelimit-output-tokens-reset': soon,
  'anthropic-ratelimit-requests-remaining': '900',
  'anthropic-ratelimit-requests-reset': soon,
}), now);
ok(full && full.inRemaining === 120000 && full.inLimit === 450000, 'parse: input tokens limit + remaining');
ok(full.outRemaining === 8000 && full.inResetAt === Date.parse(soon), 'parse: output remaining + reset timestamp');
ok(parseRateHeaders(mk({})) === null, 'parse: no ratelimit headers → null (non-Anthropic response)');
ok(parseRateHeaders(mk({ 'content-type': 'application/json' })) === null, 'parse: unrelated headers → null');

// ---- effectiveBudget: fresh live PREFERRED over estimate ----
const est = { inSafe: 405000, inFree: 300000, outSafe: 81000, outFree: 80000 };
const eFresh = effectiveBudget(est, full, { now, liveFrac: 0.95, otpmTracked: true });
ok(eFresh.source === 'live', 'budget: fresh live reading → source=live');
ok(eFresh.inFree === Math.floor(120000 * 0.95), 'budget: inFree from live remaining (×0.95), not the estimate');
ok(eFresh.outFree === Math.floor(8000 * 0.95), 'budget: outFree from live remaining — the OTPM ground truth');
ok(eFresh.inSafe === Math.floor(450000 * 0.95), 'budget: inSafe ceiling from live limit');

// ---- stale live axis (past reset) → falls back to estimate for that axis ----
const staleR = parseRateHeaders(mk({
  'anthropic-ratelimit-input-tokens-remaining': '5', 'anthropic-ratelimit-input-tokens-reset': past,
  'anthropic-ratelimit-output-tokens-remaining': '9', 'anthropic-ratelimit-output-tokens-reset': past,
}), now);
const eStale = effectiveBudget(est, staleR, { now, liveFrac: 0.95, otpmTracked: true });
ok(eStale.source === 'estimate', 'budget: stale live (past reset) → ignored, source=estimate');
ok(eStale.inFree === est.inFree && eStale.outFree === est.outFree, 'budget: stale reading does not starve the budget');

// ---- mixed: input fresh, output stale ----
const mixed = parseRateHeaders(mk({
  'anthropic-ratelimit-input-tokens-remaining': '77000', 'anthropic-ratelimit-input-tokens-reset': soon,
  'anthropic-ratelimit-output-tokens-remaining': '1', 'anthropic-ratelimit-output-tokens-reset': past,
}), now);
const eMixed = effectiveBudget(est, mixed, { now, liveFrac: 0.95, otpmTracked: true });
ok(eMixed.inFree === Math.floor(77000 * 0.95) && eMixed.outFree === est.outFree, 'budget: per-axis freshness — fresh input live, stale output falls back');

// ---- no live reading → estimate untouched ----
const eNone = effectiveBudget(est, null, { now });
ok(eNone.source === 'estimate' && eNone.inFree === est.inFree, 'budget: no live reading → pure estimate');

// ---- untracked OTPM model: output axis never overridden ----
const eNoOtpm = effectiveBudget({ ...est, outSafe: Infinity, outFree: Infinity }, full, { now, otpmTracked: false });
ok(eNoOtpm.outFree === Infinity, 'budget: OTPM-untracked model keeps Infinity output budget');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
