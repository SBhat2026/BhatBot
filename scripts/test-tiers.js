#!/usr/bin/env node
'use strict';
// Tests for lib/tiers.js — how much of Siddhant's machine an unattended run is allowed to take.
//
// The assertions that carry weight are about DIRECTION, because that is what the whole module is:
//   • dropping is immediate and raising needs a dwell, which is the mirror image of lib/governor.js
//     and deliberately so — heat is real now, but a model reload costs 3.8–15.6 seconds and a coffee
//     break must not buy one;
//   • an UNKNOWN signal may lower the tier and must never raise it, because the failure that matters
//     is taking his machine when he is sitting at it;
//   • and the ladder latches after repeated drops, which is the brake on a feedback loop where every
//     component behaves correctly and the system degrades anyway.
//
//   node scripts/test-tiers.js
const { createTiers, KEEP_ALIVE } = require('../lib/tiers');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const MIN = 60000;
/** A rig whose clock and every signal are ours. `s` is mutated between polls to move the world. */
function rig(initial = {}, config = {}) {
  const s = { idleMs: 0, onAC: true, heavyApp: null, memFreePct: 60, governor: 'nominal', ...initial };
  let t = 1790000000000;
  const changes = [];
  const T = createTiers({
    now: () => t,
    readIdleMs: () => s.idleMs,
    onAC: () => s.onAC,
    heavyAppRunning: () => s.heavyApp,
    readMemFreePct: () => s.memFreePct,
    governorLevel: () => s.governor,
    onChange: (c) => changes.push(c),
    config: { sampleEveryMs: 1, ...config },
  });
  // Advance the clock and poll — the sample spacing is what makes a poll actually re-read.
  const tick = (ms = 1000) => { t += ms; return T.poll(); };
  // A RAISE TAKES TWO POLLS, and that is the design rather than an accident: the first poll notices
  // the desire and starts the clock on it, a later one acts once the dwell has actually elapsed. A
  // single poll that jumped the clock forward would let one lucky sample buy an expensive model load.
  const settle = (ms) => { tick(1); tick(ms); return T.tier(); };
  return { T, s, tick, settle, changes, at: () => t };
}

// ── the ladder ───────────────────────────────────────────────────────────────────────────────────
{
  const { T, s, tick } = rig();
  ok(T.tier() === 'balanced', 'it starts balanced — the honest assumption is that he is here');

  s.idleMs = 20 * MIN;
  tick();
  ok(T.tier() === 'balanced', 'twenty minutes idle does NOT immediately buy aggressive');
  tick(11 * MIN);
  ok(T.tier() === 'aggressive', 'but it does after the raise dwell has actually elapsed');

  s.heavyApp = 'Xcode';
  tick(1000);
  ok(T.tier() === 'conservative', 'and Xcode drops it to conservative in one tick — no dwell, he needs the machine now');
}

// ── every route to conservative, and the reason names the cause ──────────────────────────────────
{
  for (const [label, patch, expect] of [
    ['a heavy app', { heavyApp: 'Blender' }, /Blender/],
    ['battery', { onAC: false }, /battery/],
    ['low memory', { memFreePct: 12 }, /12% memory free/],
    ['a hot machine', { governor: 'hot' }, /hot/],
    ['a critical machine', { governor: 'critical' }, /critical/],
  ]) {
    const { T, s, tick, changes } = rig();
    Object.assign(s, patch);
    tick();
    ok(T.tier() === 'conservative', `${label} → conservative`);
    const c = changes[changes.length - 1];
    ok(c && expect.test(c.why), `  and the reason says why (${c && c.why})` );
  }
}

// ── an unknown signal never raises ───────────────────────────────────────────────────────────────
// This is the one that matters: "I cannot tell whether he is here" must not be read as "he is gone".
{
  const { T, s, tick } = rig({ idleMs: null });
  tick(30 * MIN); tick(30 * MIN);
  ok(T.tier() === 'balanced', 'a null idle reading never reaches aggressive, however long it persists');

  const { T: T2, s: s2, tick: tick2, settle: settle2 } = rig({ idleMs: 30 * MIN, memFreePct: null });
  settle2(11 * MIN);
  ok(T2.tier() === 'aggressive', 'but a null MEMORY reading does not block a raise the other signals earned');
  s2.memFreePct = 4;
  tick2(1000);
  ok(T2.tier() === 'conservative', 'and once memory IS readable and bad, it drops immediately');
}

