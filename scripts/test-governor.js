'use strict';
// Pass B4 — thermal/memory governor. Claims under test: the shed ladder fires in the specified
// order, foreground is never starved, unknown readings never shed, and hysteresis prevents flapping.
const assert = require('assert');
const path = require('path');
const { createGovernor, thermalLevel, memLevel, DEFAULTS } = require(path.join(__dirname, '..', 'lib', 'governor'));

let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }

// Build a governor with fully controlled clock + probes.
function mk(initial = {}) {
  const s = { thermal: 'nominal', mem: 60, batt: false, t: 100_000, ...initial };
  const g = createGovernor({
    readThermal: () => s.thermal,
    readMemFreePct: () => s.mem,
    onBattery: () => s.batt,
    powerSaver: () => true,
    now: () => s.t,
    config: { sampleEveryMs: 0 },     // force every poll to sample
  });
  return { g, s };
}

console.log('[governor]');

// 1. Unknown readings must NOT shed. On an idle Mac `pmset -g therm` prints nothing at all and
//    os.freemem() is meaningless — a governor that reads absence as pressure would shed forever.
{
  const g = createGovernor({ readThermal: () => null, readMemFreePct: () => null, config: { sampleEveryMs: 0 } });
  g.poll();
  assert.strictEqual(g.level(), 'nominal');
  assert.strictEqual(g.allowLocalModel(), true, 'unknown thermal must not shed the local model');
  assert.strictEqual(g.allowHeavyVision(), true);
  ok('unknown/absent readings stay nominal (absence of evidence ≠ pressure)');
}

// 2. A probe that THROWS is also not pressure.
{
  const g = createGovernor({
    readThermal: () => { throw new Error('pmset gone'); },
    readMemFreePct: () => { throw new Error('no memory_pressure'); },
    config: { sampleEveryMs: 0 },
  });
  g.poll();
  assert.strictEqual(g.level(), 'nominal');
  ok('a throwing probe degrades to nominal, not to shed');
}

// 3. The shed ladder, in the order B4 specifies.
{
  const { g, s } = mk();
  g.poll();
  assert.strictEqual(g.allowLocalModel(), true);

  s.thermal = 'fair'; g.poll();
  assert.strictEqual(g.level(), 'warm');
  assert.strictEqual(g.allowLocalModel(), false, 'warm sheds the LOCAL MODEL first');
  assert.strictEqual(g.allowHeavyVision(), true, 'warm must not yet touch vision');
  assert.strictEqual(g.allowBackgroundTick('ambient'), true);

  s.thermal = 'serious'; g.poll();
  assert.strictEqual(g.level(), 'hot');
  assert.strictEqual(g.allowHeavyVision(), false, 'hot sheds the heavy caption pass');
  assert.strictEqual(g.visionCadenceMultiplier(), 2, 'hot halves vision cadence');
  assert.strictEqual(g.allowBackgroundTick('ambient'), true, 'hot must not yet defer background');

  s.thermal = 'critical'; g.poll();
  assert.strictEqual(g.level(), 'critical');
  assert.strictEqual(g.allowBackgroundTick('ambient'), false, 'critical defers background ticks');
  assert.strictEqual(g.allowBackgroundTick('scheduler'), true, 'scheduler survives critical');
  ok('shed ladder fires in order: local model → vision → background ticks');
}

// 4. THE INVARIANT: foreground is never shed, at any level.
{
  const { g, s } = mk();
  for (const th of ['nominal', 'fair', 'serious', 'critical']) {
    s.thermal = th; g.poll();
    assert.strictEqual(g.allowForeground(), true, `foreground shed at thermal=${th}`);
  }
  ok('foreground is never shed at any level (the hard invariant)');
}

// 5. Memory drives the ladder independently of thermal — sized for the REAL 16GB machine.
{
  const { g, s } = mk();
  s.mem = 30; g.poll(); assert.strictEqual(g.level(), 'nominal');
  s.mem = 20; g.poll(); assert.strictEqual(g.level(), 'warm', '20% free on 16GB → warm');
  s.mem = 12; g.poll(); assert.strictEqual(g.level(), 'hot');
  s.mem = 5;  g.poll(); assert.strictEqual(g.level(), 'critical');
  ok('memory pressure drives the ladder independently of thermal');
}

