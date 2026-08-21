'use strict';
// presenceSnapshot() tests — the UNIFIED agent roster behind the FLEET tab's 3D office.
//
// This function is why the agent dashboard never worked. It used to read jobsBus only (a different
// roster from the steerable suit-cards) and emit no `id` at all, so the renderer's click handler —
// which bails on `!e.data.id` — discarded every click that ever reached it. These tests pin the two
// invariants that fix it: every entry carries a stable id, and fleet suits (steerable) rank ahead of
// background jobs (not steerable).
//
// presenceSnapshot closes over main.js module state, so it's extracted by brace-matching and run
// with injected fakes — same approach as test-abort-pairing.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function extract(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig); if (start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}
// Pull the state maps + the function out of main.js so the test tracks the real source, not a copy.
const grab = (decl) => { const i = main.indexOf(decl); const j = main.indexOf('\n', main.indexOf(';', i)); return main.slice(i, j); };
const prelude = [
  grab('const JOB_STATE ='),
  main.slice(main.indexOf('const FLEET_STATE ='), main.indexOf('};', main.indexOf('const FLEET_STATE =')) + 2),
  grab('const PRESENCE_CAP ='),
].join('\n');

function build(fleetAgents, jobs) {
  const jobsBus = { active: () => jobs, list: () => jobs };
  return new Function('fleetAgents', 'jobsBus',
    prelude + '\n' + extract(main, 'presenceSnapshot') + '\nreturn presenceSnapshot;')(fleetAgents, jobsBus);
}

// --- THE bug: every agent must carry an id, or the click handler drops it ---------------------
{
  const fa = new Map([['suit-1', { role: 'research', codename: 'ORACLE', task: 'scan the repo', status: 'running', step: 'grep', ts: 1000 }]]);
  const snap = build(fa, [])();
  ok(snap.agents.length === 1, 'one fleet suit → one presence entry');
  ok(snap.agents[0].id === 'suit-1', 'entry carries the fleet id (the whole reason clicks were dead)');
  ok(snap.agents.every((a) => a.id), 'EVERY entry has a non-empty id');
  ok(snap.agents[0].name === 'ORACLE', 'codename preferred as the display name');
  ok(snap.agents[0].state === 'working', 'status "running" → presence state "working"');
  ok(snap.agents[0].task === 'scan the repo', 'task surfaced for the hover card');
  ok(snap.agents[0].step === 'grep', 'live step surfaced for the hover card');
  ok(snap.agents[0].steerable === true, 'fleet suits are steerable');
}

// --- both rosters in one room, suits first ----------------------------------------------------
{
  const fa = new Map([['suit-a', { role: 'code', status: 'working', task: 't' }]]);
  const snap = build(fa, [{ id: 'j1', name: 'weaver', status: 'running', note: 'linking' }])();
  ok(snap.agents.length === 2, 'fleet suits AND background jobs share one roster');
  ok(snap.agents[0].id === 'suit-a', 'steerable suits rank first');
  ok(snap.agents[1].id === 'job:j1', 'jobs get a namespaced id so they can never collide with a suit id');
  ok(snap.agents[1].steerable === false, 'background jobs are not steerable');
  ok(snap.agents[1].state === 'working', 'job status maps through JOB_STATE');
}

// --- status → state mapping edge cases --------------------------------------------------------
{
  const st = (status) => build(new Map([['x', { role: 'r', status }]]), [])().agents[0].state;
  ok(st('queued') === 'thinking', 'queued reads as thinking');
  ok(st('stopping') === 'working', 'stopping still reads as working (it is winding down, not dead)');
  ok(st('parked') === 'idle', 'a rate-limit park is a waiting agent, not an error');
  ok(st('failed') === 'error', 'failed → error');
  ok(st('done') === 'done', 'done → done');
  ok(st('weird-unknown-status') === 'idle', 'unknown status degrades to idle rather than undefined');
  ok(build(new Map([['x', { role: 'r' }]]), [])().agents[0].state === 'thinking', 'missing status defaults to queued/thinking');
}

// --- capacity + resilience --------------------------------------------------------------------
{
  const fa = new Map();
  for (let i = 0; i < 30; i++) fa.set('s' + i, { role: 'r', status: 'working' });
  const snap = build(fa, [])();
  ok(snap.agents.length === 12, 'roster caps at PRESENCE_CAP (the office has 18 anchors)');
}
{
  const fa = new Map();
  for (let i = 0; i < 12; i++) fa.set('s' + i, { role: 'r', status: 'working' });
  const jobs = [{ id: 'j1', name: 'x', status: 'running' }];
  ok(build(fa, jobs)().agents.every((a) => a.steerable), 'a full suit roster crowds jobs out, not the other way round');
}
{
  // jobsBus throwing must not take the office down — it is the lower-priority half of the roster.
  const boom = { active: () => { throw new Error('jobsBus down'); } };
  const fn = new Function('fleetAgents', 'jobsBus',
    prelude + '\n' + extract(main, 'presenceSnapshot') + '\nreturn presenceSnapshot;')(
    new Map([['s1', { role: 'r', status: 'working' }]]), boom);
  const snap = fn();
  ok(snap.agents.length === 1, 'a throwing jobsBus still yields the fleet suits');
}
{
  const snap = build(new Map(), [])();
  ok(Array.isArray(snap.agents) && snap.agents.length === 0, 'empty roster → empty array (NOT skipped)');
  // The old startPresenceFeed early-returned on this case, so the renderer never left demo mode and
  // hover/click stayed disabled forever. An empty push must be a real, deliverable payload.
}

// --- long fields are bounded so a runaway task string can't bloat every 1.2s frame -------------
{
  const fa = new Map([['s', { role: 'r', status: 'working', task: 'x'.repeat(999), step: 'y'.repeat(999) }]]);
  const a = build(fa, [])().agents[0];
  ok(a.task.length === 160, 'task clipped to 160 chars');
  ok(a.step.length === 120, 'step clipped to 120 chars');
}

console.log(`✅ presence: ${pass} assertions passed`);
