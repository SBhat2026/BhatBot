#!/usr/bin/env node
'use strict';
// Tests for lib/opsstatus.js — the "what is BhatBot managing" aggregator. Pure (probes injected).
// Verifies service-state mapping, the summary line, and that a THROWING probe degrades gracefully
// (one broken subsystem must not break the whole snapshot). In `npm run verify`.
const assert = require('assert');
const ops = require('../lib/opsstatus.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const deps = {
  selfheal: () => ({ enabled: true, queue: [{}, {}], today: 1 }),
  selfdrive: () => ({ enabled: true, running: true, lastSession: { branch: 'self-drive-x', resolved: 2 } }),
  patrolOn: () => true,
  ambient: () => ({ enabled: false }),
  schedules: () => [{ id: 's1', title: 'Morning brief', kind: 'daily', nextRun: '2026-07-01T13:00:00Z', enabled: true }, { id: 's2', title: 'old', enabled: false }],
  health: () => ({ configured: true, monitoring: true, last_sync: '2026-06-30T08:00:00Z' }),
  cloudConnected: () => true,
  fleet: () => ({ active: 3, agents: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] }),
  budgets: () => [{ model: 'claude-sonnet-4-6', outFree: 80000, outSafe: 81000 }],
  costToday: () => ({ usd: 1.23, calls: 40 }),
  recentEvents: () => Array.from({ length: 30 }, (_, i) => ({ kind: 'tool', i })),
};

const s = ops.gather(deps);
ok(Array.isArray(s.services) && s.services.length === 7, 'gather: 7 services');
const byName = Object.fromEntries(s.services.map((x) => [x.name, x]));
ok(byName['Self-heal'].state === 'on' && /2 queued/.test(byName['Self-heal'].detail), 'service: self-heal on with queue detail');
ok(byName['Self-drive'].state === 'running', 'service: self-drive running');
ok(byName['Patrol'].state === 'on', 'service: patrol on');
ok(byName['Ambient'].state === 'off', 'service: ambient off');
ok(byName['Scheduler'].state === 'on' && byName['Scheduler'].next === '2026-07-01T13:00:00Z', 'service: scheduler next run');
ok(byName['Health monitor'].state === 'on', 'service: health monitor on');
ok(s.fleet.active === 3, 'gather: fleet active count');
ok(s.schedules.length === 2 && s.schedules.filter((x) => x.enabled).length === 1, 'gather: schedules with enabled flag');
ok(s.recent_events.length === 20, 'gather: recent events capped at 20');
ok(/services active/.test(s.summary) && /3 agents/.test(s.summary), 'gather: summary line');

// graceful degradation — a throwing probe must not crash gather()
const s2 = ops.gather({ selfheal: () => { throw new Error('boom'); }, schedules: () => { throw new Error('boom'); } });
ok(s2 && s2.services.find((x) => x.name === 'Self-heal').state === 'unknown', 'degrade: throwing probe → state unknown, no crash');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
