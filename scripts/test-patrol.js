#!/usr/bin/env node
'use strict';
// Tests for ambient PATROL (lib/patrol.js) — the unsupervised health monitor that relays to Telegram
// and CALLS the user on urgent conditions. The risk it must NOT have: alert spam (repeating a relay
// for a persistent condition, or waking the user with non-urgent noise). This verifies relay-on-change
// (transitions only), first-tick baseline silence, urgent→call vs non-urgent→telegram-only,
// dedup of a held condition, quiet-hours suppression of non-urgent (but not urgent), and battery skip.
// Pure (factory + injected ctx) → plain node. Wired into `npm run verify`.
//   node scripts/test-patrol.js
const makePatrol = require('../lib/patrol');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

function harness(cfg = {}) {
  const mock = { cloud: true, crashes: 0, healPending: 0, agentState: 'idle', elCooldownMs: 0, errors: 0, spare: false };
  const telegrams = [], calls = [];
  const ctx = {
    loadConfig: () => cfg,
    telegramNotify: (t) => telegrams.push(t),
    notifyUser: (t, mode) => calls.push({ t, mode }),
    cloudConnected: () => mock.cloud,
    selfhealStatus: () => ({ pending: mock.healPending }),
    crashCount: () => mock.crashes,
    shouldSpare: () => mock.spare,
    snapshot: () => ({ agent: { state: mock.agentState }, health: { elevenLabsCooldownMs: mock.elCooldownMs } }),
    recentEvents: () => Array.from({ length: mock.errors }, () => ({ kind: 'error', ts: new Date().toISOString() })),
    log: () => {},
  };
  return { patrol: makePatrol(ctx), mock, telegrams, calls };
}

(async () => {
  // ---- baseline: first tick establishes a baseline and stays SILENT ----
  {
    const { patrol, telegrams, calls } = harness();
    await patrol.tick();
    ok(telegrams.length === 0 && calls.length === 0, 'first tick → baseline, no relays (silence = healthy)');
  }

  // ---- cloud drop → ONE telegram (non-urgent), no call; persistent → no repeat ----
  {
    const { patrol, mock, telegrams, calls } = harness();
    await patrol.tick();                       // baseline (cloud up)
    mock.cloud = false; await patrol.tick();    // transition down
    ok(telegrams.some((t) => /Cloud link dropped/.test(t)), 'cloud up→down → telegram relay');
    ok(calls.length === 0, 'cloud drop → NOT a call (non-urgent)');
    const n = telegrams.length;
    await patrol.tick();                        // still down, NO change
    ok(telegrams.length === n, 'cloud stays down → no repeat relay (relay-on-change dedup)');
    mock.cloud = true; await patrol.tick();     // restored
    ok(telegrams.some((t) => /restored/i.test(t)), 'cloud down→up → "restored" relay');
  }

  // ---- new crash → URGENT → call fired ----
  {
    const { patrol, mock, telegrams, calls } = harness();
    await patrol.tick();
    mock.crashes = 2; await patrol.tick();
    ok(calls.some((c) => c.mode === 'call' && /crash/i.test(c.t)), 'new crash → urgent → notifyUser(call)');
    ok(telegrams.some((t) => /crash/i.test(t)), 'urgent also goes to telegram');
  }

  // ---- error spike: fires on growth, silent when stable ----
  {
    const { patrol, mock, telegrams } = harness();
    await patrol.tick();
    mock.errors = 6; await patrol.tick();
    ok(telegrams.some((t) => /6 errors/.test(t)), 'error spike (≥5, growing) → relay');
    const n = telegrams.length;
    await patrol.tick();                        // still 6, no growth
    ok(telegrams.length === n, 'error count stable → no repeat relay');
  }

  // ---- quiet hours: holds non-urgent, lets urgent through ----
  {
    const { patrol, mock, telegrams, calls } = harness({ patrol: { quietHours: [0, 24] } }); // always quiet
    await patrol.tick();
    mock.cloud = false;                         // non-urgent
    mock.crashes = 1;                           // urgent (same tick)
    await patrol.tick();
    ok(!telegrams.some((t) => /Cloud link dropped/.test(t)), 'quiet hours → non-urgent cloud relay suppressed');
    ok(calls.some((c) => /crash/i.test(c.t)), 'quiet hours → urgent crash STILL calls (safety override)');
  }

  // ---- battery/power-saver → skip entirely ----
  {
    const { patrol, mock, telegrams, calls } = harness();
    await patrol.tick();
    mock.spare = true; mock.cloud = false; mock.crashes = 5;
    await patrol.tick();
    ok(telegrams.length === 0 && calls.length === 0, 'shouldSpare (battery+saver) → tick skips, no relays');
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
