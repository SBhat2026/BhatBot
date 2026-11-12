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

  // ── THE BUG THIS FILE COULD NOT SEE ────────────────────────────────────────────────────────────
  //
  // Every ElevenLabs reply was silent in a Finder-launched app: the availability probe looked ffplay
  // up with Homebrew on PATH and said yes, then spawn('ffplay') ran on the app's own PATH and died
  // with ENOENT. This suite passed throughout, because its fake spawn cannot fail and its `which`
  // returns a bare boolean — it modelled a world in which the probe and the spawn can never disagree,
  // which is the one thing that was wrong. These tests model the disagreement.
  const tick = () => new Promise((r) => setImmediate(r));

  // 1. The probe's ANSWER is what gets spawned.
  {
    const spec = detectPlayer((b) => (b === 'ffplay' ? '/opt/homebrew/bin/ffplay' : null), 24000);
    eq('detectPlayer spawns the absolute path the probe found', spec.bin, '/opt/homebrew/bin/ffplay');
    let spawned = null, gotEnv = null;
    const t = createTtsWs({ WebSocket: FakeWS, which: (b) => (b === 'ffplay' ? '/opt/homebrew/bin/ffplay' : null),
      env: { PATH: '/opt/homebrew/bin' }, getConfig: () => cfg,
      spawn: (bin, args, o) => { spawned = bin; gotEnv = o && o.env; lastProc = new FakeProc(); return lastProc; } });
    t.create(1).feed('hello');
    eq('the session spawns that same absolute path', spawned, '/opt/homebrew/bin/ffplay');
    ok('and passes the PATH the probe searched', !!(gotEnv && gotEnv.PATH));
  }

  // 2. A player that cannot start hands the text back instead of going quiet.
  {
    let failed = null, drainedN = 0;
    const t = createTtsWs({ WebSocket: FakeWS, which, getConfig: () => cfg,
      spawn: () => { const p = new FakeProc(); lastProc = p; setImmediate(() => p.emit('error', new Error('spawn ffplay ENOENT'))); return p; } });
    const s = t.create(2);
    s.onDrained(() => drainedN++);
    s.onFailed((text, why, st) => { failed = { text, why, st }; });
    s.feed('The meeting moved '); s.feed('to four.');
    await tick(); await tick();
    ok('a dead player reports failure', !!failed && /ENOENT/.test(failed.why));
    eq('with EVERYTHING it was fed, so somebody else can say it', failed && failed.text, 'The meeting moved to four.');
    eq('and it does NOT signal drained — speech is not over, it is about to happen another way', drainedN, 0);
    ok('the session is marked failed', s.failed === true);
    const before = FakeWS.last.sent.length;
    s.feed(' more');
    eq('and later text is not sent into a dead socket', FakeWS.last.sent.length, before);
  }

  // 3. A ws that errors before any audio (a rejected key looks like this) also hands back.
  {
    let failed = null;
    const t = createTtsWs({ WebSocket: FakeWS, spawn, which, getConfig: () => cfg });
    const s = t.create(3);
    s.onFailed((text, why) => { failed = { text, why }; });
    s.feed('hello there');
    await tick();
    FakeWS.last.emit('error', new Error('Unexpected server response: 401'));
    ok('a ws error before audio fails over', !!failed && /401/.test(failed.why) && failed.text === 'hello there');
    ok('and the player is torn down so nothing can play late over the fallback', lastProc.killed === true);
  }

  // 4. The case with NO event: connected, took the text, said nothing. Only a clock catches it.
  {
    let failed = null, fire = null;
    const t = createTtsWs({ WebSocket: FakeWS, spawn, which, getConfig: () => cfg, firstAudioTimeoutMs: 4000,
      setTimeout: (fn) => { fire = fn; return { unref() {} }; }, clearTimeout: () => { fire = null; } });
    const s = t.create(4);
    s.onFailed((text, why) => { failed = { text, why }; });
    s.feed('anyone there');
    await tick();
    ok('no failure while it is merely waiting', failed === null);
    fire();
    ok('silence past the first-audio deadline fails over', !!failed && /no audio after 4000ms/.test(failed.why));
  }

  // 5. Audio in time cancels the clock; a healthy stream must never be double-spoken.
  {
    let failed = null, fire = null, cleared = 0;
    const t = createTtsWs({ WebSocket: FakeWS, spawn, which, getConfig: () => cfg,
      setTimeout: (fn) => { fire = fn; return { unref() {} }; }, clearTimeout: () => { cleared++; fire = null; } });
    const s = t.create(5);
    s.onFailed((text, why) => { failed = { text, why }; });
    s.feed('fine'); await tick();
    FakeWS.last._audio(Buffer.from('pcm').toString('base64'));
    ok('first audio cancels the watchdog', cleared === 1 && fire === null);
    ok('and a healthy stream never reports failure', failed === null);
  }

  // 6. A failure AFTER some audio drains instead of repeating: half a sentence heard twice is worse
  //    than a lost tail, and there is no telling how much was heard.
  {
    let failed = null, drainedN = 0;
    const t = createTtsWs({ WebSocket: FakeWS, spawn, which, getConfig: () => cfg });
    const s = t.create(6);
    s.onFailed(() => { failed = true; }); s.onDrained(() => drainedN++);
    s.feed('partly spoken'); await tick();
    FakeWS.last._audio(Buffer.from('pcm').toString('base64'));
    FakeWS.last.emit('error', new Error('socket hang up'));
    ok('a mid-stream failure does not hand the text back to be said again', failed === null);
    eq('it drains, so the mic re-arms', drainedN, 1);
  }

  // 7. With nobody listening for failure, the turn is still released. A wedged mic is the worst outcome.
  {
    let drainedN = 0;
    const t = createTtsWs({ WebSocket: FakeWS, which, getConfig: () => cfg,
      spawn: () => { const p = new FakeProc(); setImmediate(() => p.emit('error', new Error('ENOENT'))); return p; } });
    const s = t.create(7);
    s.onDrained(() => drainedN++);
    s.feed('x'); await tick(); await tick();
    eq('an unhandled failure still drains rather than wedging the conversation', drainedN, 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
