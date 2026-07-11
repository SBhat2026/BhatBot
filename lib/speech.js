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

// ───────────────────────────────────────────────────────────────────────────────────────────────
// COMPREHENSIVE symbol / number / punctuation → spoken words. This is the HARD-GUARANTEE layer:
// every symbol a listener could hear ambiguously — or that a neural TTS voices wrongly — is mapped
// to the words a careful speaker would actually say, IN CONTEXT. Order is deliberate: multi-char and
// context-sensitive rules run BEFORE the generic strips, so nothing meaningful is flattened to a
// space before it's interpreted. Pure + exhaustively tested (scripts/test-speech-punct.js), so a
// regression is caught in `npm run verify`, never on Siddhant's ear.
function speakSymbolsForSpeech(input) {
  let s = String(input || '');
  if (!s) return s;

  // 0. Canonicalize smart quotes so downstream rules see plain forms.
  s = s.replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"');

  // 1. NUMERIC RANGES first (before minus/hyphen rules touch the dash). en/em dash always; hyphen only
  //    when it's unambiguously a small range (guarded so dates 6-12-2026 and phones 555-1234 are safe).
  s = s.replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2');
  s = s.replace(/(?<![\d.\-−])(\d{1,4})\s*-\s*(\d{1,4})(?![\d.\-−])/g,
    (m, a, b) => (a.length === 3 && b.length === 4) ? m : (a + ' to ' + b));   // …but 3-4 digits = phone, leave it

  // 2. COMPARISON / relational operators (before the generic <>~ strip) — these carry meaning Siddhant
  //    relies on (ipTM > 0.7, RMSD < 1.0 Å, <50% identity, ΔΔG < −5).
  s = s.replace(/≤|<=/g, ' less than or equal to ')
       .replace(/≥|>=/g, ' greater than or equal to ')
       .replace(/≠|!=/g, ' not equal to ')
       .replace(/±|\+\/−|\+\/-/g, ' plus or minus ');
  s = s.replace(/<\s*(?=[\d.\-−])/g, ' less than ')
       .replace(/>\s*(?=[\d.\-−])/g, ' greater than ');

  // 3. MATH operators (context-aware).
  s = s.replace(/(\d)\s*[×x]\s*(\d)/g, '$1 by $2').replace(/×/g, ' times ')
       .replace(/(\d)\s*÷\s*(\d)/g, '$1 divided by $2').replace(/÷/g, ' divided by ')
       .replace(/√/g, ' square root of ')
       .replace(/(\d)\s*\^\s*(\d)/g, '$1 to the power of $2');

  // 4. ARROWS → "to" / "from" (pipelines: "generate → novelty → fold").
  s = s.replace(/\s*(?:→|->|⟶|⇒|=>)\s*/g, ' to ').replace(/\s*(?:←|<-|⟵)\s*/g, ' from ');

  // 5. Leading MINUS before a number → "minus" (unicode + ascii), only at start/after space/paren.
  s = s.replace(/(^|[\s(])[−-](?=\d)/g, '$1minus ');
  s = s.replace(/≈/g, ' approximately ');

  // 6. SCIENTIFIC units + Greek (Siddhant's protein/ML domain).
  s = s.replace(/°\s?C\b/g, ' degrees Celsius ').replace(/°\s?F\b/g, ' degrees Fahrenheit ').replace(/°/g, ' degrees ')
       .replace(/Å/g, ' angstroms ').replace(/∞/g, ' infinity ').replace(/[µμ](?=[A-Za-z])/g, 'micro').replace(/[µμ]/g, ' micro ')
       .replace(/Δ|δ/g, ' delta ').replace(/α/g, ' alpha ').replace(/β/g, ' beta ').replace(/γ/g, ' gamma ')
       .replace(/λ/g, ' lambda ').replace(/σ/g, ' sigma ').replace(/π/g, ' pi ').replace(/θ/g, ' theta ')
       .replace(/[φϕ]/g, ' phi ').replace(/ω/g, ' omega ').replace(/Ω/g, ' ohms ')
       .replace(/\b(\d+)\s*AA\b/g, '$1 amino acids');

  // 7. CURRENCY €£¥ (dollar handled upstream with cents/commas).
  s = s.replace(/€\s?(\d[\d,]*)/g, '$1 euros').replace(/£\s?(\d[\d,]*)/g, '$1 pounds').replace(/¥\s?(\d[\d,]*)/g, '$1 yen')
       .replace(/€/g, ' euros ').replace(/£/g, ' pounds ').replace(/¥/g, ' yen ');

  // 8. UNIT RATIOS: "kcal/mol", "km/h", "mg/mL" → "per".
  s = s.replace(/\b(kcal|kJ|kg|mg|µg|ng|g|mol|mmol|nmol|km|cm|mm|nm|mL|L|units?)\s*\/\s*(mol|L|mL|kg|g|h|hr|hour|s|sec|min|day|week|mol)\b/gi, '$1 per $2');

  // 9. DECIMALS → "point" (digit.digit) BEFORE the filename dot rule ("3.5" → "3 point 5").
  s = s.replace(/(\d)\.(\d)/g, '$1 point $2');

  // 10. UNDERSCORES inside identifiers → spaces ("top_10" → "top 10").
  s = s.replace(/([A-Za-z0-9])_(?=[A-Za-z0-9])/g, '$1 ');

  // 11. DOTS → "dot" for filenames/domains (letter-adjacent) + leading-dot extensions (".csv").
  s = s.replace(/([A-Za-z0-9])\.(?=[A-Za-z])/g, '$1 dot ')
       .replace(/(^|\s)\.([A-Za-z][A-Za-z0-9]{0,4})\b/g, '$1dot $2');

  // 12. SLASH: idioms + and/or + N/A; else letter/letter → "slash". Dates (digit/digit) left alone.
  s = s.replace(/\b24\s*\/\s*7\b/g, 'twenty four seven')
       .replace(/\bN\s*\/\s*A\b/g, 'not applicable')
       .replace(/\band\s*\/\s*or\b/gi, 'and or')
       .replace(/\bw\/(?=\s)/gi, 'with ')
       .replace(/([A-Za-z])\s*\/\s*([A-Za-z])/g, '$1 slash $2');

  // 13. Remaining SYMBOLS → words.
  s = s.replace(/&/g, ' and ').replace(/%/g, ' percent ')
       .replace(/(\S)@(\S)/g, '$1 at $2').replace(/(^|\s)@(?=\s|$)/g, '$1 at ')
       .replace(/#(\d+)/g, 'number $1').replace(/#/g, ' hash ')
       .replace(/(\d)\s*\+\s*(\d)/g, '$1 plus $2').replace(/\s\+\s/g, ' plus ')
       .replace(/(\w)\s*=\s*(\w)/g, '$1 equals $2')
       .replace(/~\s*(?=\d)/g, 'about ')
       .replace(/©/g, ' copyright ').replace(/§/g, ' section ').replace(/[®™]/g, ' ')
       .replace(/\\/g, ' backslash ')
       .replace(/[~^*<>|$]/g, ' ');   // any leftover markup → space

  // 14. Collapse whitespace; keep terminal punctuation for pausing.
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
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

module.exports = { forSpeech, stripEmojiForSpeech, tidyPunctuationForSpeech, speakSymbolsForSpeech, hasEmoji, EMOJI_SPOKEN };
