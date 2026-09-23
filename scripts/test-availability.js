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
  console.log(`[availability] ${pass} assertions passed`);
})();
