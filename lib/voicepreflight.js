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

// ── THE PREFLIGHT WAS TESTING THE WRONG MACHINE ──────────────────────────────────────────────────
// It fetched https://<host>/voice/... from THIS machine, and on a Tailscale node that hostname
// resolves to the TAILNET address — 100.72.190.121 — so the request never left the laptop. It proved
// the app answers locally, which was never in doubt, and said nothing about whether Twilio can reach
// it. That is why it reported "✓ TWO-WAY" in 328ms while every real call played an application error.
//
// A public resolver returns Tailscale's funnel ingress instead (199.38.181.54), and forcing the
// request through it fails in 18ms. Two independent third-party fetchers confirm it: HTTP 522,
// connection timed out. The node sits behind a symmetric NAT with no port mapping, so the funnel
// edge cannot reach in.
//
// `externalProbe` is therefore how reachability is now established — a request made from somewhere
// that is not this computer. Without one, the check reports that it CANNOT KNOW rather than
// reporting a pass, because a local success is not evidence and pretending otherwise is what cost
// three rounds of broken calls.
async function reachableFromOutside(host, { fetchImpl, timeoutMs = 6000, budgetMs = 9000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const target = encodeURIComponent(`https://${host}/`);
  // Two unrelated services, because one being down must not read as the funnel being down.
  const proxies = [
    `https://api.codetabs.com/v1/proxy?quest=${target}`,
    `https://api.allorigins.win/raw?url=${target}`,
  ];

  // IN PARALLEL, UNDER ONE BUDGET. This used to try the two probers one after the other, each with a
  // 25 s timeout and a 25 s control fetch behind it: up to a hundred seconds to decide whether to
  // place a phone call, on the path whose whole purpose is reaching him quickly. It hung a diagnostic
  // run outright. A reachability check that can outlast the emergency is not a safety check. Both
  // probers now run at once and the whole question gets `budgetMs`; running out of time is
  // INCONCLUSIVE, exactly like no prober being usable, and is never reported as "unreachable".
  const probeOne = async (p) => {
    const prox = p.split('/')[2];
    try {
      const r = await doFetch(p, { signal: AbortSignal.timeout(timeoutMs) });
      const body = await r.text().catch(() => '');
      // 522/523/524 are the edge saying it could not reach the origin — the shape of a funnel that
      // is advertised and not serving.
      if (r.ok && !/error code: 52\d/.test(body)) return { ok: true, prox };

      // ── IS THE PROBER ITSELF ALIVE? ──────────────────────────────────────────────────────────────
      // A free proxy having a bad day and an origin being unreachable look identical from here, and
      // guessing between them is how this check declared bhatbot-cloud.fly.dev dead while a direct
      // curl to it was answering 401. So the prober is asked to fetch something known-good; if it
      // cannot, its verdict about our host is worth nothing and is discarded rather than believed.
      let control = false;
      try {
        const cr = await doFetch(p.replace(/(quest=|url=).*$/, '$1' + encodeURIComponent('https://example.com/')), { signal: AbortSignal.timeout(timeoutMs) });
        const cb = await cr.text().catch(() => '');
        control = cr.ok && /example domain/i.test(cb);
      } catch { control = false; }
      if (!control) return { ok: null, prox, note: `${prox} → unusable (it could not fetch a known-good control either)` };
      return { ok: false, prox, note: `${prox} → ${r.status}${/error code: (52\d)/.test(body) ? ' (' + body.match(/error code: (52\d)/)[1] + ' origin unreachable)' : ''}` };
    } catch (e) { return { ok: null, prox, note: `${prox} → ${(e && e.name) || 'failed'}` }; }
  };

  const runs = proxies.map(probeOne);
  let timer;
  const deadline = new Promise((res) => { timer = setTimeout(() => res('deadline'), budgetMs); if (timer.unref) timer.unref(); });
  // The first prober to say "reached it" settles the question; otherwise wait for both, or the budget.
  const firstYes = new Promise((res) => { for (const r of runs) r.then((v) => { if (v && v.ok === true) res(v); }); });
  const all = Promise.all(runs);
  const winner = await Promise.race([firstYes, all, deadline]);
  clearTimeout(timer);
  if (winner && winner.ok === true) return { ok: true, via: winner.prox, detail: 'an outside host fetched it' };
  if (winner === 'deadline') {
    return { ok: null, detail: `could not establish reachability within ${budgetMs}ms — the external probers did not answer in time. This says nothing about https://${host}.` };
  }
  const seen = winner.map((v) => v.note).filter(Boolean);
  // INCONCLUSIVE IS NOT A FAILURE. If no prober could even reach a control, we have learned nothing
  // about our own host, and reporting that as "unreachable" would send the next person to fix a
  // funnel that was never broken.
  if (!winner.some((v) => v.ok === false)) {
    return { ok: null, detail: `could not establish reachability — no external prober was usable (${seen.join('; ')}). This says nothing about https://${host}.` };
  }
  return { ok: false, detail: `no outside host could reach https://${host} — ${seen.join('; ')}` };
}

// `path`/`param` because the cloud's outbound leg is /outgoing?purpose= while the Mac's is
// /incoming?msg=. Same contract — Twilio fetches TwiML — but the probe has to knock on the door the
// call will actually use, which is the whole lesson of this bug.
async function check({ host, token, authToken, ownerPhone, externalProbe, fetchImpl, path = 'incoming', param = 'msg', timeoutMs = TWILIO_WEBHOOK_DEADLINE_MS } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!host) return { ok: false, stage: 'config', detail: 'no public host — nothing for Twilio to fetch' };
  if (!token) return { ok: false, stage: 'config', detail: 'no mcpToken — the webhook path is token-gated' };

  let unknownReach = null;
  // REACHABILITY FIRST, and from outside. Everything below tests the handler; this tests whether
  // anyone can get to it, which is the question that was never being asked.
  if (externalProbe !== false) {
    const ext = await reachableFromOutside(host, { fetchImpl: externalProbe === true ? undefined : externalProbe });
    if (ext.ok === null) {
      // Carry on and judge the handler. The reachability question stays open and is reported as
      // open — an unusable instrument must not masquerade as a finding in either direction.
      unknownReach = ext.detail;
    } else if (!ext.ok) {
      return { ok: false, stage: 'unreachable',
        detail: `${ext.detail}. A local check would PASS here and mean nothing — on a Tailscale node this hostname resolves to the tailnet address, so a request from this machine never leaves it. Twilio would get exactly what those hosts got.` };
    }
  }

  const url = `https://${host}/voice/${token}/${path}?${param}=${encodeURIComponent('preflight')}`;
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
  return { ok: true, stage: unknownReach ? 'ok-locally' : 'ok', twoWay: true, ms,
    detail: `a signed outbound-shaped request returns TwiML that speaks AND listens (${ms}ms, budget ${timeoutMs}ms)`
      + (unknownReach ? ` — but reachability from outside is UNVERIFIED: ${unknownReach}` : ''),
    reachabilityUnknown: unknownReach || undefined,
    twiml: body.slice(0, 300) };
}

module.exports = { check, reachableFromOutside, twilioSignature, TWILIO_WEBHOOK_DEADLINE_MS };
