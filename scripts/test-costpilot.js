#!/usr/bin/env node
'use strict';
// Tests for lib/costpilot.js — the thing that says what a run will cost before it costs it.
//
// Three of these guard failures that would each be invisible until they had already done damage:
//   • it must never WRITE the ledger, because recordCost already does on every call and a second
//     writer silently doubles the daily total;
//   • it must not compute burn rate from the ledger at all, because the ledger is keyed by calendar
//     day and a run started at 22:00 would watch its own spend drop to zero at midnight and report a
//     negative rate;
//   • a prediction with no measurements behind it must SAY so rather than borrow the authority of one
//     that was measured.
//
//   node scripts/test-costpilot.js
const { createCostPilot } = require('../lib/costpilot');
const pricing = require('../lib/pricing');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const HOUR = 3600000;
const priceOf = (tin, tout) => pricing.usd('claude-sonnet-5', { input_tokens: tin, output_tokens: tout });

function rig(over = {}, config = {}) {
  let t = 1790000000000;
  const state = { spendUsd: 0, budgetUsd: 10, total: 40, done: 0, rows: [] };
  const reports = [];
  const pilot = createCostPilot({
    now: () => t,
    missionMeta: () => ({ spendUsd: state.spendUsd, budgetUsd: state.budgetUsd }),
    journal: () => state.rows,
    planDigest: () => ({ total: state.total, done: state.done }),
    priceOf,
    onReport: (r) => reports.push(r),
    config: { reportEveryMs: 15 * 60000, targetUsdPerHour: 3.5, ...config },
    ...over,
  });
  return { pilot, state, reports, advance: (ms) => { t += ms; }, at: () => t };
}

// ── the basis is measured when there is something to measure ─────────────────────────────────────
{
  const { pilot, state } = rig();
  let b = pilot.basis();
  ok(b.measured === false && b.samples === 0, 'with no history the basis is an assumption');
  ok(pilot.predict().basis.includes('assumption'), 'and the prediction says so in words, not in a flag nobody reads');

  // Phase 0 started recording these; before it, every journal row had undefined for both.
  state.rows = [
    { tokensIn: 9000, tokensOut: 500 },
    { tokensIn: 11000, tokensOut: 700 },
    { tokensIn: 10000, tokensOut: 600 },
  ];
  b = pilot.basis();
  ok(b.measured === true && b.samples === 3, 'three completed items are enough to measure from');
  const expected = (priceOf(9000, 500) + priceOf(11000, 700) + priceOf(10000, 600)) / 3;
  ok(Math.abs(b.usdPerItem - expected) < 1e-9, `and the figure is the real one (${b.usdPerItem.toFixed(5)})`);
  ok(pilot.predict().basis.includes('3 completed items'), 'the prediction names its basis so a wild number can be traced');
}

// ── the projection ───────────────────────────────────────────────────────────────────────────────
{
  const { pilot, state, advance } = rig();
  state.rows = Array.from({ length: 5 }, () => ({ tokensIn: 10000, tokensOut: 600 }));
  state.done = 5; state.total = 40; state.spendUsd = 0.14;
  advance(10 * 60000);
  const p = pilot.predict();
  ok(p.remaining === 35, 'it projects over what is LEFT, not over the whole plan');
  ok(p.projectedUsd > p.spentUsd, 'the projection is ahead of what has been spent');
  ok(p.usdPerHour > 0.8 && p.usdPerHour < 0.9, `the rate is per real elapsed hour (${p.usdPerHour}/h after 10min)`);
  ok(p.etaMs && p.etaMs > 0, 'and it says how long the rest looks like taking');
}

// ── the cadence is the pilot's, not the caller's ─────────────────────────────────────────────────
{
  const { pilot, reports, advance } = rig();
  for (let i = 0; i < 100; i++) pilot.tick();
  ok(reports.length === 1, `a hundred ticks inside one window produce one report (${reports.length})`);
  advance(16 * 60000);
  pilot.tick();
  ok(reports.length === 2, 'and the next window produces the next one');
  pilot.tick(true);
  ok(reports.length === 3, 'force is there for the end of a run, when the last word should not wait for a window');
}

