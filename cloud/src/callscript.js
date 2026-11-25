'use strict';
// ⚠ COPY of ../../lib/callscript.js (the cloud image is built from cloud/ only). Edit that file and
// re-copy; scripts/test-callpath.js fails while the two differ.
// ── WHAT BHATBOT SAYS ON A CALL, AND WHEN IT IS READY TO SAY IT ──────────────────────────────────
//
// 2026-11-25: "when calling my number, it should address me in the first person and when calling
// other people, it should say who it's coming from. Another issue is the latency when calling."
//
// The 19 Nov test call, from Twilio's own event log: he picked up, Twilio spent seconds deciding
// whether a person or a voicemail had answered before it even asked for the first words, then the
// cloud spent 2.4 s writing the greeting with a model and voicing it. The cloud's greeting was told
// to "say you're Siddhant's assistant BhatBot" — to Siddhant, on his own phone.
//
// So every line a call opens with is written HERE, before the phone rings, by plain code:
//   • to HIM: spoken to him — "you", "your" — never "Siddhant" in the third person;
//   • to ANYONE ELSE: the first sentence says it is BhatBot, an AI assistant, calling on behalf of
//     Siddhant Bhat — before anything else is said;
// and main.js voices them while the phone is still ringing, so the answer is instant.
//
// Pure: no I/O. main.js and mcp-server.js do the sending and speaking.

const OWNER_FULL = 'Siddhant Bhat';

function timeGreeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/**
 * A message written ABOUT him, turned into one spoken TO him.
 * "Siddhant's build failed" → "Your build failed"; "Siddhant is late" → "You are late".
 * Only his name is rewritten — "he"/"his" are ambiguous in a message that may be about someone else.
 */
function toSecondPerson(text, names = ['Siddhant Bhat', 'Siddhant']) {
  let s = String(text || '').trim();
  // A speaker label in front of the message is for a log, not for a voice.
  s = s.replace(/^\s*(?:BhatBot|Jarvis)\s*[:\-—]\s*/i, '');
  for (const n of names) {
    const N = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`\\b${N}['’]s\\b`, 'gi'), 'your');
    s = s.replace(new RegExp(`\\b${N}\\s+(is|was|has|does)\\b`, 'gi'), (_m, v) => 'you ' + ({ is: 'are', was: 'were', has: 'have', does: 'do' })[v.toLowerCase()]);
    s = s.replace(new RegExp(`\\b(?:Mr\\.?\\s+)?${N}\\b`, 'gi'), 'you');
  }
  // Tidy the seams the substitutions leave: "you, you" from "Siddhant, you…", sentence-initial case.
  s = s.replace(/\byou,\s+you\b/gi, 'you').replace(/^,\s*/, '');
  s = s.replace(/(^|[.!?]\s+)(your|you)\b/g, (_m, pre, w) => pre + w[0].toUpperCase() + w.slice(1));
  return s.replace(/\s{2,}/g, ' ').trim();
}

/** Everything a call to HIM opens with, written before it is placed. */
function ownerLines(reason, now = new Date()) {
  const why = toSecondPerson(reason || '') || 'You asked me to ring you.';
  const hello = timeGreeting(now);
  return {
    opener: `${hello}, sir — it's BhatBot. Is now a good time?`,
    reason: `${why} What would you like to do?`,
    later: 'Understood. I will try you later. Goodbye.',
    voicemail: `${hello}, sir — it's BhatBot, sorry I missed you. ${why} It's in writing on your phone as well. Goodbye.`,
  };
}

function firstName(name) {
  const n = String(name || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'’-]{0,30}$/.test(n) ? n : '';
}

/**
 * Everything a call to SOMEONE ELSE opens with. The first sentence identifies the caller — BhatBot,
 * an AI assistant, for Siddhant Bhat — before any request is made, and so does the voicemail.
 * `purposeLine` is the one sentence that says why, phrased for them (main.js may have a model
 * phrase it while the phone rings); without one, a plain sentence built from the purpose is used.
 */
function guestLines({ name, purpose, purposeLine, owner = OWNER_FULL } = {}) {
  const fn = firstName(name);
  const who = `this is BhatBot, an AI assistant calling on behalf of ${owner}`;
  const p = String(purpose || '').trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
  const first = owner.split(' ')[0];
  // "Ask whether they have an opening" → "Siddhant asked me to ask whether they have an opening."
  const imperative = /^(ask|tell|let|check|confirm|remind|find out|see|say|book|schedule|reschedule|cancel|arrange|request|invite|thank|update|follow up)\b/i.test(p);
  const line = String(purposeLine || '').trim()
    || (!p ? `${first} asked me to get in touch with you.`
      : imperative ? `${first} asked me to ${p[0].toLowerCase()}${p.slice(1)}.`
      : `${first} asked me to call you about ${p[0].toLowerCase()}${p.slice(1)}.`);
  return {
    opener: `Hi${fn ? ' ' + fn : ''}, ${who}. Do you have a moment?`,
    purposeLine: line,
    later: `No problem. ${first} will follow up another time. Goodbye.`,
    voicemail: `Hi${fn ? ' ' + fn : ''}, ${who}. Sorry I missed you — he will follow up with you directly. Goodbye.`,
  };
}

/** The system prompt for the turns AFTER the prepared lines, on a call to someone else. No tools. */
function guestSystem({ name, purpose, note, owner = OWNER_FULL } = {}) {
  return [
    `You are BhatBot, an AI assistant, on a phone call you placed on behalf of ${owner}. You are not ${owner} and never claim to be.`,
    `You are speaking with ${name || 'the person you called'}.${note ? ' Context he gave about them: ' + note + '.' : ''}`,
    `Why you called: ${purpose || '(not stated — ask how you can help and take a message)'}.`,
    'If they ask who you are or who is calling, say plainly that you are BhatBot, an AI assistant calling for him.',
    'Speak as a person would on the phone: one or two short sentences per turn, no lists, no markdown.',
    'You can only talk and take a message. You cannot look things up, book, pay, or change anything — if they ask for that, say he will follow up.',
    'Never share his phone number, address, schedule, finances or anything private beyond what the purpose needs.',
    'When the business is done or they want to go, thank them, say goodbye, and append the literal token [END_CALL].',
  ].join(' ');
}

/** Is this a "not now"? Ambiguous answers count as "go ahead" — a maybe should not cost the call. */
function saidNotNow(speech) {
  return /\b(no|nope|not now|can'?t|cannot|busy|later|bad time|call (me )?back|another time|in a meeting|driving)\b/i.test(String(speech || ''))
    && !/\b(yes|yeah|yep|sure|go ahead|go on|ok(ay)?)\b/i.test(String(speech || ''));
}

module.exports = { toSecondPerson, ownerLines, guestLines, guestSystem, saidNotNow, timeGreeting, firstName, OWNER_FULL };
