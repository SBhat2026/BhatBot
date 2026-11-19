'use strict';
// ── REACH — getting a message to Siddhant, and KNOWING it arrived ────────────────────────────────
//
// 2026-11-17: "figuring out a system of texting that would work on eduroam as well as … guaranteed
// calling … reliably reaching me." The audit behind this:
//   • Every SMS BhatBot has ever sent was rejected by the carriers (Twilio 30034: the number is not
//     registered for US application texting). Twilio ACCEPTS the request, so notifyUser reported
//     { sent: true } every time — two "the cloud link is down" alerts on 17 Nov went nowhere.
//   • Telegram works on eduroam through the relay, but the bot has no chat to send to until he
//     links it once.
//   • A call that rang out, hit voicemail or was declined counted as "sent". Nothing tried again.
//
// So "sent" is no longer the goal; REACHED is. Each message becomes a ticket that walks a ladder of
// channels until one of them is confirmed — he replied, answered, or acknowledged on the desktop —
// respecting quiet hours and his calendar, and never using a channel known to be dead.
//
// Pure: plan() and outcome readers take facts and return decisions. main.js does the sending,
// stores tickets, and calls advance() on a timer.

const MIN = 60 * 1000;

const DEFAULTS = {
  ackWindowMs: 10 * MIN,       // high: how long the desktop/Telegram get before a call
  retryCallMs: 7 * MIN,        // a missed call is retried once, this long after
  maxCalls: 2,                 // per ticket
  expireMs: 12 * 60 * MIN,     // a ticket nobody could deliver gives up after half a day
  overnightMaxMs: 2 * 60 * MIN, // a call held by quiet hours is dropped if it would ring this long after
};

/**
 * channels(facts) → which channels are usable right now.
 * facts: { atMac, telegramLinked, telegramDown, smsHealthy, callable, quiet, busy }
 */
function channels(f) {
  return {
    desktop: !!f.atMac,
    telegram: !!f.telegramLinked && !f.telegramDown,
    sms: !!f.smsHealthy,
    call: !!f.callable && !f.quiet && !f.busy,
  };
}

/**
 * next(ticket, facts, now) → { send:[channels], wait:ms } | { done:true, why } — the next rung.
 * ticket: { urgency, createdAt, sent:{ch:count}, calls:[{at, reached}], ackAt, lastCallAt }
 */
function next(t, f, now = Date.now(), opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (t.ackAt) return { done: true, why: 'acknowledged' };
  if ((t.calls || []).some((c) => c.reached)) return { done: true, why: 'answered the call' };
  if (now - t.createdAt > o.expireMs) return { done: true, why: 'expired undelivered' };
  const ch = channels(f);
  const sent = t.sent || {};
  const out = [];
  // Written channels first, once each: they are quiet, they leave a record, and he can reply.
  if (ch.desktop && !sent.desktop) out.push('desktop');
  if (ch.telegram && !sent.telegram) out.push('telegram');
  if (ch.sms && !sent.sms && t.urgency !== 'low') out.push('sms');
  if (t.urgency === 'low' || t.urgency === 'info') {
    // Low urgency is delivered when it is written somewhere he will see it; it never rings.
    if (out.length) return { send: out };
    const written = sent.desktop || sent.telegram || sent.sms;
    return written ? { done: true, why: 'delivered in writing' } : { wait: 5 * MIN, why: 'no written channel yet (Telegram not linked, not at the Mac)' };
  }
  if (t.urgency === 'medium') {
    if (out.length) return { send: out };
    const written = sent.telegram || sent.sms || sent.desktop;
    if (written) return { done: true, why: 'delivered in writing' };
    // Nothing written can reach him: a medium message that needs an answer earns a call.
    if (t.needsReply && ch.call && (t.calls || []).length < 1) return { send: ['call'] };
    return { wait: 5 * MIN, why: 'waiting for a channel' };
  }
  // high / call: everything written goes out at once; the phone rings for 'call' right away, and for
  // 'high' only when the written message has gone unacknowledged (or there was nowhere to write it).
  const calls = t.calls || [];
  const last = calls[calls.length - 1];
  const written = !!(sent.desktop || sent.telegram || sent.sms || out.length);
  const age = now - t.createdAt;
  const hold = (wait, why) => (out.length ? { send: out, wait, why } : { wait, why });
  if (!(t.urgency === 'call' || !written || age >= o.ackWindowMs)) return hold(o.ackWindowMs - age, 'giving the written message time first');
  if (calls.length >= o.maxCalls) return out.length ? { send: out } : { done: true, why: `called ${calls.length}× without an answer — left in writing` };
  if (last && last.pending) return hold(30 * 1000, 'call in progress');
  if (last && now - last.at < o.retryCallMs) return hold(o.retryCallMs - (now - last.at), 'retrying the call shortly');
  if (!ch.call) {
    // Something that came up overnight is not worth ringing him about at dawn: by the time quiet hours
    // end it has sat in writing for hours, and if it still mattered he will see it there first.
    if (f.quiet && f.quietEndsAt && f.quietEndsAt - t.createdAt > o.overnightMaxMs) {
      return out.length ? { send: out } : { done: true, why: 'came up overnight — left in writing rather than ringing at dawn' };
    }
    const why = f.quiet ? 'quiet hours' : f.busy ? 'in a meeting or class' : 'calling unavailable';
    const until = f.busy && f.busyUntil ? f.busyUntil + 2 * MIN : f.quiet && f.quietEndsAt ? f.quietEndsAt : now + 5 * MIN;
    return hold(Math.max(MIN, until - now), `not calling yet — ${why}`);
  }
  return { send: [...out, 'call'] };
}

/** Twilio call resource → did a person actually pick up? */
function callOutcome(c) {
  if (!c) return { final: false };
  const st = String(c.status || '');
  if (['queued', 'ringing', 'in-progress', 'initiated'].includes(st)) return { final: false };
  const by = String(c.answered_by || c.answeredBy || '');
  const dur = Number(c.duration || 0);
  if (st === 'completed' && /^machine/.test(by)) return { final: true, reached: false, voicemail: true, why: 'voicemail' };
  if (st === 'completed' && (by === 'human' || ((by === 'unknown' || !by) && dur >= 15))) return { final: true, reached: true, why: 'answered' };
  if (st === 'completed') return { final: true, reached: false, why: `picked up for ${dur}s only` };
  return { final: true, reached: false, why: st };          // no-answer, busy, failed, canceled
}

/** Twilio message resource → delivered, still moving, or dead (and why). */
function smsOutcome(m) {
  if (!m) return { final: false };
  const st = String(m.status || ''), code = Number(m.error_code || m.errorCode || 0);
  if (st === 'delivered') return { final: true, ok: true };
  if (['undelivered', 'failed'].includes(st)) {
    const why = code === 30034 ? 'the Twilio number is not registered for US texting (A2P 10DLC) — carriers drop every message'
      : code === 30032 ? 'toll-free number not verified' : code === 30007 ? 'carrier filtered it as spam' : code === 30003 ? 'his phone was unreachable' : `error ${code || st}`;
    return { final: true, ok: false, code, why, channelDead: [30034, 30032, 30007].includes(code) };
  }
  if (st === 'sent') return { final: false, probablyOk: true };
  return { final: false };
}

module.exports = { channels, next, callOutcome, smsOutcome, DEFAULTS };