// ── the levers, in the order that actually saves money ───────────────────────────────────────────
{
  const { pilot, state, reports, advance } = rig();
  state.rows = Array.from({ length: 5 }, () => ({ tokensIn: 10000, tokensOut: 600 }));
  state.done = 5; state.spendUsd = 2.0;          // $2 in ten minutes = $12/h, well over
  advance(10 * 60000);
  const r1 = pilot.tick();
  ok(r1 && r1.overRate, 'it notices the rate is over target');
  ok(r1.lever === 'local', 'and reaches for the local lane FIRST — the only lever that removes cost rather than reshaping it');

  // Keep spending as the clock moves, or the rate falls back under target on its own and no further
  // lever is due — which is correct behaviour and would have made this test assert nothing.
  const over = (mins) => { advance(mins * 60000); state.spendUsd += 3.0; return pilot.tick(); };
  const r2 = over(16), r3 = over(16), r4 = over(16);
  ok(r2.lever === 'max_tokens' && r3.lever === 'max_turns', 'then the two that cut tokens per item');
  ok(r4.lever === 'width',
    'and width LAST — if the account rate limit is binding, narrowing it saves nothing and only takes longer');
  ok(pilot.widthCap() !== null, 'width is the one lever the pilot can pull itself, so it does');
  ok(new Set(reports.map((x) => x.lever).filter(Boolean)).size === reports.filter((x) => x.lever).length,
    'no lever is recommended twice — a run mildly over budget does not get every remedy at once');
}
{
  // Under target, it says nothing and asks for nothing.
  const { pilot, state, advance } = rig();
  state.rows = Array.from({ length: 5 }, () => ({ tokensIn: 5000, tokensOut: 200 }));
  state.done = 5; state.spendUsd = 0.1;
  advance(30 * 60000);
  const r = pilot.tick();
  ok(r && !r.overRate && r.lever === null, 'a run inside its budget is reported on and left alone');
  ok(pilot.widthCap() === null, 'and the pilot has no opinion about width');
}

// ── midnight ─────────────────────────────────────────────────────────────────────────────────────
// lib/costledger.js is keyed by calendar day. A run started at 22:00 that took its spend from there
// would watch it reset to zero at midnight and compute a negative burn rate — then "optimise" on the
// strength of it. Run spend comes from mission.json, which is monotonic for the life of the run.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'costpilot.js'), 'utf8');
  ok(!/costledger/.test(src.replace(/\/\/[^\n]*/g, '')),
    'the module does not import or call costledger anywhere outside its comments');
  ok(/missionMeta/.test(src), 'run-scoped spend comes from the mission, which is monotonic');

  const { pilot, state, advance } = rig();
  state.spendUsd = 1.0; advance(30 * 60000);
  const before = pilot.predict().usdPerHour;
  state.spendUsd = 1.2; advance(30 * 60000);       // the clock crosses midnight; mission spend does not reset
  const after = pilot.predict().usdPerHour;
  ok(before > 0 && after > 0, 'the rate stays positive across a day boundary');
  ok(after <= before, 'and falls when spending slows, rather than going negative');
}

// ── it cannot break the run ──────────────────────────────────────────────────────────────────────
{
  const pilot = createCostPilot({
    missionMeta: () => { throw new Error('mission file vanished'); },
    journal: () => { throw new Error('journal unreadable'); },
    planDigest: () => null,
    onReport: () => { throw new Error('the reporter exploded'); },
  });
  let threw = null;
  try { pilot.tick(true); } catch (e) { threw = e.message; }
  ok(!threw, `every dependency failing does not throw out of tick() (${threw || 'clean'})`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} costpilot: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
