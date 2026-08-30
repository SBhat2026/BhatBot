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
  'let _rosterCache = null, _rosterAt = 0;',
  'const ROSTER_TTL_MS = 30000;',
  grab('const JOB_STATE ='),
  main.slice(main.indexOf('const FLEET_STATE ='), main.indexOf('};', main.indexOf('const FLEET_STATE =')) + 2),
  grab('const PRESENCE_CAP ='),
].join('\n');

// `subagents` must be injected too, or the standing-roster branch silently throws into its own
// try/catch and every assertion about it passes vacuously — the test would still be green while
// testing nothing. Default to the real roster shape; pass [] to model "no specialists configured".
function build(fleetAgents, jobs, standing) {
  const jobsBus = { active: () => jobs, list: () => jobs };
  const roster = standing === undefined
    ? [{ name: 'research', codename: 'ORACLE', turns: 3 }, { name: 'coding', codename: 'FORGE', turns: 0 }, { name: 'lifeadmin', codename: 'WARDEN', turns: 12 }]
    : standing;
  const subagents = { list: () => roster };
  // presenceSnapshot reads the roster through standingRoster(), a 30s-TTL cache added because
  // subagents.list() reads one history FILE PER SPECIALIST and the presence feed polls every 1.2s —
  // ~150 file reads a minute to draw three idle characters. Extract it alongside so the test
  // exercises the real path rather than a shape that no longer exists.
  return new Function('fleetAgents', 'jobsBus', 'subagents',
    prelude + '\n' + extract(main, 'standingRoster') + '\n' + extract(main, 'presenceSnapshot') + '\nreturn presenceSnapshot;')(fleetAgents, jobsBus, subagents);
}

// --- THE bug: every agent must carry an id, or the click handler drops it ---------------------
{
  const fa = new Map([['suit-1', { role: 'research', codename: 'ORACLE', task: 'scan the repo', status: 'running', step: 'grep', ts: 1000 }]]);
  const snap = build(fa, [], [])();
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
  const snap = build(fa, [{ id: 'j1', name: 'weaver', status: 'running', note: 'linking' }], [])();
  ok(snap.agents.length === 2, 'fleet suits AND background jobs share one roster');
  ok(snap.agents[0].id === 'suit-a', 'steerable suits rank first');
  ok(snap.agents[1].id === 'job:j1', 'jobs get a namespaced id so they can never collide with a suit id');
  ok(snap.agents[1].steerable === false, 'background jobs are not steerable');
  ok(snap.agents[1].state === 'working', 'job status maps through JOB_STATE');
}

// --- status → state mapping edge cases --------------------------------------------------------
{
  const st = (status) => build(new Map([['x', { role: 'r', status }]]), [], [])().agents[0].state;
  ok(st('queued') === 'thinking', 'queued reads as thinking');
  ok(st('stopping') === 'working', 'stopping still reads as working (it is winding down, not dead)');
  ok(st('parked') === 'idle', 'a rate-limit park is a waiting agent, not an error');
  ok(st('failed') === 'error', 'failed → error');
  ok(st('done') === 'done', 'done → done');
  ok(st('weird-unknown-status') === 'idle', 'unknown status degrades to idle rather than undefined');
  ok(build(new Map([['x', { role: 'r' }]]), [], [])().agents[0].state === 'thinking', 'missing status defaults to queued/thinking');
}

// --- capacity + resilience --------------------------------------------------------------------
{
  const fa = new Map();
  for (let i = 0; i < 30; i++) fa.set('s' + i, { role: 'r', status: 'working' });
  const snap = build(fa, [], [])();
  ok(snap.agents.length === 12, 'roster caps at PRESENCE_CAP (the office has 18 anchors)');
}
{
  const fa = new Map();
  for (let i = 0; i < 12; i++) fa.set('s' + i, { role: 'r', status: 'working' });
  const jobs = [{ id: 'j1', name: 'x', status: 'running' }];
  ok(build(fa, jobs, [])().agents.every((a) => a.steerable), 'a full suit roster crowds jobs out, not the other way round');
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
  const snap = build(new Map(), [], [])();
  ok(Array.isArray(snap.agents) && snap.agents.length === 0, 'nothing running AND no specialists → empty array (NOT skipped)');
  // The old startPresenceFeed early-returned on this case, so the renderer never left demo mode and
  // hover/click stayed disabled forever. An empty push must be a real, deliverable payload.
}

