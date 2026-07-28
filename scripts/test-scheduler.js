#!/usr/bin/env node
'use strict';
// Tests for lib/scheduler.js — specifically the time-zone rewrite of computeNext.
//
// "7am" is meaningless without a zone, and the previous implementation used naive local-time
// arithmetic (`new Date().setHours()`), which silently drifted by an hour across a DST boundary —
// a 7am job quietly became 6am or 8am twice a year. It also had no way to express "this fires at
// Eastern regardless of where I am" vs "this follows me when I travel".
//
// The contract:
//   tz: 'America/New_York'  PINNED   — that wall-clock time, wherever the machine is
//   tz: 'auto' (default)    FOLLOWS  — the machine's zone, so travel just works
// Every assertion below pins the zone explicitly, so results do not depend on where this runs.
// Wired into `npm run verify`.
//   node scripts/test-scheduler.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sched-'));
process.env.HOME = TMP;
const S = require('../lib/scheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };
const wall = (ms, tz) => new Date(ms).toLocaleString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
const dayName = (ms, tz) => new Date(ms).toLocaleString('en-US', { timeZone: tz, weekday: 'short' });

// ---- zone resolution ----
ok(typeof S.systemTz() === 'string' && S.systemTz().length > 2, 'systemTz: returns an IANA zone');
ok(S.resolveTz('auto') === S.systemTz(), 'resolveTz: "auto" follows the machine (travel adapts)');
ok(S.resolveTz('local') === S.systemTz(), 'resolveTz: "local" is an alias for auto');
ok(S.resolveTz(undefined) === S.systemTz(), 'resolveTz: unset defaults to following the machine');
ok(S.resolveTz('America/New_York') === 'America/New_York', 'resolveTz: an explicit zone is pinned');
ok(S.HOME_TZ === 'America/New_York', 'HOME_TZ is Eastern (the fallback when the system zone is unresolvable)');

// ---- pinned zone fires at the right wall-clock time, from anywhere ----
{
  const from = Date.parse('2026-07-28T02:00:00Z');
  const nyc = S.computeNext({ kind: 'daily', at: '07:00', tz: 'America/New_York' }, from);
  ok(wall(nyc, 'America/New_York') === '07:00', 'daily: a pinned ET schedule fires at 07:00 Eastern');
  const ist = S.computeNext({ kind: 'daily', at: '07:00', tz: 'Asia/Kolkata' }, from);
  ok(wall(ist, 'Asia/Kolkata') === '07:00', 'daily: a pinned IST schedule fires at 07:00 India time');
  ok(nyc !== ist, 'daily: the two zones resolve to genuinely different instants');
  ok(nyc > from && ist > from, 'daily: the next fire is always strictly in the future');
}

// ---- THE DST BUG the old naive arithmetic had ----
// US spring-forward 2027-03-14 (02:00 → 03:00 ET) and fall-back 2027-11-07.
{
  const tz = 'America/New_York';
  let t = Date.parse('2027-03-12T12:00:00Z');
  const hits = [];
  for (let i = 0; i < 5; i++) { t = S.computeNext({ kind: 'daily', at: '07:00', tz }, t); hits.push(t); }
  ok(hits.every((h) => wall(h, tz) === '07:00'), 'DST: 07:00 stays 07:00 across the spring-forward (the old code drifted an hour)');
  ok(new Set(hits).size === 5, 'DST: five distinct consecutive fire times');

  let f = Date.parse('2027-11-05T12:00:00Z');
  const fallHits = [];
  for (let i = 0; i < 5; i++) { f = S.computeNext({ kind: 'daily', at: '07:00', tz }, f); fallHits.push(f); }
  ok(fallHits.every((h) => wall(h, tz) === '07:00'), 'DST: 07:00 stays 07:00 across the fall-back too');

  // A wall-clock time that does NOT EXIST on the spring-forward day (02:30 ET is skipped) must still
  // resolve to something sane rather than returning null and silently disabling the schedule.
  const skipped = S.computeNext({ kind: 'daily', at: '02:30', tz }, Date.parse('2027-03-14T05:00:00Z'));
  ok(skipped !== null && skipped > Date.parse('2027-03-14T05:00:00Z'), 'DST: a nonexistent local time still yields a future instant, not null');
}

// ---- weekly lands on the right weekday IN THAT ZONE ----
{
  const tz = 'America/New_York';
  const from = Date.parse('2026-07-28T02:00:00Z');
  for (const dow of [0, 1, 5, 6]) {
    const t = S.computeNext({ kind: 'weekly', at: '09:30', dow, tz }, from);
    const want = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
    ok(dayName(t, tz) === want && wall(t, tz) === '09:30', `weekly: dow=${dow} lands on ${want} at 09:30 in-zone`);
  }
  // The zone decides the weekday: late Sunday ET is already Monday in India.
  const sunNight = Date.parse('2026-08-03T02:00:00Z');   // Sun 22:00 ET / Mon 07:30 IST
  ok(dayName(S.computeNext({ kind: 'weekly', at: '09:00', dow: 1, tz: 'America/New_York' }, sunNight), 'America/New_York') === 'Mon',
    'weekly: the weekday is evaluated in the schedule\'s own zone');
}

// ---- kinds that are zone-independent ----
{
  const from = 1_700_000_000_000;
  ok(S.computeNext({ kind: 'interval', everyMs: 60000 }, from) === from + 60000, 'interval: from + everyMs');
  ok(S.computeNext({ kind: 'interval', everyMs: 0 }, from) === null, 'interval: a zero interval is rejected');
  ok(S.computeNext({ kind: 'once', runAt: '2027-01-01T00:00:00Z' }, from) === Date.parse('2027-01-01T00:00:00Z'), 'once: the exact instant');
  ok(S.computeNext({ kind: 'once', runAt: 'not a date' }, from) === null, 'once: an unparseable date → null');
}

// ---- malformed input is rejected, never guessed ----
{
  const from = 1_700_000_000_000;
  ok(S.computeNext({ kind: 'daily', at: 'garbage' }, from) === null, 'daily: an unparseable time → null');
  ok(S.computeNext({ kind: 'daily' }, from) === null, 'daily: a missing time → null');
  ok(S.computeNext({ kind: 'daily', at: '25:00' }, from) === null, 'daily: hour 25 is rejected, not wrapped');
  ok(S.computeNext({ kind: 'daily', at: '07:99' }, from) === null, 'daily: minute 99 is rejected');
  ok(S.computeNext({ kind: 'nonsense', at: '07:00' }, from) === null, 'unknown kind → null');
}

// ---- add() persists the zone and round-trips ----
{
  const r = S.add({ title: 'pinned', prompt: 'do the thing', kind: 'daily', at: '07:00', tz: 'America/New_York' });
  ok(r.success && r.schedule.tz === 'America/New_York', 'add: stores an explicit zone');
  ok(wall(r.schedule.nextRun, 'America/New_York') === '07:00', 'add: computes the first fire in that zone');

  const d = S.add({ title: 'default', prompt: 'x', kind: 'daily', at: '08:00' });
  ok(d.schedule.tz === 'auto', 'add: defaults to "auto" so a new schedule follows travel');

  // markRan must advance in-zone, not drift.
  S.markRan(r.schedule.id, r.schedule.nextRun + 1000);
  const after = S.list().find((x) => x.id === r.schedule.id);
  ok(wall(after.nextRun, 'America/New_York') === '07:00', 'markRan: the next occurrence is still 07:00 in-zone');
  ok(after.nextRun > r.schedule.nextRun, 'markRan: it advances forward');
  ok(after.lastRun, 'markRan: records lastRun');

  // A legacy schedule with no tz field must keep working.
  const list = S.load();
  delete list.find((x) => x.id === d.schedule.id).tz;
  S.save(list);
  const legacy = S.list().find((x) => x.id === d.schedule.id);
  ok(S.computeNext(legacy, Date.now()) !== null, 'back-compat: a schedule saved before tz existed still computes');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
