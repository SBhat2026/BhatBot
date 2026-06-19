'use strict';
// Phone calls via Twilio — BhatBot calls people / answers your Twilio number IN YOUR NAME and
// relays to you. Lives on the always-on cloud (Twilio webhooks must hit a public URL).
//   • Outbound: place a call to a number with a goal; BhatBot converses, streams the transcript
//     to the app's Activity feed, then texts you a summary.
//   • Inbound (LIVE SCREENING): answer, find out who/why, text YOU the options
//     (TAKE / HANDLE / VM), hold the caller briefly, then connect you, handle it, or take a
//     message — your choice. Transcript streams to Activity in real time.
const db = require('./db');
const { callClaude } = require('./llm');
const voice = require('./voice');

const SID = process.env.TWILIO_SID || '';
const AUTH = process.env.TWILIO_TOKEN || '';
const FROM = process.env.TWILIO_FROM || '';          // your Twilio number (caller ID)
const OWNER = process.env.OWNER_PHONE || '';         // your real cell (where relays go / TAKE bridges to)
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const configured = () => !!(SID && AUTH && FROM);

const xmlEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const enc = encodeURIComponent;

// ---- Twilio REST (no SDK) -----------------------------------------------------
async function twilioPost(resource, form) {
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/${resource}`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${SID}:${AUTH}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('twilio ' + r.status + ': ' + (j.message || ''));
  return j;
}
async function sendSMS(to, body) { if (!configured() || !to) return; try { await twilioPost('Messages.json', { To: to, From: FROM, Body: String(body).slice(0, 1500) }); } catch (e) { console.warn('[twilio] sms failed:', e.message); } }
const notifyOwner = (body) => sendSMS(OWNER, body);

// ---- per-call state -----------------------------------------------------------
const calls = new Map();   // callSid → { dir, peer, purpose, history:[], decision, message, endedNote }
function getCall(sid) { if (!calls.has(sid)) calls.set(sid, { history: [] }); return calls.get(sid); }
setInterval(() => { /* GC old calls */ if (calls.size > 200) calls.clear(); }, 3600000).unref?.();

// ---- spoken-clip cache (serve BhatBot's own ElevenLabs voice to Twilio via <Play>) --------
const clips = new Map(); let clipSeq = 0;
setInterval(() => { const t = Date.now(); for (const [k, v] of clips) if (t - v.at > 600000) clips.delete(k); }, 120000).unref?.();
async function sayEl(host, text) {
  const t = String(text || '').trim(); if (!t) return '';
  try {
    const r = await voice.tts(t);
    if (r && r.audio) { const id = (++clipSeq).toString(36) + Date.now().toString(36); clips.set(id, { buf: Buffer.from(r.audio, 'base64'), at: Date.now() }); return `<Play>https://${host}/vc/${id}.mp3</Play>`; }
  } catch {}
  return `<Say voice="Google.en-US-Neural2-D">${xmlEsc(t)}</Say>`;   // fallback so the call never goes silent
}
const gather = (host, token, playEl, leg) => `<?xml version="1.0" encoding="UTF-8"?><Response>` +
  `<Gather input="speech" action="https://${host}/voice/${token}/gather?leg=${leg}" method="POST" speechTimeout="auto" speechModel="experimental_conversations" actionOnEmptyResult="true">${playEl}</Gather>` +
  `<Redirect method="POST">https://${host}/voice/${token}/gather?leg=${leg}</Redirect></Response>`;
const hangup = (playEl) => `<?xml version="1.0" encoding="UTF-8"?><Response>${playEl}<Hangup/></Response>`;

// ---- the on-call brain (low-latency: direct model call, no tool loop mid-call) -------------
async function converse(sid, speech, sysExtra) {
  const c = getCall(sid);
  const sys = `You are BhatBot, speaking ON THE PHONE on behalf of Siddhant Bhat (you are his assistant, not him). Be warm, concise, and natural — one or two sentences per turn, as a real person would speak. No markdown. ${sysExtra || ''}`;
  c.history.push({ role: 'user', content: speech });
  let reply = '';
  try { const j = await callClaude({ system: sys, messages: c.history.slice(-16), maxTokens: 200 }); reply = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim(); }
  catch (e) { reply = 'My apologies, I had a brief technical issue.'; }
  c.history.push({ role: 'assistant', content: reply });
  db.pushActivity('call', `📞 ${c.peer || sid}: “${speech.slice(0, 120)}” → “${reply.slice(0, 120)}”`);
  return reply;
}