// ── THE STANDING ROSTER — why the office is no longer empty at rest ───────────────────────────
// The FLEET tab showed an immaculate unoccupied room whenever nothing was mid-flight, which is most
// of the time. Every part of it worked — the scene rendered, the feed pushed — the roster was just
// empty, because it only ever contained IN-FLIGHT work. The long-lived specialists in
// lib/subagents.js genuinely exist and persist, so drawing them idle is honest, not decorative.
{
  const snap = build(new Map(), [])();
  ok(snap.agents.length === 3, 'with nothing running, the standing specialists populate the office');
  ok(snap.agents.every((a) => a.state === 'idle'), 'and they are drawn IDLE — grey in the legend, not pretending to work');
  ok(snap.agents.every((a) => a.standing === true), 'each is flagged `standing` so the UI can tell available from busy');
  ok(snap.agents.every((a) => a.steerable === false), 'and none is steerable — there is no suit-card until it actually runs');
  ok(snap.agents.map((a) => a.name).join(',') === 'ORACLE,FORGE,WARDEN', 'they carry their codenames, so identity matches every other surface');
  ok(snap.agents.every((a) => a.id.startsWith('sub:')), 'ids are namespaced, so they can never collide with a suit or job id');
  ok(/3 turns of history/.test(snap.agents[0].task), 'the hover card says how much history each specialist carries');
  ok(/no history yet/.test(snap.agents[1].task), '…and says so plainly when there is none');
}
{
  // A live run must WIN the anchor: the character you see working is the one actually working.
  const fa = new Map([['suit-1', { role: 'research', codename: 'ORACLE', status: 'running', task: 'digging' }]]);
  const snap = build(fa, [])();
  const oracles = snap.agents.filter((a) => a.name === 'ORACLE');
  ok(oracles.length === 1, 'a specialist that is actually running is NOT also drawn as a standing idle copy');
  ok(oracles[0].steerable === true && oracles[0].state === 'working', 'and the surviving one is the live, steerable, working entry');
  ok(snap.agents.length === 3, 'the other specialists still stand by');
}
{
  // Real work must never be crowded out by decoration.
  const fa = new Map();
  for (let i = 0; i < 12; i++) fa.set('s' + i, { role: 'r', status: 'working' });
  const snap = build(fa, [])();
  ok(snap.agents.length === 12 && snap.agents.every((a) => a.steerable), 'at capacity the standing roster yields entirely to live agents');
}

// --- long fields are bounded so a runaway task string can't bloat every 1.2s frame -------------
{
  const fa = new Map([['s', { role: 'r', status: 'working', task: 'x'.repeat(999), step: 'y'.repeat(999) }]]);
  const a = build(fa, [], [])().agents[0];
  ok(a.task.length === 160, 'task clipped to 160 chars');
  ok(a.step.length === 120, 'step clipped to 120 chars');
}

// ── a BACKGROUND run is visible but not steerable ─────────────────────────────────────────────
// The backlog worker borrows fleetAgents so the office animates from real work. presenceSnapshot
// used to assert `steerable: true` for every fleetAgents entry, so clicking one called
// openAgentWindow() for an agent with no monitor stream and no suit-card — the same dead-window bug
// already fixed for `job:*`, reintroduced through a different door the moment another subsystem
// started writing to that map. `steerable` is now DERIVED from the entry.
{
  const fa = new Map([
    ['suit-1', { role: 'code', codename: 'FORGE', status: 'running', task: 'a real fleet suit' }],
    ['backlog:x', { role: 'research', codename: 'ORACLE', status: 'working', task: 'a backlog item', background: true }],
  ]);
  const snap = build(fa, [], [])();
  const suit = snap.agents.find((a) => a.id === 'suit-1');
  const bg = snap.agents.find((a) => a.id === 'backlog:x');
  ok(suit.steerable === true, 'a real fleet suit stays steerable — it has a card and a feedback queue that is actually drained');
  ok(bg.steerable === false, 'a background run is NOT steerable — nothing reads its feedback and it has no monitor');
  ok(bg.state === 'working' && bg.task === 'a backlog item', 'but it is still fully visible: state, task and hover text all work');
  ok(bg.name === 'ORACLE', 'and it carries the specialist codename, so it is the same identity everywhere');
}


