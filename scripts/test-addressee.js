#!/usr/bin/env node
'use strict';
// Tests for lib/addressee.js (who an utterance is FOR) and lib/audioenv.js (whether this machine is
// making sound the microphone can hear).
//
// The bug these exist for: a wake word opened "conversation mode", and conversation mode re-armed the
// mic after every reply with no time limit and no addressee check at all. Once open, any clear
// sentence said in the room — to a person, from the television, into a phone — was a command.
//   node scripts/test-addressee.js      (wired into npm run verify)
const { decide, DEFAULTS } = require('../lib/addressee');
const { parse, createAudioEnv } = require('../lib/audioenv');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };
const show = (r) => `${r.verdict} ${r.score} [${r.reasons.join(' | ')}]`;

const OWNER = { score: 0.86, best: 0.9, threshold: 0.739 };
const OTHER = { score: 0.41, best: 0.47, threshold: 0.739 };
const EDGE = { score: 0.70, best: 0.72, threshold: 0.739 };          // inside the margin: not decisive
const SILENT = { playing: false, audible: false, private: false };
const SPEAKERS = { playing: true, audible: true, private: false };
const HEADPHONES = { playing: true, audible: false, private: true };
const f = (text, x = {}) => decide({ text, mode: 'followup', sinceReplyMs: 3000, voice: OWNER, audio: SILENT, ...x });

// ── an ordinary follow-up must still just work ────────────────────────────────────────────────────
// The fix for "answers the wrong things" must not be "stops answering". These are the cases that
// conversation mode existed for, and every one has to pass without the name.
for (const t of ['what about tomorrow', 'and how long will that take', 'can you send that to my phone', 'open it in the browser', 'thanks, now play something quieter']) {
  const r = f(t);
  ok(r.verdict === 'yes', `follow-up, no name, his voice: "${t}" → ${r.verdict}`);
}
{
  const r = f('what about tomorrow', { voice: null });
  ok(r.verdict === 'yes', `and it does not REQUIRE voice ID — with no voice evidence a clean follow-up still passes (${r.verdict})`);
}

// ── whose voice: asymmetric on purpose ────────────────────────────────────────────────────────────
{
  const r = f('open the garage door', { voice: OTHER });
  ok(r.verdict === 'no', `a command-shaped sentence in somebody else's voice is refused: ${show(r)}`);
  const tv = f('the president announced today that the summit will go ahead', { voice: OTHER, audio: SPEAKERS });
  ok(tv.verdict === 'no', `television speech, not his voice, speakers on → ${tv.verdict}`);
  const edge = f('open the garage door', { voice: EDGE });
  ok(edge.verdict !== 'no', `a borderline score alone does not reject him — voice ID is a margin, not a switch (${edge.verdict})`);
  const short = f('yes', { voice: { short: true, threshold: 0.739 }, lastReply: 'Shall I send it now?' });
  ok(short.verdict === 'yes', `too little speech to verify is not treated as a failed verification (${short.verdict})`);
}

// ── the machine: speakers vs headphones ───────────────────────────────────────────────────────────
{
  const a = f('skip this one', { audio: SPEAKERS });
  ok(a.verdict === 'yes', `he can talk over music — his voice plus a command survives the speakers being on (${a.verdict})`);
  const b = f('open the pod bay doors', { voice: EDGE, audio: SPEAKERS });
  ok(b.verdict !== 'yes', `speakers playing AND the voice not clearly his is not accepted outright: ${show(b)}`);
  const c = f('you have to see what happens next', { voice: null, audio: SPEAKERS });
  ok(c.verdict !== 'yes', `speakers playing with no voice evidence at all is not accepted outright (${c.verdict})`);
  const d = f('skip this one', { audio: HEADPHONES, voice: EDGE });
  ok(d.verdict === 'yes', `audio in his HEADPHONES is not held against him — the mic cannot hear it (${d.verdict})`);
  ok(d.reasons.some((x) => /headphones/.test(x)), 'and the reasons say why it was ignored');
}

// ── talking to someone else, in his own voice ─────────────────────────────────────────────────────
{
  const r = f('and then he said he was not coming after all');
  ok(r.verdict === 'no', `narrative in his own voice right after a reply is not a command: ${show(r)}`);
  const m = f('mom, can you grab the door');
  ok(m.verdict !== 'yes', `a named other addressee is not answered (${m.verdict})`);
  const w = f('i was thinking we could go to the store later');
  ok(w.verdict !== 'yes', `a remark about plans is not accepted outright just because it came soon after a reply: ${show(w)}`);
}

// ── on a call ─────────────────────────────────────────────────────────────────────────────────────
{
  const r = f('so i think we should ship it on friday', { inCall: true });
  ok(r.verdict === 'no', `on a call, ordinary speech is for the people on the call (${r.verdict})`);
  const n = f('jarvis, mute my microphone', { inCall: true });
  ok(n.verdict === 'yes', `but the name still reaches it mid-call (${n.verdict})`);
}

