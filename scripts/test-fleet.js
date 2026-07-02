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
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
