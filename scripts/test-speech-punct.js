'use strict';
// Exhaustive spoken-punctuation guarantee for lib/speech.speakSymbolsForSpeech. Every symbol/number
// pattern that could be voiced ambiguously is asserted here → a regression fails `npm run verify`,
// never Siddhant's ear. Assertions check that the EXPECTED spoken phrase appears (whitespace-tolerant).
const assert = require('assert');
const { speakSymbolsForSpeech } = require('../lib/speech');

let pass = 0;
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
function say(input, expectContains, mustNotContain) {
  const out = norm(speakSymbolsForSpeech(input));
  for (const e of [].concat(expectContains)) assert.ok(out.includes(e), `"${input}" → "${out}"  (expected to contain "${e}")`);
  for (const n of [].concat(mustNotContain || [])) assert.ok(!out.includes(n), `"${input}" → "${out}"  (should NOT contain "${n}")`);
  pass++;
}

// ── filenames / dots / underscores ──────────────────────────────────────────
say('top_10.csv', 'top 10 dot csv', '.csv');
say('Save it to top_10.csv.', 'top 10 dot csv');
say('main.js and pipeline.py', ['main dot js', 'pipeline dot py']);
say('gmail.com', 'gmail dot com');
say('modal_af2.py', 'modal af2 dot py');
say('ipTM_score_final.json', ['ipTM score final dot json']);
say('the output is .csv', 'dot csv');
say('a_b_c_d', 'a b c d');   // underscore runs

// ── decimals vs dots (context) ──────────────────────────────────────────────
say('version 3.5 is fine', '3 point 5', 'dot');
say('57.5%', ['57 point 5', 'percent']);
say('pLDDT > 85', 'greater than 85');

// ── comparison operators (the protein spec) ─────────────────────────────────
say('ipTM > 0.7', ['greater than', '0 point 7']);
say('RMSD < 1.0 Å', ['less than', '1 point 0', 'angstroms']);
say('<50% identity', ['less than 50 percent']);
say('x <= 5', 'less than or equal to');
say('y >= 10', 'greater than or equal to');
say('a != b', 'not equal to');
say('ΔΔG < −5 kcal/mol', ['delta delta', 'less than minus 5', 'kcal per mol']);
say('± 3', 'plus or minus');

// ── ranges (and NOT dates/phones) ───────────────────────────────────────────
say('80–300 AA', ['80 to 300', 'amino acids']);   // en-dash range + AA unit
say('pages 3-5', '3 to 5');
say('2018-2022', '2018 to 2022');
say('call 555-1234', ['555', '1234'], 'to 1234');  // phone: NOT a range
say('date 6-12-2026', [], 'to 12');                 // date: NOT a range

// ── math ────────────────────────────────────────────────────────────────────
say('1920x1080', '1920 by 1080');
say('3 × 3', '3 by 3');
say('10 ÷ 2', 'divided by');
say('2^8', 'to the power of');

// ── arrows / pipelines ──────────────────────────────────────────────────────
say('generate → novelty → fold', ['generate to novelty to fold']);
say('A -> B', 'A to B');

// ── minus / negatives ───────────────────────────────────────────────────────
say('the delta is -5', 'minus 5');
say('score −12', 'minus 12');

// ── scientific units + greek ────────────────────────────────────────────────
say('37°C', ['37', 'degrees Celsius']);
say('a 90° turn', 'degrees');
say('α helix and β sheet', ['alpha', 'beta']);
say('λ = 0.5', ['lambda', 'equals']);

// ── currency ────────────────────────────────────────────────────────────────
say('£20', '20 pounds');
say('€100', '100 euros');
say('¥500', '500 yen');

// ── unit ratios ─────────────────────────────────────────────────────────────
say('5 kcal/mol', 'kcal per mol');
say('60 km/h', 'km per h');

// ── everyday symbols ────────────────────────────────────────────────────────
say('R&D', 'R and D');
say('50% done', ['50 percent']);
say('email me @ home', 'at');
say('siddhant@gmail.com', ['siddhant at gmail dot com']);
say('#5 on the list', 'number 5');
say('the C# language', 'hash');
say('a & b = c', ['and', 'equals']);
say('~5 minutes', 'about 5');
say('24/7 support', 'twenty four seven');
say('and/or', 'and or');
say('N/A', 'not applicable');
say('TCP/IP', 'slash');
say('© 2026', 'copyright');
say('path C:\\Users', 'backslash');

// ── idempotence: running twice must not corrupt an already-spoken string ─────
{
  const once = speakSymbolsForSpeech('top_10.csv is > 0.7');
  const twice = speakSymbolsForSpeech(once);
  assert.strictEqual(norm(once), norm(twice), 'speakSymbolsForSpeech must be idempotent');
  pass++;
}

console.log(`✅ speech-punct: ${pass} cases passed`);
