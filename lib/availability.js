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
  // An explicit decline is not a commitment. Two shapes: Google's raw attendee objects, and the
  // `selfResponse` lib/google.js flattens them to (its attendee list is bare email strings).
  const me = (ev.attendees || []).find((a) => a && typeof a === 'object' && a.self);
  const resp = (me && me.responseStatus) || ev.selfResponse || '';
  if (/^declined$/i.test(String(resp))) return false;
  return true;
}

/**
 * span(ev) → { from, to, allDay } in epoch ms, or null if the event has no usable times.
 *
 * THE GATE NEVER BLOCKED A CALL, and this is why. It read `ev.start.dateTime` — Google's raw shape —
 * while the only thing that ever fed it, lib/google.js calendarList(), returns a FLATTENED event whose
 * `start` is already the string "2026-11-12T10:40:00-05:00". `"…".dateTime` is undefined, so every
 * event on his calendar parsed as "undated — cannot say it is happening" and was skipped. With three
 * lectures and a lab on the calendar it reported him free in 48 of 48 half-hour slots. The unit tests
 * passed throughout, because they were written against the raw shape too: they proved the gate
 * agreed with the test, not with its caller. Both shapes are read here, and the test now feeds it
 * what calendarList really returns.
 */
function span(ev) {
  const pick = (v) => {
    if (v == null) return { at: null, dateOnly: false };
    if (typeof v === 'string') return { at: ms(v), dateOnly: /^\d{4}-\d{2}-\d{2}$/.test(v) };
    if (typeof v === 'object') return { at: ms(v.dateTime || v.date), dateOnly: !!(v.date && !v.dateTime) };
    return { at: null, dateOnly: false };
  };
  const s = pick(ev.start), e = pick(ev.end);
  if (s.at == null || e.at == null) return null;
  return { from: s.at, to: e.at, allDay: ev.allDay === true || s.dateOnly };
}

const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/**
 * busyNow(events, { now, allDayCounts }) → the blocking event covering `now`, or null.
 *
 * An ALL-DAY event does not mean he is unreachable for twenty-four hours — "Conference" or a
 * birthday would otherwise silence the phone for the whole day. They are ignored unless the caller
 * explicitly says otherwise.
 */
function busyNow(events = [], { now = Date.now(), allDayCounts = false, leadMs = 0 } = {}) {
  for (const ev of events) {
    if (!isBlocking(ev)) continue;
    const sp = span(ev);
    if (!sp) continue;                              // genuinely undated → cannot say it is happening
    if (sp.allDay && !allDayCounts) continue;
    // `leadMs`: the few minutes BEFORE it starts count too. A call at 10:36 for a 10:40 lecture
    // reaches him walking into the room, which is the interruption this exists to prevent.
    if (now >= sp.from - leadMs && now < sp.to) return ev;
  }
  return null;
}

/**
 * check({ listEvents, now, windowMin }) → { free, reason, event?, until? }
 * `listEvents()` should return today's events across whatever calendars matter.
 */
async function check({ listEvents, now = Date.now(), windowMin = 5, allDayCounts = false, leadMin = 5 } = {}) {
  if (typeof listEvents !== 'function') return { free: true, reason: 'no calendar wired — assuming free' };
  let events;
  try {
    events = await listEvents({ timeMin: new Date(now - windowMin * 60000).toISOString(), timeMax: new Date(now + Math.max(windowMin, leadMin) * 60000).toISOString() });
  } catch (e) {
    // FAIL OPEN, LOUDLY. The calendar being unreachable is not evidence that he is busy.
    //
    // But two very different things arrive here, and `authDead` tells them apart. A network blip is
    // transient and says nothing about his day, so it still fails open. A revoked or expired grant is
    // not transient: on 2026-11-12 all three accounts had been `invalid_grant` for weeks, which means
    // "assuming free" had quietly become the permanent answer and the gate had been off the whole
    // time. That is not an uncertain moment, it is a broken instrument, and the caller should treat a
    // ring as unsafe until it is fixed.
    const msg = String((e && e.message) || e);
    const authDead = /invalid_grant|invalid_client|unauthori[sz]ed|no google accounts?|not connected|\b401\b|\b403\b/i.test(msg);
    return { free: true, unknown: true, authDead, reason: `calendar ${authDead ? 'disconnected' : 'unreachable'} (${msg.slice(0, 60)}) — assuming free` };
  }
  const list = Array.isArray(events) ? events : (events && (events.events || events.items)) || [];
  const ev = busyNow(list, { now, allDayCounts, leadMs: Math.max(0, leadMin) * 60000 });
  if (!ev) return { free: true, reason: list.length ? `nothing on the calendar right now (${list.length} nearby event(s))` : 'calendar is clear' };
  const until = (span(ev) || {}).to || null;
  return {
    free: false, event: ev, until,
    reason: `"${String(ev.summary || 'a calendar event').slice(0, 60)}"`
      + (until ? ` until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''),
  };
}

module.exports = { check, busyNow, isBlocking, span };
