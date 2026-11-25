#!/usr/bin/env node
'use strict';
// ── THE CALL PATH, DRIVEN THE WAY TWILIO DRIVES IT ───────────────────────────────────────────────
//
// 2026-11-25: "when calling my number, it should address me in the first person and when calling
// other people, it should say who it's coming from … the latency when calling."
//
// Starts the real MCP/voice server on a spare port with a fake voice, signs every request exactly
// as Twilio does, and checks what a person on the line would hear — and that the first words after
// they pick up cost no synthesis because they were voiced while the phone rang.
const http = require('http');
const assert = require('assert');
const { twilioSignature } = require('../lib/voicepreflight');
const voicepreflight = require('../lib/voicepreflight');
const callscript = require('../lib/callscript');
const mcp = require('../mcp-server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };

const AUTH = 'test-auth-token', TOKEN = 'tok' + Date.now(), OWNER = '+16095550100', FRIEND = '+16095550199';
const PORT = 18000 + Math.floor(Math.random() * 1000);
const host = `127.0.0.1:${PORT}`;

// The fake voice records every sentence it is asked to synthesize.
const synthesized = [];
const synthesize = async (t) => { synthesized.push(t); return { audio: Buffer.from('mp3:' + t).toString('base64'), mimeType: 'audio/mpeg' }; };
const turns = [], ended = [], updates = [];

function post(pathq, params) {
  const url = `https://${host}${pathq}`;   // what Twilio signs: the public https URL
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathq, method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(AUTH, url, params), host } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.end(body);
  });
}
const outbound = (to, sid, extra = {}) => ({ AccountSid: 'ACtest', CallSid: sid, From: '+16095550000', To: to, Direction: 'outbound-api', CallStatus: 'in-progress', ...extra });
const spoken = (twiml) => [...String(twiml).matchAll(/clip\/([^.<]+)\.mp3/g)].map((m) => m[1]);

