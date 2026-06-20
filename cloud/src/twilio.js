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
const CMD_PASS = process.env.COMMAND_PASSPHRASE || '';  // spoken passphrase that unlocks command mode (closes caller-ID spoofing)
const normPass = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
// Turn-taking knobs (env-tunable): the caller fed back that BhatBot interrupted + missed speech.
//  • speechTimeout = seconds of trailing SILENCE before we treat the turn as done. "auto" uses
//    Twilio's endpointing (can clip mid-thought); a fixed value (default 2s) is more patient.
//  • speechModel "phone_call" + enhanced is Twilio's telephony-optimized recognizer → fewer "say
//    that again" repeats than experimental_conversations on a noisy line.
const GATHER_TIMEOUT = process.env.GATHER_SPEECH_TIMEOUT || '2';
const GATHER_MODEL = process.env.GATHER_SPEECH_MODEL || 'phone_call';
const GATHER_ENHANCED = process.env.GATHER_ENHANCED !== '0';
const gather = (host, token, playEl, leg) => `<?xml version="1.0" encoding="UTF-8"?><Response>` +
  `<Gather input="speech" action="https://${host}/voice/${token}/gather?leg=${leg}" method="POST" speechTimeout="${GATHER_TIMEOUT}" speechModel="${GATHER_MODEL}" enhanced="${GATHER_ENHANCED}" actionOnEmptyResult="true">${playEl}</Gather>` +
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

// Siddhant's butler persona for inbound (non-owner) calls + a civility backstop.
const BUTLER_SYS = "You are BhatBot, Siddhant Bhat's courteous, professional butler answering his phone line (you are his assistant, never him). Identify yourself as BhatBot when it's natural. You have learned who is calling and why. Acknowledge them warmly — by name if they gave one — then offer to help on his behalf: answer what you reasonably can, take details or a message, and assure them you'll pass it along to Siddhant. Speak as a real butler would: gracious, composed, one or two short spoken sentences per turn, no markdown. "
  + "PROTECT HIS TIME — this is important: only offer to connect a caller directly to Siddhant when BOTH are true: (1) they specifically ask to speak with Siddhant (by name), AND (2) they are clearly a real person with a genuine, legitimate reason — NOT a sales pitch, marketing, robocall, survey, fundraiser, or vague/spammy call. When BOTH hold, tell them you'll try to put them through and append the literal token [PATCH] to that sentence. If they do not ask for Siddhant by name, or the reason looks like spam/sales, do NOT offer to connect them — help them yourself or take a message instead. "
  + "If the caller is rude, insulting, vulgar, demeaning, or hostile, give exactly ONE polite warning; if the disrespect continues, end the call by appending the literal token [END_CALL] to a final courteous sentence. When their business is clearly concluded, wrap up warmly (you may also use [END_CALL]). Never tolerate abuse, but never be abrupt or impolite yourself.";
