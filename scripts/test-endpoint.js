#!/usr/bin/env node
'use strict';
// Tests the adaptive endpointing engine (lib/endpoint.js): default-before-learning, learns the user's
// mid-utterance pauses and raises the threshold, floor/ceil clamps, ignores noise, the cocktail-party
// shouldEnd gate (userSpeaking never ends), and persistence round-trip. Pure — runs in node, in verify.
const { createEndpointer, percentile } = require('../lib/endpoint');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- percentile helper ----
ok(percentile([10, 20, 30, 40, 50], 0.9) === 46, 'percentile: p90 of 10..50 interpolates to 46');
ok(percentile([], 0.9) === 0 && percentile([7], 0.5) === 7, 'percentile: empty → 0, single → itself');

// ---- default before learning ----
const e = createEndpointer();
ok(e.threshold() === 1800, 'threshold: default (1800) before enough samples');
ok(e.stats().learned === false, 'stats: not learned yet');

// ---- learns from mid-utterance pauses (user pauses ~900ms then keeps talking) ----
for (let i = 0; i < 20; i++) e.observePause(900, true);
ok(e.threshold() === 1400, 'threshold: learns ~900ms pauses → 900 + 500 margin = 1400');
ok(e.stats().learned === true && e.stats().p90 === 900, 'stats: learned, p90 tracks the 900ms habit');

// ---- a talker who leaves long pauses pushes the threshold up (clamped at ceil) ----
const slow = createEndpointer();
for (let i = 0; i < 20; i++) slow.observePause(5800, true);
ok(slow.threshold() === 6000, 'threshold: long-pauser clamped to ceil (6000)');

// ---- a fast, clipped talker can't drop below the floor ----
const fast = createEndpointer();
for (let i = 0; i < 20; i++) fast.observePause(200, true);
ok(fast.threshold() === 1200, 'threshold: fast talker clamped to floor (1200)');

// ---- noise is ignored: non-resumed gaps + out-of-range never learned ----
const n = createEndpointer();
for (let i = 0; i < 20; i++) { n.observePause(900, false); n.observePause(50, true); n.observePause(99999, true); }
ok(n.pauses.length === 0 && n.threshold() === 1800, 'learn: ignores end-of-turn gaps + sub-blips + absurd gaps');

// ---- cocktail-party gate: shouldEnd ----
ok(e.shouldEnd({ userSilentMs: 2000, userSpeaking: false }) === true, 'shouldEnd: user silent past threshold → end');
ok(e.shouldEnd({ userSilentMs: 2000, userSpeaking: true }) === false, 'shouldEnd: user still speaking → never end (even past threshold)');
ok(e.shouldEnd({ userSilentMs: 500, userSpeaking: false }) === false, 'shouldEnd: not silent long enough → keep listening');
// background voice = userSpeaking stays false AND userSilentMs is USER-attributed silence → it still
// ends when the USER has been quiet, regardless of room chatter.
ok(e.shouldEnd({ userSilentMs: 1500, userSpeaking: false }) === true, 'shouldEnd: background-only chatter does not stop a real user endpoint');

// ---- persistence round-trip ----
const saved = e.toJSON();
const restored = createEndpointer({ pauses: saved.pauses });
ok(restored.threshold() === e.threshold(), 'persist: restored endpointer reproduces learned threshold');
ok(restored.pauses.length === saved.pauses.length, 'persist: pause samples survive the round-trip');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
