#!/usr/bin/env node
'use strict';
// One ledger, written by everything that spends money — which was not true until 2026-09-22.
//
// The implementation lived inside main.js, so only Electron could reach it. The headless worker,
// which runs unattended every thirty minutes and pays for embeddings and rationales, wrote its spend
// to a runtime-state SNAPSHOT instead. Two consequences: the daily total was silently and always
// low, and overBudget() could not see worker spend — so the one subsystem nobody watches was also
// the one the budget cap did not apply to. A budget that exempts the unattended process is not a
// budget.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the ledger at a scratch HOME so the real one is never touched by a test.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cost-'));
const realHome = os.homedir;
os.homedir = () => TMP;
delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'costledger'))];
const ledger = require(path.join(__dirname, '..', 'lib', 'costledger'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const today = () => new Date().toISOString().slice(0, 10);

console.log('[costledger]');

{
  assert.ok(ledger.COSTS_PATH.startsWith(TMP), 'the test must not write the real ledger');
  const t = ledger.todayTotal();
  assert.strictEqual(t.usd, 0, 'a missing ledger reads as zero, not as a throw');
  ok('an absent ledger reads as an empty day');
}
{
  ledger.record({ usd: 0.25, model: 'claude-sonnet-5', source: 'app' });
  ledger.record({ usd: 0.10, model: 'claude-sonnet-5', source: 'worker' });
  const t = ledger.todayTotal();
  assert.ok(Math.abs(t.usd - 0.35) < 1e-9, 'totals add across sources: ' + t.usd);
  assert.strictEqual(t.calls, 2);
  // THE POINT OF THE WHOLE EXERCISE: the worker's spend is IN the number the budget reads.
  assert.ok(Math.abs(t.bySource.worker - 0.10) < 1e-9, 'worker spend is attributed, not merged away');
  assert.ok(Math.abs(t.bySource.app - 0.25) < 1e-9);
  ok('app and worker spend land in ONE total, each attributable to its source');
}
{
  // "The worker is expensive" and "the app is expensive" are different problems with different
  // fixes, and the ledger could not previously tell them apart at all.
  const t = ledger.todayTotal();
  assert.deepStrictEqual(Object.keys(t.bySource).sort(), ['app', 'worker']);
  ok('bySource distinguishes who spent it');
}
{
  ledger.recordTool('flux', 0.02);
  const t = ledger.todayTotal();
  assert.ok(Math.abs(t.usd - 0.37) < 1e-9, 'a paid tool folds into the same daily total');
  assert.ok(Math.abs(t.toolUsd - 0.02) < 1e-9);
  assert.ok(Math.abs(t.byTool.flux - 0.02) < 1e-9);
  // A tool spend has no model and no token count; putting it in byModel would be a nonsense entry.
  assert.ok(!Object.keys(t.byModel).includes('flux'), 'and does NOT appear as a model');
  ok('paid tools are in the total, separately accounted, never faked as a model');
}
{
  for (const bad of [{ usd: 0 }, { usd: NaN }, { usd: Infinity }, {}]) {
    assert.strictEqual(ledger.record(bad), null, 'a non-spend is not recorded: ' + JSON.stringify(bad));
  }
  const t = ledger.todayTotal();
  assert.strictEqual(t.calls, 2, 'and does not inflate the call count');
  ok('a zero or non-finite amount is ignored rather than corrupting the day');
}
{
  // Failing to RECORD a cost must never fail the work that incurred it.
  fs.writeFileSync(ledger.COSTS_PATH, '{ this is not json');
  assert.doesNotThrow(() => ledger.todayTotal(), 'a corrupt ledger reads as empty');
  assert.doesNotThrow(() => ledger.record({ usd: 0.01, model: 'x', source: 'app' }));
  assert.ok(ledger.todayTotal().usd > 0, 'and the next write starts a clean ledger');
  ok('a corrupt file degrades to a fresh ledger instead of throwing into the caller');
}
{
  const led = ledger.read();
  led['2020-01-01'] = { usd: 99, calls: 1, byModel: {} };
  fs.writeFileSync(ledger.COSTS_PATH, JSON.stringify(led));
  ledger.record({ usd: 0.01, model: 'x', source: 'app' });
  assert.ok(!ledger.read()['2020-01-01'], 'entries older than the retention window are pruned on write');
  assert.ok(ledger.read()[today()], 'today survives');
  ok('the ledger prunes itself and cannot grow without bound');
}

os.homedir = realHome;
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`[costledger] ${pass} assertions passed`);
