#!/usr/bin/env node
'use strict';
// Tests the drone runtime (lib/drone.js) + fleet supervisor (lib/fleet.js): scoped tools, board
// posting, envelope collection, budget accounting, hard cap, and STALL REAPING. Headless with a
// mock agentRun + real blackboard. Run: node scripts/test-fleet.js  (wired into npm run verify)
const fs = require('fs'), os = require('os'), path = require('path');
const { createDrone, scopeTools } = require('../lib/drone');
const { runFleet } = require('../lib/fleet');
const { createBlackboard } = require('../lib/blackboard');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-fleet-'));
  const board = createBlackboard({ dir });

  // ---- drone: scoped tools + identity prompt + envelope normalization ----
  {
    const drone = createDrone({ id: 'd1', persona: { name: 'TESTER', brief: 'tries to break things' }, tools: ['read_file', 'browser'], budget: { usd: 0.1, maxTurns: 3 } },
      { board, agentRun: async (ctx) => { ctx.onStep({ usd: 0.02, note: 'poking' }); return { status: 'ok', summary: 'found a bug' }; } });
    ok(drone.tools.join(',') === 'read_file,browser', 'drone: tool grant recorded');
    ok(/TESTER/.test(drone.identityPrompt()) && /LIMITED to: read_file, browser/.test(drone.identityPrompt()), 'drone: identity prompt states persona + tool limit');
    const r = await drone.run({ goal: 'break the login' });
    ok(r.status === 'ok' && r.summary === 'found a bug', 'drone: returns a normalized envelope');
    ok(r.spend.turns === 1 && r.spend.usd === 0.02, 'drone: charges spend/turns from onStep');
    ok(board.all().some((e) => e.agent === 'TESTER' && e.kind === 'finding'), 'drone: posts a finding to the board');
  }
  ok(scopeTools(['read_file'], [{ name: 'read_file' }, { name: 'run_shell' }]).length === 1, 'scopeTools: intersects grant with offered defs');

  // ---- fleet: 3 parallel drones → all collected, spend summed, all posted to board ----
  {
    const specs = [1, 2, 3].map((n) => ({ id: 'p' + n, persona: { name: 'P' + n, brief: 'worker ' + n }, tools: ['read_file'], budget: { usd: 0.5, maxTurns: 4 } }));
    const agentRun = async (ctx) => { ctx.onStep({ usd: 0.05, note: 'working' }); return { status: 'ok', summary: ctx.persona.name + ' done' }; };
    const out = await runFleet(specs, { board, agentRun, now: () => Date.now() }, { staleMs: 5000, mission: 'do work' });
    ok(out.results.filter((r) => r.status === 'ok').length === 3, 'fleet: collects 3 ok envelopes');
    ok(Math.abs(out.totalSpend - 0.15) < 1e-9, 'fleet: total spend sums correctly (3 × 0.05)');
    ok(out.launched === 3 && out.reaped === 0, 'fleet: launched all, reaped none');
  }

  // ---- fleet: hard cap limits the roster ----
  {
    const specs = Array.from({ length: 9 }, (_, i) => ({ id: 'h' + i, persona: { name: 'H' + i, brief: 'x' }, tools: ['read_file'] }));
    const agentRun = async (ctx) => ({ status: 'ok', summary: 'ok' });
    const out = await runFleet(specs, { board, agentRun }, { hardCap: 4, staleMs: 5000 });
    ok(out.launched === 4 && out.skipped === 5, 'fleet: hardCap caps launched, rest skipped');
  }

  // ---- fleet: STALL REAPING — a silent drone gets nudged then reaped as partial ----
  {
    const specs = [
      { id: 'fast', persona: { name: 'FAST', brief: 'quick' }, tools: ['read_file'] },
      { id: 'staller', persona: { name: 'STALLER', brief: 'hangs' }, tools: ['read_file'] },
    ];
    const agentRun = (ctx) => {
      if (ctx.persona.name === 'FAST') { ctx.onStep({ usd: 0.01, note: 'zoom' }); return Promise.resolve({ status: 'ok', summary: 'fast done' }); }
      // staller: never posts a heartbeat, resolves far in the future (unref'd so the test can exit)
      return new Promise((resolve) => { const t = setTimeout(() => resolve({ status: 'ok', summary: 'too late' }), 60000); if (t.unref) t.unref(); });
    };
    const out = await runFleet(specs, { board, agentRun }, { staleMs: 200, nudgeGraceMs: 150, pollMs: 50 });
    const staller = out.results.find((r) => r.persona === 'STALLER');
    const fast = out.results.find((r) => r.persona === 'FAST');
    ok(fast && fast.status === 'ok', 'fleet(reap): the healthy drone completes normally');
    ok(staller && staller.reaped === true && staller.status === 'partial', 'fleet(reap): the silent drone is reaped as partial');
    ok(board.all().some((e) => e.agent === 'FLEET' && e.kind === 'need'), 'fleet(reap): a nudge was posted before reaping');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  
// ---- B4: run persistence (a fleet's whole output used to vanish with the return value) ----
{
  const os2 = require('os'), path2 = require('path'), fs2 = require('fs');
  const { listRuns, readRun, FLEET_HARD_CAP, DRONE_ROSTER_DEFAULT } = require('../lib/fleet');
  const RUNS = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'bb-runs-'));
  const wsDir = path2.join(RUNS, 'run-12345');

  const specs = [
    { id: 'd1', persona: { name: 'SCOUT' }, _task: { goal: 'look around' } },
    { id: 'd2', persona: { name: 'SMITH' }, _task: { goal: 'build it' } },
  ];
  const out = await runFleet(specs, {
    agentRun: async (ctx) => { ctx.onStep({ text: 'working' }); return { summary: 'did ' + ctx.persona.name, spend: { usd: 0.02, turns: 1 } }; },
  }, { wsDir, mission: 'test the persistence', envelopeUsd: 5 });

  ok(out.runFile && fs2.existsSync(out.runFile), 'B4: runFleet writes run.json into the workspace');
  ok(!fs2.existsSync(out.runFile + '.tmp'), 'B4: atomic write leaves no .tmp behind');
  const rec = JSON.parse(fs2.readFileSync(out.runFile, 'utf8'));
  ok(rec.mission === 'test the persistence', 'B4: the mission is recorded');
  ok(rec.results.length === 2 && rec.results[0].summary.startsWith('did '), 'B4: per-drone results are recorded');
  ok(rec.launched === 2 && typeof rec.totalSpend === 'number', 'B4: launch count + spend recorded');
  ok(typeof rec.ms === 'number' && rec.startedAt && rec.endedAt, 'B4: timings recorded');
  ok(rec.specs.every((x) => !('tools' in x)), 'B4: only persona/role/goal persisted — never tool grants or prompts');

  const listed = listRuns({ dir: RUNS });
  ok(listed.length === 1 && listed[0].id === 'run-12345', 'B4: listRuns finds it off disk (works with the app closed)');
  ok(readRun('run-12345', { dir: RUNS }).mission === 'test the persistence', 'B4: readRun round-trips');
  ok(readRun('run-nope', { dir: RUNS }) === null, 'B4: readRun on a missing id → null, no throw');

  // A run that died before persisting must not break the listing.
  fs2.mkdirSync(path2.join(RUNS, 'run-broken'), { recursive: true });
  ok(listRuns({ dir: RUNS }).length === 1, 'B4: a run with no run.json is skipped, not fatal');
  ok(listRuns({ dir: '/no/such/dir' }).length === 0, 'B4: a missing runs dir → [], no throw');

  // Persistence must never be load-bearing: an unwritable wsDir cannot fail the fleet.
  const out2 = await runFleet([specs[0]], { agentRun: async (c) => { c.onStep({}); return { summary: 'ok' }; } },
    { wsDir: '/proc/definitely-not-writable/nope', mission: 'm' });
  ok(out2.results.length === 1, 'B4: an unwritable workspace does not fail the run');

  // B6: the two ceilings are named and exported so they cannot be confused again.
  ok(FLEET_HARD_CAP === 24, 'B6: FLEET_HARD_CAP (concurrency ceiling) exported');
  ok(DRONE_ROSTER_DEFAULT === 6, 'B6: DRONE_ROSTER_DEFAULT (per-mission roster) exported');
  ok(FLEET_HARD_CAP !== DRONE_ROSTER_DEFAULT, 'B6: they are genuinely different numbers with different jobs');
  const mainSrc = fs2.readFileSync(path2.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/FLEET_HARD_CAP/.test(mainSrc) && !/const FLEET_CAP = 24/.test(mainSrc), 'B6: main.js imports the cap instead of redeclaring 24');

  try { fs2.rmSync(RUNS, { recursive: true, force: true }); } catch {}
}

// ---- B5: synthesis/integration failures are reported, not swallowed ----
{
  const orch = require('../lib/orchestrator');
  const deps = {
    models: { sonnet: 's' }, apiKey: 'k',
    anthropicRequest: async () => { throw new Error('model exploded'); },
    runAgent: async () => ({ text: 'a take' }),
  };
  const posts = [];
  const board = { post: (e) => posts.push(e), fleetStatusBlock: () => '', read: () => [], heartbeat: () => {}, lastPost: () => null };

  const r = await orch.ensemble('do a thing', { ...deps, makeBoard: () => board }, { roles: [{ name: 'a', persona: 'p' }, { name: 'b', persona: 'p' }] });
  ok(r.synthesisError && /exploded/.test(r.synthesisError), 'B5: ensemble reports WHY synthesis failed');
  ok(r.synthesized === false, 'B5: ensemble flags that the result is unsynthesized');
  ok(r.result && r.result.length > 0, 'B5: it still falls back to the concatenated takes (behaviour unchanged)');
  ok(posts.some((p) => /synthesis failed/.test(p.text)), 'B5: the failure is posted to the shared board');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
