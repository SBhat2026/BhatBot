#!/usr/bin/env node
'use strict';
// T3 — endpointing everywhere: (a) the phone path (lib/voicestream) drives its end-of-utterance silence
// off the SHARED learned engine, clamped to a phone-appropriate range; (b) a decision simulator mirrors
// the renderer/phone loop to prove: no early endpoint on a thinking-pause, prompt endpoint on the true
// end, and background (user-attributed silence) still ends at threshold. Pure — runs in node, in verify.
const { createEndpointer } = require('../lib/endpoint');
const makeVoiceStream = require('../lib/voicestream');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- phone parity: learned pauses → phone-clamped threshold [500,2000] ----
const ctx = { transcribe: () => ({}), synthUlaw: () => ({}), voiceBegin: () => ({}), voicePoll: () => ({}) };
const vsLearned = makeVoiceStream({ ...ctx, pauses: [1400, 1500, 1600, 1450, 1550, 1500, 1520] });
ok(vsLearned._silenceEnd() === 2000, 'phone: learned ~1500ms pauses → clamped to phone ceil (2000)');
const vsDefault = makeVoiceStream({ ...ctx });
ok(vsDefault._silenceEnd() === 700, 'phone: nothing learned → default 700ms (unchanged behavior)');
const vsFast = makeVoiceStream({ ...ctx, pauses: [200, 210, 190, 220, 205, 195, 200] });
const fastT = vsFast._silenceEnd();
ok(fastT >= 500 && fastT <= 800, `phone: short learned pauses → snappy ${fastT}ms (within phone range, never below the 500 floor)`);
ok(typeof vsLearned.handle === 'function', 'phone: still exposes handle() — construction intact');

// ---- decision simulator (mirrors the renderer VAD gate + phone VAD loop) ----
// events: [{userSpeaking, dt}]. userSilentMs accrues only while the USER isn't speaking (background
// chatter is not user-attributed, so it doesn't reset the countdown). Returns the frame index it ENDS.
function simulate(events, ep) {
  let silent = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.userSpeaking) silent = 0; else silent += e.dt;
    if (ep.shouldEnd({ userSilentMs: silent, userSpeaking: e.userSpeaking })) return i;
  }
  return -1;
}
const ep = createEndpointer();   // default threshold 1800ms

// user talks, pauses ~1s to think, resumes, then truly stops → must NOT cut off at the 1s pause
const withPause = [
  { userSpeaking: true, dt: 200 }, { userSpeaking: true, dt: 200 },     // talking
  { userSpeaking: false, dt: 500 }, { userSpeaking: false, dt: 500 },   // 1s thinking-pause (< 1800)
  { userSpeaking: true, dt: 200 },                                      // resumes (proves no early end)
  { userSpeaking: false, dt: 600 }, { userSpeaking: false, dt: 600 }, { userSpeaking: false, dt: 700 }, // ~1900ms real silence
];
ok(simulate(withPause, ep) === 7, 'no early endpoint on a 1s thinking-pause; ends only after ~1800ms of real silence');

// while the user is actively speaking, it NEVER ends no matter how the clock reads
ok(simulate([{ userSpeaking: true, dt: 5000 }], ep) === -1, 'user still speaking → never ends (even past threshold)');

// background-only chatter (user is silent) → ends at threshold; room noise doesn't hold the mic open
ok(simulate([{ userSpeaking: false, dt: 600 }, { userSpeaking: false, dt: 600 }, { userSpeaking: false, dt: 700 }], ep) === 2,
  'background-only (user silent) → ends at threshold; room noise ignored');

// a learned long-pauser waits longer before ending (adaptive)
const slow = createEndpointer(); for (let i = 0; i < 12; i++) slow.observePause(3000, true);   // threshold 3500
ok(simulate([{ userSpeaking: false, dt: 1000 }, { userSpeaking: false, dt: 1000 }], slow) === -1, 'adaptive: a learned long-pauser is NOT ended at 2s');
ok(simulate([{ userSpeaking: false, dt: 1200 }, { userSpeaking: false, dt: 1200 }, { userSpeaking: false, dt: 1200 }], slow) === 2, 'adaptive: same user ends after their learned ~3.5s');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