// ── WHEN THE OFFICE RAISES ITSELF (lib/pure.shouldRaiseFleet) ────────────────────────────────────
// Three tools used to raise the FLEET panel themselves, so the auto-switch covered those three and
// nothing else — a DAG fan-out, a delegated project or a background specialist all started work with
// the panel still showing chat. The rule now lives at the single point every agent heartbeat passes
// through, and lives in lib/pure so it can be read and tested rather than inferred from a call site.
{
  const { shouldRaiseFleet, FLEET_RAISE_COOLDOWN_MS } = require('../lib/pure');
  const NEVER = Infinity;

  ok(shouldRaiseFleet({ id: 'a', status: 'working' }, [], NEVER).raise,
    'fleet: the first agent to start work in a quiet office raises it');
  ok(shouldRaiseFleet({ id: 'a', state: 'thinking' }, [], NEVER).raise,
    'fleet: thinking counts as starting work, not just working');

  // A five-agent fan-out must switch ONCE. Agents 2..N see agent 1 already working.
  ok(!shouldRaiseFleet({ id: 'b', status: 'working' }, [{ id: 'a', status: 'working' }], 500).raise,
    'fleet: a second agent does not raise it again — one switch per fan-out');
  ok(/already working/.test(shouldRaiseFleet({ id: 'b', status: 'working' }, [{ id: 'a', status: 'working' }], 500).why),
    'fleet: and it says why it declined, so a missing switch is explainable');

  ok(!shouldRaiseFleet({ id: 'a', status: 'done' }, [], NEVER).raise,
    'fleet: an agent FINISHING is not a reason to yank the screen');
  ok(!shouldRaiseFleet({ id: 'a', status: 'failed' }, [], NEVER).raise, 'fleet: nor is one failing');
  ok(!shouldRaiseFleet({ id: 'a', status: 'queued' }, [], NEVER).raise, 'fleet: nor is one being queued');

  ok(!shouldRaiseFleet({ id: 'bl', status: 'working', background: true }, [], NEVER).raise,
    'fleet: the idle backlog worker never hijacks the panel — it is not something Siddhant asked for');

  ok(!shouldRaiseFleet({ id: 'd', status: 'working' }, [], FLEET_RAISE_COOLDOWN_MS - 1).raise,
    'fleet: throttled inside the cooldown');
  ok(shouldRaiseFleet({ id: 'd', status: 'working' }, [], FLEET_RAISE_COOLDOWN_MS + 1).raise,
    'fleet: a genuinely new fan-out after the cooldown raises it again');

  // An agent that has gone idle is not "already working", so the next real start still counts.
  ok(shouldRaiseFleet({ id: 'b', status: 'working' }, [{ id: 'a', status: 'done' }], NEVER).raise,
    'fleet: a finished agent lying around does not suppress the next real start');
  ok(shouldRaiseFleet({ id: 'a', status: 'working' }, [{ id: 'a', status: 'working' }], NEVER).raise,
    'fleet: an agent is not counted as its own competition');

  for (const junk of [undefined, null, {}, { id: 'x' }]) {
    const r = shouldRaiseFleet(junk || {}, [{ id: 'y' }, null], NEVER);
    ok(r && typeof r.raise === 'boolean', 'fleet: junk input returns a decision rather than throwing');
  }
}

console.log(`✅ presence: ${pass} assertions passed`);
