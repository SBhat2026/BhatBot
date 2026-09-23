#!/usr/bin/env node
'use strict';
// The audit itself — every branch driven with a fake TTS/STT pair, so the verdicts are tested
// without a model, a microphone, or ninety seconds of synthesis.
//
// It exists because "did he speak, and what did he say" had one instrument: asking Siddhant. That
// oracle found the SSML leak only after hearing BhatBot say the word "speak" out loud; this found
// the same bug in the same hour, unattended.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { audit, similarity, spokenForm } = require(path.join(__dirname, '..', 'lib', 'speechaudit'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-speech-'));
const clip = (bytes = 40000) => { const p = path.join(TMP, 'c' + Math.random().toString(36).slice(2) + '.wav'); fs.writeFileSync(p, Buffer.alloc(bytes)); return { path: p }; };
const tts = (bytes) => async () => clip(bytes);
const stt = (text) => async () => ({ text });

console.log('[speechaudit]');

(async () => {
  {
    const r = await audit({ text: 'The fleet is back.', synthesize: tts(), transcribe: stt('the fleet is back') });
    assert.ok(r.ok, r.detail);
    ok('audio that transcribes back to the intent passes');
  }
  {
    // THE BUG THIS WAS BUILT FOR. Siddhant heard BhatBot say the word "speak" because the local voice
    // has no SSML parser and pronounces whatever it is handed.
    const r = await audit({ text: '<speak>Mail is open.</speak>', synthesize: tts(), transcribe: stt('speak mail is open slash speak') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'markup', 'markup read aloud is its own diagnosis: ' + r.detail);
    ok('markup pronounced as words is caught and named as markup');
  }
  {
    const r = await audit({ text: 'Good evening, sir.', synthesize: tts(), transcribe: stt('') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'silent');
    ok('an audio file with nothing audible in it fails as SILENT, not as a mismatch');
  }
  {
    // A tiny file is the shape of a TTS that returned "success" and produced nothing.
    const r = await audit({ text: 'Good evening, sir.', synthesize: tts(64), transcribe: stt('good evening sir') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'tts');
    assert.match(r.detail, /silence/);
    ok('a clip too small to contain speech fails before it is even transcribed');
  }
  {
    const long = 'The morning brief is ready: three accounts checked, nothing urgent, one interesting paper on enzyme design.';
    const r = await audit({ text: long, synthesize: tts(), transcribe: stt('the morning brief is ready three accounts checked') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'truncated', 'a prefix that stops early is truncation, not a wrong answer: ' + r.detail);
    ok('speech that stops halfway is reported as TRUNCATED, which is a different bug from saying the wrong thing');
  }
  {
    const r = await audit({ text: 'Open Spotify.', synthesize: tts(), transcribe: stt('the fleet is back') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'mismatch');
    ok('saying something else entirely is a mismatch');
  }
  {
    const r = await audit({ text: 'hello', synthesize: async () => ({ path: '/no/such/file.wav' }), transcribe: stt('hello') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'tts');
    ok('a TTS that produces no file fails at the TTS stage');
  }
  {
    const r = await audit({ text: 'hello', synthesize: tts(), transcribe: async () => { throw new Error('whisper died'); } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'stt');
    ok('a broken transcriber is reported as the INSTRUMENT failing, never as bad speech');
  }
  {
    // A transcriber is a guess, not a decoder. "It's 20 degrees" heard as "it is twenty degrees" is
    // a listener hearing the right thing, and failing it would make every run a coin flip.
    assert.strictEqual(similarity("It's 20 degrees", 'it is twenty degrees'), 1);
    assert.strictEqual(spokenForm('<speak>**Hi**, 5 things</speak>'), 'hi five things');
    assert.ok(similarity('open spotify', 'the fleet is back') < 0.2);
    ok('comparison is on SPOKEN form — numbers spelled out, markup and contractions resolved');
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`[speechaudit] ${pass} assertions passed`);
})();