const ABUSE_RE = /\b(f+u+c+k\w*|motherf\w*|sh[i1]t\w*|b[i1]tch\w*|assholes?|c[u]nt\w*|dickheads?|bastards?|shut up|screw you|piss off|go to hell|n[i1]gg\w*|fa[g6]+ots?|slut|whore)\b/i;
function isAbusive(t) { return ABUSE_RE.test(String(t || '')); }

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
      // Caller-ID alone is spoofable, so command mode (run_shell/system_control/Mac relay) requires
      // a spoken passphrase when COMMAND_PASSPHRASE is set. Without it, fall back to caller-ID only.
      if (!CMD_PASS) {
        c.owner = true;
        db.pushActivity('call', '📞← Siddhant calling in (command mode — ⚠ no COMMAND_PASSPHRASE set)');
        return res.type('text/xml').send(gather(host, token, await sayEl(host, 'Good evening, sir. BhatBot here. What can I do for you?'), 'owner'));
      }
      c.awaitingAuth = true;
      db.pushActivity('call', '📞← command-mode call on your number — requesting passphrase');
      return res.type('text/xml').send(gather(host, token, await sayEl(host, 'Good evening, sir. BhatBot here. Your passphrase, please.'), 'auth'));
    }
    db.pushActivity('call', `📞← incoming from ${c.peer}`);
    const greet = await converse(sid, '[Incoming call. Greet them, clearly state that this is BhatBot, Siddhant Bhat\'s assistant, then in one short greeting ask who is calling, what it\'s regarding, and who they are hoping to reach.]',
      'This is an INBOUND call. Open by identifying yourself as "BhatBot, Siddhant\'s assistant." In one short greeting, ask who is calling, why, and who they are hoping to reach.');
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
    // AUTH leg: verify the spoken passphrase before granting command mode (anti-spoofing gate).
    if (leg === 'auth') {
      if (CMD_PASS && normPass(speech) === normPass(CMD_PASS)) {
        c.owner = true; c.awaitingAuth = false;
        db.pushActivity('call', '🔓 command mode unlocked (passphrase ok)');
        return res.type('text/xml').send(gather(host, token, await sayEl(host, 'Verified. What can I do for you, sir?'), 'owner'));
      }
      c.authTries = (c.authTries || 0) + 1;
      if (c.authTries >= 3) {
        db.pushActivity('call', `🚫 3 bad command-mode passphrase tries from ${c.peer} — dropped to butler`);
        notifyOwner(`🚫 ${c.authTries} failed command-mode passphrase attempts on a call from ${c.peer}. If that wasn't you, your caller ID may have been spoofed.`);
        c.dir = 'in'; c.owner = false;   // deny machine access; treat as an unknown caller
        const greet = await converse(sid, '[The caller failed the passphrase. Treat them as an unknown caller: politely state you are BhatBot, Siddhant\'s assistant, and ask who is calling and why.]', BUTLER_SYS);
        return res.type('text/xml').send(gather(host, token, await sayEl(host, greet), 'screen'));
      }
      return res.type('text/xml').send(gather(host, token, await sayEl(host, 'That didn’t match. Your passphrase, please.'), 'auth'));
    }

    // Inbound BUTLER mode: BhatBot answers as Siddhant's courteous butler. It has learned who/why,
    // texts the owner (who may reply TAKE to jump in), then helps the caller on his behalf and
    // relays a summary. Disrespect → one polite warning, then a courteous hang-up.
    if ((leg === 'screen' || leg === 'butler') && c.dir === 'in') {
      // Owner texted TAKE → bridge the caller to him right away.
      if (c.decision === 'take') {
        const bye = await sayEl(host, 'Of course — connecting you to Siddhant now. One moment.');
        return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${bye}<Dial callerId="${xmlEsc(FROM)}" timeout="25">${xmlEsc(OWNER)}</Dial></Response>`);
      }
      // Civility backstop: obvious abuse → warn once, end politely on a repeat.
      if (isAbusive(speech)) {
        c.rude = (c.rude || 0) + 1;
        if (c.rude >= 2) {
          db.pushActivity('call', `🚫 ended call from ${c.peer} — disrespectful`);
          notifyOwner(`🚫 Ended a call from ${c.peer} — the caller was being disrespectful.`);
          relaySummary(sid);
          return res.type('text/xml').send(hangup(await sayEl(host, 'I’m sorry, but I won’t be able to continue this call. Good day.')));
        }
        const warn = await sayEl(host, 'I’d kindly ask that we keep this respectful. How may I help you on Siddhant’s behalf?');
        return res.type('text/xml').send(gather(host, token, warn, 'butler'));
      }
      // First screening turn → record who/why and quietly notify the owner.
      if (!c.screened) {
        c.screened = true; c.reason = speech;
        notifyOwner(`📞 Call from ${c.peer}: “${speech.slice(0, 200)}”\nReply TAKE to be connected — otherwise I’ll assist them as your butler and text you a summary.`);
        db.pushActivity('call', `🛎 ${c.peer}: ${speech.slice(0, 140)} — assisting as butler (reply TAKE to jump in)`);
      }
      // Courteous butler turn: acknowledge, offer help, take details, relay later.
      const r = await converse(sid, speech, BUTLER_SYS);
      // Patch-through: butler only emits [PATCH] when the caller asked for Siddhant by name AND has
      // a legitimate reason → try to ring Siddhant; if he doesn't pick up, fall to a message.
      if (/\[PATCH\]/i.test(r)) {
        const clean = r.replace(/\[PATCH\]/ig, '').trim() || 'Let me see if I can put you through to Siddhant — one moment.';
        notifyOwner(`📞 ${c.peer} asked to speak with you (re: ${(c.reason || '').slice(0, 140)}). Patching them through — answer to take it.`);
        db.pushActivity('call', `🔗 patching ${c.peer} through to Siddhant`);
        return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${await sayEl(host, clean)}<Dial callerId="${xmlEsc(FROM)}" timeout="25" action="https://${host}/voice/${token}/afterdial" method="POST">${xmlEsc(OWNER)}</Dial></Response>`);
      }
      if (/\[END_?CALL\]/i.test(r) || /\b(goodbye|good bye|take care|have a (great|good) (day|one)|bye now)\b/i.test(r)) {
        const clean = r.replace(/\[END_?CALL\]/ig, '').trim() || 'Thank you for calling. Good day.';
        relaySummary(sid);
        return res.type('text/xml').send(hangup(await sayEl(host, clean)));
      }
      return res.type('text/xml').send(gather(host, token, await sayEl(host, r), 'butler'));
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

  // After a patch-through Dial: if Siddhant answered, wrap up; if not, offer to take a message.
  app.post('/voice/:token/afterdial', form, async (req, res) => {
    if (!verified(req)) return reject(res);
    const sid = req.body.CallSid || ''; const c = getCall(sid); const host = req.get('host');
    if ((req.body.DialCallStatus || '') === 'completed') { relaySummary(sid); return res.type('text/xml').send(hangup(await sayEl(host, 'Thank you — goodbye.'))); }
    db.pushActivity('call', `📵 patch-through to Siddhant not answered (${c.peer}) — offering message`);
    const ask = await sayEl(host, 'I’m sorry, I couldn’t reach Siddhant just now. May I take a message and pass it along?');
    return res.type('text/xml').send(gather(host, token, ask, 'msg'));
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
