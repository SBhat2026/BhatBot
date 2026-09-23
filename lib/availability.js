'use strict';
// ── IS HE FREE RIGHT NOW? ─────────────────────────────────────────────────────────────────────────
// A phone call is the most intrusive thing BhatBot can do, and the gate in lib/callgate.js only
// answers "how OFTEN" — three a day, fifteen minutes apart. It has no idea whether the moment it
// picked is the middle of a lecture.
//
// This asks the calendar. It is deliberately separate from callgate because the two questions are
// different and fail differently: a rate cap is arithmetic and always available, while the calendar
// is a network call that can be down, and an unreachable calendar must NEVER become a reason to
// stay silent about something urgent.
//
// THE BIAS IS TOWARD CALLING, and it has to be stated plainly: on any uncertainty — the calendar
// could not be reached, the event has no times, the account is unauthorised — this returns FREE.
// The cost of a call during a lecture is embarrassment; the cost of silence during an emergency is
// the thing the call existed for. Those are not symmetric.
//
// Pure and injected: `listEvents` is passed in, so the policy is testable without Google.

const BUSY_STATUS = /^(confirmed|tentative)$/i;

/** Events that do not mean "unavailable", however they are marked. */
function isBlocking(ev, { respectTransparency = true } = {}) {
  if (!ev) return false;
  // `transparency: 'transparent'` is the calendar's own word for "show me as free" — a reminder,
  // a birthday, a booking someone else made. Honouring it is the whole reason it exists.
  if (respectTransparency && String(ev.transparency || '').toLowerCase() === 'transparent') return false;
  if (String(ev.eventType || '').toLowerCase() === 'workinglocation') return false;   // not an engagement
  if (ev.status && !BUSY_STATUS.test(String(ev.status))) return false;                // cancelled
  // An explicit decline is not a commitment.
  const me = (ev.attendees || []).find((a) => a && a.self);
  if (me && /^declined$/i.test(String(me.responseStatus || ''))) return false;
  return true;
}

const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/**
 * busyNow(events, { now, allDayCounts }) → the blocking event covering `now`, or null.
 *
 * An ALL-DAY event does not mean he is unreachable for twenty-four hours — "Conference" or a
 * birthday would otherwise silence the phone for the whole day. They are ignored unless the caller
 * explicitly says otherwise.
 */
function busyNow(events = [], { now = Date.now(), allDayCounts = false } = {}) {
  for (const ev of events) {
    if (!isBlocking(ev)) continue;
    const s = ev.start || {}, e = ev.end || {};
    const allDay = !!(s.date && !s.dateTime);
    if (allDay && !allDayCounts) continue;
    const from = ms(s.dateTime || s.date), to = ms(e.dateTime || e.date);
    if (from == null || to == null) continue;      // undated → cannot say it is happening
    if (now >= from && now < to) return ev;
  }
  return null;
}

/**
 * check({ listEvents, now, windowMin }) → { free, reason, event?, until? }
 * `listEvents()` should return today's events across whatever calendars matter.
 */
async function check({ listEvents, now = Date.now(), windowMin = 5, allDayCounts = false } = {}) {
  if (typeof listEvents !== 'function') return { free: true, reason: 'no calendar wired — assuming free' };
  let events;
  try {
    events = await listEvents({ timeMin: new Date(now - windowMin * 60000).toISOString(), timeMax: new Date(now + windowMin * 60000).toISOString() });
  } catch (e) {
    // FAIL OPEN, LOUDLY. The calendar being unreachable is not evidence that he is busy.
    return { free: true, reason: `calendar unreachable (${String((e && e.message) || e).slice(0, 60)}) — assuming free` };
  }
  const list = Array.isArray(events) ? events : (events && (events.events || events.items)) || [];
  const ev = busyNow(list, { now, allDayCounts });
  if (!ev) return { free: true, reason: list.length ? `nothing on the calendar right now (${list.length} nearby event(s))` : 'calendar is clear' };
  const until = ms((ev.end || {}).dateTime || (ev.end || {}).date);
  return {
    free: false, event: ev, until,
    reason: `"${String(ev.summary || 'a calendar event').slice(0, 60)}"`
      + (until ? ` until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''),
  };
}

module.exports = { check, busyNow, isBlocking };