// 6. Battery alone caps at `warm` — being unplugged is not the same as being hot.
{
  const { g, s } = mk();
  s.batt = true; g.poll();
  assert.strictEqual(g.level(), 'warm');
  assert.strictEqual(g.allowHeavyVision(), true, 'battery must never escalate past warm on its own');
  assert.strictEqual(g.allowBackgroundTick('ambient'), true);
  ok('battery alone caps at warm and never defers background work');
}

// 7. HYSTERESIS. Escalation is immediate; de-escalation requires dwell. Without this the governor
//    flaps at a boundary and thrashes the model slot every sample — worse than no governor.
{
  const { g, s } = mk();
  s.thermal = 'serious'; g.poll();
  assert.strictEqual(g.level(), 'hot', 'escalation is immediate');

  s.thermal = 'nominal'; g.poll();
  assert.strictEqual(g.level(), 'hot', 'must NOT relax on the first cool reading');

  s.t += DEFAULTS.dwellMs - 1; g.poll();
  assert.strictEqual(g.level(), 'hot', 'still inside the dwell window');

  s.t += 2; g.poll();
  assert.strictEqual(g.level(), 'warm', 'relaxes exactly one step after dwell');

  s.t += DEFAULTS.dwellMs + 1; g.poll();
  assert.strictEqual(g.level(), 'nominal', 'second dwell returns to nominal');
  ok('hysteresis: instant escalation, dwell-gated one-step de-escalation');
}

// 8. A cooling trend interrupted by fresh heat re-escalates immediately (no stale dwell credit).
{
  const { g, s } = mk();
  s.thermal = 'critical'; g.poll();
  s.thermal = 'nominal'; s.t += DEFAULTS.dwellMs - 100; g.poll();
  assert.strictEqual(g.level(), 'critical', 'dwell not yet met');
  s.thermal = 'critical'; g.poll();
  s.t += 200; g.poll();
  assert.strictEqual(g.level(), 'critical', 'renewed heat must cancel accumulated dwell credit');
  ok('renewed pressure cancels accumulated cool-down credit');
}

// 9. sampleEveryMs actually throttles probe calls — the governor must not spawn a shell per question.
{
  let reads = 0;
  let t = 0;
  const g = createGovernor({
    readThermal: () => { reads++; return 'nominal'; },
    readMemFreePct: () => 50,
    now: () => t,
    config: { sampleEveryMs: 20_000 },
  });
  for (let i = 0; i < 50; i++) g.poll();
  assert.strictEqual(reads, 1, 'repeated polls inside the window must reuse the last sample');
  t += 20_001; g.poll();
  assert.strictEqual(reads, 2);
  ok('probes are throttled by sampleEveryMs (no shell-per-question)');
}

// 10. Pure helpers.
{
  assert.strictEqual(thermalLevel('critical'), 'critical');
  assert.strictEqual(thermalLevel('Fair'), 'warm');
  assert.strictEqual(thermalLevel(undefined), 'nominal');
  assert.strictEqual(thermalLevel('garbage'), 'nominal');
  assert.strictEqual(memLevel(null, DEFAULTS), 'nominal');
  assert.strictEqual(memLevel(NaN, DEFAULTS), 'nominal');
  assert.strictEqual(memLevel(4, DEFAULTS), 'critical');
  ok('thermalLevel/memLevel handle null, NaN and garbage without shedding');
}

// 11. Transitions are logged so the shed is explainable after the fact.
{
  const { g, s } = mk();
  s.thermal = 'serious'; g.poll();
  const h = g.history();
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].to, 'hot');
  assert.ok(/thermal/.test(h[0].why), 'transition records WHY it shed');
  assert.ok(/level=hot/.test(g.describe()));
  ok('level transitions are recorded with a reason');
}

console.log(`[governor] ${pass} assertions passed`);