// ---- outbound: the agent tool calls this -------------------------------------
async function placeCall(to, purpose) {
  if (!configured()) return { success: false, error: 'Twilio not configured (set TWILIO_SID/TOKEN/FROM secrets).' };
  if (!to) return { success: false, error: 'need a phone number to call' };
  if (!PUBLIC_URL) return { success: false, error: 'PUBLIC_URL not set (cloud cannot receive Twilio webhooks).' };
  const token = process.env.BHATBOT_TOKEN;
  try {
    const j = await twilioPost('Calls.json', {
      To: to, From: FROM,
      Url: `${PUBLIC_URL}/voice/${token}/outgoing?purpose=${enc(purpose || '')}`,
      StatusCallback: `${PUBLIC_URL}/voice/${token}/status`, StatusCallbackEvent: 'completed',
    });
    const c = getCall(j.sid); c.dir = 'out'; c.peer = to; c.purpose = purpose || '';
    db.pushActivity('call', `📞→ calling ${to}${purpose ? ' re: ' + purpose.slice(0, 80) : ''}`);
    return { success: true, callSid: j.sid, result: `Calling ${to}. I'll handle it and text you a summary.` };
  } catch (e) { return { success: false, error: e.message }; }
}

// ---- agent reply → phone-friendly: collapse whitespace, drop markdown noise, cap length -----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function condense(t) {
  let s = String(t == null ? '' : t).replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 600) s = s.slice(0, 580).replace(/\s+\S*$/, '') + '…';
  return s || 'Done.';
}

// ---- outbound: CALL Siddhant for input mid-task, wait for his spoken answer, return it --------
async function askOwner(question, opts = {}) {
  if (!configured()) return { success: false, error: 'Twilio not configured' };
  if (!OWNER) return { success: false, error: 'OWNER_PHONE not set' };
  if (!PUBLIC_URL) return { success: false, error: 'PUBLIC_URL not set' };
  const token = process.env.BHATBOT_TOKEN;
  const timeoutMs = opts.timeoutMs || 150000;
  let j;
  try {
    j = await twilioPost('Calls.json', {
      To: OWNER, From: FROM,
      Url: `${PUBLIC_URL}/voice/${token}/ask?q=${enc(question)}`,
      StatusCallback: `${PUBLIC_URL}/voice/${token}/status`, StatusCallbackEvent: 'completed',
    });
  } catch (e) { return { success: false, error: e.message }; }
  const sid = j.sid; const c = getCall(sid); c.dir = 'ask'; c.peer = OWNER; c.question = question; c.answer = undefined;
  db.pushActivity('call', `🆘 calling you for input: ${String(question).slice(0, 100)}`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (c.answer !== undefined) return { success: true, answer: c.answer, result: `You said: ${c.answer}` }; await sleep(1500); }
  return { success: true, answer: c.answer ?? null, note: 'no spoken answer captured in time (you may not have answered)' };
}

