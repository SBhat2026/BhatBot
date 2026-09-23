#!/usr/bin/env node
'use strict';
// ── "THE CALL WAS PLACED" IS NOT "THE CALL WORKED" ────────────────────────────────────────────────
// Twice now a call has been reported as sent while the phone played "An application error has
// occurred". Each time, every layer we could see said success:
//
//   • twilio accepted the request           → sent: true
//   • `tailscale funnel status` said published
//   • an unsigned curl got 403              → "the guard works"
//   • a SIGNED curl got 200 with <Say>      → "it speaks"
//
// ...and the body was <Say>Unauthorized.</Say><Hangup/>: the app politely declining every outbound
// call, because the owner check read `From`, which on an outbound call is the Twilio number rather
// than Siddhant. The lesson is in the last bullet — a 200 that speaks is not a working call, and a
// check that stops there inherits the bug it was written to catch.
const assert = require('assert');
const path = require('path');
const { check, twilioSignature } = require(path.join(__dirname, '..', 'lib', 'voicepreflight'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
// externalProbe:false — these cases exercise the HANDLER, and a unit test must not depend on two
// third-party proxies being up. Reachability has its own cases below, with a fake fetch.
const OPTS = { host: 'h.example.com', token: 'tok', authToken: 'secret', ownerPhone: '+16095550100', externalProbe: false };
const reply = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

console.log('[voicepreflight]');

(async () => {
  {
    const r = await check({ ...OPTS, fetchImpl: reply('<?xml version="1.0"?><Response><Say>Hello sir.</Say><Gather input="speech" action="/g"/></Response>') });
    assert.ok(r.ok, r.detail);
    assert.ok(r.twoWay);
    ok('TwiML that speaks AND listens is a working two-way call');
  }
  {
    // THE EXACT BODY THAT SHIPPED BROKEN.
    const r = await check({ ...OPTS, fetchImpl: reply('<?xml version="1.0"?><Response><Say>Unauthorized.</Say><Hangup/></Response>') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'authz');
    assert.match(r.detail, /refused|unauthoris/i);
    ok('"Unauthorized" + Hangup is a REFUSAL, not an announcement-only pass');
  }
  {
    // A refusal need not use the word. Speaking once and hanging up is the shape of one.
    const r = await check({ ...OPTS, fetchImpl: reply('<?xml version="1.0"?><Response><Say>System error.</Say><Hangup/></Response>') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'twiml');
    assert.match(r.detail, /hangs up/);
    ok('speak-once-then-hangup is rejected even when the words are innocuous');
  }
  {
    const r = await check({ ...OPTS, fetchImpl: reply('<?xml version="1.0"?><Response><Say>Hello.</Say></Response>') });
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /never listens|monologue/);
    ok('TwiML that speaks but cannot listen is not a two-way call');
  }
  {
    const r = await check({ ...OPTS, fetchImpl: reply('<?xml version="1.0"?><Response><Reject/></Response>') });
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /Reject/);
    ok('<Reject/> is caught');
  }
  {
    const r = await check({ ...OPTS, fetchImpl: reply('<Response><Say>x</Say><Gather/></Response>', 403) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'http');
    assert.match(r.detail, /signed request|twilioAuthToken/);
    ok('a 403 on a correctly-signed request names the auth-token mismatch');
  }
  {
    const r = await check({ ...OPTS, fetchImpl: reply('<html>502 Bad Gateway</html>', 200) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'twiml');
    ok('a 200 carrying HTML instead of TwiML fails — Twilio cannot run it either');
  }
  {
    const r = await check({ ...OPTS, fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'dns/tls');
    assert.match(r.detail, /funnel/);
    ok('an unreachable host names the funnel as the likely cause');
  }
  {
    for (const missing of [{ host: '' }, { token: '' }]) {
      const r = await check({ ...OPTS, ...missing, fetchImpl: reply('<Response><Say>x</Say><Gather/></Response>') });
      assert.strictEqual(r.stage, 'config', JSON.stringify(missing));
    }
    ok('missing config is reported as config, not as a network failure');
  }
  {
    // The probe must be shaped like the call it is proving. Outbound authorises on `To`, so a probe
    // that leaves a stranger there exercises the refusal path and reports on the success path.
    let seen = null;
    await check({ ...OPTS, fetchImpl: async (u, o) => { seen = new URLSearchParams(o.body); return { ok: true, status: 200, text: async () => '<Response><Say>x</Say><Gather/></Response>' }; } });
    assert.strictEqual(seen.get('To'), OPTS.ownerPhone, 'To must be the owner');
    assert.strictEqual(seen.get('Direction'), 'outbound-api', 'and the direction must match a real outbound call');
    ok('the probe is shaped like the outbound call it is proving');
  }
  {
    // Signed the way Twilio signs: HMAC-SHA1 over url + each sorted key and value.
    const sig = twilioSignature('secret', 'https://h/x', { b: '2', a: '1' });
    const same = twilioSignature('secret', 'https://h/x', { a: '1', b: '2' });
    assert.strictEqual(sig, same, 'parameter order must not change the signature');
    assert.notStrictEqual(sig, twilioSignature('other', 'https://h/x', { a: '1', b: '2' }));
    ok('the signature matches Twilio\'s scheme and depends on the secret');
  }
  {
    // THE ONE NOBODY MEASURED. Twilio abandons a webhook at ~15s and plays "An application error has
    // occurred". Three rounds of debugging checked reachability, signatures, authorisation and TwiML
    // shape — every one of them passed — while the handler was running an LLM round-trip before
    // replying. A slow handler must be reported as SLOW, not as a network fault, or the next person
    // is sent to the funnel while the real cause sits in the request path.
    const r = await check({ ...OPTS, timeoutMs: 50, fetchImpl: async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'slow', 'a timeout is its own diagnosis: ' + r.detail);
    assert.match(r.detail, /model|15s|application error/i);
    ok('a webhook slower than the deadline is reported as SLOW, not as a dead funnel');
  }
  {
    // ...and a healthy call reports how close to the limit it ran, because 14s passes today and
    // fails on a slower day.
    const r = await check({ ...OPTS, fetchImpl: reply('<Response><Say>x</Say><Gather input="speech"/></Response>') });
    assert.ok(r.ok);
    assert.strictEqual(typeof r.ms, 'number', 'the timing is reported even on success');
    assert.match(r.detail, /budget/);
    ok('a passing check still reports its margin against the deadline');
  }
  // ── REACHABILITY, WHICH IS THE QUESTION THAT WAS NEVER ASKED ─────────────────────────────────
  // The old preflight fetched the webhook from THIS machine. On a Tailscale node that hostname
  // resolves to the tailnet address, so the request never left the laptop — it reported "✓ TWO-WAY"
  // in 328ms while every real call played an application error. A local success is not evidence.
  const { reachableFromOutside } = require(path.join(__dirname, '..', 'lib', 'voicepreflight'));
  {
    const r = await reachableFromOutside('funnel.invalid', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>hello</html>' }) });
    assert.ok(r.ok, r.detail);
    ok('an outside host that fetches the page proves reachability');
  }
  {
    // THE SHAPE OF THE REAL FAILURE. Cloudflare 522 means the edge accepted the connection and could
    // not reach the origin — a funnel that is advertised and not serving, which is precisely what
    // Princeton's symmetric NAT produces. The prober must prove itself on a control first, so the
    // fake answers the control normally and only fails on the target.
    const proberUp = (targetBody) => async (u) => ({ ok: true, status: 200,
      text: async () => (/quest=https%3A%2F%2Fexample|url=https%3A%2F%2Fexample/i.test(u) ? '<h1>Example Domain</h1>' : targetBody) });
    const r = await reachableFromOutside('funnel.invalid', { fetchImpl: proberUp('error code: 522') });
    assert.strictEqual(r.ok, false, r.detail);
    assert.match(r.detail, /522|origin unreachable/);
    ok('a 200 carrying "error code: 522" is NOT reachability — the edge could not reach the origin');
  }
  {
    // AND AN UNUSABLE PROBER IS NOT A VERDICT. Both free proxies went down mid-session and this
    // check declared bhatbot-cloud.fly.dev dead while a direct curl to it was answering 401.
    // "I could not find out" has to be its own answer, or a broken instrument becomes a finding.
    const proberDown = async () => ({ ok: true, status: 200, text: async () => 'error code: 522' });
    const r2 = await reachableFromOutside('funnel.invalid', { fetchImpl: proberDown });
    assert.strictEqual(r2.ok, null, 'inconclusive, not false: ' + r2.detail);
    assert.match(r2.detail, /says nothing about/);
    ok('when no prober can fetch a control, the result is INCONCLUSIVE rather than a failure');
  }
  {
    // One proxy being down must not read as the funnel being down.
    let n = 0;
    const r = await reachableFromOutside('funnel.invalid', { fetchImpl: async (u) => (++n === 1 ? Promise.reject(new Error('proxy down')) : { ok: true, status: 200, text: async () => (/quest=https%3A%2F%2Fexample|url=https%3A%2F%2Fexample/i.test(u) ? 'Example Domain' : 'hello') }) });
    assert.ok(r.ok, 'the second prober answers: ' + r.detail);
    ok('a dead prober falls through to the other rather than failing the check');
  }
  {
    const probe = async (u) => ({ ok: true, status: 200,
      text: async () => (/quest=https%3A%2F%2Fexample|url=https%3A%2F%2Fexample/i.test(u) ? 'Example Domain' : 'error code: 522') });
    const r = await check({ ...OPTS, externalProbe: probe, fetchImpl: reply('<Response><Say>x</Say><Gather/></Response>') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'unreachable', r.detail);
    assert.match(r.detail, /never leaves it|tailnet/);
    ok('an unreachable host fails BEFORE the handler is judged — and says why a local check would lie');
  }
  console.log(`[voicepreflight] ${pass} assertions passed`);
})();
