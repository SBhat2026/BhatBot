#!/usr/bin/env node
'use strict';
// T6 — the feedback instrumentation that fills spoken.jsonl with real labels. Tests the pure outcome
// labeler (barge-in → interrupted@N, ask-for-more → under, else clean) over a simulated 4-turn convo,
// and that the labeled rows train + move the L metric. Runs in node, in verify.
const sm = require('../lib/spokenmodel');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- labelOutcome primitives ----
ok(JSON.stringify(sm.labelOutcome({ bargedAt: 9, nextUserText: 'anything' })) === JSON.stringify({ outcome: 'interrupted', interrupt_at: 9 }), 'label: barge-in dominates → interrupted@9');
ok(sm.labelOutcome({ bargedAt: null, nextUserText: 'why?' }).outcome === 'under', 'label: "why?" → under');
ok(sm.labelOutcome({ bargedAt: null, nextUserText: 'go deeper on that' }).outcome === 'under', 'label: "go deeper" → under');
ok(sm.labelOutcome({ bargedAt: null, nextUserText: 'now open spotify' }).outcome === 'clean', 'label: new topic → clean');
ok(sm.labelOutcome({ bargedAt: null, nextUserText: '' }).outcome === 'clean', 'label: no next text → clean');
ok(sm.labelOutcome({ bargedAt: 0, nextUserText: 'x' }).outcome === 'interrupted', 'label: barge at word 0 still counts as interrupted');

// ---- simulate a 4-turn convo: clean → interrupted → under(→expand) → clean ----
// each "spoken turn" carries how many words were delivered + the barge state; the NEXT turn's text
// resolves the outcome (exactly how main.js finalizeSpokenRow carries a one-slot pending row).
const turns = [
  { delivered: 22, bargedAt: null, nextText: 'thanks, now something else' },   // clean
  { delivered: 40, bargedAt: 11, nextText: 'stop' },                            // interrupted@11
  { delivered: 8, bargedAt: null, nextText: 'why?' },                           // under
  { delivered: 25, bargedAt: null, nextText: 'great, new question' },           // clean
];
const rows = turns.map((t) => {
  const { outcome, interrupt_at } = sm.labelOutcome({ bargedAt: t.bargedAt, nextUserText: t.nextText });
  return { spoken_words: t.delivered, outcome, interrupt_at, to_next_ms: outcome === 'clean' ? 3500 : null };
});
ok(rows.map((r) => r.outcome).join(',') === 'clean,interrupted,under,clean', 'convo: 4 rows carry the right outcomes in order');
ok(rows[1].interrupt_at === 11, 'convo: interrupted row carries the censor position (11 words)');
ok(rows[0].to_next_ms === 3500 && rows[1].to_next_ms === null, 'convo: only clean rows carry time-to-next');

// ---- those labels drive the L metric ----
const L = sm.computeL(rows, { lambda: 1.0 });
ok(L.interrupt_rate === 0.25 && L.underinform_rate === 0.25 && L.L === 0.5, 'L: 1 interrupt + 1 under of 4 → L = 0.25 + 0.25 = 0.50');
// as good (clean) rows accumulate, L drops toward 0
const better = sm.computeL(rows.concat(Array.from({ length: 96 }, () => ({ outcome: 'clean', to_next_ms: 3000 }))));
ok(better.L < L.L, `L: adding clean rows lowers L (${better.L} < ${L.L})`);

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
