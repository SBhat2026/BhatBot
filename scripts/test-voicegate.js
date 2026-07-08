#!/usr/bin/env node
'use strict';
// Voice CLARITY GATE (pure.looksActionable) — discards rambling / thinking-aloud / trailing-off so
// BhatBot only acts on clear directives. 'drop' = ignore, 'ok' = act, 'borderline' = cheap-model check.
// Run: node scripts/test-voicegate.js  (wired into npm run verify)
const { looksActionable } = require('../lib/pure');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };
const A = (t) => looksActionable(t).action;

// clear commands → act
ok(A('open spotify and play some jazz') === 'ok', 'ok: clear multi-word command');
ok(A('what is the capital of France') === 'ok', 'ok: a clear question');
ok(A('design and simulate an iron man suit') === 'ok', 'ok: a build request');
ok(A('stop') === 'ok', 'ok: known single-word command (stop)');
ok(A('continue') === 'ok', 'ok: known single-word command (continue)');

// rambling / filler / thinking-aloud → drop
ok(A('') === 'drop', 'drop: empty');
ok(A('um, uh, so, like, yeah') === 'drop', 'drop: pure filler');
ok(A('hmm') === 'drop', 'drop: lone hmm');
ok(A('wait, actually') === 'drop', 'drop: retraction / thinking-aloud');
ok(A('you know, i mean, sort of') === 'drop', 'drop: filler phrases only');
ok(A('uh let me think') === 'drop', 'drop: "let me think"');

// ambiguous fragments → borderline (defer to the model)
ok(A('spotify') === 'borderline', 'borderline: bare noun fragment');
ok(A('um spotify') === 'borderline', 'borderline: filler + one noun');
ok(A('the thing') === 'ok', 'ok: two content words → act (agent will clarify if needed)');

// a real request that merely CONTAINS a filler word still passes
ok(A('so can you email John about the meeting') === 'ok', 'ok: filler-prefixed real request still acts');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