// ---- Twilio signature check (defense even though token-gated) ------------------
const crypto = require('crypto');
function verified(req) {
  if (!AUTH) return true;
  try {
    const sig = req.get('x-twilio-signature') || ''; const url = `https://${req.get('host')}${req.originalUrl}`;
    const p = req.body || {}; let data = url; for (const k of Object.keys(p).sort()) data += k + p[k];
    const exp = crypto.createHmac('sha1', AUTH).update(Buffer.from(data, 'utf-8')).digest('base64');
    const a = Buffer.from(sig), b = Buffer.from(exp); return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// ---- mount all the webhooks ---------------------------------------------------
function mount(app, { token, form }) {
  // Serve cached voice clips (ephemeral, no token — Twilio fetches these; harmless audio blobs).
  app.get('/vc/:id', (req, res) => { const c = clips.get(String(req.params.id).replace(/\.mp3$/, '')); if (!c) return res.status(404).end(); res.set('content-type', 'audio/mpeg').set('cache-control', 'no-store').send(c.buf); });

  // The secret token must be in the webhook path (you set this in the Twilio console). Defense
  // in depth alongside the Twilio signature check.
  const tg = (req, res, next) => (req.params.token === token && token) ? next() : res.status(404).end();
  app.use('/voice/:token', tg);
  app.use('/sms/:token', tg);

  const reject = (res) => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');

  // OUTBOUND first leg — open with the goal, then listen.
  app.post('/voice/:token/outgoing', form, async (req, res) => {
    if (!verified(req)) return reject(res);
    const sid = req.body.CallSid || ''; const c = getCall(sid); c.dir = 'out'; c.peer = req.body.To || c.peer;
    const purpose = req.query.purpose || c.purpose || '';
    const opener = await converse(sid, `[You placed this call. Your goal: ${purpose}. Greet them, say you're Siddhant's assistant BhatBot, and state why you're calling.]`,
      `This is an OUTBOUND call you placed for Siddhant. Accomplish: ${purpose}. When done, thank them and wrap up.`);
    res.type('text/xml').send(gather(req.get('host'), token, await sayEl(req.get('host'), opener), 'out'));
  });

  // INBOUND first leg. OWNER calling in → COMMAND MODE (his voice = instructions to the full
  // agent). Anyone else → screen who/why.
  app.post('/voice/:token/incoming', form, async (req, res) => {
    if (!verified(req)) return reject(res);
    const sid = req.body.CallSid || ''; const c = getCall(sid); c.dir = 'in'; c.peer = req.body.From || 'caller';
    const host = req.get('host');
    if (OWNER && c.peer === OWNER) {
      c.owner = true;
      db.pushActivity('call', '📞← Siddhant calling in (command mode)');
      const hello = 'Good evening, sir. BhatBot here. What can I do for you?';
      return res.type('text/xml').send(gather(host, token, await sayEl(host, hello), 'owner'));
    }
    db.pushActivity('call', `📞← incoming from ${c.peer}`);
    const greet = await converse(sid, '[Incoming call. Greet them as Siddhant\'s assistant and politely ask who is calling and what it\'s regarding.]',
      'This is an INBOUND call. First find out WHO is calling and WHY (screening), in one short question.');
    res.type('text/xml').send(gather(host, token, await sayEl(host, greet), 'screen'));
  });

  // Conversation turns.
  app.post('/voice/:token/gather', form, async (req, res) => {
    if (!verified(req)) return reject(res);
    const sid = req.body.CallSid || ''; const c = getCall(sid); const host = req.get('host'); const leg = req.query.leg || 'in';
    const speech = (req.body.SpeechResult || '').trim();
    if (!speech) return res.type('text/xml').send(gather(host, token, await sayEl(host, 'Sorry, I didn’t catch that. Go on.'), leg));

    // OWNER COMMAND MODE: his speech is an instruction → run the FULL agent (tools + Mac relay),
    // speak the result, loop. Long tasks race an 11s timer so Twilio doesn't time out; if still
    // running we say "on it" and poll /ownerwait until it finishes.
    if (leg === 'owner' || c.owner) {
      if (/\b(that'?s all|nothing else|that is all|we'?re done|hang up|good\s?bye|^bye)\b/i.test(speech)) {
        relaySummary(sid);
        return res.type('text/xml').send(hangup(await sayEl(host, 'Very good, sir. Goodbye.')));
      }
      db.pushActivity('call', `🗣 Siddhant (call): “${speech.slice(0, 140)}”`);
      c.history.push({ role: 'user', content: speech });
      c.pendingResult = undefined;
      c.pending = require('./agent').runTurn('phone-voice', speech)
        .then((r) => { c.pendingResult = condense(r && r.text); c.history.push({ role: 'assistant', content: c.pendingResult }); return c.pendingResult; })
        .catch((e) => { c.pendingResult = 'I hit an error: ' + e.message; return c.pendingResult; });
      const winner = await Promise.race([c.pending, new Promise((r) => setTimeout(() => r(null), 11000))]);
      if (winner != null) { c.pendingResult = undefined; return res.type('text/xml').send(gather(host, token, await sayEl(host, winner + ' Anything else, sir?'), 'owner')); }
      const hold = await sayEl(host, 'On it — one moment.');
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${hold}<Redirect method="POST">https://${host}/voice/${token}/ownerwait?n=0</Redirect></Response>`);
    }
    // ASK leg: BhatBot called Siddhant for input → capture his spoken answer + end.
    if (leg === 'ask') {
      c.answer = speech;
      db.pushActivity('call', `🆘 your answer: “${speech.slice(0, 140)}”`);
      return res.type('text/xml').send(hangup(await sayEl(host, 'Thank you, sir — I’ll proceed with that.')));
    }

    // Inbound screening: after we learn who/why, text the owner the options and put caller on hold.
    if (leg === 'screen' && c.dir === 'in' && !c.screened) {
      c.screened = true; c.reason = speech;
      await converse(sid, speech, 'Acknowledge warmly and say you\'ll check if Siddhant is available — ask them to hold a moment.');
      notifyOwner(`📞 Call from ${c.peer}: “${speech.slice(0, 200)}”\nReply TAKE to be connected, HANDLE to let me deal with it, or VM for a message.`);
      db.pushActivity('call', `🛎 screening ${c.peer}: ${speech.slice(0, 140)} — texted you (TAKE/HANDLE/VM)`);
      const hold = await sayEl(host, 'One moment please — let me see if Siddhant is available.');
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${hold}<Redirect method="POST">https://${host}/voice/${token}/wait?n=0</Redirect></Response>`);
    }
    // Take-a-message leg → store + relay to owner, thank caller, hang up.
    if (leg === 'msg') {
      c.message = speech;
      notifyOwner(`📝 Message from ${c.peer}: “${speech.slice(0, 400)}”`);
      db.pushActivity('call', `📝 message from ${c.peer}: ${speech.slice(0, 140)}`);
      relaySummary(sid);
      return res.type('text/xml').send(hangup(await sayEl(host, 'Thank you — I’ll pass that along to Siddhant right away. Goodbye.')));
    }
    // Normal conversational turn (outbound goal, or inbound after HANDLE).
    const reply = await converse(sid, speech);
    // Heuristic end: if the model says goodbye, hang up + relay summary.
    if (/\b(goodbye|good bye|take care|have a (great|good) (day|one)|bye now)\b/i.test(reply)) {
      relaySummary(sid); return res.type('text/xml').send(hangup(await sayEl(host, reply)));
    }
    res.type('text/xml').send(gather(host, token, await sayEl(host, reply), leg));
  });

  // Hold loop — poll for the owner's SMS decision (TAKE/HANDLE/VM), ~5s per cycle, up to ~50s.
  app.post('/voice/:token/wait', form, async (req, res) => {
    if (!verified(req)) return reject(res);
    const sid = req.body.CallSid || ''; const c = getCall(sid); const host = req.get('host'); const n = Number(req.query.n || 0);
    if (c.decision === 'take') {
      const bye = await sayEl(host, 'Connecting you now — one moment.');
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${bye}<Dial callerId="${xmlEsc(FROM)}" timeout="25">${xmlEsc(OWNER)}</Dial></Response>`);
    }
    if (c.decision === 'handle') { const r = await converse(sid, '[Siddhant asked you to handle this. Tell them you\'ll help on his behalf and ask how you can help.]', 'Handle the call fully on Siddhant\'s behalf; be helpful and take any needed details.'); return res.type('text/xml').send(gather(host, token, await sayEl(host, r), 'in')); }
    if (c.decision === 'vm' || n >= 10) {
      const ask = await sayEl(host, 'Siddhant isn’t available right now. May I take a message and I’ll pass it along?');
      return res.type('text/xml').send(gather(host, token, ask, 'msg'));
    }
    // keep holding
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="5"/><Redirect method="POST">https://${host}/voice/${token}/wait?n=${n + 1}</Redirect></Response>`);
  });

  // Owner command-mode hold loop — poll for the agent task to finish, then speak the result.
  app.post('/voice/:token/ownerwait', form, async (req, res) => {
    if (!verified(req)) return reject(res);
    const sid = req.body.CallSid || ''; const c = getCall(sid); const host = req.get('host'); const n = Number(req.query.n || 0);
    if (c.pendingResult !== undefined) { const t = c.pendingResult; c.pendingResult = undefined; return res.type('text/xml').send(gather(host, token, await sayEl(host, t + ' Anything else, sir?'), 'owner')); }
    if (n >= 16) { return res.type('text/xml').send(gather(host, token, await sayEl(host, 'Still working on that — I’ll text you when it’s done. Anything else?'), 'owner')); }
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="3"/><Redirect method="POST">https://${host}/voice/${token}/ownerwait?n=${n + 1}</Redirect></Response>`);
  });

  // ASK first leg — BhatBot is calling Siddhant for input; ask the question, then listen.
  app.post('/voice/:token/ask', form, async (req, res) => {
    if (!verified(req)) return reject(res);
    const sid = req.body.CallSid || ''; const c = getCall(sid); c.dir = 'ask'; c.peer = req.body.To || OWNER;
    const host = req.get('host'); const q = req.query.q || c.question || 'I need your input on something.';
    c.question = q;
    res.type('text/xml').send(gather(host, token, await sayEl(host, `Good evening, sir. BhatBot here — I need your input. ${q}`), 'ask'));
  });

  // Status callback (call ended) → ensure a summary went out.
  app.post('/voice/:token/status', form, (req, res) => { if (verified(req) && req.body.CallStatus === 'completed') relaySummary(req.body.CallSid || ''); res.status(204).end(); });

  // INBOUND SMS — owner replies steer a live call (TAKE/HANDLE/VM); otherwise drive the agent.
  app.post('/sms/:token/incoming', form, async (req, res) => {
    if (!verified(req)) return res.status(403).end();
    const from = req.body.From || ''; const body = (req.body.Body || '').trim();
    const reply = (t) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${t ? `<Message>${xmlEsc(t)}</Message>` : ''}</Response>`);
    if (OWNER && from === OWNER) {
      const m = body.toLowerCase();
      const live = [...calls.values()].find((c) => c.dir === 'in' && c.screened && !c.decision);
      if (live && /^(take|yes|connect)\b/.test(m)) { live.decision = 'take'; return reply('Connecting you to the caller now.'); }
      if (live && /^(handle|deal|you)\b/.test(m)) { live.decision = 'handle'; return reply('On it — I’ll handle the call.'); }
      if (live && /^(vm|voicemail|message|no)\b/.test(m)) { live.decision = 'vm'; return reply('I’ll take a message.'); }
    }
    // Not a call-steer → run it through the agent (owner only) and text the answer back.
    if (!OWNER || from === OWNER) { try { const r = await require('./agent').runTurn('sms', body); return reply((r.text || '').slice(0, 1400)); } catch (e) { return reply('Error: ' + e.message); } }
    return reply('');   // ignore non-owner SMS
  });

  // gather leg 'msg' is handled in /gather above when leg=msg → record + relay.
}

// Take-a-message handling rides on the normal gather (leg=msg): when we see it, store + relay.
function relaySummary(sid) {
  const c = calls.get(sid); if (!c || c.relayed) return; c.relayed = true;
  const lines = c.history.filter((m) => m.role !== 'system').slice(-8).map((m) => (m.role === 'user' ? '• them: ' : '• BhatBot: ') + String(m.content).slice(0, 160)).join('\n');
  const head = c.dir === 'out' ? `📞 Call to ${c.peer} done${c.purpose ? ' (re: ' + c.purpose.slice(0, 80) + ')' : ''}.` : `📞 Call from ${c.peer} ended.`;
  notifyOwner(`${head}\n${lines}`.slice(0, 1500));
  db.pushActivity('call', `${head} summary texted to you`);
}

module.exports = { mount, placeCall, askOwner, sendSMS, notifyOwner, configured };
