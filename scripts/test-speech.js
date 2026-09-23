#!/usr/bin/env node
'use strict';
// Unit tests for lib/speech.js (emoji → spoken cue / drop, context-aware punctuation).
// Pure — no app boot. Run: node scripts/test-speech.js  (wired into npm run verify)
const speech = require('../lib/speech');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { console.log('✅ ' + name); pass++; }
  else { console.log(`❌ ${name}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); fail++; }
}
function ok(name, cond) { if (cond) { console.log('✅ ' + name); pass++; } else { console.log('❌ ' + name); fail++; } }

// --- emoji: semantic → one spoken cue, positioned naturally ---
eq('status ✅ → voiced once', speech.stripEmojiForSpeech('Deploy finished ✅'), 'Deploy finished done');
eq('warning ⚠️ → heads up', speech.stripEmojiForSpeech('⚠️ disk almost full'), 'heads up disk almost full');
eq('thinking 🤔 → hmm', speech.stripEmojiForSpeech('🤔 not sure that is right'), 'hmm not sure that is right');

// --- emoji: decoration dropped cleanly, no stranded punctuation ---
eq('decoration 🔥🎉 collapse to one cue', speech.stripEmojiForSpeech('Shipped it 🔥🎉'), 'Shipped it strong work');
eq('pure decoration dropped', speech.stripEmojiForSpeech('all good 🚀🌟✨'), 'all good');
eq('emoji before period → no space gap', speech.stripEmojiForSpeech('Nice work 😊.'), 'Nice work.');
eq('heart dropped silently', speech.stripEmojiForSpeech('thanks ❤️'), 'thanks');

// --- emoji: cap at one voiced cue per utterance ---
eq('two semantic emojis → only first voiced', speech.stripEmojiForSpeech('✅ built ✅ tested'), 'done built tested');

// --- emoji: complex graphemes (ZWJ family, flag, skin tone) fully removed ---
ok('ZWJ family removed', !speech.hasEmoji(speech.stripEmojiForSpeech('family 👨‍👩‍👧‍👦 here')));
ok('flag removed', !speech.hasEmoji(speech.stripEmojiForSpeech('winner 🇺🇸 today')));
ok('skin-tone wave removed', !speech.hasEmoji(speech.stripEmojiForSpeech('hi 👋🏽 there')));
eq('family collapses spacing', speech.stripEmojiForSpeech('family 👨‍👩‍👧‍👦 here'), 'family here');

// --- no emoji: untouched fast path ---
eq('plain text unchanged', speech.stripEmojiForSpeech('just plain words.'), 'just plain words.');

// --- punctuation: shouty normalization ---
eq('triple bang → single', speech.tidyPunctuationForSpeech('Amazing!!!'), 'Amazing!');
eq('interrobang → question', speech.tidyPunctuationForSpeech('Really?!'), 'Really?');
eq('long ellipsis → one', speech.tidyPunctuationForSpeech('well.....'), 'well…');
eq('doubled comma cleaned', speech.tidyPunctuationForSpeech('a,, b'), 'a, b');

// --- full pipeline ---
eq('forSpeech emoji+punct', speech.forSpeech('Done ✅!!!'), 'Done done!');
eq('forSpeech idempotent on clean', speech.forSpeech('all set.'), 'all set.');
ok('forSpeech strips all emoji', !speech.hasEmoji(speech.forSpeech('mixed 🔥 message 🎯 here 🤔')));

// ── MARKUP IS NOT SPEECH ─────────────────────────────────────────────────────────────────────────
// Four call sites hand speakDesktop a <speak>…</speak> wrapper and the default local voice has no
// SSML parser, so BhatBot was saying "speak, Mail's open, slash speak" out loud. The string is
// perfect at every point you can inspect; only the audio was wrong, which is why it survived until
// something transcribed its own output.
{
  const sp = require('../lib/speech');
  for (const [raw, want] of [
    ['<speak>Mail is open.</speak>', 'Mail is open.'],
    ['<speak>The fleet is back.</speak>', 'The fleet is back.'],
    ['<break time="0.2s"/>then this', 'then this'],
    ['<prosody rate="slow">careful</prosody>', 'careful'],
  ]) {
    const got = sp.forSpeech(raw);
    ok(`SSML stripped before synthesis: ${JSON.stringify(raw)} → ${JSON.stringify(got)}`, got === want);
  }
  // ...and nothing that is not markup is touched.
  ok('a bare < is not treated as a tag', sp.forSpeech('He scored 3 < 5 points') === 'He scored 3 < 5 points');
  ok('ordinary text passes through untouched', sp.forSpeech('plain sentence, untouched') === 'plain sentence, untouched');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
