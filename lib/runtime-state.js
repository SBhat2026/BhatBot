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

// --- structured event log ---
function event(kind, data = {}) {
  try {
    fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
    try { if (fs.statSync(EVENTS_PATH).size > 5 * 1024 * 1024) fs.writeFileSync(EVENTS_PATH, ''); } catch {}
    fs.appendFileSync(EVENTS_PATH, JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n');
    scheduleWrite();   // an event likely changed state → refresh the snapshot soon
  } catch {}
}
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

module.exports = { pushActivity, getActivity, event, recentEvents, bind, snapshot, writeStateNow, startSnapshotLoop, STATE_PATH, EVENTS_PATH };
