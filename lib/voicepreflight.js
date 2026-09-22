'use strict';
// ── DOES THE PHONE PATH ACTUALLY WORK? ────────────────────────────────────────────────────────────
// Twilio fetches TwiML from us to run a two-way call. If that fetch fails for ANY reason the caller
// hears "An application error has occurred" — and from our side the call looks placed, because
// Twilio accepted the request. That asymmetry has now cost two rounds of broken calls.
//
// Every earlier check tested one link and inferred the rest:
//   • `tailscale funnel status` proves something is published, not that OUR app answers.
//   • an unsigned curl returning 403 proves the guard works, not that a SIGNED request succeeds.
//   • `sent: true` proves Twilio queued the call, not that the call worked.
//
// So this exercises the WHOLE chain the way Twilio will: build the same POST, sign it with the real
// auth token exactly as Twilio signs it, send it to the PUBLIC url, and require parseable TwiML with
// speech in it. Anything less is an inference.
//
// It is safe to run whenever: the webhook it hits is idempotent and no call is placed.
const crypto = require('crypto');

/** Sign a request the way Twilio does: HMAC-SHA1 over url + each sorted POST key and value. */
function twilioSignature(authToken, url, params = {}) {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/**
 * check({ host, token, authToken, fetchImpl, timeoutMs }) → { ok, stage, detail, twiml }
 *
 * `stage` names the link that broke, because "the call did not work" has at least four distinct
 * causes and they need different fixes:
 *   dns/tls   → the funnel is down or the hostname is wrong          (tailscale funnel 8788)
 *   http      → we answered, but not with success                    (guard/signature/app error)
 *   twiml     → we answered 200 with something Twilio cannot run     (a bug in the handler)
 *   ok        → a signed request returns speakable TwiML
 */
// Twilio abandons a webhook at roughly 15 seconds and plays "An application error has occurred".
// The preflight therefore has to hold the SAME deadline — a probe that waits 30s for a reply Twilio
// would never have waited for is not testing the call, it is testing patience. This is the number
// that three rounds of debugging never measured.
const TWILIO_WEBHOOK_DEADLINE_MS = 15000;

async function check({ host, token, authToken, ownerPhone, fetchImpl, timeoutMs = TWILIO_WEBHOOK_DEADLINE_MS } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!host) return { ok: false, stage: 'config', detail: 'no public host — nothing for Twilio to fetch' };
  if (!token) return { ok: false, stage: 'config', detail: 'no mcpToken — the webhook path is token-gated' };

  const url = `https://${host}/voice/${token}/incoming?msg=${encodeURIComponent('preflight')}`;
  // The params Twilio actually sends on an outbound-call webhook. They are part of the signature, so
  // a plausible-but-wrong set would fail for the wrong reason.
  // Shaped like the OUTBOUND call this is meant to prove, because outbound and inbound are
  // authorised differently: on outbound the owner is `To`, and a probe that puts a stranger there
  // tests the refusal path while reporting on the success path.
  const params = {
    AccountSid: 'ACpreflight00000000000000000000000',
    CallSid: 'CApreflight0000000000000000000000',
    From: '+10000000000', To: ownerPhone || '+10000000000',
    CallStatus: 'in-progress', Direction: 'outbound-api', ApiVersion: '2010-04-01',
  };

  let res;
  const t0 = Date.now();
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Without a valid signature the app SHOULD refuse — so sending a real one is the only way to
        // test the success path rather than the rejection path.
        'x-twilio-signature': authToken ? twilioSignature(authToken, url, params) : 'unsigned',
        'user-agent': 'TwilioProxy/1.1',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const m = String((e && e.message) || e);
    // A TIMEOUT IS NOT A NETWORK PROBLEM, and calling it one sends the next person to the funnel
    // while the real cause is a handler doing an LLM round-trip inside a 15-second budget.
    if (/timeout|abort/i.test(m)) {
      return { ok: false, stage: 'slow',
        detail: `the webhook did not answer within ${timeoutMs}ms. Twilio gives up at about 15s and plays `
              + '"An application error has occurred" — so a handler that calls a model before replying '
              + 'fails here even though every other layer is healthy.' };
    }
    return { ok: false, stage: 'dns/tls',
      detail: `could not reach https://${host} — ${m}. The funnel is probably down: run \`tailscale funnel 8788\`.` };
  }

  const ms = Date.now() - t0;
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, stage: 'http', status: res.status,
      detail: res.status === 403 ? 'the app REFUSED a correctly-signed request — twilioAuthToken in config does not match the account placing calls'
            : res.status === 401 ? 'the token in the webhook path was rejected by the guard'
            : `the app answered ${res.status}, and Twilio treats any non-2xx as an application error`,
      twiml: body.slice(0, 300) };
  }
  // 200 is not enough: Twilio needs TwiML it can actually run, and a 200 carrying an HTML error page
  // produces the same "application error" as a 500.
  if (!/<Response[\s>]/i.test(body)) {
    return { ok: false, stage: 'twiml', detail: 'answered 200 but the body is not TwiML', twiml: body.slice(0, 300) };
  }
  if (/<Reject\s*\/?>/i.test(body)) {
    return { ok: false, stage: 'twiml', detail: 'the handler returned <Reject/> — the call would be dropped on answer', twiml: body.slice(0, 300) };
  }
  // A two-way call needs to SAY something and then LISTEN. TwiML with neither is a silent call.
  const speaks = /<Say[\s>]|<Play[\s>]/i.test(body);
  const listens = /<Gather[\s>]|<Connect[\s>]|<Stream[\s>]/i.test(body);
  if (!speaks) return { ok: false, stage: 'twiml', detail: 'TwiML says nothing — the call would connect to silence', twiml: body.slice(0, 300) };

  // A REFUSAL IS NOT A PASS. The first version of this check saw <Say> plus a 200 and reported
  // "ok — announcement only" for a body that read `<Say>Unauthorized.</Say><Hangup/>`: the app
  // politely declining every call. Speaking one sentence and hanging up is what a refusal LOOKS
  // like, so on the incoming webhook it has to be treated as one.
  if (/unauthoriz/i.test(body)) {
    return { ok: false, stage: 'authz',
      detail: 'the app refused the call as unauthorised — the owner check rejected this party '
            + (ownerPhone ? `(To=${ownerPhone})` : '(no ownerPhone passed to the preflight)'),
      twiml: body.slice(0, 300) };
  }
  if (!listens && /<Hangup\s*\/?>/i.test(body)) {
    return { ok: false, stage: 'twiml',
      detail: 'the handler speaks once and hangs up — that is a refusal or an error path, not a conversation',
      twiml: body.slice(0, 300) };
  }
  if (!listens) {
    return { ok: false, stage: 'twiml',
      detail: 'TwiML speaks but never listens — a two-way call would be a monologue',
      twiml: body.slice(0, 300) };
  }
  return { ok: true, stage: 'ok', twoWay: true, ms,
    detail: `a signed outbound-shaped request returns TwiML that speaks AND listens (${ms}ms, budget ${timeoutMs}ms)`,
    twiml: body.slice(0, 300) };
}

module.exports = { check, twilioSignature, TWILIO_WEBHOOK_DEADLINE_MS };
