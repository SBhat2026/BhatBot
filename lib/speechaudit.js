'use strict';
// ── WHAT DID IT ACTUALLY SAY? ─────────────────────────────────────────────────────────────────────
// Every other check in this repo verifies the string BhatBot INTENDED to say. None of them verify
// what came out of the speaker, and those are not the same thing — between the two sit SSML that can
// leak as literal text, a voice that mispronounces a name, markdown that gets read aloud as
// asterisks, truncation, and an empty clip that looks like success everywhere in the logs.
//
// That gap is why the broken phone calls took three rounds: the only instrument for "did he speak,
// and what did he say" was Siddhant listening and reporting back.
//
// THE LOOP: synthesize the line through the REAL TTS, transcribe the audio through the REAL STT, and
// compare what came back against what was asked for. Both ends are the same local workers the app
// uses, so a regression in either shows up here rather than on a phone call.
//
// WHAT A MISMATCH MEANS, and why the comparison is fuzzy: STT is not a decoder, it is a guess. "It's
// 20 degrees" may transcribe as "it is twenty degrees" and that is a PASS — the listener heard the
// right thing. So similarity is measured on spoken form (numbers spelled out, punctuation dropped,
// contractions expanded), and the threshold is deliberately loose. This catches "the audio was empty",
// "it read the SSML tags aloud", "it stopped halfway" — not "the transcriber misheard a vowel".
const fs = require('fs');

/** Spoken form: what a listener would actually hear, so transcript and intent can be compared. */
function spokenForm(s) {
  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const say = (n) => {
    if (n < 20) return ONES[n];
    if (n < 100) return (TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
    if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + say(n % 100) : '');
    return String(n);
  };
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')                                  // SSML/markup is not speech
    .replace(/[*_`#>|]/g, ' ')                                 // markdown is not speech either
    .toLowerCase()
    .replace(/\b(\d+)\b/g, (_, d) => (Number(d) < 1000 ? say(Number(d)) : d))
    .replace(/n't\b/g, ' not').replace(/'s\b/g, ' is').replace(/'re\b/g, ' are').replace(/'ll\b/g, ' will')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bag-of-words overlap, 0..1. Order-insensitive on purpose — a transcriber reorders nothing, but it
 *  does drop and merge, and penalising that as a failure would make every pass a coin flip. */
function similarity(a, b) {
  const wa = spokenForm(a).split(' ').filter(Boolean);
  const wb = spokenForm(b).split(' ').filter(Boolean);
  if (!wa.length && !wb.length) return 1;
  if (!wa.length || !wb.length) return 0;
  const bag = new Map();
  for (const w of wb) bag.set(w, (bag.get(w) || 0) + 1);
  let hit = 0;
  for (const w of wa) if (bag.get(w) > 0) { hit++; bag.set(w, bag.get(w) - 1); }
  return hit / Math.max(wa.length, wb.length);
}

/**
 * audit({ text, synthesize, transcribe, threshold }) → a verdict about the AUDIO, not the string.
 *   synthesize(text) → { path } | { audio }   the real TTS
 *   transcribe(path) → { text }               the real STT
 *
 * Distinguishes the failure modes, because they need different fixes:
 *   silent      — audio produced nothing a transcriber could hear
 *   markup      — SSML or markdown was read aloud as literal words
 *   truncated   — the transcript is a prefix of the intent and stops early
 *   mismatch    — it said something else
 */
async function audit({ text, synthesize, transcribe, threshold = 0.6 } = {}) {
  const intent = String(text || '').trim();
  if (!intent) return { ok: false, stage: 'input', detail: 'nothing to say' };

  let clip;
  try { clip = await synthesize(intent); } catch (e) { return { ok: false, stage: 'tts', detail: 'synthesis threw: ' + (e && e.message) }; }
  const p = clip && (clip.path || clip.file);
  if (!p || !fs.existsSync(p)) return { ok: false, stage: 'tts', detail: 'no audio file produced' };
  const bytes = fs.statSync(p).size;
  if (bytes < 1024) return { ok: false, stage: 'tts', detail: `audio is ${bytes} bytes — effectively silence`, bytes };

  let heard;
  try { heard = await transcribe(p); } catch (e) { return { ok: false, stage: 'stt', detail: 'transcription threw: ' + (e && e.message), bytes }; }
  const said = String((heard && heard.text) || '').trim();
  if (!said) return { ok: false, stage: 'silent', detail: 'audio produced, but nothing audible in it', bytes, heard: '' };

  const score = similarity(intent, said);
  // Markup leaking into speech is its own diagnosis: the words are there AND extra ones are being
  // pronounced, which a bare similarity score reports as a vague mismatch.
  if (/\b(speak|prosody|break time|emphasis|asterisk|angle bracket)\b/i.test(said)) {
    return { ok: false, stage: 'markup', detail: 'markup was read aloud as words', bytes, heard: said, score };
  }
  if (score < threshold) {
    const prefix = similarity(said, intent.slice(0, Math.max(12, said.length * 1.4)));
    if (prefix > 0.75) return { ok: false, stage: 'truncated', detail: 'speech stopped early', bytes, heard: said, score };
    return { ok: false, stage: 'mismatch', detail: 'what was heard does not match what was meant', bytes, heard: said, score };
  }
  return { ok: true, stage: 'ok', detail: `heard back at ${(score * 100).toFixed(0)}% of intent`, bytes, heard: said, score };
}

module.exports = { audit, similarity, spokenForm };
