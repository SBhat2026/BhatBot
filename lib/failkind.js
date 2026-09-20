'use strict';
// ── FAILURE CLASSIFIER ────────────────────────────────────────────────────────────────────────────
// Answers one question about an error: WILL WAITING HELP?
//
// THE BUG THIS EXISTS FOR. The worker's schedule runner leaves a failed schedule due so it retries
// on the next tick. That is exactly right for a dropped socket and exactly wrong for an empty
// billing account: between 2026-09-04 and 2026-09-20 the morning brief failed 15–28 times a day,
// 680 times in total, each one writing an unread result file, against an error whose text said in
// plain English that no amount of retrying would fix it. Nothing was broken except the assumption
// that a failure is a failure.
//
// So every retry-on-a-timer call site needs to distinguish:
//   transient — the fault is in the weather. Retry on the normal cadence.
//   permanent — the fault is in the configuration, the credentials or the account. Retrying is a
//               loop; the only thing that clears it is a human. Park, say so ONCE, stop.
//   unknown   — unrecognized. Treated as transient but with a bounded streak, so a novel error
//               cannot produce an unbounded loop the way a recognized-as-transient one could.
//
// WHY A SEPARATE MODULE AND NOT A REGEX AT THE CALL SITE. There are at least four of these timers
// (scheduler, backlog worker, synapse paid pass, patrol) and they each learned this lesson
// separately or not at all — `lib/backlogworker.js` has a circuit breaker, the scheduler had
// nothing. One classifier, one set of tests, one place to add the next error shape.
//
// CLASSIFY ON MEANING, NOT ON STATUS CODE ALONE. A 400 from Anthropic is permanent when it is
// `invalid_request_error` about credit, and a 429 is transient even though both are 4xx. The
// provider's own error *type* is the most reliable signal available, so it is checked first; the
// message text second; the bare status code last, as a fallback for errors that arrived as a
// string with no structure left.
//
// Pure. No I/O, no clock, never throws — a classifier that can throw would take down the caller it
// exists to protect. See scripts/test-failkind.js.

const TRANSIENT = 'transient';
const PERMANENT = 'permanent';
const UNKNOWN = 'unknown';

// Provider error *types*, which are more trustworthy than any message text.
// `invalid_request_error` is deliberately NOT here: it covers both "you sent malformed JSON"
// (permanent for a fixed prompt) and "your credit balance is too low" (permanent), so either way
// it lands permanent — but it gets there through the message table so the REASON is specific.
const TYPE_KIND = {
  authentication_error: PERMANENT,
  permission_error: PERMANENT,
  not_found_error: PERMANENT,
  request_too_large: PERMANENT,   // the same request will always be too large
  rate_limit_error: TRANSIENT,
  api_error: TRANSIENT,
  overloaded_error: TRANSIENT,
  timeout_error: TRANSIENT,
};

// Message-text signatures. Each carries the reason it reports, because "permanent" alone tells the
// user nothing actionable and the whole point of stopping is to say what would unblock it.
const SIGNATURES = [
  // ── permanent: money and identity ──────────────────────────────────────────────────────────────
  [/credit balance is too low|insufficient[_ ]quota|billing|payment required|exceeded your current quota/i,
    PERMANENT, 'the account is out of credit'],
  [/invalid[_ ]api[_ ]key|invalid x-api-key|incorrect api key|unauthorized|authentication[_ ]error|401\b/i,
    PERMANENT, 'the API key is missing, wrong or revoked'],
  [/permission|forbidden|not allowed|403\b/i,
    PERMANENT, 'the key lacks permission for this model or endpoint'],
  [/model[^\n]{0,40}(not found|does not exist|is not supported)|unknown model/i,
    PERMANENT, 'the configured model does not exist'],
  [/no (?:anthropic|openai|api) key|key is (?:missing|unreachable)|CRED_REF/i,
    PERMANENT, 'no usable key could be resolved'],

  // ── transient: the network and the other end's bad day ─────────────────────────────────────────
  [/rate[_ ]limit|429\b|too many requests/i, TRANSIENT, 'rate limited'],
  [/overloaded|capacity|try again later|temporarily unavailable|50[0234]\b|529\b/i, TRANSIENT, 'the provider is overloaded'],
  [/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timed? ?out|aborted/i,
    TRANSIENT, 'the network call did not complete'],
];

