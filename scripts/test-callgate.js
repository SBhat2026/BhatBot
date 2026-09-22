#!/usr/bin/env node
'use strict';
// A phone call is the most intrusive thing BhatBot can do, and on 2026-09-21 it made seven or eight
// in one day, every one of them playing "An application error has occurred." These are the rules
// that make that specific sequence impossible, asserted against that specific sequence.
const assert = require('assert');
const path = require('path');
const { decide, checkWebhookHost, DEFAULTS } = require(path.join(__dirname, '..', 'lib', 'callgate'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const T = Date.parse('2026-09-21T15:00:00Z');
const ago = (min, okFlag = true) => ({ at: T - min * 60000, ok: okFlag });

console.log('[callgate]');

{
  assert.ok(decide({ history: [], now: T }).allow, 'the first call of the day goes through');
  ok('an empty history allows the call — the gate is a cap, not a mute');
}
{
  const r = decide({ history: [ago(3)], now: T });
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /cooldown/);
  assert.strictEqual(r.downgrade, 'sms', 'a refusal must still deliver the message');
  ok('a call three minutes after the last one is refused, and downgraded rather than dropped');
}
{
  // THE EXACT SHAPE OF THE 21st: repeated calls, none of which reached him.
  const eight = Array.from({ length: 8 }, (_, i) => ago(60 - i * 7, false));
  const r = decide({ history: eight, now: T });
  assert.strictEqual(r.allow, false, 'the ninth must not happen');
  ok('the run that actually occurred is refused');
}
{
  // ...and it is refused EARLY. Two failures in a row is already enough evidence: a channel that
  // just failed twice is broken, and redialling a broken channel is how you reach eight.
  const r = decide({ history: [ago(120, false), ago(60, false)], now: T });
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /both failed|broken/);
  ok('two consecutive FAILED calls stop the third, even with the rate budget untouched');
}
{
  // The brake is about failure, not about volume — two calls that WORKED do not block the next one
  // (the cooldown and the daily cap still apply, so this is checked past both).
  const r = decide({ history: [ago(600, true), ago(400, true)], now: T });
  assert.strictEqual(r.allow, true, 'successful calls spaced hours apart are fine: ' + r.reason);
  ok('two successful calls do not trip the failure brake');
}
{
  const r = decide({ history: [ago(50), ago(30)], now: T });
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /last hour/);
  ok('the hourly cap holds');
}
{
  const spread = [ago(600), ago(400), ago(200)];
  const r = decide({ history: spread, now: T });
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /24h/);
  assert.strictEqual(DEFAULTS.maxPerDay, 3);
  ok('the fourth call in a day is refused however well spaced');
}
{
  // Yesterday's calls must not count against today — a cap that never resets is a mute.
  const r = decide({ history: [ago(1500), ago(1600), ago(1700)], now: T });
  assert.strictEqual(r.allow, true, 'calls older than 24h have expired: ' + r.reason);
  ok('the daily window rolls — yesterday does not silence today');
}
{
  // THE LIVELOCK. The ledger records refusals as well as calls — it should, that is the audit trail
  // — but counting them against the caps means every refusal pushes the cooldown out by another
  // fifteen minutes, and anything that keeps trying keeps the gate shut forever. Caught within
  // minutes of this gate shipping, by trying to place a single test call three times.
  const blocked = (min) => ({ at: T - min * 60000, ok: false, blocked: true, reason: 'cooldown' });
  const r = decide({ history: [ago(600), blocked(10), blocked(5), blocked(1)], now: T });
  assert.strictEqual(r.allow, true, 'refusals must not extend the cooldown: ' + r.reason);
  ok('a blocked attempt never rang the phone, so it does not count against the caps');
}
{
  // ...and it must not trip the consecutive-failure brake either — those are attempts that never
  // reached the network, so they are no evidence about whether the channel works.
  const blocked = (min) => ({ at: T - min * 60000, ok: false, blocked: true });
  const r = decide({ history: [ago(700, true), blocked(30), blocked(25)], now: T });
  assert.strictEqual(r.allow, true, 'two refusals are not two failures: ' + r.reason);
  ok('refusals do not trip the two-consecutive-failures brake');
}
{
  const r = decide({ history: [], now: T, config: { maxPerDay: 0 } });
  assert.strictEqual(r.allow, false, 'maxPerDay 0 is a way to turn calling off entirely');
  ok('config can disable calling outright');
}

// ── the host check ────────────────────────────────────────────────────────────────────────────────
(async () => {
  {
    const r = await checkWebhookHost('', { probe: async () => ({ ok: true }) });
    assert.strictEqual(r.usable, false);
    ok('no host is not a usable host');
  }
  {
    // THE TRAP. A Tailscale MagicDNS name resolves perfectly from inside the tailnet and not at all
    // from Twilio's servers. The hostname exists, looks right, and is unreachable by the only party
    // that matters — so "is it a non-empty string" is not the question.
    const r = await checkWebhookHost('macbook-pro.tail816be0.ts.net', { probe: async () => ({ ok: false, why: 'funnel not published' }) });
    assert.strictEqual(r.usable, false);
    assert.match(r.why, /funnel/);
    ok('a hostname that exists but is not published is NOT usable');
  }
  {
    const r = await checkWebhookHost('h.example.com', { probe: async () => ({ ok: true }) });
    assert.ok(r.usable);
    ok('a genuinely reachable host is usable');
  }
  {
    const r = await checkWebhookHost('h.example.com', { probe: async () => { throw new Error('boom'); } });
    assert.strictEqual(r.usable, false, 'a probe that throws means NOT usable — never assume reachable');
    ok('a probe that throws fails closed');
  }
  {
    const r = await checkWebhookHost('h.example.com', {});
    assert.strictEqual(r.usable, false, 'with no probe at all we cannot claim reachability');
    ok('no probe means not usable — the claim needs evidence');
  }
  console.log(`[callgate] ${pass} assertions passed`);
})();