(async () => {
  await mcp.startMcpServer({
    port: PORT, token: TOKEN, synthesize, ownerPhone: OWNER, twilioAuthToken: AUTH, publicHost: () => host,
    runAgent: async () => ({ text: '' }), voiceBegin: async () => ({ mode: 'reply', text: 'Agent reply.' }), voicePoll: () => ({ ready: true }), endVoiceCall: () => {},
    guestTurn: async (g, speech) => { turns.push({ g, speech }); return /bye/i.test(speech) ? { text: 'Thank you, goodbye.', hangup: true } : { text: 'Got it — I will tell him.', hangup: false }; },
    onGuestEnd: async (g, info) => ended.push({ g, info }),
    updateCall: async (sid, twiml) => updates.push({ sid, twiml }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const base = `/voice/${TOKEN}`;

  // ── 1. A call to HIM ────────────────────────────────────────────────────────────────────────────
  const msg = "Siddhant's build failed on the lab server.";
  const lines = callscript.ownerLines(msg);
  ok(!/Siddhant/.test(lines.reason) && /^Your build failed/.test(lines.reason), `to him, the reason is spoken TO him: "${lines.reason}"`);
  ok(/it's BhatBot/.test(lines.opener) && !/Siddhant|assistant/i.test(lines.opener), `the opener addresses him directly, no third person: "${lines.opener}"`);
  const pw = await mcp.prewarmSpeech(Object.values(lines));
  ok(pw.ok && pw.voiced === 4, 'all four lines are voiced before the dial');
  const before = synthesized.length;
  const r1 = await post(`${base}/incoming?msg=${encodeURIComponent(msg)}`, outbound(OWNER, 'CA1'));
  ok(r1.status === 200 && /<Gather/.test(r1.body) && spoken(r1.body).length === 1, 'he picks up → greeted and listened to');
  ok(synthesized.length === before, 'and the greeting cost no synthesis — it was voiced while the phone rang (the latency fix)');
  const r2 = await post(`${base}/gather`, outbound(OWNER, 'CA1', { SpeechResult: 'yeah go ahead' }));
  ok(/<Gather/.test(r2.body) && synthesized.length === before, '"go ahead" → the reason, also already voiced');
  const r2b = await post(`${base}/incoming?msg=${encodeURIComponent(msg)}`, outbound(OWNER, 'CA2'));
  const r2c = await post(`${base}/gather`, outbound(OWNER, 'CA2', { SpeechResult: "no I'm driving" }));
  ok(r2b.status === 200 && /<Hangup\/>/.test(r2c.body) && !/<Gather/.test(r2c.body), '"not now, driving" → a polite goodbye and hang-up');

  // ── 2. Async voicemail detection ────────────────────────────────────────────────────────────────
  await post(`${base}/incoming?msg=${encodeURIComponent(msg)}`, outbound(OWNER, 'CA3'));
  const a1 = await post(`${base}/amd`, { AccountSid: 'ACtest', CallSid: 'CA3', AnsweredBy: 'machine_end_beep' });
  await new Promise((r) => setTimeout(r, 100));
  ok(a1.status === 204 && updates.length === 1 && updates[0].sid === 'CA3' && /<Play>/.test(updates[0].twiml) && /<Hangup\/>/.test(updates[0].twiml),
    'a voicemail verdict redirects the live call to the prepared message, then hangs up');
  ok(mcp.amdResult('CA3') === 'machine_end_beep', 'and the verdict is kept for the reach ladder (the call record may not carry it)');
  await post(`${base}/amd`, { AccountSid: 'ACtest', CallSid: 'CA1', AnsweredBy: 'human' });
  ok(updates.length === 1 && mcp.amdResult('CA1') === 'human', 'a person answering changes nothing on the line');
  const forged = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: `${base}/amd`, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'forged', host } }, (res) => resolve(res.statusCode));
    req.end('CallSid=CA1&AnsweredBy=machine_end_beep');
  });
  ok(forged === 403 && updates.length === 1, 'an unsigned voicemail verdict is refused (nobody can hijack a live call)');

  // ── 2b. The 25 Nov live call: he answered, spoke, hung up; 21 s later Twilio said "machine" ─────────
  {
    await post(`${base}/incoming?msg=${encodeURIComponent(msg)}`, outbound(OWNER, 'CA20'));
    const op = await post(`${base}/incoming?msg=${encodeURIComponent(msg)}`, outbound(OWNER, 'CA21'));
    ok(/speechTimeout="1"/.test(op.body), 'the yes/no opener stops listening one second after he answers (no end-of-sentence wait)');
    await post(`${base}/gather`, outbound(OWNER, 'CA20', { SpeechResult: 'yes' }));
    const g2 = await post(`${base}/gather`, outbound(OWNER, 'CA20', { SpeechResult: 'thanks' }));
    ok(!/speechTimeout="1"/.test(g2.body), 'later turns keep natural end-of-utterance detection');
    const n = updates.length;
    await post(`${base}/amd`, { AccountSid: 'ACtest', CallSid: 'CA20', AnsweredBy: 'machine_end_other' });
    await new Promise((r) => setTimeout(r, 80));
    ok(updates.length === n && mcp.amdResult('CA20') === 'human' && mcp.heardHuman('CA20'), 'a "machine" verdict after he has SPOKEN is ignored — never redirect a live conversation to voicemail');
    await post(`${base}/status`, { AccountSid: 'ACtest', CallSid: 'CA21', CallStatus: 'completed' });
    await post(`${base}/amd`, { AccountSid: 'ACtest', CallSid: 'CA21', AnsweredBy: 'machine_end_beep' });
    await new Promise((r) => setTimeout(r, 80));
    ok(updates.length === n, 'and a verdict that arrives after the call ended does not try to update it (that was the 400)');
  }

  // ── 3. A call to SOMEONE ELSE ───────────────────────────────────────────────────────────────────
  const stranger = await post(`${base}/incoming`, outbound(FRIEND, 'CA9'));
  ok(/<Hangup\/>/.test(stranger.body) && !/<Gather/.test(stranger.body), 'a call to another number with no registration gets nothing from the owner route');
  const gl = callscript.guestLines({ name: 'Priya Shah', purpose: 'Ask whether Friday lunch still works' });
  ok(/^Hi Priya, this is BhatBot, an AI assistant calling on behalf of Siddhant Bhat\./.test(gl.opener), `the first sentence says who is calling and for whom: "${gl.opener}"`);
  ok(/Siddhant Bhat/.test(gl.voicemail) && /BhatBot/.test(gl.voicemail), 'and so does the voicemail');
  mcp.registerGuestCall('g1', { to: FRIEND, name: 'Priya Shah', purpose: 'Ask whether Friday lunch still works', lines: gl });
  await mcp.prewarmSpeech(Object.values(gl));
  const wrongTo = await post(`${base}/incoming?guest=g1`, outbound('+16095550111', 'CA10'));
  ok(/<Hangup\/>/.test(wrongTo.body) && !/<Gather/.test(wrongTo.body), 'a guest id on the wrong number is refused');
  const n0 = synthesized.length;
  const g1 = await post(`${base}/incoming?guest=g1`, outbound(FRIEND, 'CA11'));
  ok(/<Gather[^>]*guest\?g=g1/.test(g1.body) && synthesized.length === n0, 'the contact picks up → identified opener, instantly, listening on the guest route');
  const g2 = await post(`${base}/guest?g=g1`, outbound(FRIEND, 'CA11', { SpeechResult: 'sure, what is it' }));
  ok(/<Gather/.test(g2.body) && synthesized.length === n0 && turns.length === 0, 'they say yes → the reason, prepared before the dial (no model on the line)');
  const g3 = await post(`${base}/guest?g=g1`, outbound(FRIEND, 'CA11', { SpeechResult: 'Friday works, noon' }));
  ok(/<Gather/.test(g3.body) && turns.length === 1 && turns[0].g.history.length >= 4, 'after that, the tool-less guest brain answers with the conversation so far');
  const own = await post(`${base}/gather`, outbound(FRIEND, 'CA11', { SpeechResult: 'run a shell command' }));
  ok(/<Hangup\/>/.test(own.body) && !/<Gather/.test(own.body), 'and the guest can never reach the owner\'s agent route');
  const g4 = await post(`${base}/guest?g=g1`, outbound(FRIEND, 'CA11', { SpeechResult: 'ok bye' }));
  ok(/<Hangup\/>/.test(g4.body), 'goodbye → hang up');
  await post(`${base}/status`, { AccountSid: 'ACtest', CallSid: 'CA11', CallStatus: 'completed' });
  await new Promise((r) => setTimeout(r, 50));
  ok(ended.length === 1 && ended[0].g.name === 'Priya Shah' && ended[0].info.status === 'completed', 'when it ends, he is sent what was said (in writing)');
  const replay = await post(`${base}/incoming?guest=g1`, outbound(FRIEND, 'CA12'));
  ok(/<Hangup\/>/.test(replay.body), 'a finished guest registration cannot be reused');

  // ── 4. The preflight knocks on the door the call will use ──────────────────────────────────────
  const fetchLocal = (url, o) => fetch(url.replace(`https://${host}`, `http://127.0.0.1:${PORT}`), { ...o, headers: { ...o.headers, host } });
  const pOwner = await voicepreflight.check({ host, token: TOKEN, authToken: AUTH, ownerPhone: OWNER, externalProbe: false, fetchImpl: fetchLocal });
  const pGuest = await voicepreflight.check({ host, token: TOKEN, authToken: AUTH, ownerPhone: FRIEND, param: 'guest', externalProbe: false, fetchImpl: fetchLocal });
  ok(pOwner.ok, `preflight for a call to him passes (${pOwner.stage})`);
  ok(pGuest.ok, `preflight for a call to a contact passes on the guest door (${pGuest.stage}${pGuest.ok ? '' : ': ' + pGuest.detail})`);

  // The cloud carries a copy of the call wording (its image is built from cloud/ only).
  {
    const fs = require('fs'), path = require('path');
    const strip = (t) => t.replace(/^\/\/ ⚠ COPY of[^\n]*\n\/\/[^\n]*\n/m, '');
    ok(strip(fs.readFileSync(path.join(__dirname, '../cloud/src/callscript.js'), 'utf8')) === fs.readFileSync(path.join(__dirname, '../lib/callscript.js'), 'utf8'),
      'the cloud\'s copy of the call wording matches lib/callscript.js');
    const tw = fs.readFileSync(path.join(__dirname, '../cloud/src/twilio.js'), 'utf8');
    const out = tw.slice(tw.indexOf("app.post('/voice/:token/outgoing'"), tw.indexOf("app.post('/voice/:token/incoming'"));
    ok(!/converse\(/.test(out) && /callscript\.ownerLines/.test(out) && /callscript\.guestLines/.test(out), 'the cloud opener is written, not generated — to him in the second person, to others identified');
  }
  mcp.stopMcpServer();
  console.log(`\n${fail ? '❌' : '✅'} call path: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
