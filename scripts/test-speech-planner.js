#!/usr/bin/env node
'use strict';
// Unit tests for the streaming speech planner (T2 classifySpeech) + stream-safe normalizer
// (T1/T3 createSpeechNormalizer), both pure in lib/pure.js. No app boot.
// Run: node scripts/test-speech-planner.js   (wired into npm run verify)
const { classifySpeech, createSpeechNormalizer } = require('../lib/pure');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { console.log('✅ ' + name); pass++; }
  else { console.log(`❌ ${name}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); fail++; }
}
function ok(name, cond) { if (cond) { console.log('✅ ' + name); pass++; } else { console.log('❌ ' + name); fail++; } }

// --- classifySpeech: prose vs structured vs long ---
eq('short prose → short-plain', classifySpeech('Done, sir.'), 'short-plain');
eq('two short sentences prose → short-plain', classifySpeech('Yes. The build passed.'), 'short-plain');
eq('empty → undecided', classifySpeech(''), 'undecided');
eq('mid-sentence, short → undecided (keep buffering)', classifySpeech('Let me pull that'), 'undecided');
eq('code fence → digest', classifySpeech('Here you go:\n```js\nconst x = 1;'), 'digest');
eq('two bullets → digest', classifySpeech('Findings:\n- one thing\n- another thing'), 'digest');
eq('numbered list → digest', classifySpeech('Steps:\n1. do this\n2. do that'), 'digest');
eq('markdown table → digest', classifySpeech('| team | pts |\n| --- | --- |'), 'digest');
eq('two headers → digest', classifySpeech('# Summary\ntext\n## Details'), 'digest');
eq('url-dense line → digest', classifySpeech('See https://a.com/x and https://b.com/y for detail.'), 'digest');
eq('second paragraph → digest', classifySpeech('First line here.\n\nSecond paragraph begins.'), 'digest');
eq('long first sentence (>220, no terminator) → digest', classifySpeech('x'.repeat(230)), 'digest');
eq('very long single sentence terminated late → digest', classifySpeech('a '.repeat(120) + 'end.'), 'digest');
eq('one bullet only → not yet digest (undecided/plain)', classifySpeech('- just one point so far'), 'undecided');

// --- createSpeechNormalizer: never normalizes across a split token ---
const upper = createSpeechNormalizer((s) => s.toUpperCase());
ok('holds trailing partial token', upper.push('hello wor') === 'HELLO ');       // "wor" held back
eq('completes held token on next delta', (upper.push('ld there ') + upper.flush()).trim(), 'WORLD THERE');

// a URL split across two deltas must not be half-normalized (drop-URL normalizer)
const dropUrl = createSpeechNormalizer((s) => s.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim());
let acc = '';
acc += dropUrl.push('see http://exa');
acc += dropUrl.push('mple.com/x now ');
acc += dropUrl.flush();
ok('split URL fully dropped, not half-surviving', !/exa|mple|http/.test(acc));
ok('surrounding words survive the split URL', /see/.test(acc) && /now/.test(acc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
