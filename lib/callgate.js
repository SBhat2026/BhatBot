'use strict';
// ── THE CALL GATE ─────────────────────────────────────────────────────────────────────────────────
// Everything that decides whether BhatBot is allowed to ring a real telephone, in one pure module.
//
// WHY THIS EXISTS. On 2026-09-21 it called Siddhant seven or eight times and every single call played
// "An application error has occurred." Three separate failures lined up:
//
//   1. The webhook URL was a Tailscale MagicDNS name that was never actually PUBLISHED, so Twilio —
//      which is on the public internet — could not fetch it. The name looks public and is not.
//   2. `sent: true` meant "Twilio ACCEPTED the request", not "the call worked". So BhatBot logged
//      "📞 (called you)" each time, saw success, and had no reason to stop.
//   3. Nothing capped the rate. Even a correct call has a budget; eight in a day is not one.
//
// And afterwards none of it could be reconstructed, because a call left no durable record — the one
// action with real-world consequences was the one with no audit trail.
//
// Pure and dependency-injected: `now`, `reachable` and the ledger are all passed in, so the policy
// can be tested without a phone, a network, or a clock.

const DEFAULTS = {
  maxPerDay: 3,          // a real emergency is rare; the fourth in a day is a loop, not an emergency
  minGapMs: 15 * 60000,  // 15 minutes — nothing that just failed is worth redialling immediately
  maxPerHour: 2,
};

/**
 * decide({ history, now, config }) → { allow, reason, downgrade }
 * `history` is the recent call ledger, newest last, each { at, ok }.
 * A refusal always names a DOWNGRADE — the message still gets through, by a quieter channel. A gate
 * that silently swallows an urgent notice is worse than the thing it is protecting against.
 */
function decide({ history = [], now = Date.now(), config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };

  // A REFUSED CALL IS NOT A CALL. The ledger records blocked attempts too — it should, that is the
  // audit trail — but counting them against the rate limit is a livelock: every refusal pushes the
  // cooldown out by another fifteen minutes, so anything that keeps trying keeps the gate shut
  // forever. Observed immediately after this gate shipped, while trying to place a test call: three
  // refusals in a row, each one resetting the clock on the last.
  //
  // The caps exist to limit how often the PHONE RINGS. A blocked attempt never rang it.
  const placed = history.filter((h) => h && !h.blocked);
  const since = (ms) => placed.filter((h) => now - h.at < ms);

  const lastCall = placed.length ? placed[placed.length - 1] : null;
  if (lastCall && now - lastCall.at < cfg.minGapMs) {
    const mins = Math.ceil((cfg.minGapMs - (now - lastCall.at)) / 60000);
    return { allow: false, downgrade: 'sms', reason: `called ${Math.round((now - lastCall.at) / 60000)}m ago — ${mins}m of cooldown left` };
  }
  const inHour = since(3600000).length;
  if (inHour >= cfg.maxPerHour) {
    return { allow: false, downgrade: 'sms', reason: `${inHour} call(s) in the last hour (cap ${cfg.maxPerHour})` };
  }
  const inDay = since(86400000).length;
  if (inDay >= cfg.maxPerDay) {
    return { allow: false, downgrade: 'sms', reason: `${inDay} call(s) in the last 24h (cap ${cfg.maxPerDay})` };
  }

  // THE CONSECUTIVE-FAILURE BRAKE. This is the one that would have stopped the 21st on its own: the
  // second call in a row that did not reach him is evidence the CHANNEL is broken, not that the
  // message was not urgent enough. Redialling a broken channel is how you get to eight.
  const tail = placed.slice(-2);
  if (tail.length === 2 && tail.every((h) => h.ok === false)) {
    return { allow: false, downgrade: 'sms', reason: 'the last two calls both failed — the phone path is broken, not unheard' };
  }
  return { allow: true, reason: `${inDay}/${cfg.maxPerDay} today` };
}

/**
 * A public host is one the OUTSIDE WORLD can fetch. A Tailscale MagicDNS name resolves beautifully
 * from inside the tailnet and not at all from Twilio's servers, which is precisely the trap: the
 * hostname exists, looks right, and is unreachable by the only party that matters.
 *
 * `probe` is injected; it should make a real request from outside, or at minimum confirm the funnel
 * is published. Returns { usable, why }.
 */
async function checkWebhookHost(host, { probe } = {}) {
  if (!host) return { usable: false, why: 'no public host configured' };
  if (typeof probe !== 'function') return { usable: false, why: 'no reachability probe available' };
  try {
    const r = await probe(host);
    return r && r.ok ? { usable: true, why: 'reachable' }
                     : { usable: false, why: (r && r.why) || 'not reachable from the public internet' };
  } catch (e) { return { usable: false, why: 'probe threw: ' + ((e && e.message) || e) }; }
}

module.exports = { decide, checkWebhookHost, DEFAULTS };
