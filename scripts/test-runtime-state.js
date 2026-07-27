#!/usr/bin/env node
'use strict';
// Tests for lib/runtime-state.js — the "direct line to BhatBot's current state" (state.json snapshot +
// events.jsonl structured log + activity ring) that patrol and self-heal read. Verifies the activity
// ring (channel filter, cap, since-cursor), structured event append/read, snapshot built from injected
// getters with graceful defaults when a getter throws, and the ATOMIC state.json write. Temp $HOME
// isolation. Wired into `npm run verify`.
//   node scripts/test-runtime-state.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-rstate-'));
process.env.HOME = TMP;
const rs = require('../lib/runtime-state');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- activity ring: channel filter ----
rs.pushActivity('chat-message', { text: 'should be ignored' });
ok(rs.getActivity(0).events.length === 0, 'pushActivity: ignores non tool-* channels');

rs.pushActivity('tool-update', { type: 'thinking', text: 'planning the build' });
let a = rs.getActivity(0);
ok(a.events.length === 1 && a.events[0].text === 'planning the build', 'pushActivity: captures tool-update text');
ok(a.events[0].kind === 'thinking', 'pushActivity: derives kind from data.type');

rs.pushActivity('tool-result', { name: 'web_search' });   // no text/note → uses name
ok(rs.getActivity(0).events.some((e) => e.text === 'web_search'), 'pushActivity: falls back to data.name when no text');

// ---- since cursor ----
const cursor = rs.getActivity(0).seq;
rs.pushActivity('tool-start', { text: 'newest' });
const after = rs.getActivity(cursor);
ok(after.events.length === 1 && after.events[0].text === 'newest', 'getActivity(since): returns only events after the cursor');

// ---- structured event log ----
rs.event('error', { msg: 'something failed' });
const evs = rs.recentEvents(50);
ok(evs.some((e) => e.kind === 'error' && e.msg === 'something failed'), 'event/recentEvents: structured row round-trips');
// NB: pushActivity mirrors via event('activity', {kind,text}) but the {...data} spread lets data.kind
// win, so the mirrored row is labeled by its inner kind (e.g. "thinking"), not "activity". Cosmetic —
// nothing filters on "activity"; patrol's error-spike filter keys on kind==="error" (set correctly).
ok(evs.some((e) => e.text === 'planning the build'), 'event: pushActivity mirrors activity text into the structured log');
ok(evs.every((e) => typeof e.ts === 'string'), 'event: every row has an ISO ts');

// ---- snapshot from injected getters ----
rs.bind({ agent: () => ({ state: 'running', lastUser: 'hi' }), health: () => ({ cloud: true, crashes: 0 }), jobs: () => [{ id: 1 }, { id: 2 }] });
const snap = rs.snapshot();
ok(snap.agent.state === 'running' && snap.health.cloud === true && snap.jobs.length === 2, 'snapshot: pulls live values from bound getters');
ok(typeof snap.pid === 'number' && typeof snap.uptimeSec === 'number' && typeof snap.ts === 'string', 'snapshot: includes pid/uptime/ts');
ok(Array.isArray(snap.activity), 'snapshot: includes the recent activity slice');

// ---- snapshot graceful when a getter THROWS ----
rs.bind({ health: () => { throw new Error('boom'); } });
const snap2 = rs.snapshot();
ok(JSON.stringify(snap2.health) === '{}', 'snapshot: a throwing getter degrades to {} (never crashes the snapshot)');

// ---- atomic state.json write ----
rs.writeStateNow();
ok(fs.existsSync(rs.STATE_PATH), 'writeStateNow: state.json written');
let parsed = null; try { parsed = JSON.parse(fs.readFileSync(rs.STATE_PATH, 'utf8')); } catch {}
ok(parsed && parsed.agent && typeof parsed.uptimeSec === 'number', 'writeStateNow: state.json is valid JSON with live fields');
ok(!fs.existsSync(rs.STATE_PATH + '.tmp'), 'writeStateNow: no leftover .tmp (atomic rename completed)');

// ---- ring cap at 200 ----
for (let i = 0; i < 250; i++) rs.pushActivity('tool-update', { text: 'evt' + i });
ok(rs.getActivity(0).events.length === 200, 'activity ring: capped at 200 entries (oldest evicted)');

// ---- trace / span ids ----
// A TRACE is one agent turn; a SPAN is one tool call inside it. traceId is ambient (set once per turn,
// auto-stamped onto every event) so a 10-hour run can be reconstructed after the fact; spanId is
// explicit because concurrent PARALLEL_SAFE tools would otherwise be mis-attributed.
{
  ok(rs.currentTrace() === null, 'trace: no ambient trace by default');
  rs.event('untraced', { k: 1 });
  ok(rs.recentEvents(5).some((e) => e.kind === 'untraced' && e.traceId === undefined), 'trace: events outside a trace carry no traceId');

  const t1 = rs.startTrace();
  ok(typeof t1 === 'string' && t1.startsWith('t_'), 'startTrace: returns a t_-prefixed id');
  ok(rs.currentTrace() === t1, 'startTrace: sets the ambient trace');

  rs.event('turn', { text: 'do the thing' });
  rs.event('tool', { spanId: rs.newId('s'), name: 'read_file', ms: 12, status: 'ok' });
  rs.event('tool', { spanId: rs.newId('s'), name: 'run_shell', ms: 900, status: 'error', error: 'boom' });

  const mine = rs.traceEvents(t1);
  ok(mine.length === 3, 'traceEvents: returns exactly the events recorded under this trace');
  ok(mine.every((e) => e.traceId === t1), 'event: ambient traceId auto-stamped on every row');
  ok(mine[0].kind === 'turn' && mine[2].name === 'run_shell', 'traceEvents: preserves chronological order');
  const spans = mine.filter((e) => e.spanId);
  ok(spans.length === 2 && spans[0].spanId !== spans[1].spanId, 'newId: each span gets a distinct id');
  ok(spans.every((e) => e.spanId.startsWith('s_')), 'newId: span ids are s_-prefixed');
  ok(spans.some((e) => e.status === 'error' && e.error === 'boom'), 'tool span: failures record status + error');

  // An explicit traceId in data must beat the ambient one (how a resumed mission re-parents its work).
  rs.event('adopted', { traceId: 't_explicit' });
  ok(rs.recentEvents(5).some((e) => e.kind === 'adopted' && e.traceId === 't_explicit'), 'event: explicit data.traceId overrides the ambient one');

  // Two turns must not share a trace.
  const t2 = rs.startTrace();
  ok(t2 !== t1, 'startTrace: a second turn gets a fresh id');
  rs.event('turn', { text: 'second turn' });
  ok(rs.traceEvents(t1).length === 3, 'traceEvents: the first trace is unaffected by the second');
  ok(rs.traceEvents(t2).length === 1, 'traceEvents: the second trace is isolated');

  ok(rs.endTrace() === t2 && rs.currentTrace() === null, 'endTrace: clears the ambient trace and returns it');
  rs.event('after', {});
  ok(rs.recentEvents(3).some((e) => e.kind === 'after' && e.traceId === undefined), 'endTrace: later events are untraced again');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
