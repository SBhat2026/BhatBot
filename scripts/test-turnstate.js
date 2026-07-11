'use strict';
// T2 — lib/turnstate.js reducer tests. Pure reducer: transitions, plan ticking, snapshot
// isolation, subscriber notification, monotonic seq, and graceful ignore of junk events.
const assert = require('assert');
const { createTurnState } = require('../lib/turnstate');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// --- fresh state is idle/empty ---
{
  const ts = createTurnState();
  const s = ts.snapshot();
  ok(s.status === 'idle', 'starts idle');
  ok(Array.isArray(s.plan) && s.plan.length === 0, 'empty plan');
  ok(s.seq === 0, 'seq starts at 0');
  ok(!('_active' in s), 'internal _active stripped from snapshot');
}

// --- turn_start → working, carries the ask ---
{
  const ts = createTurnState();
  const s = ts.reduce({ type: 'turn_start', text: 'read my email then add it to my calendar', ts: 100 });
  ok(s.status === 'working', 'turn_start → working');
  ok(s.turnText.startsWith('read my email'), 'turn_start captures ask');
  ok(s.seq === 1, 'seq incremented');
}

// --- plan populates checklist, ticks one item per tool_done, all done on clean finish ---
{
  const ts = createTurnState();
  ts.reduce({ type: 'turn_start', text: 'do a, b, c' });
  let s = ts.reduce({ type: 'plan', steps: ['step a', 'step b', 'step c'] });
  ok(s.plan.length === 3 && s.plan.every((p) => !p.done), 'plan seeded, none done');
  ok(s.phase === 'executing', 'plan sets executing phase');

  s = ts.reduce({ type: 'tool_start', name: 'run_shell', narrate: 'running a' });
  ok(s.status === 'tool' && s.currentStep === 'running a', 'tool_start sets tool status + narrate');

  s = ts.reduce({ type: 'tool_done', name: 'run_shell', ok: true });
  ok(s.toolsRan === 1, 'toolsRan counted');
  ok(s.plan[0].done && !s.plan[1].done, 'first plan item ticked, second still open');
  ok(s.status === 'working', 'back to working after tool');

  s = ts.reduce({ type: 'tool_done', name: 'gmail', ok: false });
  ok(s.plan[1].done, 'second item ticked on next tool');
  ok(/failed — recovering/.test(s.currentStep), 'failed tool surfaces recovery step');
  ok(s.tools.length === 2 && s.tools[1].ok === false, 'tool ring records failure');

  s = ts.reduce({ type: 'turn_done' });
  ok(s.status === 'done', 'clean finish → done');
  ok(s.plan.every((p) => p.done), 'all plan items marked done on clean finish');
  ok(s.currentStep === '', 'currentStep cleared on finish');
}

// --- stopped + error finishes ---
{
  const ts = createTurnState();
  ts.reduce({ type: 'turn_start', text: 'x' });
  ok(ts.reduce({ type: 'turn_done', stopped: true }).status === 'stopped', 'stopped finish');
  const e = ts.reduce({ type: 'turn_done', error: 'boom' });
  ok(e.status === 'error' && e.error === 'boom', 'error finish carries message');
}

// --- model/provider fold, claude- prefix + date suffix stripped ---
{
  const ts = createTurnState();
  const s = ts.reduce({ type: 'model', model: 'claude-haiku-4-5-20251001', provider: 'anthropic' });
  ok(s.model === 'haiku-4-5', 'model normalized');
  ok(s.provider === 'anthropic', 'provider recorded');
}

// --- subscribers notified with snapshot; unsubscribe works ---
{
  const ts = createTurnState();
  let hits = 0; let last = null;
  const unsub = ts.subscribe((snap) => { hits++; last = snap; });
  ts.reduce({ type: 'turn_start', text: 'y' });
  ok(hits === 1 && last && last.status === 'working', 'subscriber notified with snapshot');
  ok(!('_active' in last), 'subscriber snapshot is public-only');
  unsub();
  ts.reduce({ type: 'thinking', text: 'still going here' });
  ok(hits === 1, 'no notification after unsubscribe');
}

// --- junk / unrelated events are ignored (no throw, no seq bump) ---
{
  const ts = createTurnState();
  const before = ts.snapshot().seq;
  ts.reduce(null); ts.reduce({}); ts.reduce({ type: 'guidance_applied', text: 'z' });
  ok(ts.snapshot().seq === before, 'unrelated/junk events do not bump seq');
}

// --- snapshot is a copy: mutating it does not corrupt internal state ---
{
  const ts = createTurnState();
  ts.reduce({ type: 'plan', steps: ['a', 'b'] });
  const s = ts.snapshot();
  s.plan[0].done = true; s.status = 'HACKED';
  const s2 = ts.snapshot();
  ok(!s2.plan[0].done && s2.status !== 'HACKED', 'snapshot mutation does not leak into state');
}

console.log(`✅ turnstate: ${pass} assertions passed`);
