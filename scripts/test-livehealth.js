'use strict';
// Pass C1 — live-heal lane. Claims under test: each failure class is classified deterministically
// and recovered without any git operation, attempts are bounded, and exhaustion produces a concrete
// blocker report rather than a stack trace.
const assert = require('assert');
const path = require('path');
const { createLiveHealth, classify, retryAfterMs } = require(path.join(__dirname, '..', 'lib', 'livehealth'));

let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }
const nosleep = async () => {};

(async () => {
  console.log('[livehealth]');

  // 1. Deterministic classification — no model call on the hot path of a failing turn.
  {
    const cases = [
      [{ status: 401 }, 'auth'],
      [{ message: 'invalid_grant: token has expired' }, 'auth'],
      [new Error('403 permission denied'), 'auth'],
      [{ status: 429 }, 'ratelimit'],
      [new Error('Rate limit reached for requests'), 'ratelimit'],
      [new Error('overloaded_error'), 'ratelimit'],
      [new Error('Target page, context or browser has been closed'), 'browser'],
      [new Error('Execution context was destroyed'), 'browser'],
      [new Error('model "qwen3.5" not found, try pulling it'), 'model'],
      [new Error('socket hang up'), 'bridge'],
      [new Error('getaddrinfo ENOTFOUND api.anthropic.com'), 'network'],
      [new Error('ECONNRESET'), 'network'],
      [new Error('ENOSPC: no space left on device'), 'disk'],
      [new Error('something nobody predicted'), 'unknown'],
    ];
    for (const [err, want] of cases) {
      assert.strictEqual(classify(err), want, `classify(${err.message || err.status}) → expected ${want}`);
    }
    ok('all failure classes are classified deterministically');
  }

  // 2. THE ORDERING TRAP: a 429 body very often mentions "key"/"credentials". Treating it as auth
  //    would fire a re-auth storm against an endpoint that is already asking us to slow down.
  {
    const err = { status: 429, message: 'Rate limit exceeded for your API key. Check your credentials plan.' };
    assert.strictEqual(classify(err), 'ratelimit', 'rate limit must outrank the auth keywords in its own body');
    ok('a 429 mentioning "key"/"credentials" is NOT misread as auth');
  }

  // 3. Recovery per class, and the hard rail: no remedy performs a git operation.
  {
    const called = [];
    const lh = createLiveHealth({
      sleep: nosleep,
      remedies: {
        auth: async () => { called.push('auth'); return true; },
        browser: async () => { called.push('browser'); return true; },
        model: async () => { called.push('model'); return true; },
        network: async () => { called.push('network'); return true; },
        bridge: async () => { called.push('bridge'); return true; },
      },
    });
    lh.beginTurn();
    for (const e of [{ status: 401 }, new Error('browser has been closed'), new Error('ollama model not found'), new Error('ECONNRESET'), new Error('socket hang up')]) {
      const r = await lh.heal(e, { tool: 'x' });
      assert.strictEqual(r.recovered, true, `expected recovery for ${classify(e)}`);
    }
    assert.deepStrictEqual(called, ['auth', 'browser', 'model', 'network', 'bridge']);
    ok('each class routes to its own remedy and reports recovery');
  }

  // 4. Rate limit heals by WAITING, and honors Retry-After rather than guessing.
  {
    const waits = [];
    const lh = createLiveHealth({ sleep: async (ms) => waits.push(ms), remedies: {} });
    lh.beginTurn();
    const r = await lh.heal({ status: 429, headers: { 'retry-after': '7' } });
    assert.strictEqual(r.recovered, true, 'waiting IS the remedy for a rate limit');
    assert.strictEqual(waits[0], 7000, 'must honor Retry-After exactly, not guess');
    assert.ok(/backoff 7s/.test(r.action));
    ok('rate limit waits the server-specified Retry-After');
  }

  // 5. A hostile / garbled Retry-After cannot park the turn for an hour.
  {
    assert.strictEqual(retryAfterMs({ retryAfter: '999999' }, 60_000), 60_000, 'must clamp to the cap');
    assert.strictEqual(retryAfterMs({ retryAfter: 'not-a-date' }, 60_000), null, 'garbage → fall back to backoff');
    assert.strictEqual(retryAfterMs({}, 60_000), null);
    const httpDate = new Date(Date.now() + 5000).toUTCString();
    const ms = retryAfterMs({ headers: { 'Retry-After': httpDate } }, 60_000);
    assert.ok(ms > 3000 && ms <= 5000, 'HTTP-date form is supported');
    ok('Retry-After is clamped and accepts both seconds and HTTP-date forms');
  }

  // 6. BOUNDED per class. A healer that retries forever is worse than one that gives up.
  {
    let tries = 0;
    const lh = createLiveHealth({ sleep: nosleep, remedies: { auth: async () => { tries++; return false; } }, config: { maxAttempts: 2 } });
    lh.beginTurn();
    const a = await lh.heal({ status: 401 });
    const b = await lh.heal({ status: 401 });
    const c = await lh.heal({ status: 401 });
    assert.strictEqual(a.recovered, false);
    assert.strictEqual(c.reason, 'budget', 'third attempt must be refused by budget');
    assert.strictEqual(tries, 2, 'the remedy must not run past maxAttempts');
    ok('per-class attempts are bounded (maxAttempts)');
  }

  // 7. BOUNDED globally, across classes.
  {
    const lh = createLiveHealth({
      sleep: nosleep,
      remedies: { auth: async () => false, browser: async () => false, model: async () => false },
      config: { maxAttempts: 5, maxPerTurn: 3 },
    });
    lh.beginTurn();
    await lh.heal({ status: 401 });
    await lh.heal(new Error('browser has been closed'));
    await lh.heal(new Error('ollama model not found'));
    const fourth = await lh.heal({ status: 401 });
    assert.strictEqual(fourth.reason, 'budget', 'global per-turn ceiling must hold across classes');
    assert.strictEqual(lh.stats().exhausted, true);
    ok('the global per-turn ceiling holds across classes');
  }

  // 8. Budget RESETS per turn — a long session must not inherit an exhausted healer.
  {
    const lh = createLiveHealth({ sleep: nosleep, remedies: { auth: async () => false }, config: { maxAttempts: 1 } });
    lh.beginTurn();
    await lh.heal({ status: 401 });
    assert.strictEqual((await lh.heal({ status: 401 })).reason, 'budget');
    lh.beginTurn();
    assert.strictEqual((await lh.heal({ status: 401 })).reason, 'failed', 'a new turn gets a fresh budget');
    ok('the healing budget resets per turn');
  }

  // 9. A missing remedy is reported honestly, not silently "recovered".
  {
    const lh = createLiveHealth({ sleep: nosleep, remedies: {} });
    lh.beginTurn();
    const r = await lh.heal(new Error('browser has been closed'));
    assert.strictEqual(r.recovered, false);
    assert.strictEqual(r.reason, 'no-remedy');
    ok('an unwired remedy reports no-remedy instead of a false green');
  }

  // 10. A remedy that THROWS must not sink the turn — the healer is the last line, it cannot itself fail loudly.
  {
    const lh = createLiveHealth({ sleep: nosleep, remedies: { auth: async () => { throw new Error('keychain locked'); } } });
    lh.beginTurn();
    const r = await lh.heal({ status: 401 });
    assert.strictEqual(r.recovered, false, 'a throwing remedy is a failed heal, not an exception');
    ok('a throwing remedy degrades to a failed heal (never throws)');
  }

  // 11. A remedy returning `undefined` counts as success (the common `async () => {...}` shape),
  //     but explicit `false` is a failure. This distinction is easy to get wrong.
  {
    const lh = createLiveHealth({ sleep: nosleep, remedies: { model: async () => {}, auth: async () => false } });
    lh.beginTurn();
    assert.strictEqual((await lh.heal(new Error('ollama model not found'))).recovered, true);
    assert.strictEqual((await lh.heal({ status: 401 })).recovered, false);
    ok('undefined means success, explicit false means failure');
  }

  // 12. C3 — exhaustion produces an actionable blocker report naming the credential/permission needed.
  {
    const lh = createLiveHealth({ sleep: nosleep, remedies: { auth: async () => false }, config: { maxAttempts: 2 } });
    lh.beginTurn();
    await lh.heal({ status: 401, message: 'invalid_grant' }, { tool: 'gmail_search' });
    await lh.heal({ status: 401, message: 'invalid_grant' }, { tool: 'gmail_search' });
    const rep = lh.blockerReport({ goal: 'triage the inbox', step: 12 });
    assert.ok(/could not recover/i.test(rep));
    assert.ok(/auth — 2 attempt/.test(rep), 'the report states what was tried, and how often');
    assert.ok(/google:auth|fresh credential/.test(rep), 'the report names the concrete remedy the human must supply');
    assert.ok(/Parked at step 12/.test(rep), 'the report says the work is parked, not lost');
    assert.ok(/triage the inbox/.test(rep));
    ok('exhaustion yields a concrete, actionable blocker report (C3)');
  }

  // 13. Recovered-then-failed-again is reported as such — the nastiest case to get wrong, because a
  //     naive report would claim success on the strength of the first attempt.
  {
    let n = 0;
    const lh = createLiveHealth({ sleep: nosleep, remedies: { browser: async () => (++n === 1) }, config: { maxAttempts: 2 } });
    lh.beginTurn();
    assert.strictEqual((await lh.heal(new Error('browser has been closed'))).recovered, true);
    assert.strictEqual((await lh.heal(new Error('browser has been closed'))).recovered, false);
    const rep = lh.blockerReport({});
    assert.ok(/recovered at least once, then failed again/.test(rep));
    ok('a flapping remedy is reported as flapping, not as success');
  }

  // 14. Every attempt is recorded to the injected sink — an unobservable healer is unmaintainable.
  {
    const seen = [];
    const lh = createLiveHealth({ sleep: nosleep, remedies: { auth: async () => true }, record: (e) => seen.push(e) });
    lh.beginTurn();
    await lh.heal({ status: 401 }, { tool: 'gmail_search' });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].cls, 'auth');
    assert.strictEqual(seen[0].tool, 'gmail_search');
    assert.strictEqual(seen[0].recovered, true);
    ok('every heal attempt is recorded to the telemetry sink');
  }

  console.log(`[livehealth] ${pass} assertions passed`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
