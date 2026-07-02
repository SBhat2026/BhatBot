#!/usr/bin/env node
'use strict';
// T5 — learned spoken-length model (lib/spokenmodel.js). Pure: feature extraction from a finished
// answer, qtype from the prompt, ridge training that RECOVERS a density→length signal, barge-in
// censoring (never learn to exceed observed interrupts), the fallback below MIN_ROWS, and the L metric
// (interrupt_rate + λ·underinform_rate) dropping as "good" rows accumulate. Runs in node, in verify.
const sm = require('../lib/spokenmodel');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- feature extraction ----
const f1 = sm.extractFeatures('The answer is 42, discovered by Douglas Adams in 1979.', 'what is the answer?');
ok(f1.n_numbers >= 2 && f1.n_entities >= 2, 'features: counts numbers + proper-noun entities');
ok(f1.struct_type === 'prose' && f1.qtype === 'factoid' && f1.has_headline === true, 'features: prose/factoid, headline (number+name in first sentence)');
const f2 = sm.extractFeatures('- one\n- two\n- three\n- four', 'list the options');
ok(f2.struct_type === 'list' && f2.n_list === 4, 'features: 4 list items → struct=list');
const f3 = sm.extractFeatures('```js\nconst x=1;\n```\nAlso:\n- a\n- b', 'how do I set it up?');
ok(f3.struct_type === 'mixed' && f3.qtype === 'procedural', 'features: code + list → mixed; "how do I" → procedural');
const f4 = sm.extractFeatures('| a | b |\n| 1 | 2 |', 'which is better, a or b?');
ok(f4.struct_type === 'table' && f4.qtype === 'decision', 'features: table row → table; "which is better" → decision');
ok(sm.classifyQType('why does it work') === 'explanatory', 'qtype: "why does" → explanatory');

// ---- censoring: effectiveTarget ----
ok(sm.effectiveTarget({ spoken_words: 50, outcome: 'interrupted', interrupt_at: 12 }) === 12, 'censor: interrupted@12 → target min(50,12)=12');
ok(sm.effectiveTarget({ spoken_words: 20, outcome: 'under' }) === 30, 'censor: under → target boosted (20×1.5=30)');
ok(sm.effectiveTarget({ spoken_words: 25, outcome: 'clean' }) === 25, 'censor: clean → delivered length as-is');

// ---- training recovers a density→length signal (dense answers → shorter spoken target) ----
// synthetic: spoken length ∝ (1/density). More numbers = denser = the user wants it SHORT.
function synthRow(nNum, base) {
  const f = { screen_tokens: 300, n_numbers: nNum, n_entities: 2, n_code: 0, n_list: 0, n_urls: 0, ttr: 0.6, struct_type: 'prose', qtype: 'factoid', has_headline: true };
  return { spoken_words: Math.max(6, base - nNum * 3), outcome: 'clean', f };
}
const rows = [];
for (let i = 0; i < 260; i++) { const nn = i % 10; rows.push(synthRow(nn, 60)); }
const model = sm.train(rows);
ok(model.ok && model.r2 > 0.3, `train: fits the synthetic density→length signal (r2=${model.ok ? model.r2.toFixed(2) : 'n/a'})`);
// a dense answer (many numbers) should predict FEWER words than a sparse one
sm.trainFromLog; // (no-op ref)
// predict directly off the trained weights (bypass the on-disk cache)
function predictWith(m, f) { const x = [...sm.featurize(f), 1]; return x.reduce((s, xj, j) => s + xj * m.w[j], 0); }
const dense = predictWith(model, { screen_tokens: 300, n_numbers: 9, n_entities: 2, ttr: 0.6, struct_type: 'prose', qtype: 'factoid', has_headline: true });
const sparse = predictWith(model, { screen_tokens: 300, n_numbers: 0, n_entities: 2, ttr: 0.6, struct_type: 'prose', qtype: 'factoid', has_headline: true });
ok(dense < sparse, `train: denser answer → shorter predicted spoken length (${dense.toFixed(0)} < ${sparse.toFixed(0)})`);

// ---- barge-in ceiling: interruptP75 is learned and caps predictions ----
const withInt = rows.slice();
for (let i = 0; i < 30; i++) withInt.push({ spoken_words: 40, outcome: 'interrupted', interrupt_at: 15, f: synthRow(0, 60).f });
const m2 = sm.train(withInt);
ok(m2.interruptP75 === 15, 'censor: interruptP75 learned from observed barge-in positions (15)');

// ---- fallback below MIN_ROWS ----
ok(sm.train(rows.slice(0, 50)).ok === false, 'fallback: <MIN_ROWS → not ok (caller keeps heuristic)');

// ---- L metric ----
const clean = Array.from({ length: 90 }, () => ({ outcome: 'clean', to_next_ms: 4000 }));
const bad = Array.from({ length: 10 }, () => ({ outcome: 'interrupted', interrupt_at: 8 }));
const Lgood = sm.computeL(clean.concat(bad));
ok(Lgood.L === 0.1 && Lgood.interrupt_rate === 0.1 && Lgood.underinform_rate === 0, 'L: 10% interrupts, 0 under → L=0.10');
const Lbetter = sm.computeL(Array.from({ length: 100 }, () => ({ outcome: 'clean', to_next_ms: 3000 })));
ok(Lbetter.L === 0 && Lbetter.median_spoken_to_next_ms === 3000, 'L: all clean → L=0 (best), median-to-next tracked');
ok(sm.computeL([]).L === null, 'L: no rows → null');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
