'use strict';
// Runtime state + structured event feed (the "direct line to BhatBot's current state").
// Three things, all readable from outside the app with no UI attached:
//   1. ~/.bhatbot/state.json     — a LIVE snapshot (atomic, debounced): agent state, health, jobs,
//                                  recent activity. `cat` it any time to see exactly what BhatBot is doing.
//   2. ~/.bhatbot/logs/events.jsonl — an append-only STRUCTURED event log (tool calls, errors, state
//                                  changes) — machine-parseable, unlike the human app.log tee.
//   3. the in-RAM activity ring  — moved here from main.js (self-contained), served to the phone/cloud.
//
// main.js calls bind() once with getters for its live values, then event()s flow in and a snapshot
// loop persists state.json. patrol + self-heal read snapshot() for richer, cheaper health signals.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.bhatbot');
const STATE_PATH = path.join(DIR, 'state.json');
const EVENTS_PATH = path.join(DIR, 'logs', 'events.jsonl');

// --- activity ring (moved verbatim from main.js; self-contained) ---
const activityFeed = [];
let activitySeq = 0;
function pushActivity(channel, data) {
  try {
    if (channel !== 'tool-update' && channel !== 'tool-start' && channel !== 'tool-result') return;
    const d = data || {};
    let text = d.text || d.note || d.name || d.type || '';
    if (typeof text !== 'string') text = JSON.stringify(text);
    if (!text) return;
    activityFeed.push({ id: ++activitySeq, t: Date.now(), kind: d.type || d.kind || channel, text: String(text).slice(0, 400) });
    if (activityFeed.length > 200) activityFeed.splice(0, activityFeed.length - 200);
    event('activity', { kind: d.type || d.kind || channel, text: String(text).slice(0, 240) });   // mirror into the structured log
  } catch {}
}
function getActivity(since) {
  const s = Number(since) || 0;
  return { seq: activitySeq, events: activityFeed.filter((e) => e.id > s) };
}

// --- trace context ---
// A TRACE is one agent turn (or one mission resume); a SPAN is one unit of work inside it (a model
// call, a tool call). Debugging a 10-hour run means being able to say "show me every span under
// trace X, in order" — which needs the ids present on every line of events.jsonl.
//
// traceId is AMBIENT (set once per turn by main.js) because a turn is genuinely a single logical
// scope and threading it through ~100 event() call sites would be churn for no gain. spanId is
// EXPLICIT (passed in `data`) because tools can run concurrently — an ambient span would be
// mis-attributed the moment a PARALLEL_SAFE burst interleaves. Anything in `data` wins over ambient.
let _seq = 0;
function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + (++_seq).toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6);
}
let _traceId = null;
function setTrace(traceId) { _traceId = traceId || null; return _traceId; }
function currentTrace() { return _traceId; }
function startTrace() { return setTrace(newId('t')); }
function endTrace() { const t = _traceId; _traceId = null; return t; }

// --- structured event log ---
function event(kind, data = {}) {
  try {
    fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
    try { if (fs.statSync(EVENTS_PATH).size > 5 * 1024 * 1024) fs.writeFileSync(EVENTS_PATH, ''); } catch {}
    const rec = { ts: new Date().toISOString(), kind };
    if (_traceId) rec.traceId = _traceId;      // ambient; an explicit data.traceId overrides below
    fs.appendFileSync(EVENTS_PATH, JSON.stringify({ ...rec, ...data }) + '\n');
    scheduleWrite();   // an event likely changed state → refresh the snapshot soon
  } catch {}
}
// Every event recorded under one trace, oldest first — the "reconstruct this run" query.
function traceEvents(traceId, n = 2000) { return recentEvents(n).filter((e) => e && e.traceId === traceId); }
function recentEvents(n = 50) {
  try { return fs.readFileSync(EVENTS_PATH, 'utf8').trim().split('\n').slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

// --- live snapshot (built from main.js getters) ---
let _getters = {};
function bind(getters) { _getters = { ..._getters, ...getters }; }
function snapshot() {
  const g = _getters;
  const call = (fn, d) => { try { return fn ? fn() : d; } catch { return d; } };
  return {
    ts: new Date().toISOString(),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    agent: call(g.agent, {}),
    health: call(g.health, {}),
    jobs: call(g.jobs, []),
    // B3/B4 endurance telemetry (heap, governor level, background-tick starvation). This shape is
    // fixed, so a getter that isn't listed here is bound and then silently never called — which is
    // exactly what happened: main.js bound `endurance` and state.json never carried it.
    endurance: call(g.endurance, {}),
    activity: activityFeed.slice(-25),
  };
}
function writeStateNow() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot(), null, 2));
    fs.renameSync(tmp, STATE_PATH);   // atomic replace — a reader never sees a half-written file
  } catch {}
}
let _writeTimer = null;
function scheduleWrite() {
  if (_writeTimer) return;
  _writeTimer = setTimeout(() => { _writeTimer = null; writeStateNow(); }, 1000);   // coalesce bursts
}
let _loop = null;
function startSnapshotLoop(everyMs = 5000) {
  if (_loop) return;
  writeStateNow();
  _loop = setInterval(writeStateNow, Math.max(1000, everyMs));
}

module.exports = {
  pushActivity, getActivity, event, recentEvents, bind, snapshot, writeStateNow, startSnapshotLoop,
  newId, setTrace, currentTrace, startTrace, endTrace, traceEvents,
  STATE_PATH, EVENTS_PATH,
};
