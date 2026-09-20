'use strict';
// Tests for lib/failkind.js — the classifier that decides whether waiting will help.
//
// The fixtures are REAL error strings taken from ~/.bhatbot/logs/synapse-worker.log and
// ~/.bhatbot/schedule-results/ on 2026-09-20, not invented ones. The 680-failure loop this module
// exists to end was driven by the first fixture below, so if that one ever classifies transient
// again the loop is back.

const assert = require('assert');
const fk = require('../lib/failkind');

let pass = 0;
const ok = (m) => { console.log('✅ ' + m); pass++; };

// ── the real one ──────────────────────────────────────────────────────────────────────────────────
const CREDIT = 'Anthropic 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CfEvJKSLCzCaymPkxmyRt"}';
{
  const r = fk.classify(CREDIT);
  assert.strictEqual(r.kind, fk.PERMANENT, 'the credit-balance error must be permanent');
  assert.strictEqual(r.retryable, false);
  assert.match(r.reason, /credit/i, 'the reason must name the actual cause, not just "permanent"');
  ok('the error behind 680 retries classifies permanent, and says why');
}

// ── the transient one it was interleaved with ─────────────────────────────────────────────────────
{
  const r = fk.classify('Anthropic request failed after 3 retries: fetch failed');
  assert.strictEqual(r.kind, fk.TRANSIENT, 'a dropped fetch is weather');
  assert.strictEqual(r.retryable, true);
  ok('a failed fetch stays transient — the existing retry behaviour is preserved');
}

// ── structured provider types ─────────────────────────────────────────────────────────────────────
{
  assert.strictEqual(fk.classify('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}').kind, fk.TRANSIENT);
  assert.strictEqual(fk.classify('{"type":"error","error":{"type":"overloaded_error"}}').kind, fk.TRANSIENT);
  assert.strictEqual(fk.classify('{"type":"error","error":{"type":"authentication_error"}}').kind, fk.PERMANENT);
  assert.strictEqual(fk.classify('{"type":"error","error":{"type":"not_found_error","message":"model x"}}').kind, fk.PERMANENT);
  ok('provider error types map to the right kind');
}

// ── the precedence rule that matters ──────────────────────────────────────────────────────────────
{
  // A transient TYPE with a permanent MESSAGE must land permanent. Providers do send 429s whose
  // body explains the account is empty, and treating that as "rate limited, retry" is the loop.
  const r = fk.classify('{"type":"error","error":{"type":"rate_limit_error","message":"Your credit balance is too low"}}');
  assert.strictEqual(r.kind, fk.PERMANENT, 'a permanent message beats a transient type');
  ok('a permanent message overrides a transient error type');
}

// ── key and permission failures ───────────────────────────────────────────────────────────────────
{
  assert.strictEqual(fk.classify('401 invalid x-api-key').kind, fk.PERMANENT);
  assert.strictEqual(fk.classify(new Error('OpenAI 403 Forbidden')).kind, fk.PERMANENT);
  assert.strictEqual(fk.classify('no anthropic key is reachable').kind, fk.PERMANENT);
  // A CRED_REF handle sent as a bearer token is the documented failure in lib/llm.js.
  assert.strictEqual(fk.classify('401 unauthorized (sent CRED_REF_APIKEY_MR2FLH9H9CB3)').kind, fk.PERMANENT);
  ok('auth, permission and unresolved-key failures are permanent');
}

// ── input shapes ──────────────────────────────────────────────────────────────────────────────────
{
  assert.strictEqual(fk.classify(new Error('fetch failed')).kind, fk.TRANSIENT, 'Error object');
  assert.strictEqual(fk.classify({ error: { type: 'authentication_error', message: 'bad key' } }).kind, fk.PERMANENT, 'parsed body');
  assert.strictEqual(fk.classify('ECONNRESET').kind, fk.TRANSIENT, 'bare code string');
  const circular = { message: 'boom' }; circular.self = circular;
  assert.doesNotThrow(() => fk.classify(circular), 'a circular object must not throw');
  ok('Error objects, strings, parsed bodies and circular objects are all accepted');
}

// ── never throws, never returns garbage ───────────────────────────────────────────────────────────
{
  for (const v of [null, undefined, '', 0, [], {}, NaN, () => {}]) {
    const r = fk.classify(v);
    assert.ok([fk.TRANSIENT, fk.PERMANENT, fk.UNKNOWN].includes(r.kind), `kind for ${String(v)}`);
    assert.strictEqual(typeof r.retryable, 'boolean');
  }
  ok('every degenerate input returns a well-formed verdict instead of throwing');
}

// ── unknown is retryable, but is NOT silently transient ───────────────────────────────────────────
{
  const r = fk.classify('the flux capacitor disengaged');
  assert.strictEqual(r.kind, fk.UNKNOWN, 'an unrecognized error must be labelled unknown');
  assert.strictEqual(r.retryable, true, 'unknown still retries — we do not park on ignorance');
  ok('an unrecognized error retries but is labelled unknown, so a streak can bound it');
}

// ── status-code fallback ──────────────────────────────────────────────────────────────────────────
{
  assert.strictEqual(fk.classify('Gemini 503').kind, fk.TRANSIENT);
  assert.strictEqual(fk.classify('Gemini 429').kind, fk.TRANSIENT);
  assert.strictEqual(fk.classify('some provider 422').kind, fk.PERMANENT);
  ok('a bare status code falls back to the right side');
}

// ── backoff ───────────────────────────────────────────────────────────────────────────────────────
{
  assert.strictEqual(fk.backoffMs(fk.PERMANENT), 6 * 3600e3, 'permanent → 6h probe, not Infinity');
  assert.strictEqual(fk.backoffMs(fk.TRANSIENT, 1), 60e3);
  assert.strictEqual(fk.backoffMs(fk.TRANSIENT, 3), 240e3);
  assert.ok(fk.backoffMs(fk.TRANSIENT, 99) <= 3600e3, 'transient backoff is capped at an hour');
  assert.ok(fk.backoffMs(fk.TRANSIENT, 0) >= 60e3, 'a zero/garbage count still yields a real delay');

  // The whole point, as arithmetic: the 30-minute tick produced ~48 attempts/day against a
  // permanent error. A 6h window produces 4.
  const perDay = 24 * 3600e3 / fk.backoffMs(fk.PERMANENT);
  assert.ok(perDay <= 4, `permanent errors must retry at most 4×/day, got ${perDay}`);
  ok('backoff turns 48 failures a day into 4');
}

// ── explain() is actionable ───────────────────────────────────────────────────────────────────────
{
  const e = fk.explain(fk.PERMANENT, 'the account is out of credit');
  assert.match(e, /needs you/i, 'a permanent failure must tell the human it is theirs');
  assert.match(fk.explain(fk.TRANSIENT, 'rate limited'), /retry/i);
  ok('explain() says who has to act');
}

console.log(`\n✅ failkind: ${pass} groups passed`);