// ── the dwell is real, and it resets ─────────────────────────────────────────────────────────────
{
  const { T, s, tick } = rig({ idleMs: 30 * MIN });
  tick(5 * MIN);
  ok(T.tier() === 'balanced', 'halfway through the dwell it has not climbed');
  s.idleMs = 0;                       // he came back
  tick(1000);
  ok(T.tier() === 'balanced', 'he returns and it is still balanced — nothing to drop from');
  s.idleMs = 30 * MIN;                // he left again
  tick(1); tick(6 * MIN);
  ok(T.tier() === 'balanced', 'the dwell restarted rather than crediting the earlier absence');
  tick(6 * MIN);
  ok(T.tier() === 'aggressive', 'and completes on its own terms');
}

// ── the latch, which is the brake on the death spiral ────────────────────────────────────────────
// Browser leaks → memory falls → tier drops → the local model is evicted → all work goes to the cloud
// → slower → more leak. Every component is behaving correctly and the machine degrades anyway. After
// two drops the ladder stops climbing, so the loop cannot run again.
{
  const { T, s, tick, changes } = rig({}, { maxDrops: 2 });
  const cycle = () => { s.memFreePct = 10; tick(1000); s.memFreePct = 60; s.idleMs = 30 * MIN; tick(1); tick(11 * MIN); };
  cycle();
  ok(T.tier() === 'aggressive', 'it recovers from the first drop');
  cycle();
  ok(T.drops() === 2, 'two drops recorded');
  s.memFreePct = 60; s.idleMs = 30 * MIN;
  tick(1); tick(20 * MIN); tick(20 * MIN);
  ok(T.tier() !== 'aggressive', `and after two drops it will not climb again this run (stayed ${T.tier()})`);
  const latched = changes.filter((c) => c.direction === 'latched');
  ok(latched.length === 1, 'the latch is announced exactly once, not every twenty seconds for the rest of the day');
}

// ── what the tier actually controls ──────────────────────────────────────────────────────────────
{
  const { T, s, tick } = rig();
  ok(T.localLaneEnabled() === true, 'balanced runs the local lane');
  s.onAC = false; tick();
  ok(T.tier() === 'conservative' && T.localLaneEnabled() === false,
    'conservative shuts the local lane — a resident model costs 5-10GB and real power, which is what the machine gets a say over');
  ok(T.keepAlive() === KEEP_ALIVE.conservative && KEEP_ALIVE.conservative === '0',
    'and evicts it rather than keeping it warm');
  ok(KEEP_ALIVE.balanced === '30m' && KEEP_ALIVE.aggressive === '-1', 'the three residencies are evict / warm / pin');
}

// ── it does not read the machine on every call ───────────────────────────────────────────────────
{
  let reads = 0;
  const T = createTiers({ readIdleMs: () => { reads++; return 0; }, config: { sampleEveryMs: 60000 }, now: () => 1790000000000 });
  for (let i = 0; i < 50; i++) T.poll();
  ok(reads <= 1, `fifty polls inside the sample window cost ${reads} shell read(s) — poll() is on the hot path`);
}

// ── junk in ──────────────────────────────────────────────────────────────────────────────────────
{
  const T = createTiers({
    readIdleMs: () => { throw new Error('ioreg exploded'); },
    onAC: () => { throw new Error('pmset exploded'); },
    heavyAppRunning: () => { throw new Error('pgrep exploded'); },
    readMemFreePct: () => NaN,
    governorLevel: () => undefined,
  });
  ok(T.poll() === 'balanced', 'every reader throwing lands on balanced rather than taking the machine or refusing to work');
  ok(typeof T.describe() === 'string', 'and it can still describe itself');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} tiers: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
