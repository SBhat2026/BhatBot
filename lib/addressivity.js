'use strict';
// ── ADDRESSIVITY — "was that said TO me, or ABOUT me?" ────────────────────────────────────────────
//
// A wake word answers the wrong question. It fires on "BhatBot", which is also what you say when you
// are telling someone what BhatBot did, reading its name off the screen, or complaining about it. The
// detector cannot tell those apart because at the acoustic level they are identical — so the fix does
// not belong in the detector.
//
// This is the second gate. The wake word PROPOSES; the transcript DISPOSES. That ordering is the
// whole design: it means a false wake becomes harmless rather than merely rarer, and it lets the
// acoustic side stay sensitive enough to catch you the first time you say it.
//
// It sits beside lib/pure.js `looksActionable`, and the two ask genuinely different questions:
//     looksActionable  — is this a clear request, or rambling?      ("um, so, like, yeah")
//     addressivity     — was this request aimed at ME, or at Dad?   ("I told BhatBot to do that")
// An utterance has to pass both. Neither subsumes the other: "open Spotify" is perfectly clear and
// might be said to a person in the room, and "BhatBot, uhh, the thing" is aimed at us but useless.
//
// THREE-WAY, NOT BOOLEAN. Real speech has a genuine middle, and forcing it to a coin flip is how you
// get both false wakes and, worse, ignoring a real command. 'unsure' hands off to the cheap local
// model that already backs the borderline branch of the clarity gate (main.js `voice-intent`), so the
// expensive judgement is only paid for on the utterances that actually need it.
//
// PURE: no I/O, no clock, no model. Every decision is explainable from `reasons`, which is what makes
// the thresholds tunable against real transcripts instead of vibes.

// How the name survives speech-to-text. "Bhatbot" is not a word in any acoustic model's vocabulary,
// so every engine renders it as the nearest real words — which is also exactly why the acoustic
// detector over-triggers, and why this list has to be generous to be useful here.
// One source for every name-anchored pattern below. Writing `\bbot\b` instead — which is what I did
// first — silently fails on "bhatbot", because there is no word boundary inside it: the possessive
// and third-person rules matched nothing at all and every description of BhatBot scored as a command.
const NAME_SRC = '(?:bhat|bat|butt?|bought|bot)[\\s-]?bot|bhatbot|jarvis';
const NAME_RE = new RegExp(`\\b(?:${NAME_SRC})s?\\b`, 'i');

