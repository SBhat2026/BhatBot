'use strict';
// Proactive scheduler (item 5) — lets BhatBot run tasks on its own: reminders, recurring jobs,
// "every morning…", "in 30 minutes…", periodic checks. Pure store + due-time logic here (no
// Electron deps, so it's unit-testable); main.js owns the tick loop + actually runs each task
// through the agent. Persisted to ~/.bhatbot/schedules.json so schedules survive restarts.
const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE = path.join(os.homedir(), '.bhatbot', 'schedules.json');

function load() { try { const a = JSON.parse(fs.readFileSync(STORE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function save(list) { try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(list, null, 2)); } catch {} }
function genId() { return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Next fire time (epoch ms) for a schedule, strictly after `from`.
//  kind 'daily'    → next HH:MM (at) each day
//  kind 'weekly'   → next HH:MM on `dow` (0=Sun..6=Sat)
//  kind 'interval' → from + everyMs
//  kind 'once'     → the runAt instant (no repeat)
function computeNext(s, from = Date.now()) {
  if (s.kind === 'once') { const t = Date.parse(s.runAt); return isNaN(t) ? null : t; }
  if (s.kind === 'interval') { const e = Number(s.everyMs); return e > 0 ? from + e : null; }
  if (s.kind === 'daily' || s.kind === 'weekly') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.at || '')); if (!m) return null;
    const h = +m[1], min = +m[2];
    const d = new Date(from); d.setSeconds(0, 0); d.setHours(h, min, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    if (s.kind === 'weekly' && s.dow != null) {
      let guard = 0;
      while (d.getDay() !== Number(s.dow) && guard++ < 8) d.setDate(d.getDate() + 1);
    }
    return d.getTime();
  }
  return null;
}

function add(partial = {}) {
  const list = load();
  const now = Date.now();
  const s = {
    id: genId(),
    title: String(partial.title || partial.prompt || 'task').slice(0, 100),
    prompt: String(partial.prompt || '').slice(0, 2000),
    kind: ['daily', 'weekly', 'interval', 'once'].includes(partial.kind) ? partial.kind : 'once',
    at: partial.at || null,            // 'HH:MM' for daily/weekly
    dow: partial.dow != null ? Number(partial.dow) : null,  // 0-6 for weekly
    everyMs: partial.everyMs != null ? Number(partial.everyMs) : null,
    runAt: partial.runAt || null,      // ISO for once
    enabled: partial.enabled !== false,
    announce: partial.announce !== false,   // speak the result aloud
    notify: partial.notify !== false,       // forward to Telegram
    lastRun: null,
    createdAt: new Date(now).toISOString(),
  };
  s.nextRun = computeNext(s, now);
  if (!s.prompt) return { error: 'prompt required' };
  if (s.nextRun == null) return { error: 'could not compute a fire time — check kind/at/everyMs/runAt' };
  list.push(s); save(list);
  return { success: true, schedule: s };
}

function remove(id) {
  const list = load(); const i = list.findIndex((s) => s.id === id);
  if (i === -1) return { error: 'no schedule with id ' + id };
  const [s] = list.splice(i, 1); save(list);
  return { success: true, removed: s };
}

function setEnabled(id, enabled) {
  const list = load(); const s = list.find((x) => x.id === id);
  if (!s) return { error: 'no schedule with id ' + id };
  s.enabled = !!enabled;
  if (s.enabled && (s.nextRun == null || s.nextRun <= Date.now())) s.nextRun = computeNext(s, Date.now());
  save(list);
  return { success: true, schedule: s };
}

function list() { return load(); }

// Schedules whose time has come (enabled + nextRun due). Caller runs them, then calls markRan.
function due(from = Date.now()) { return load().filter((s) => s.enabled && s.nextRun != null && s.nextRun <= from); }

// After running: record lastRun, advance nextRun (or disable a fired 'once').
function markRan(id, when = Date.now()) {
  const all = load(); const s = all.find((x) => x.id === id);
  if (!s) return;
  s.lastRun = new Date(when).toISOString();
  if (s.kind === 'once') { s.enabled = false; s.nextRun = null; }
  else s.nextRun = computeNext(s, when);
  save(all);
}

module.exports = { load, save, add, remove, setEnabled, list, due, markRan, computeNext, STORE };
