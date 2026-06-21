'use strict';
// J.A.R.V.I.S. guide §5 — the "movie sheen" post-processing pass, applied to already-rendered TTS
// audio (NOT baked into the clone). Offline only: it adds latency + needs ffmpeg, so we don't run it
// on live phone audio — it's for assets / a polished render you can A/B against the raw voice.
//
//   node scripts/voice-fx.js                       # ~/.bhatbot/voice-samples/after.mp3 → after-fx.mp3
//   node scripts/voice-fx.js in.mp3 out.mp3        # explicit paths
//
// Chain (subtle by design — should be "almost imperceptible" per the guide):
//   1. acompressor — gentle compression to smooth dynamics → consistent, authoritative level.
//   2. treble/equalizer — a touch of high-frequency "air" (exciter/enhancer) for the crisp hi-tech feel.
//   3. aecho — a very short, low room reverb so it sounds present in a high-tech lab.
//   4. loudnorm + alimiter — broadcast-consistent loudness without clipping.
const path = require('path');
const { execFileSync } = require('child_process');

const SAMPLES = path.join(process.env.HOME, '.bhatbot', 'voice-samples');
const inFile = process.argv[2] || path.join(SAMPLES, 'after.mp3');
const outFile = process.argv[3] || path.join(SAMPLES, 'after-fx.mp3');

const CHAIN = [
  'acompressor=threshold=-20dB:ratio=3:attack=15:release=180:makeup=2',
  'treble=g=3.5:f=8500',                       // exciter "air"
  'equalizer=f=3000:t=q:w=1.2:g=1.5',          // subtle presence lift
  'aecho=0.85:0.9:18|34:0.10|0.06',            // short, subtle room reverb (two faint taps)
  'loudnorm=I=-16:TP=-1.5:LRA=11',
  'alimiter=limit=0.95',
].join(',');

try {
  execFileSync('ffmpeg', ['-y', '-i', inFile, '-af', CHAIN, '-c:a', 'libmp3lame', '-q:a', '2', outFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`✓ FX applied → ${outFile}`);
} catch (e) {
  console.error('✗ ffmpeg failed:', String(e.stderr || e.message).slice(-400));
  process.exit(1);
}
