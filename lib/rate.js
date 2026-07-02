'use strict';
// Pure rate-limit helpers. Anthropic returns the GROUND TRUTH of your remaining budget on EVERY
// response via `anthropic-ratelimit-*` headers; the app used to pace against hardcoded tier guesses
// and only read `retry-after` on a 429. These two pure functions (a) parse those headers and (b) merge
// a fresh live reading over the windowed estimate so rateBudget paces against reality. No I/O, no
// electron — unit-testable in node, wired into main.js's anthropicRequest/anthropicStream.

// Parse the live ratelimit headers. `get(name)` → header string | null (pass res.headers.get bound).
// Returns a reading object, or null when no ratelimit headers are present (non-Anthropic response).
function parseRateHeaders(get, now = Date.now()) {
  const num = (n) => { const v = get(n); const x = v == null ? NaN : Number(v); return Number.isFinite(x) ? x : null; };
  const ts = (n) => { const v = get(n); if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
  const out = {
    inLimit: num('anthropic-ratelimit-input-tokens-limit'),
    inRemaining: num('anthropic-ratelimit-input-tokens-remaining'),
    inResetAt: ts('anthropic-ratelimit-input-tokens-reset'),
    outLimit: num('anthropic-ratelimit-output-tokens-limit'),
    outRemaining: num('anthropic-ratelimit-output-tokens-remaining'),
    outResetAt: ts('anthropic-ratelimit-output-tokens-reset'),
    reqRemaining: num('anthropic-ratelimit-requests-remaining'),
    reqResetAt: ts('anthropic-ratelimit-requests-reset'),
    at: now,
  };
  const any = out.inRemaining != null || out.outRemaining != null || out.reqRemaining != null;
  return any ? out : null;
}

// Merge a live reading over the windowed estimate. `estimate` = {inSafe,inFree,outSafe,outFree}. A
// live axis is PREFERRED only while fresh (now < its reset) — after reset the bucket refills and the
// remaining count is stale, so we fall back to the estimate. `liveFrac` is a small safety margin on
// the exact header number (0.95, vs the estimate's 0.9). Returns the same shape + `source`.
function effectiveBudget(estimate, live, { now = Date.now(), liveFrac = 0.95, otpmTracked = true } = {}) {
  let { inSafe, inFree, outSafe, outFree } = estimate;
  let source = 'estimate';
  if (live) {
    if (live.inRemaining != null && live.inResetAt != null && now < live.inResetAt) {
      if (live.inLimit != null) inSafe = Math.floor(live.inLimit * liveFrac);
      inFree = Math.floor(live.inRemaining * liveFrac);
      source = 'live';
    }
    if (otpmTracked && live.outRemaining != null && live.outResetAt != null && now < live.outResetAt) {
      if (live.outLimit != null) outSafe = Math.floor(live.outLimit * liveFrac);
      outFree = Math.floor(live.outRemaining * liveFrac);
      source = 'live';
    }
  }
  return { inSafe, inFree, outSafe, outFree, source };
}

module.exports = { parseRateHeaders, effectiveBudget };
