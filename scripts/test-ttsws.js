#!/usr/bin/env node
'use strict';
// Unit tests for lib/ttsws.js — the continuous ws streaming TTS transport (T1). Fully mocked:
// a fake WebSocket + fake spawn stand in for ElevenLabs + ffplay, so we assert the lifecycle
// (open → BOS → text → audio→player stdin → EOS → drain, plus barge-in teardown and wake-mute)
// with no network or audio device. Run: node scripts/test-ttsws.js  (wired into npm run verify)
const { createTtsWs, detectPlayer } = require('../lib/ttsws');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { console.log('✅ ' + name); pass++; } else { console.log('❌ ' + name); fail++; } }
function eq(name, got, want) { ok(name + ` (got ${JSON.stringify(got)})`, got === want); }

// --- mocks ---------------------------------------------------------------
class FakeWS extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.sent = []; this.readyState = 0; FakeWS.last = this;
    setImmediate(() => { this.readyState = 1; this.emit('open'); }); }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; this.emit('close'); }
  // test helper: simulate an inbound audio frame / final
  _audio(b64) { this.emit('message', Buffer.from(JSON.stringify({ audio: b64 }))); }
  _final() { this.emit('message', Buffer.from(JSON.stringify({ isFinal: true }))); }
}
class FakeStdin extends EventEmitter { constructor() { super(); this.writable = true; this.writes = []; this.ended = false; }
  write(b) { this.writes.push(b); return true; } end() { this.ended = true; this.writable = false; } }
class FakeProc extends EventEmitter { constructor() { super(); this.stdin = new FakeStdin(); this.killed = false; } kill() { this.killed = true; this.emit('close'); } }
let lastProc = null;
const spawn = () => { lastProc = new FakeProc(); return lastProc; };
const which = (b) => b === 'ffplay';   // pretend ffplay is installed
const cfg = { elevenLabsKey: 'k', ttsVoice: 'v', jarvisVoiceSettings: { stability: 0.4 } };

let wakeMutes = [];
function make() {
  wakeMutes = [];
  return createTtsWs({ WebSocket: FakeWS, spawn, which, getConfig: () => cfg, onWakeMute: (on) => wakeMutes.push(on) });
}

// --- detectPlayer --------------------------------------------------------
ok('detectPlayer picks ffplay', detectPlayer((b) => b === 'ffplay', 24000).bin === 'ffplay');
ok('detectPlayer falls back to sox play', detectPlayer((b) => b === 'play', 24000).bin === 'play');
ok('detectPlayer null when none present', detectPlayer(() => false, 24000) === null);

// --- available -----------------------------------------------------------
ok('available true with key + player', make().available() === true);
ok('available false without key', createTtsWs({ WebSocket: FakeWS, spawn, which, getConfig: () => ({}) }).available() === false);

// --- lifecycle: feed → open → BOS → text --------------------------------
(async () => {
  const t = make();
  const s = t.create(1);
  let firstAudio = 0, drained = 0;
  s.onFirstAudio(() => firstAudio++);
  s.onDrained(() => drained++);
  s.feed('Hello there.');
  await new Promise((r) => setImmediate(r));   // let ws "open"
  const ws = FakeWS.last;
  const msgs = ws.sent.map((m) => JSON.parse(m));
  ok('BOS sent first with voice_settings + key', msgs[0].voice_settings && msgs[0].xi_api_key === 'k');
  ok('buffered text flushed after open', msgs.some((m) => m.text === 'Hello there.'));
  ok('player process spawned', lastProc && !lastProc.killed);

  // inbound audio → written to player stdin + fires onFirstAudio once
  ws._audio(Buffer.from('abc').toString('base64'));
  ws._audio(Buffer.from('def').toString('base64'));
  eq('onFirstAudio fired exactly once', firstAudio, 1);
  eq('two audio frames written to player stdin', lastProc.stdin.writes.length, 2);

  // flush → EOS text:'' sent
  s.flush();
  ok('EOS empty-text sent on flush', ws.sent.map((m) => JSON.parse(m)).some((m) => m.text === ''));

  // isFinal → player stdin ended → player closes → drained fires
  ws._final();
  ok('player stdin ended after isFinal', lastProc.stdin.ended);
  lastProc.emit('close');
  eq('onDrained fired after player close (post-EOS)', drained, 1);

  // --- barge-in teardown ----------------------------------------------
  const t2 = make();
  const s2 = t2.create(2);
  let drained2 = 0; s2.onDrained(() => drained2++);
  s2.feed('Jarvis online.');
  await new Promise((r) => setImmediate(r));
  ok('wake-mute engaged for our own name clip', wakeMutes[0] === true);
  s2.close();
  ok('ws closed on barge-in', FakeWS.last.readyState === 3);
  ok('player killed on barge-in', lastProc.killed === true);
  eq('onDrained fired on barge-in', drained2, 1);
  ok('wake-mute released on teardown', wakeMutes[wakeMutes.length - 1] === false);

  // --- flush with nothing fed → immediate drain ----------------------
  const t3 = make();
  const s3 = t3.create(3);
  let drained3 = 0; s3.onDrained(() => drained3++);
  s3.flush();
  eq('silent turn drains immediately', drained3, 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
