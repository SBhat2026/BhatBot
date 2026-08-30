#!/usr/bin/env node
'use strict';
// EMBEDDING CACHE + SINGLE-FLIGHT (lib/semantic.js).
//
// One turn embeds the user's text three times — semantic recall, episodic-vector recall, and tool
// retrieval — because none of the three knows the others exist. A plain cache fixes that only if the
// callers are separated in time, and the preamble optimisation in main.js deliberately stopped
// separating them: all three now start in the same tick, all miss, all issue their own request.
// The two optimisations cancelled each other until single-flight was added, which is why this file
// tests CONCURRENT callers and not just repeat ones.
//
// Asserted with a provider-call COUNTER, not a stopwatch: "did this cost a round trip" is the actual
// question, and timing is a flaky way to ask it under load.
//
// Run: node scripts/test-embed-coalesce.js   (wired into npm run verify)
const semantic = require('../lib/semantic');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('❌ ' + m); } };
const uniq = (n) => `test-embed-coalesce ${n} ${process.pid} ${Math.random()}`;

(async () => {
  if (!(await semantic.embedderReady())) {
    console.log('⏭  embed coalescing skipped — no embedder available (no OpenAI key, no local Ollama)');
    process.exit(0);
  }

  // ── concurrent callers collapse to one request ────────────────────────────────────────────────
  {
    semantic._memoClear();
    const q = uniq('concurrent');
    const results = await Promise.all([semantic.embedBatch([q]), semantic.embedBatch([q]), semantic.embedBatch([q])]);
    ok(semantic._memoStats().providerCalls === 1,
      `three concurrent embeds of one string cost ONE provider call (got ${semantic._memoStats().providerCalls})`);
    ok(results.every((r) => r.vecs && r.vecs[0]), 'every concurrent caller still receives a vector');
    const [a, b, c] = results.map((r) => JSON.stringify(r.vecs[0]));
    ok(a === b && b === c, 'and they all receive the SAME vector, not merely a valid one');
    ok(semantic._memoStats().inflight === 0, 'the in-flight table is emptied when the request settles (no leak)');
  }

  // ── a later repeat is served from the memo ────────────────────────────────────────────────────
  {
    semantic._memoClear();
    const q = uniq('repeat');
    await semantic.embedBatch([q]);
    const after = semantic._memoStats().providerCalls;
    const r = await semantic.embedBatch([q]);
    ok(semantic._memoStats().providerCalls === after, 'a sequential repeat costs no provider call');
    ok(r.cached === true, 'and reports itself as cached, so a caller can tell');
    ok(r.vecs && r.vecs[0], 'the cached result is a real vector');
  }

  // ── a mixed batch asks only for what is missing ───────────────────────────────────────────────
  {
    semantic._memoClear();
    const known = uniq('known'), fresh = uniq('fresh');
    await semantic.embedBatch([known]);
    const before = semantic._memoStats().providerCalls;
    const r = await semantic.embedBatch([known, fresh]);
    ok(semantic._memoStats().providerCalls === before + 1, 'a mixed batch issues exactly one request, for the miss only');
    ok(r.vecs.length === 2 && r.vecs[0] && r.vecs[1], 'and returns both vectors, in the original order');
  }

  // ── order is preserved through the cache/join/fresh split ─────────────────────────────────────
  // The three groups are gathered separately and stitched back together, so an off-by-one here would
  // silently pair each text with someone else's vector — a bug cosine cannot detect.
  {
    semantic._memoClear();
    const a = uniq('order-a'), b = uniq('order-b'), c = uniq('order-c');
    await semantic.embedBatch([b]);                                  // b is now cached
    const solo = await semantic.embedBatch([a]);                     // a alone, for comparison
    const mixed = await semantic.embedBatch([a, b, c]);
    ok(JSON.stringify(mixed.vecs[0]) === JSON.stringify(solo.vecs[0]),
      'a text in a mixed batch gets ITS OWN vector, not a neighbour\'s');
    ok(mixed.vecs.every(Boolean), 'no slot is left null by the cached/joined/fresh stitching');
  }

  // ── junk in never throws ──────────────────────────────────────────────────────────────────────
  {
    const r = await semantic.embedBatch(['', null, undefined]);
    ok(Array.isArray(r.vecs) && r.vecs.length === 3, 'empty and nullish inputs return a full-length result rather than throwing');
  }

  // (The memo's 64-entry cap is not tested here: reaching it honestly costs 65 provider round trips,
  // and a test that fakes its way there would only be asserting that the fake works.)

  console.log(`\n${fail ? '❌' : '✅'} embed coalescing: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
