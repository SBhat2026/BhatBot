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

// ── TIME ZONES ────────────────────────────────────────────────────────────────────────────────────
// "7am" is meaningless without a zone. A schedule carries `tz`:
//   • an IANA zone ('America/New_York')  — PINNED. Fires at that wall-clock time wherever you are.
//   • 'auto' (the default)                — follows the machine's zone, so travel just works: the Mac
//                                           picks up the local zone and 7am stays 7am where you are.
// HOME_TZ is the fallback when the system zone can't be resolved. It is NOT a second source of truth
// for 'auto' — reading it there would mean a traveller gets home-time, which is the opposite of what
// 'auto' promises.
const HOME_TZ = 'America/New_York';

function systemTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || HOME_TZ; } catch { return HOME_TZ; }
}
function resolveTz(tz) {
  if (!tz || tz === 'auto' || tz === 'local') return systemTz();
  return tz;
}
// The wall-clock fields an instant shows in a given zone.
function zonedParts(ms, tz) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms))) p[type] = value;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    h: (+p.hour) % 24, mi: +p.minute, s: +p.second,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}
// The UTC instant at which a given wall-clock time occurs in a zone. Two passes because the offset
// itself depends on the instant — the naive `new Date().setHours()` this replaced silently drifted by
// an hour across a DST boundary, so a 7am job became 6am or 8am twice a year.
function zonedTimeToMs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const off1 = Date.UTC(...(({ y, mo, d, h, mi, s }) => [y, mo - 1, d, h, mi, s])(zonedParts(guess, tz))) - guess;
  const t1 = guess - off1;
  const off2 = Date.UTC(...(({ y, mo, d, h, mi, s }) => [y, mo - 1, d, h, mi, s])(zonedParts(t1, tz))) - t1;
  return guess - off2;
}

// Next fire time (epoch ms) for a schedule, strictly after `from`.
//  kind 'daily'    → next HH:MM (at) each day, in the schedule's zone
//  kind 'weekly'   → next HH:MM on `dow` (0=Sun..6=Sat), in the schedule's zone
//  kind 'interval' → from + everyMs  (zone-independent by definition)
//  kind 'once'     → the runAt instant (no repeat)
function computeNext(s, from = Date.now()) {
  if (s.kind === 'once') { const t = Date.parse(s.runAt); return isNaN(t) ? null : t; }
  if (s.kind === 'interval') { const e = Number(s.everyMs); return e > 0 ? from + e : null; }
  if (s.kind === 'daily' || s.kind === 'weekly') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.at || '')); if (!m) return null;
    const h = +m[1], min = +m[2];
    if (h > 23 || min > 59) return null;
    const tz = resolveTz(s.tz);
    let { y, mo, d } = zonedParts(from, tz);
    // Walk forward a day at a time in WALL-CLOCK terms, re-resolving the instant each step so DST
    // transitions and month/year rollovers are handled by the zone, not by us.
    for (let i = 0; i < 9; i++) {
      const cand = zonedTimeToMs(y, mo, d, h, min, tz);
      const parts = zonedParts(cand, tz);
      const dowOk = s.kind !== 'weekly' || s.dow == null || parts.dow === Number(s.dow);
      if (cand > from && dowOk) return cand;
      const nxt = new Date(Date.UTC(y, mo - 1, d + 1));   // advance one calendar day
      y = nxt.getUTCFullYear(); mo = nxt.getUTCMonth() + 1; d = nxt.getUTCDate();
    }
    return null;
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
    tz: partial.tz || 'auto',          // IANA zone, or 'auto' = follow the machine (so travel adapts)
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

module.exports = { load, save, add, remove, setEnabled, list, due, markRan, computeNext, systemTz, resolveTz, zonedParts, zonedTimeToMs, HOME_TZ, STORE };
