#!/usr/bin/env node
'use strict';
// A phone call is the most intrusive thing BhatBot can do, and lib/callgate.js only answers "how
// OFTEN" — three a day, fifteen minutes apart. It has no idea whether the moment it chose is the
// middle of a lecture. This is the second question.
//
// THE BIAS IS TOWARD CALLING, deliberately. On any uncertainty this says FREE: the cost of a call
// during a seminar is embarrassment, the cost of silence during an emergency is the thing calling
// exists for, and those are not symmetric.
const assert = require('assert');
const path = require('path');
const { check, busyNow, isBlocking } = require(path.join(__dirname, '..', 'lib', 'availability'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const NOW = Date.parse('2026-09-23T15:30:00Z');
const at = (h, m = 0) => new Date(Date.parse('2026-09-23T00:00:00Z') + (h * 60 + m) * 60000).toISOString();
const ev = (o = {}) => ({ summary: 'MAT 203 Lecture', status: 'confirmed', start: { dateTime: at(15) }, end: { dateTime: at(16, 20) }, ...o });

console.log('[availability]');

{
  assert.ok(busyNow([ev()], { now: NOW }), 'a lecture in progress is blocking');
  assert.strictEqual(busyNow([ev({ start: { dateTime: at(17) }, end: { dateTime: at(18) } })], { now: NOW }), null);
  ok('an event covering the moment blocks; one later today does not');
}
{
  // The calendar's own word for "show me as free" — reminders, birthdays, things someone else put
  // in the diary. Honouring it is the entire reason the field exists.
  assert.strictEqual(isBlocking(ev({ transparency: 'transparent' })), false);
  assert.strictEqual(isBlocking(ev({ status: 'cancelled' })), false);
  assert.strictEqual(isBlocking(ev({ eventType: 'workingLocation' })), false);
  ok('transparent, cancelled and working-location events do not count as busy');
}
{
  const declined = ev({ attendees: [{ self: true, responseStatus: 'declined' }] });
  assert.strictEqual(isBlocking(declined), false, 'an invitation he declined is not a commitment');
  const accepted = ev({ attendees: [{ self: true, responseStatus: 'accepted' }] });
  assert.ok(isBlocking(accepted));
  ok('an event he declined is not treated as an engagement');
}
{
  // "Conference" or a birthday would otherwise silence the phone for a full day.
  const allDay = ev({ summary: 'Conference', start: { date: '2026-09-23' }, end: { date: '2026-09-24' } });
  assert.strictEqual(busyNow([allDay], { now: NOW }), null, 'an all-day event does not block by default');
  assert.ok(busyNow([allDay], { now: NOW, allDayCounts: true }), 'unless the caller asks for it');
  ok('an all-day event does not mute the phone for twenty-four hours');
}
(async () => {
  {
    const r = await check({ listEvents: async () => [ev()], now: NOW });
    assert.strictEqual(r.free, false);
    assert.match(r.reason, /MAT 203/);
    assert.ok(r.until, 'and it says when he is free again');
    ok('a lecture in progress reports NOT free, names it, and says until when');
  }
  {
    const r = await check({ listEvents: async () => [], now: NOW });
    assert.strictEqual(r.free, true);
    ok('an empty calendar is free');
  }
  {
    // THE ONE THAT MATTERS MOST. An unreachable calendar is not evidence that he is busy, and
    // treating it as such would turn a network blip into silence during an emergency.
    const r = await check({ listEvents: async () => { throw new Error('ENOTFOUND oauth2.googleapis.com'); }, now: NOW });
    assert.strictEqual(r.free, true, 'it must FAIL OPEN: ' + r.reason);
    assert.match(r.reason, /unreachable/);
    ok('a calendar that cannot be reached fails OPEN, and says so rather than pretending');
  }
  {
    const r = await check({ listEvents: undefined, now: NOW });
    assert.strictEqual(r.free, true);
    ok('no calendar wired at all is free, not busy');
  }
  {
    // A malformed event must not throw its way into blocking a call.
    const r = await check({ listEvents: async () => [{ summary: 'broken' }, null, ev({ start: {}, end: {} })], now: NOW });
    assert.strictEqual(r.free, true, 'undated events cannot be said to be happening');
    ok('events with no usable times are ignored rather than crashing the check');
  }

  // ── THE SHAPE THE GATE IS ACTUALLY GIVEN ─────────────────────────────────────────────────────────
  //
  // Everything above feeds the gate RAW Google events ({ start: { dateTime } }). Nothing in the app
  // does: lib/google.js calendarList() flattens them first, so `start` is already a string. The gate
  // read `start.dateTime` off that string, got undefined, and skipped every event as "undated" — with
  // three lectures and a lab on the calendar it reported him free in 48 of 48 half-hour slots, and
  // these tests were green the whole time because they agreed with the gate rather than its caller.
  // So these run real Google-shaped events THROUGH the real flattener and gate on the result.
  {
    const { flattenEvent } = require('../lib/google');
    const { span } = require('../lib/availability');
    const raw = [
      { id: '1', summary: 'Lecture', status: 'confirmed', start: { dateTime: '2026-11-12T10:40:00-05:00' }, end: { dateTime: '2026-11-12T12:00:00-05:00' } },
      { id: '2', summary: 'Lab', status: 'confirmed', start: { dateTime: '2026-11-12T13:30:00-05:00' }, end: { dateTime: '2026-11-12T16:20:00-05:00' } },
      { id: '3', summary: 'Birthday', status: 'confirmed', start: { date: '2026-11-12' }, end: { date: '2026-11-13' } },
      { id: '4', summary: 'Hold', status: 'confirmed', transparency: 'transparent', start: { dateTime: '2026-11-12T12:15:00-05:00' }, end: { dateTime: '2026-11-12T13:05:00-05:00' } },
      { id: '5', summary: 'Declined', status: 'confirmed', start: { dateTime: '2026-11-12T17:00:00-05:00' }, end: { dateTime: '2026-11-12T18:30:00-05:00' }, attendees: [{ email: 'me@x.edu', self: true, responseStatus: 'declined' }] },
      { id: '6', summary: 'Cancelled', status: 'cancelled', start: { dateTime: '2026-11-12T09:00:00-05:00' }, end: { dateTime: '2026-11-12T10:00:00-05:00' } },
    ];
    const flat = raw.map(flattenEvent);
    assert.strictEqual(typeof flat[0].start, 'string', 'the flattener really does produce string times — the premise of this block');
    const at = (hhmm) => Date.parse(`2026-11-12T${hhmm}:00-05:00`);
    const chk = (hhmm) => check({ listEvents: async () => flat, now: at(hhmm) });

    let r = await chk('11:00');
    assert.strictEqual(r.free, false, 'mid-lecture, on FLATTENED events, he is busy');
    assert.strictEqual(r.until, at('12:00'), 'and it knows when the lecture ends');
    ok('a lecture blocks a call when the gate is fed what calendarList really returns');

    r = await chk('14:45'); assert.strictEqual(r.free, false); ok('so does the lab');
    r = await chk('12:05'); assert.strictEqual(r.free, true); ok('the gap between classes is free');
    r = await chk('08:00'); assert.strictEqual(r.free, true); ok('an all-day event (a date-only string after flattening) does not silence the phone all day');
    r = await chk('12:30'); assert.strictEqual(r.free, true); ok('"show me as free" survives the flattening and is honoured');
    r = await chk('17:30'); assert.strictEqual(r.free, true); ok('a meeting he declined survives the flattening and does not block');
    r = await chk('09:30'); assert.strictEqual(r.free, true); ok('a cancelled event does not block');

    // The measurement that exposed it, as an assertion: walk the day in half-hours.
    let blocked = 0;
    for (let t = at('08:00'); t < at('20:00'); t += 30 * 60000) { if (!(await check({ listEvents: async () => flat, now: t })).free) blocked++; }
    assert.ok(blocked >= 8, `a day with a lecture and a lab must block SOME slots (blocked ${blocked}) — zero is the bug`);
    ok(`walking the day in half-hours, the gate refuses ${blocked} slots (it used to refuse 0)`);

    assert.deepStrictEqual(span({ start: '2026-11-12', end: '2026-11-13' }).allDay, true);
    assert.strictEqual(span({ start: null, end: null }), null);
    ok('span() reads both shapes and still refuses an event with no times');
  }

  // ── a broken instrument is not an uncertain moment ───────────────────────────────────────────────
  {
    let r = await check({ listEvents: async () => { throw new Error('invalid_grant'); }, now: Date.now() });
    assert.strictEqual(r.free, true); assert.strictEqual(r.authDead, true); assert.strictEqual(r.unknown, true);
    ok('a revoked grant is reported as authDead — the caller can refuse to ring blind');
    r = await check({ listEvents: async () => { throw new Error('getaddrinfo ENOTFOUND www.googleapis.com'); }, now: Date.now() });
    assert.strictEqual(r.free, true); assert.strictEqual(r.authDead, false); assert.strictEqual(r.unknown, true);
    ok('a network blip is NOT authDead — it still fails open, because it says nothing about his day');
    r = await check({ listEvents: async () => [], now: Date.now() });
    assert.strictEqual(r.unknown, undefined);
    ok('and a genuinely empty calendar is neither');
  }
  // ── the minutes before it starts ─────────────────────────────────────────────────────────────────
  {
    const ev = [{ summary: 'Lecture', start: '2026-11-12T10:40:00-05:00', end: '2026-11-12T12:00:00-05:00' }];
    const at = (hhmm) => Date.parse(`2026-11-12T${hhmm}:00-05:00`);
    let r = await check({ listEvents: async () => ev, now: at('10:36') });
    assert.strictEqual(r.free, false); ok('four minutes before a lecture he is walking in — no call');
    r = await check({ listEvents: async () => ev, now: at('10:30') });
    assert.strictEqual(r.free, true); ok('ten minutes before is still free');
    r = await check({ listEvents: async () => ev, now: at('10:36'), leadMin: 0 });
    assert.strictEqual(r.free, true); ok('and the lead-in is a setting, off when asked');
  }

  // ── a timed event that spans days is not a meeting ──────────────────────────────────────────────
  {
    const ev = [{ summary: 'Block', start: '2026-11-12T17:30:00-05:00', end: '2026-11-18T19:00:00-05:00' }];
    const at = (iso) => Date.parse(iso);
    let r = await check({ listEvents: async () => ev, now: at('2026-11-14T16:37:00-05:00') });
    assert.strictEqual(r.free, true);
    ok('a six-day TIMED event (the real one on his calendar, Nov 12 → Nov 18) does not block calls all week');
    const lab = [{ summary: 'Lab', start: '2026-11-14T13:00:00-05:00', end: '2026-11-14T22:00:00-05:00' }];
    r = await check({ listEvents: async () => lab, now: at('2026-11-14T16:00:00-05:00') });
    assert.strictEqual(r.free, false);
    ok('while a nine-hour lab still does');
    r = await check({ listEvents: async () => ev, now: at('2026-11-14T16:37:00-05:00'), allDayCounts: true });
    assert.strictEqual(r.free, false);
    ok('and the caller who asked for all-day events to count gets the long one too');
  }
  console.log(`[availability] ${pass} assertions passed`);
})();