// ── the window closes ─────────────────────────────────────────────────────────────────────────────
{
  const late = f("what's the weather like", { sinceReplyMs: DEFAULTS.followUpMs + 5000 });
  ok(late.verdict === 'no' && late.expired === true, `past the follow-up window a nameless utterance is refused and marked expired (${late.verdict})`);
  ok(/window closed/.test(late.reasons[0]), `and it says so: "${late.reasons[0]}"`);
  const named = f("jarvis, what's the weather like", { sinceReplyMs: DEFAULTS.followUpMs + 5000 });
  ok(named.verdict === 'yes', `the name reopens it (${named.verdict})`);
  const edge = f("what's the weather like", { sinceReplyMs: DEFAULTS.followUpMs - 1000 });
  ok(edge.verdict === 'yes', `just inside the window still works (${edge.verdict})`);
}

// ── answering its question ────────────────────────────────────────────────────────────────────────
{
  const y = f('yeah', { lastReply: 'I found two flights. Shall I book the earlier one?', sinceReplyMs: 6000 });
  ok(y.verdict === 'yes', `"yeah" straight after a question is the answer (${y.verdict})`);
  const n = f('yeah', { lastReply: 'Done. The file is on your desktop.', sinceReplyMs: 15000 });
  ok(n.verdict !== 'yes', `"yeah" with no question pending is not taken as an instruction (${n.verdict})`);
  const o = f('the second one', { lastReply: 'Which calendar should I use?', voice: OTHER });
  ok(o.verdict === 'no', `somebody else answering its question is still somebody else (${o.verdict})`);
}

// ── wake mode is unchanged ────────────────────────────────────────────────────────────────────────
{
  const a = decide({ text: 'bhatbot open spotify', mode: 'wake', voice: OWNER, audio: SILENT });
  ok(a.verdict === 'yes' && a.command === 'open spotify', `a wake utterance still strips the vocative (${a.verdict}, "${a.command}")`);
  const b = decide({ text: 'bhatbot is being really slow today', mode: 'wake', voice: OWNER, audio: SILENT });
  ok(b.verdict === 'no', `and talking ABOUT it is still refused (${b.verdict})`);
  const c = decide({ text: 'bhatbot open spotify', mode: 'wake', voice: OTHER, audio: SILENT });
  ok(c.verdict === 'no', `a wake in another person's voice is refused — it answers to him (${c.verdict})`);
}

// ── every decision explains itself ────────────────────────────────────────────────────────────────
{
  const r = f('open the garage door', { voice: OTHER, audio: SPEAKERS, inCall: true });
  ok(r.reasons.length >= 3 && r.reasons.every((x) => typeof x === 'string' && x.length > 8), `reasons are complete sentences, one per piece of evidence (${r.reasons.length})`);
  ok(decide({ text: '   ' }).verdict === 'no', 'nothing said is nothing to answer');
}

// ── lib/audioenv.js ───────────────────────────────────────────────────────────────────────────────
{
  const SPK = `Listed by owning process:
   pid 420(coreaudiod): [0x0002260e0001920a] 00:00:00 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInSpeakerDevice.context.preventuseridlesleep"
	Resources: audio-out BuiltInSpeakerDevice
`;
  const s = parse(SPK);
  ok(s.playing && s.audible && !s.private && s.devices[0] === 'BuiltInSpeakerDevice', `the real pmset output parses: speakers → audible (${JSON.stringify(s)})`);
  const q = parse('Assertion status system-wide:\n   PreventUserIdleSystemSleep    0\n');
  ok(q.playing === false && q.audible === false, 'no assertion = the machine is silent');
  const h = parse('   pid 420(coreaudiod): PreventUserIdleSystemSleep named: "com.apple.audio.AirPodsPro.context.preventuseridlesleep"\n\tResources: audio-out AirPodsPro\n');
  ok(h.playing && h.private && !h.audible, `AirPods → playing but private, the mic cannot hear it (${JSON.stringify(h)})`);
  const u = parse('   pid 420(coreaudiod): PreventUserIdleSystemSleep named: "com.apple.audio.SomeNewGadget9000.context.preventuseridlesleep"\n');
  ok(u.playing && u.audible, 'an output device it has never seen is treated as AUDIBLE — unknown must not switch the protection off');
  const both = parse('\tResources: audio-out BuiltInSpeakerDevice\n\tResources: audio-out AirPodsPro\n');
  ok(both.audible, 'speakers AND headphones together still count as audible');

  // The probe failing is "unknown", never "silent".
  const dead = createAudioEnv({ exec: () => { throw new Error('pmset went away'); } }).sample();
  ok(dead.unknown === true && dead.playing === null, 'a failed probe reports unknown rather than asserting silence nobody measured');
  const r = decide({ text: 'what about tomorrow', mode: 'followup', sinceReplyMs: 3000, voice: OWNER, audio: dead });
  ok(r.verdict === 'yes', 'and an unknown audio state takes nothing away from an otherwise clean follow-up');

  // Cached, because this is asked once per utterance.
  let calls = 0, t = 0;
  const env = createAudioEnv({ exec: () => { calls++; return SPK; }, now: () => t, ttlMs: 1500 });
  env.sample(); env.sample(); t = 1000; env.sample();
  ok(calls === 1, `repeated samples inside the TTL fork pmset once (${calls})`);
  t = 2000; env.sample();
  ok(calls === 2, `and it re-reads once the answer could have changed (${calls})`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} addressee: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
