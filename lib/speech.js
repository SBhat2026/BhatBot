'use strict';
// Human-speech shaping for the TTS path. PURE + testable (no Electron/network) so it can run
// under `node scripts/test-speech.js` without booting the app. main.js's normalizeForSpeech
// handles symbols/markdown/paths and humanizeCadence handles pauses; this module fills the two
// gaps those don't: (1) EMOJI — decide, by context, whether an emoji should be VOICED as a short
// spoken cue or silently dropped (never let neural TTS read a codepoint name or choke), and
// (2) extra human cadence — collapse shouty repeated punctuation, soften trailing particles, and
// vary micro-pauses so delivery reads like a person, not a screen reader.
//
//   const speech = require('./lib/speech');
//   const spoken = speech.forSpeech(text);            // full pipeline (emoji + cadence tidy)
//   const t2 = speech.stripEmojiForSpeech(text);      // just the emoji layer
//   const t3 = speech.tidyPunctuationForSpeech(text); // just the punctuation layer

// High-signal emojis that carry MEANING rather than decoration. When one of these stands alone
// or trails a clause, voicing a short word preserves intent for a listener who can't see it.
// Everything NOT in this map is treated as decoration and removed. Values are deliberately terse
// and butler-register; capped to one spoken cue per utterance (see stripEmojiForSpeech).
const EMOJI_SPOKEN = {
  '✅': 'done', '☑️': 'done', '✔️': 'done', '✔': 'done',
  '❌': 'no', '✖️': 'no', '🚫': 'no',
  '⚠️': 'heads up', '⚠': 'heads up',
  '🤔': 'hmm', '🧐': 'hmm',
  '🎉': 'excellent', '🥳': 'excellent',
  '🔥': 'strong work', '💯': 'absolutely',
  '👍': 'got it', '👌': 'got it', '🙏': 'thank you',
  '❤️': '', '🩵': '', '💙': '', '😊': '', '🙂': '', '😄': '', '😅': '', '😂': '', '🤣': '',
};

// Matches a single emoji GRAPHEME: an Extended_Pictographic base plus optional skin-tone modifier,
// variation selector, and ZWJ-joined continuations (families/flags). Also regional-indicator pairs.
const EMOJI_GRAPHEME = /(?:\p{RI}\p{RI}|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️|⃣)?(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️|⃣)?)*)/gu;
// Bare variation selectors / ZWJ left dangling after we lift a mapped emoji out of a sequence.
const STRAY_JOINERS = /[︎️‍⃣]/gu;

// Emoji → speech. Semantic emojis become at most ONE short spoken cue (the first meaningful one),
// preferring a trailing/standalone position so we voice tone, not decoration. All other emojis are
// dropped cleanly. Punctuation around a removed emoji is tidied so we never leave "text  ." gaps.
function stripEmojiForSpeech(input) {
  let s = String(input || '');
  if (!s) return s;
  if (!EMOJI_GRAPHEME.test(s)) return s;          // fast path: no emoji at all
  EMOJI_GRAPHEME.lastIndex = 0;

  let spokenBudget = 1;                            // at most one voiced cue per utterance
  s = s.replace(EMOJI_GRAPHEME, (g) => {
    const norm = g.replace(STRAY_JOINERS, '');     // ❤️ (with VS16) → ❤ so the map keys hit
    const word = Object.prototype.hasOwnProperty.call(EMOJI_SPOKEN, g) ? EMOJI_SPOKEN[g]
      : Object.prototype.hasOwnProperty.call(EMOJI_SPOKEN, norm) ? EMOJI_SPOKEN[norm]
      : null;
    if (word && spokenBudget > 0) { spokenBudget--; return word ? ' ' + word + ' ' : ' '; }
    return ' ';                                    // decoration, or budget spent → drop
  });
  s = s.replace(STRAY_JOINERS, ' ');
  // Tidy the holes emoji removal leaves: space-before-punct, doubled punct/space, orphan bullets.
  s = s.replace(/\s+([.,!?;:])/g, '$1')
       .replace(/[ \t]{2,}/g, ' ')
       .replace(/\s+\n/g, '\n')
       .trim();
  return s;
}

// Context-aware punctuation for spoken delivery. Shouty/emphatic punctuation reads as unnatural
// through neural TTS, so we normalize it the way a composed speaker would deliver it. We keep the
// terminal mark (it still cues intonation) but stop the pile-ups.
function tidyPunctuationForSpeech(input) {
  let s = String(input || '');
  if (!s) return s;
  s = s.replace(/([!?])\1{1,}/g, '$1')             // "!!!" → "!", "???" → "?"
       .replace(/\?\s*!+|\!\s*\?+/g, '?')          // "?!" / "!?" → "?" (a question, delivered calmly)
       .replace(/\.{4,}/g, '…')                    // "....." → single ellipsis (humanizeCadence times it)
       .replace(/\s*;\s*/g, '; ')                  // normalize semicolons to a clean mid-pause
       .replace(/([,;:])\1+/g, '$1')               // no doubled separators
       .replace(/[ \t]{2,}/g, ' ')
       .replace(/\s+([.,!?;:])/g, '$1')
       .trim();
  return s;
}

// Full spoken shaping (order matters: emoji first so removed decoration doesn't strand punctuation,
// then punctuation tidy). Symbol/markdown/path expansion + <break> cadence stay in main.js and run
// around this; forSpeech is safe to call before or after them (idempotent on already-clean text).
function forSpeech(input) {
  return tidyPunctuationForSpeech(stripEmojiForSpeech(input));
}

// Does this text contain any emoji at all? (cheap pre-check for callers that want to skip work)
function hasEmoji(input) { EMOJI_GRAPHEME.lastIndex = 0; return EMOJI_GRAPHEME.test(String(input || '')); }

module.exports = { forSpeech, stripEmojiForSpeech, tidyPunctuationForSpeech, hasEmoji, EMOJI_SPOKEN };