/**
 * classify(err) → { kind, reason, retryable }
 *
 * `err` may be an Error, a string, or a parsed provider body — call sites have all three shapes and
 * a classifier that only accepts one of them will silently be handed the others.
 */
function classify(err) {
  const text = toText(err);
  if (!text) return { kind: UNKNOWN, reason: 'no error text', retryable: true };

  // 1. Structured provider type, wherever it appears in the payload.
  const t = /"type"\s*:\s*"([a-z_]+_error)"/i.exec(text);
  if (t && TYPE_KIND[t[1]]) {
    const kind = TYPE_KIND[t[1]];
    // An authoritative transient type still defers to a permanent message: `rate_limit_error` is
    // transient, but a body that also says "credit balance" is not going to clear on its own.
    if (kind === TRANSIENT) {
      const sig = matchSignature(text);
      if (sig && sig.kind === PERMANENT) return { kind: PERMANENT, reason: sig.reason, retryable: false };
    }
    return { kind, reason: t[1].replace(/_/g, ' '), retryable: kind !== PERMANENT };
  }

  // 2. Message signatures.
  const sig = matchSignature(text);
  if (sig) return { kind: sig.kind, reason: sig.reason, retryable: sig.kind !== PERMANENT };

  // 3. Bare status code, last resort — a string like "Anthropic 400: …" with nothing else left.
  const code = /\b(4\d\d|5\d\d)\b/.exec(text);
  if (code) {
    const n = Number(code[1]);
    if (n === 408 || n === 409 || n === 425 || n === 429 || n >= 500) {
      return { kind: TRANSIENT, reason: `HTTP ${n}`, retryable: true };
    }
    return { kind: PERMANENT, reason: `HTTP ${n}`, retryable: false };
  }

  return { kind: UNKNOWN, reason: 'unrecognized error', retryable: true };
}

function matchSignature(text) {
  for (const [re, kind, reason] of SIGNATURES) if (re.test(text)) return { kind, reason };
  return null;
}

// Errors arrive as Error objects, strings, or parsed bodies. Flatten all three without throwing on
// a circular object — JSON.stringify on a response object is a real possibility at these call sites.
function toText(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return `${err.message || ''} ${err.code || ''}`.trim();
  if (typeof err === 'object') {
    const parts = [err.message, err.error && err.error.message, err.error && err.error.type, err.type, err.code, err.status];
    const direct = parts.filter((p) => p != null && typeof p !== 'object').join(' ').trim();
    if (direct) {
      // Keep the structured type discoverable by classify()'s regex even when we took the fast path.
      const ty = (err.error && err.error.type) || err.type;
      return ty ? `${direct} "type":"${ty}"` : direct;
    }
    try { return JSON.stringify(err); } catch { return String(err); }
  }
  return String(err);
}

/**
 * backoffMs(kind, consecutive) → ms to wait before the next attempt.
 *
 * Transient failures back off exponentially from 1 minute, capped at an hour — enough to ride out
 * a provider incident without hammering it, short enough that a dropped socket costs one cycle.
 * Permanent failures get a LONG window (6h) rather than `Infinity`: the account genuinely might be
 * topped up, and a retry twice a day is a probe, not a loop. The difference between 6 hours and the
 * 30-minute tick is the difference between 4 failures a day and 48.
 */
function backoffMs(kind, consecutive = 1) {
  const n = Math.max(1, consecutive | 0);
  if (kind === PERMANENT) return 6 * 3600e3;
  const base = 60e3 * Math.pow(2, Math.min(n - 1, 6));   // 1m → 64m
  return Math.min(base, 3600e3);
}

/** A one-line, human-facing explanation. This is what gets spoken or pushed, so it says what to do. */
function explain(kind, reason) {
  if (kind === PERMANENT) return `${reason} — this will not fix itself; it needs you.`;
  if (kind === TRANSIENT) return `${reason} — retrying.`;
  return `${reason} — retrying, but this error was not recognized.`;
}

module.exports = { classify, backoffMs, explain, TRANSIENT, PERMANENT, UNKNOWN };