// ── directed-at-me signals ──────────────────────────────────────────────────────────────────────
const SECOND_PERSON = /\b(?:you|your|you're|youre|yourself|yours)\b/i;
// A bare verb, or a modal that is explicitly aimed at "you". The modal must carry the pronoun:
// "can you find it" is a request, "can do that" is a description of a capability.
const IMPERATIVE = /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|you\s+)?(?:open|close|play|pause|stop|start|show|tell|find|search|look|get|give|make|build|create|write|read|send|email|call|text|set|add|remove|delete|move|rename|run|check|fix|update|install|turn|switch|put|pull|push|draft|remind|schedule|book|order|translate|summari[sz]e|explain|list|count|convert|render|generate|design|model|animate|export|save|load|go|take|bring|help|try|keep|let|do|use|draw|plot|graph|record|capture|screenshot|download|upload|copy|paste|sort|filter|compare|analy[sz]e)\b/i;
// Wh-words open a question on their own; an auxiliary only does when a subject follows it.
const QUESTION_OPENER = /^(?:what|whats|what's|when|where|why|who|whose|which|how)\b|^(?:is|are|am|do|does|did|can|could|would|should|will|was|were|have|has|had)\s+(?:you|i|we|it|there|this|that|the|my|your)\b/i;
const POLITE = /\b(?:please|thanks|thank you)\b/i;

// ── talking-about-me signals ────────────────────────────────────────────────────────────────────
// A third-person predicate immediately after the name is the single most reliable "not to you" cue:
// you do not say "BhatBot is" to BhatBot.
const THIRD_PERSON_PREDICATE = new RegExp(
  `\\b(?:${NAME_SRC})s?\\b[\\s,]*(?:is|was|isn't|isnt|wasn't|wasnt|has|had|does|did|doesn't|doesnt|didn't|didnt|says|said|keeps|kept|went|got|gets|made|makes|seems|looks|works|worked|failed|fails|crashed|crashes|thinks|knows|wants|needs|likes|can't|cant|couldn't|couldnt|won't|wont|(?:will|can|could|would|should)\\s+(?!you\\b))`, 'i');
const POSSESSIVE = new RegExp(`\\b(?:${NAME_SRC})s?['’]s?\\b`, 'i');
// Reported speech: the name is the OBJECT of somebody else's sentence.
const QUOTATIVE = /\b(?:told|telling|tell|asked|asking|ask|said|says|saying|showed|showing|show)\s+(?:it\s+to\s+)?(?:the\s+)?(?:bhat|bat|but|butt|bought)?[\s-]?bot\b|\b(?:i|we|he|she|they|you)\s+(?:told|asked|said|showed)\b/i;
// Somebody ELSE is being spoken to.
const OTHER_ADDRESSEE = /\b(?:mom|mum|dad|mother|father|dude|man|bro|bruh|guys|y'all|yall|everyone|everybody|honey|babe|sir|ma'am|siri|alexa|google)\b/i;
// A narrative subject at the head of the utterance: describing, not requesting.
const NARRATIVE_SUBJECT = /^(?:so|and|but|then|yeah|well|anyway|actually|basically|i mean)?[\s,]*(?:i|we|he|she|they|it|my|our|his|her|their|this|that|there)\b/i;
const PAST_TENSE = /\b(?:was|were|had|used to|yesterday|last (?:night|week|time)|earlier|before|already)\b/i;

// Words that carry no content, so "just the name plus noise" can be recognised as such.
const FILLER = new Set(['um', 'uh', 'uhh', 'er', 'ah', 'oh', 'hey', 'ok', 'okay', 'so', 'well', 'like',
  'yeah', 'yep', 'yes', 'no', 'hmm', 'mm', 'mhm', 'right', 'the', 'a', 'an', 'and', 'but', 'just']);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Where the name sits in the utterance. Position carries most of the signal: at the front it is a
 * vocative ("BhatBot, open Spotify"); buried in the middle it is a noun ("I use BhatBot for that").
 */
function locateName(text) {
  const m = NAME_RE.exec(text);
  if (!m) return { found: false, head: false, index: -1, before: '', after: String(text || '').trim() };
  const before = text.slice(0, m.index).trim();
  const after = text.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/, '').trim();
  // "head" = nothing but filler in front of it, which is how a vocative actually sounds ("hey bhatbot").
  const leading = (before.toLowerCase().match(/[a-z']+/g) || []);
  const head = leading.every((w) => FILLER.has(w));
  return { found: true, head, index: m.index, before, after, matched: m[0] };
}

/**
 * @param {string} text  the transcript of what was said after the wake fired
 * @param {object} opts  { hadWake?: boolean }  — whether an acoustic detector proposed this
 * @returns {{verdict:'yes'|'no'|'unsure', score:number, reasons:string[], name:object, command:string}}
 *          `command` is the utterance with a leading vocative stripped, ready to act on.
 */
function score(text, opts = {}) {
  const raw = String(text || '').trim();
  const reasons = [];
  const name = locateName(raw);
  if (!raw) return { verdict: 'no', score: -10, reasons: ['nothing was said'], name, command: '' };
  // A possessive name is never a vocative — "BhatBot's graph is huge" opens with the name and is
  // still plainly a description — so it forfeits the head-position credit rather than merely offsetting it.
  const possessive = POSSESSIVE.test(raw);
  if (possessive) name.head = false;

  // The utterance minus a leading vocative — everything below judges THIS, not the name.
  const body = name.found && name.head ? name.after : raw;
  const words = (body.toLowerCase().match(/[a-z0-9']+/g) || []);
  const content = words.filter((w) => !FILLER.has(w));

  let s = 0;
  const add = (n, why) => { s += n; reasons.push(`${n >= 0 ? '+' : ''}${n} ${why}`); };

  // ── the name, and where ────────────────────────────────────────────────────────────────────────
  if (!name.found) {
    // The wake fired but the name is nowhere in the transcript. Usually that means the detector
    // matched noise. Not decisive on its own — STT drops the name often enough — so it is a strong
    // prior, not a veto, and a clean command below can still overcome it.
    if (opts.hadWake) add(-3, 'the wake fired but no name appears in what was transcribed');
  } else if (name.head) {
    add(3, 'the name opens the utterance, the way you address someone');
  } else if (name.after && !possessive) {
    // `possessive` already forfeited the head credit and scores below; saying "buried mid-sentence"
    // about a name that opens the utterance would be a reason that reads as wrong.
    add(-3, 'the name is buried mid-sentence, which is how you refer to a thing rather than address it');
  }

  // ── nothing followed the name ─────────────────────────────────────────────────────────────────
  // You said it in passing. This is the case the 3-second window exists for, and it is decisive.
  if (name.found && !content.length) {
    return { verdict: 'no', score: -10, reasons: [...reasons, 'the name was said with no request after it'], name, command: '' };
  }

  // ── talking ABOUT it ──────────────────────────────────────────────────────────────────────────
  if (THIRD_PERSON_PREDICATE.test(raw)) add(-6, 'a third-person predicate follows the name ("… is/was/did …")');
  if (possessive) add(-3, "the name is possessive (\"BhatBot's\"), so it is the subject of a description");
  if (QUOTATIVE.test(raw)) add(-4, 'reported speech — the name is the object of someone else\'s sentence');
  if (OTHER_ADDRESSEE.test(body)) add(-4, 'another addressee is named');
  if (PAST_TENSE.test(body)) add(-2, 'past tense — recounting rather than requesting');

  // ── directed AT it ────────────────────────────────────────────────────────────────────────────
  const second = SECOND_PERSON.test(body);
  if (second) add(2, 'second person — it is speaking to someone, and the name says who');
  if (IMPERATIVE.test(body)) add(2, 'the request opens with an imperative');
  if (QUESTION_OPENER.test(body)) add(2, 'it opens as a question');
  if (POLITE.test(body)) add(1, 'a politeness marker, which people use on assistants and not on descriptions');
  // Narrative framing only counts against us when there is no second person: "I need you to open
  // Spotify" starts with "I" and is unambiguously directed.
  if (!second && NARRATIVE_SUBJECT.test(body)) add(-2, 'opens with a narrative subject and never says "you"');
  // Short and verb-first is what a command to a machine actually looks like.
  if (content.length > 0 && content.length <= 12 && IMPERATIVE.test(body)) add(1, 'short and command-shaped');

  s = clamp(s, -12, 12);
  const verdict = s >= 2 ? 'yes' : s <= -1 ? 'no' : 'unsure';
  return { verdict, score: s, reasons, name, command: body };
}

/** Convenience for callers that only branch on accept/defer/discard. */
function addressed(text, opts) { return score(text, opts).verdict === 'yes'; }

module.exports = {
  score, addressed, locateName,
  NAME_RE, SECOND_PERSON, IMPERATIVE, QUESTION_OPENER, THIRD_PERSON_PREDICATE, QUOTATIVE,
  OTHER_ADDRESSEE, NARRATIVE_SUBJECT, FILLER,
};
