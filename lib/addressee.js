'use strict';
// ── ADDRESSEE — "is this one for me?", asked of EVERY utterance ──────────────────────────────────
//
// lib/addressivity.js judges the utterance a wake word started: was "BhatBot" said TO it or ABOUT
// it. That gate works. The hole was everything after it. A wake opened "conversation mode", and
// conversation mode re-armed the microphone after every reply with no time limit and no addressee
// check at all — the comment said so on purpose: demanding the name again would make the assistant
// deaf mid-conversation. True, and the cure was to stop asking the question entirely. So once a
// session was open, any clear sentence said in the room was a command: a remark to someone on the
// sofa, a line from the television, half of a phone call.
//
// The answer is not to demand the name again. It is to keep asking "is this for me?" with the
// evidence that is actually available, and to let a session CLOSE:
//
//   • WHOSE VOICE.     Speaker verification, used as a margin rather than a switch. Clearly him,
//                      clearly not him, and a real middle where it should not decide alone.
//   • THE MACHINE.     Is this computer playing sound the microphone can hear (lib/audioenv.js)?
//                      Speech while the speakers are busy is suspect; speech while audio goes to
//                      headphones is not.
//   • ANOTHER LISTENER. Is he on a call or in a meeting? Then he is talking to people.
//   • WHAT WAS SAID.   The linguistic cues addressivity already scores — second person, imperative,
//                      a named other addressee, narrative framing.
//   • WHEN.            A follow-up is likeliest right after BhatBot spoke and decays from there; an
//                      answer to a question BhatBot just asked is the likeliest of all.
//
// THREE-WAY, like addressivity, and for the same reason: forcing the genuine middle to a coin flip
// produces both false answers and — worse — ignoring a real command. 'unsure' goes to the cheap
// local model.
//
// Voice evidence is deliberately ASYMMETRIC. A clear non-match is close to decisive: the television
// is not Siddhant however command-shaped its sentence. A clear match is only mild support, because
// he also talks to other people in his own voice. That asymmetry is the whole reason voice ID helps
// here at all — it is good at saying "not him" and bad at saying "to me".
//
// Pure: no I/O, no clock, no model. Every decision is explainable from `reasons`.

const addressivity = require('./addressivity');

const DEFAULTS = {
  followUpMs: 20000,        // how long after BhatBot stops speaking a follow-up needs no wake word
  freshMs: 8000,            // inside this, a follow-up is as likely as it will ever be
  voiceMargin: 0.10,        // below threshold by more than this = clearly somebody else
  voiceStrong: 0.03,        // above threshold by at least this = clearly him
};

