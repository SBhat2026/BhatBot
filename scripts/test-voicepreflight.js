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
const OPTS = { host: 'h.example.com', token: 'tok', authToken: 'secret', ownerPhone: '+16095550100' };
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
  console.log(`[voicepreflight] ${pass} assertions passed`);
})();
