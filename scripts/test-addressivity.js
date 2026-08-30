#!/usr/bin/env node
'use strict';
// ADDRESSIVITY — "was that said TO me, or ABOUT me?" (lib/addressivity.js)
//
// The wake word cannot answer this: "BhatBot" sounds identical whether you are addressing it or
// complaining about it to someone else. So the transcript decides, and this pins the decision.
//
// Run: node scripts/test-addressivity.js   (wired into npm run verify)
const A = require('../lib/addressivity');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('❌ ' + m); } };

/** Assert a verdict, and print the reasons when it disagrees — the reasons ARE the tuning surface. */
function verdict(text, want, note) {
  const r = A.score(text, { hadWake: true });
  const got = r.verdict;
  if (got === want) { pass++; return r; }
  fail++;
  console.error(`❌ ${note || ''}\n   ${JSON.stringify(text)}\n   want ${want}, got ${got} (score ${r.score})\n   ${r.reasons.join('\n   ')}`);
  return r;
}

// ── addressed to it: act ────────────────────────────────────────────────────────────────────────
verdict('bhatbot open spotify', 'yes', 'vocative + imperative');
verdict('bhatbot, what is the weather today', 'yes', 'vocative + question');
verdict('bhatbot can you find the file I edited yesterday', 'yes', 'modal question with "you"');
verdict('hey bhatbot please render the lamp model', 'yes', 'filler prefix still counts as head position');
verdict('bhat bot show me the fleet', 'yes', 'the spaced STT rendering of the name');
verdict('bhatbot I need you to open spotify', 'yes', 'first-person framing is fine when "you" is present');
verdict('bought bot summarise my email', 'yes', 'the homophone rendering is still the name');

// ── said about it, or to somebody else: discard ─────────────────────────────────────────────────
verdict('bhatbot', 'no', 'the name alone is a mention, not a request');
verdict('bhatbot um', 'no', 'the name plus filler is still just the name');
verdict('I told bhatbot to do that yesterday', 'no', 'reported speech');
verdict('bhatbot is really good at this', 'no', 'third-person predicate');
verdict('mom, bhatbot made the slides already', 'no', 'another addressee is named');
verdict('I use bhatbot for all my 3d models', 'no', 'the name is a noun mid-sentence');
verdict("bhatbot's memory graph is huge", 'no', 'possessive — never a vocative');
verdict('so I was showing bat bot to my friend', 'no', 'narrative, past tense, name as object');
verdict('do you think bhatbot could handle that', 'no', 'a question about it, asked of a person');

// ── the genuinely ambiguous middle defers rather than guessing ──────────────────────────────────
{
  const r = A.score('open spotify', { hadWake: true });
  ok(r.verdict === 'unsure', 'a bare command with no name is unsure, not a coin flip');
  ok(/wake fired but no name/.test(r.reasons.join(' ')), 'and it says WHY it is unsure');
}

// ── the 3-second window's decisive case ─────────────────────────────────────────────────────────
// Saying the name and then nothing is the exact thing the probation window exists to catch, so it
// must not depend on any of the weighted signals — it returns early.
for (const t of ['bhatbot', 'hey bhatbot', 'bhatbot uh', 'bhatbot, um, yeah']) {
  const r = A.score(t, { hadWake: true });
  ok(r.verdict === 'no' && /no request after it/.test(r.reasons.join(' ')),
    `"${t}" is recognised as a passing mention`);
  ok(r.command === '', `"${t}" yields no command to run`);
}

// ── the command is returned with the vocative stripped ──────────────────────────────────────────
{
  const r = A.score('bhatbot, open spotify and play jazz', { hadWake: true });
  ok(r.command === 'open spotify and play jazz', 'the vocative is stripped from the command to act on');
}
{
  const r = A.score('open spotify', { hadWake: true });
  ok(r.command === 'open spotify', 'a command with no vocative is passed through unchanged');
}

// ── name-anchored patterns must survive the name having no internal word boundary ───────────────
// `\bbot\b` does not match inside "bhatbot". Writing the rules that way made the possessive and
// third-person checks match NOTHING, and every description scored as a command. Pin it directly.
ok(A.THIRD_PERSON_PREDICATE.test('bhatbot is broken'), 'third-person predicate matches the joined spelling');
ok(A.THIRD_PERSON_PREDICATE.test('bhat bot was slow'), 'third-person predicate matches the spaced spelling');
ok(!A.THIRD_PERSON_PREDICATE.test('bhatbot can you help'), '"can you" is a request, not a third-person modal');
ok(A.THIRD_PERSON_PREDICATE.test('bhatbot can do that'), '"can do" without "you" is descriptive');

// ── locateName ──────────────────────────────────────────────────────────────────────────────────
{
  const n = A.locateName('hey bhatbot open the door');
  ok(n.found && n.head, 'a filler-only prefix still counts as head position');
  ok(n.after === 'open the door', 'the text after the name is extracted cleanly');
}
{
  const n = A.locateName('I asked bhatbot about it');
  ok(n.found && !n.head, 'real words before the name mean it is not a vocative');
}
{
  const n = A.locateName('what is the weather');
  ok(!n.found && n.after === 'what is the weather', 'no name → the whole utterance is the body');
}

// ── empty / junk input never throws ─────────────────────────────────────────────────────────────
for (const t of [null, undefined, '', '   ', 123, {}]) {
  const r = A.score(t, { hadWake: true });
  ok(r && r.verdict === 'no', `junk input ${JSON.stringify(t)} is refused, not thrown on`);
}

console.log(`\n${fail ? '❌' : '✅'} addressivity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