// A reply that ended by asking him something. The next thing he says is very probably the answer.
const ASKED = /\?\s*["')\]]*\s*$/;
// The shapes an answer to a question takes: too short to score on their own, entirely natural here.
const ANSWER = /^(?:yes|yeah|yep|yup|sure|ok|okay|no|nope|nah|correct|right|exactly|do it|go ahead|go on|please do|not yet|cancel|never ?mind|the (?:first|second|third|last) one|that one|both|neither|either)\b/i;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * decide(input) → { verdict:'yes'|'no'|'unsure', score, reasons, command, expired }
 *
 * input:
 *   text            the transcript
 *   mode            'wake' (a wake word started this) | 'followup' (inside an open session) | 'locked'
 *   sinceReplyMs    ms since BhatBot finished speaking (followup only); null if it has not spoken
 *   lastReply       the text BhatBot last said (to spot an answer to its own question)
 *   voice           { score, best, threshold, match, short } from lib/voiceid, or null if unavailable
 *   audio           { playing, audible, private, unknown } from lib/audioenv, or null
 *   inCall          true when he is on a call / in a meeting
 *   opts            overrides for DEFAULTS
 */
function decide(input = {}) {
  const o = { ...DEFAULTS, ...(input.opts || {}) };
  const text = String(input.text || '').trim();
  const mode = input.mode || 'followup';
  const reasons = [];
  if (!text) return { verdict: 'no', score: -10, reasons: ['nothing was said'], command: '', expired: false };

  // A voice lock is an explicit, standing instruction to listen to everything. Nothing here gets to
  // second-guess that — but another person's voice still should not drive it.
  const lang = addressivity.score(text, { hadWake: mode === 'wake' });
  let s = 0;
  const add = (n, why) => { if (!n) return; s += n; reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`); };

  // ── the window ──────────────────────────────────────────────────────────────────────────────────
  // Checked first because it is the one rule with no weighing in it: past the window, a session is
  // over, and only the name reopens it. Without this the follow-up window is a suggestion.
  const since = Number.isFinite(input.sinceReplyMs) ? input.sinceReplyMs : null;
  const named = lang.name && lang.name.found && lang.name.head;
  if (mode === 'followup' && since !== null && since > o.followUpMs && !named) {
    return { verdict: 'no', score: -10, expired: true, command: lang.command,
      reasons: [`the follow-up window closed ${Math.round((since - o.followUpMs) / 1000)}s ago and the name was not said`] };
  }

  // ── what was said ───────────────────────────────────────────────────────────────────────────────
  // addressivity's score is on a wake-utterance scale where the name carries ±3 of it. Inside a
  // session nobody says the name, so its language evidence is taken at half weight and the missing
  // name is not held against the speaker.
  if (mode === 'wake') add(lang.score, 'the wake-utterance gate (name position + phrasing)');
  else {
    const half = Math.round(lang.score / 2);
    add(half, half >= 0 ? 'phrased like a request to an assistant' : 'phrased like talk between people, or about something');
  }

  // ── was anything actually said? ─────────────────────────────────────────────────────────────────
  // "yeah", "okay", "mm" carry no request. They are an answer when a question is pending and noise
  // otherwise — and timing plus his voice would otherwise carry a bare "yeah" over the line as if it
  // were an instruction, which is how an assistant ends up acting on somebody agreeing with the TV.
  const pendingQuestion = mode === 'followup' && ASKED.test(String(input.lastReply || ''));
  const content = (String(lang.command || text).toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => !addressivity.FILLER.has(w));
  if (!content.length && !pendingQuestion) add(-3, 'only filler was said, and I had not asked anything');

  // ── when ────────────────────────────────────────────────────────────────────────────────────────
  if (mode === 'followup' && since !== null) {
    // Timing is support for something that already sounds like a request — it is not evidence on its
    // own. Said flatly, "+2 for speaking soon after me" made BhatBot answer a remark to someone else
    // precisely BECAUSE it came right after its reply, which is when people turn and comment on what
    // it just said. So the bonus shrinks as the phrasing turns away from it, and vanishes for talk
    // that is plainly narrative.
    const weight = lang.score >= 0 ? 1 : lang.score >= -2 ? 0.5 : 0;
    const base = since <= o.freshMs ? 2 : 1;
    const bonus = Math.floor(base * weight);
    if (bonus) add(bonus, since <= o.freshMs ? 'said within a few seconds of my reply' : 'said inside the follow-up window');
    if (pendingQuestion) {
      if (ANSWER.test(text)) add(4, 'I had just asked a question and this is shaped like its answer');
      else add(1, 'I had just asked a question');
    }
  }
  if (mode === 'locked') add(3, 'voice lock is on — he asked me to listen to everything');

  // ── whose voice ─────────────────────────────────────────────────────────────────────────────────
  const v = input.voice;
  let voiceClass = 'unknown';
  if (v && !v.short && typeof v.threshold === 'number' && (typeof v.score === 'number' || typeof v.best === 'number')) {
    const top = Math.max(Number(v.score) || -1, Number(v.best) || -1);
    if (top < v.threshold - o.voiceMargin) { voiceClass = 'other'; add(-7, `this is clearly not his voice (${top.toFixed(2)} against ${v.threshold.toFixed(2)})`); }
    else if (top >= v.threshold + o.voiceStrong) { voiceClass = 'owner'; add(1, 'it is his voice'); }
    else { voiceClass = 'borderline'; }
  } else if (v && v.short) {
    reasons.push('0 too little speech to tell whose voice it was');
  }

  // ── the machine ─────────────────────────────────────────────────────────────────────────────────
  const a = input.audio;
  if (a && a.audible === true) {
    // Sound the microphone can hear is coming out of this computer. That does not make the speech
    // the computer's — he can talk over music — so how much it counts depends on the voice.
    if (voiceClass === 'owner') add(-1, 'the speakers are playing, though the voice is his');
    else if (voiceClass === 'borderline') add(-4, 'the speakers are playing and the voice is not clearly his — likely the audio itself');
    else if (voiceClass === 'unknown') add(-3, 'the speakers are playing and I cannot tell whose voice it was');
    else add(-2, 'the speakers are playing');
  } else if (a && a.private === true) {
    reasons.push('0 audio is playing in his headphones, which the microphone cannot hear');
  }

  // ── another listener ────────────────────────────────────────────────────────────────────────────
  if (input.inCall) add(named ? -1 : -5, named ? 'he is on a call, but said my name first' : 'he is on a call or in a meeting — he is talking to people');

  s = clamp(s, -14, 14);
  // The same thresholds addressivity uses, so the two gates mean the same thing by yes/no/unsure.
  const verdict = s >= 2 ? 'yes' : s <= -1 ? 'no' : 'unsure';
  return { verdict, score: s, reasons, command: lang.command || text, expired: false, voiceClass };
}

module.exports = { decide, DEFAULTS, ASKED, ANSWER };
