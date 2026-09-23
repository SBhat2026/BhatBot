#!/usr/bin/env node
'use strict';
// Grading an agent against something that is NOT itself.
//
// scripts/perf-eval.js uses Claude-as-judge, which is useful and has a ceiling: a model from the
// same family shares the blind spots of the thing it is grading, and on a hallucinated fact both are
// confidently wrong together. These rules grade against an answer key fetched live from the API that
// owns the fact — and the rules themselves are tested here, with no network at all.
const assert = require('assert');
const path = require('path');
const { grade, summarize, numbersIn } = require(path.join(__dirname, '..', 'lib', 'agenteval'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };

console.log('[agenteval]');

{
  assert.deepStrictEqual(numbersIn('about 8.3 million, up from 1,234'), [8300000.000000001, 1234]);
  assert.deepStrictEqual(numbersIn('M1.5 quake'), [1.5]);
  assert.deepStrictEqual(numbersIn('minus 4 degrees'), [4]);   // sign words are not parsed; documented, not pretended
  ok('numbers are read out of prose, with thousands separators and k/m/bn units');
}
{
  assert.strictEqual(grade('It is 58.7 degrees', { number: 58.7 }).ok, true);
  assert.strictEqual(grade('62°F, sir.', { number: 58.7, tolerance: 0.06, absolute: 2 }).ok, true);
  // A live reading moves between the ask and the grade, so tolerance is required — but it is not
  // infinite, or the benchmark passes anything.
  assert.strictEqual(grade('71°F', { number: 58.7, tolerance: 0.06, absolute: 2 }).ok, false);
  ok('a number within tolerance passes and one outside it does not');
}
{
  const g = grade('The magnitude was 4.2', { number: 1.5, tolerance: 0.05, absolute: 0.2 });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.kind, 'wrong-number', 'a confident wrong number is named, not folded into a generic miss');
  ok('stating a number that is simply untrue is classified as FABRICATION');
}
{
  // ABSTENTION IS NOT FAILURE. When a source is down, "I could not find it" is the correct answer,
  // and scoring it as a miss would teach the agent that inventing a plausible figure scores better.
  for (const s of ['I could not reach the feed.', "I couldn't find that.", 'That source is unavailable right now.']) {
    assert.strictEqual(grade(s, { number: 5 }).ok, null, s);
  }
  ok('an honest "I could not find it" is scored as an abstention, never as wrong');
}
{
  // THE INSTRUMENT'S OWN FALSE NUMBER. The first real run reported a 20% FABRICATION RATE for a turn
  // that said nothing at all — the exact class of confident-and-wrong the benchmark exists to catch,
  // produced by the benchmark. A turn with no output is not a belief and cannot be a wrong one.
  const g = grade('(no text)', { text: 'anything' });
  assert.strictEqual(g.ok, null);
  assert.strictEqual(g.kind, 'no-answer');
  assert.strictEqual(grade('(harness error: timeout)', { number: 1 }).kind, 'no-answer');
  ok('a turn that produced no answer is excluded, not counted as a fabrication');
}
{
  const g = grade('The top story is "GPT-6 Sol and Luna"', { anyOf: ['GPT-6 Sol and Luna', 'Sol'] });
  assert.strictEqual(g.ok, true);
  assert.strictEqual(grade('Something else entirely', { anyOf: ['GPT-6 Sol and Luna'] }).kind, 'wrong-text');
  ok('text answers match on any acceptable form, so a paraphrase is not a failure');
}
{
  const rows = [
    { ms: 100, verdict: grade('58.7', { number: 58.7 }) },
    { ms: 200, verdict: grade('999', { number: 12 }) },
    { ms: 300, verdict: grade('I could not find it', { number: 3 }) },
    { ms: 400, verdict: grade('(no text)', { number: 4 }) },
  ];
  const s = summarize(rows);
  assert.strictEqual(s.asked, 4);
  assert.strictEqual(s.answered, 2, 'only actual beliefs count toward accuracy');
  assert.strictEqual(s.correct, 1);
  assert.strictEqual(s.abstained, 1);
  assert.strictEqual(s.noAnswer, 1, 'and a missing answer is tracked separately from an abstention');
  assert.strictEqual(s.accuracy, 0.5);
  assert.strictEqual(s.fabricationRate, 0.5);
  assert.strictEqual(s.medianMs, 300);
  ok('the summary separates correct, wrong, abstained and no-answer rather than collapsing them');
}

console.log(`[agenteval] ${pass} assertions passed`);
