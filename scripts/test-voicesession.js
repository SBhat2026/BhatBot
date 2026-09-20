'use strict';
// Tests for lib/voicesession.js — the state machine that owns a spoken conversation.
//
// The assertions that matter most are the two that used to be comments:
//   • the wake word is required to ENTER a session and never again inside it (the felt difference
//     between dictating to a machine and talking to someone);
//   • `speaking` has exactly one normal exit, `ttsIdle` — main.js documents this as an [[invariant]]
//     in prose, and prose cannot fail a build. If hands-free conversation ever wedges again, one of
//     these should have gone red first.

const assert = require('assert');
const vs = require('../lib/voicesession');

let pass = 0;
const ok = (m) => { console.log('✅ ' + m); pass++; };

// A rig with a controllable clock and a record of every effect.
function rig(config = {}) {
  let t = 1000;
  const fx = { stopped: 0, wakeMute: [], wakeRequired: [], spoken: [], states: [] };
  const sess = vs.createVoiceSession({
    now: () => t,
    stopPlayback: () => { fx.stopped++; },
    setWakeMute: (on) => fx.wakeMute.push(on),
    setWakeRequired: (on) => fx.wakeRequired.push(on),
    speak: (text, o) => fx.spoken.push({ text, kind: o && o.kind }),
    onState: (from, to, why) => fx.states.push(`${from}→${to}`),
    config,
  });
  return { sess, fx, advance: (ms) => { t += ms; return t; }, at: () => t };
}

// A full, ordinary exchange.
function exchange(r, { text = 'what is on my calendar', reply = 'Two things, sir.' } = {}) {
  r.sess.speechStart({ ms: 400 });
  r.sess.endpoint({ text });
  r.sess.firstAudio();
  r.sess.noteReply(reply);
  r.sess.ttsIdle();
}

// ── the wake word is an entry condition, not a per-utterance tax ──────────────────────────────────
{
  const r = rig();
  assert.strictEqual(r.sess.status().wakeRequired, true, 'closed → the wake word is how you get in');

  r.sess.open({ via: 'wake' });
  assert.strictEqual(r.sess.state(), vs.LISTENING);
  assert.strictEqual(r.fx.wakeRequired.at(-1), false, 'opening a session turns the wake word OFF');

  for (let i = 0; i < 5; i++) {
    exchange(r);
    assert.strictEqual(r.sess.state(), vs.LISTENING, `back to listening after exchange ${i + 1}`);
    assert.strictEqual(r.sess.status().wakeRequired, false, 'still no wake word needed mid-session');
  }
  assert.strictEqual(r.sess.status().session.turns, 5);

  r.sess.close({ via: 'user' });
  assert.strictEqual(r.fx.wakeRequired.at(-1), true, 'closing hands the wake word back');
  ok('the wake word is needed once to open, never again inside the session, and returns on close');
}

// ── ⚠ THE INVARIANT: speaking has exactly one normal exit ─────────────────────────────────────────
{
  const out = Object.keys(vs.TRANSITIONS[vs.SPEAKING]);
  assert.deepStrictEqual(out.sort(), ['abort', 'bargeIn', 'close', 'ttsIdle'].sort(),
    'speaking must not grow a new exit without someone thinking about the mic');

  const r = rig();
  r.sess.open({ via: 'tap' });
  r.sess.speechStart({ ms: 400 }); r.sess.endpoint({ text: 'hi' }); r.sess.firstAudio();
  assert.strictEqual(r.sess.state(), vs.SPEAKING);

  // Every event that is NOT one of the four must be refused rather than silently ignored.
  for (const ev of ['open', 'endpoint', 'firstAudio', 'silentTurn']) {
    assert.strictEqual(r.sess.can(ev), false, `${ev} must be illegal from speaking`);
  }
  assert.strictEqual(r.sess.endpoint({ text: 'x' }).ok, false, 'an illegal event returns a refusal, not a throw');
  assert.strictEqual(r.sess.state(), vs.SPEAKING, 'and leaves the state alone');

  r.sess.ttsIdle();
  assert.strictEqual(r.sess.state(), vs.LISTENING, 'tts-idle is what re-arms the mic');
  assert.strictEqual(r.fx.wakeMute.at(-1), false, 'and un-mutes the wake word');
  ok('speaking exits only through tts-idle, barge-in, abort or close — the wedge has a test now');
}

// ── the wedge is detectable instead of silent ─────────────────────────────────────────────────────
{
  const r = rig({ wedgeMs: 10000 });
  r.sess.open({ via: 'tap' });
  r.sess.speechStart({ ms: 400 }); r.sess.endpoint({ text: 'hi' }); r.sess.firstAudio();

  r.advance(9000);
  assert.strictEqual(r.sess.wedged(), false, 'not wedged yet');
  r.advance(2000);
  assert.strictEqual(r.sess.wedged(), true, 'tts-idle never came — this is the failure that used to be invisible');
  assert.strictEqual(r.sess.tick().action, 'wedged', 'and a tick reports it so a watchdog can act');

  r.sess.abort('watchdog');
  assert.strictEqual(r.sess.state(), vs.LISTENING, 'recovery returns the mic rather than stranding the session');
  assert.strictEqual(r.sess.wedged(), false);
  ok('a broken tts-idle contract is detectable, reported, and recoverable');
}

// ── barge-in ──────────────────────────────────────────────────────────────────────────────────────
{
  const r = rig();
  r.sess.open({ via: 'tap' });
  r.sess.speechStart({ ms: 400 }); r.sess.endpoint({ text: 'tell me about the fleet' }); r.sess.firstAudio();

  const before = r.fx.stopped;
  r.sess.speechStart({ ms: 500 });
  assert.strictEqual(r.sess.state(), vs.LISTENING, 'talking over him returns to listening immediately');
  assert.strictEqual(r.fx.stopped, before + 1, 'and kills playback — the tail is the thing people hate');
  assert.strictEqual(r.sess.status().session.bargeIns, 1);

  const last = r.fx.spoken.at(-1);
  assert.strictEqual(last.kind, 'bargeIn');
  assert.ok(!/sorry|apolog/i.test(last.text), 'he does not apologise for being interrupted — that makes it an event');
  assert.ok(last.text.length < 20, 'the response to an interruption is a half-beat, not a sentence');
  ok(`barge-in cuts playback and answers with an attentive half-beat ("${last.text}")`);
}

// ── ...but a cough is not an interruption ─────────────────────────────────────────────────────────
{
  const r = rig({ bargeInMinMs: 220 });
  r.sess.open({ via: 'tap' });
  r.sess.speechStart({ ms: 400 }); r.sess.endpoint({ text: 'go on' }); r.sess.firstAudio();

  const before = r.fx.stopped;
  const res = r.sess.speechStart({ ms: 90 });
  assert.strictEqual(res.ok, false, 'a 90ms noise is below the floor');
  assert.strictEqual(r.sess.state(), vs.SPEAKING, 'and does not cut him off');
  assert.strictEqual(r.fx.stopped, before, 'nothing was killed');
  ok('a short noise does not trigger barge-in — attentive, not flaky');
}

// ── a silent turn cannot strand the session ───────────────────────────────────────────────────────
{
  const r = rig();
  r.sess.open({ via: 'tap' });
  r.sess.speechStart({ ms: 400 });
  r.sess.endpoint({ text: 'turn the volume down' });
  assert.strictEqual(r.sess.state(), vs.THINKING);
  r.sess.silentTurn();                         // the action produced no speech at all
  assert.strictEqual(r.sess.state(), vs.LISTENING, 'a turn with no audio still re-arms the mic');
  assert.strictEqual(r.sess.status().session.turns, 1, 'and counts as a turn');
  ok('a turn that produces no audio returns to listening — the wedge from the other side');
}

// ── idle: nudge once, then close ──────────────────────────────────────────────────────────────────
{
  const r = rig({ idleNudgeMs: 5000, idleCloseMs: 10000 });
  r.sess.open({ via: 'tap' });
  exchange(r);

  r.advance(5500);
  assert.strictEqual(r.sess.tick().action, 'nudged');
  assert.strictEqual(r.fx.spoken.at(-1).kind, 'nudge');
  r.advance(1000);
  assert.strictEqual(r.sess.tick(), null, 'he nudges once, not every tick');

  r.advance(5000);
  assert.strictEqual(r.sess.tick().action, 'closed');
  assert.strictEqual(r.sess.state(), vs.CLOSED);
  assert.strictEqual(r.fx.wakeRequired.at(-1), true);
  ok('an idle session is nudged once and then closed, handing the wake word back');
}

// ── a session is never timed out mid-thought or mid-sentence ──────────────────────────────────────
{
  for (const reach of ['thinking', 'speaking']) {
    const r = rig({ idleNudgeMs: 100, idleCloseMs: 200 });
    r.sess.open({ via: 'tap' });
    r.sess.speechStart({ ms: 400 });
    r.sess.endpoint({ text: 'run the long thing' });
    if (reach === 'speaking') r.sess.firstAudio();
    r.advance(60000);
    const action = r.sess.tick();
    assert.notStrictEqual(r.sess.state(), vs.CLOSED, `must not close while ${reach}`);
    if (reach === 'thinking') assert.strictEqual(action, null, 'a long think is not an idle ear');
  }
  ok('a long think or a long answer never trips the idle timeout — only silence does');
}

// ── the register: he greets once ──────────────────────────────────────────────────────────────────
{
  const r = rig();
  r.sess.open({ via: 'wake' });
  const greeting = r.fx.spoken.at(-1);
  assert.strictEqual(greeting.kind, 'greet');

  const greetsBefore = r.fx.spoken.filter((x) => x.kind === 'greet' || x.kind === 'greetAgain').length;
  for (let i = 0; i < 4; i++) exchange(r);
  const greetsAfter = r.fx.spoken.filter((x) => x.kind === 'greet' || x.kind === 'greetAgain').length;
  assert.strictEqual(greetsAfter, greetsBefore, 'he does not greet you again inside a conversation');
  ok(`he greets once per session ("${greeting.text}") and never again inside it`);
}

// ── ...and knows when he was just here ────────────────────────────────────────────────────────────
{
  const r = rig();
  r.sess.open({ via: 'wake' }); exchange(r); r.sess.close({ via: 'user' });
  r.advance(5000);
  r.sess.open({ via: 'wake' });
  assert.strictEqual(r.fx.spoken.at(-1).kind, 'greetAgain', 'reopening seconds later is not a fresh greeting');

  exchange(r); r.sess.close({ via: 'user' });
  r.advance(600000);                        // ten minutes
  r.sess.open({ via: 'wake' });
  assert.strictEqual(r.fx.spoken.at(-1).kind, 'greet', 'but ten minutes later it is');
  ok('reopening straight away gets "back again, sir"; much later gets a proper greeting');
}

// ── the sign-off reflects whether anything was actually done ──────────────────────────────────────
{
  const a = rig();
  a.sess.open({ via: 'tap' }); exchange(a); a.sess.close({ via: 'user' });
  assert.strictEqual(a.fx.spoken.at(-1).kind, 'close');

  const b = rig();
  b.sess.open({ via: 'tap' }); exchange(b); b.sess.noteWork(true); b.sess.close({ via: 'user' });
  assert.strictEqual(b.fx.spoken.at(-1).kind, 'closeDone', 'a session that did real work signs off differently');

  const c = rig();
  c.sess.open({ via: 'tap', silent: true });
  c.sess.close({ via: 'user' });
  assert.strictEqual(c.fx.spoken.length, 0, 'closing a session in which nothing was said says nothing');
  ok('the sign-off knows whether work happened, and an empty session closes in silence');
}

// ── the register library is written for the ear ───────────────────────────────────────────────────
{
  for (const [kind, lines] of Object.entries(vs.REGISTERS)) {
    assert.ok(lines.length >= 3, `${kind} needs alternatives or it becomes a catchphrase`);
    for (const l of lines) {
      assert.ok(l.length <= 60, `${kind}: "${l}" is too long to be said between two other thoughts`);
      assert.ok(!/[!]|😀|🙂|:\)/.test(l), `${kind}: "${l}" — no exclamation marks, no emoji; he is not perky`);
      assert.ok(!/\bI'm sorry\b|\bapolog/i.test(l), `${kind}: "${l}" — no apologising`);
    }
  }
  // The persona in lib/static-prompt.js says "address him as sir — naturally and sparingly". Some
  // lines should, not all of them, or it becomes a verbal tic.
  const all = Object.values(vs.REGISTERS).flat();
  const sirs = all.filter((l) => /\bsir\b/i.test(l)).length;
  assert.ok(sirs > all.length * 0.25 && sirs < all.length * 0.75,
    `"sir" should be frequent but not constant — ${sirs}/${all.length}`);
  ok(`${all.length} register lines: short, unexclaimed, unapologetic, "sir" in ${sirs} of them`);
}

// ── lines rotate rather than repeat ───────────────────────────────────────────────────────────────
{
  const r = rig();
  r.sess.open({ via: 'tap', silent: true });
  const seen = new Set();
  for (let i = 0; i < 4; i++) seen.add(r.sess.say('ack'));
  assert.ok(seen.size >= 3, `acks must not repeat back to back, got ${[...seen].join(' / ')}`);
  ok('register lines rotate, so a session does not hear the same phrase twice');
}

// ── the prompt directive is derived, not guessed ──────────────────────────────────────────────────
{
  const r = rig();
  assert.strictEqual(r.sess.promptDirective(), '', 'no session → no directive');

  r.sess.open({ via: 'tap' });
  const first = r.sess.promptDirective();
  assert.match(first, /LISTENED to/, 'it tells the model this is speech, not text');
  assert.match(first, /first exchange/i);

  exchange(r);
  const second = r.sess.promptDirective();
  assert.match(second, /do NOT greet him again/i, 'the second turn forbids re-greeting');

  r.sess.speechStart({ ms: 400 }); r.sess.endpoint({ text: 'x' }); r.sess.firstAudio();
  r.sess.speechStart({ ms: 500 });                       // barge in
  assert.match(r.sess.promptDirective(), /interrupted/i, 'being cut off changes the instruction');

  for (let i = 0; i < 4; i++) exchange(r);
  assert.match(r.sess.promptDirective(), /shorter, not longer/i, 'a long conversation tightens, not loosens');
  ok('the prompt directive is a function of session state — greeting, interruption and length');
}

// ── illegal transitions are refused everywhere, and nothing throws ────────────────────────────────
{
  const r = rig();
  const events = ['speechStart', 'endpoint', 'firstAudio', 'silentTurn', 'ttsIdle', 'bargeIn', 'abort', 'close'];
  for (const ev of events) {
    const res = r.sess[ev]({});                          // all of these from CLOSED
    assert.ok(res && res.ok === false, `${ev} from closed must be refused`);
  }
  assert.strictEqual(r.sess.state(), vs.CLOSED, 'and none of them opened a session by accident');
  assert.strictEqual(r.sess.open({}).ok, true);
  assert.strictEqual(r.sess.open({}).ok, false, 'opening twice is refused');
  ok('every event from every wrong state returns a refusal rather than throwing or corrupting state');
}

// ── the transition table has no unreachable state and no dead end ─────────────────────────────────
{
  const reachable = new Set([vs.CLOSED]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const from of [...reachable]) {
      for (const to of Object.values(vs.TRANSITIONS[from] || {})) {
        if (!reachable.has(to)) { reachable.add(to); grew = true; }
      }
    }
  }
  assert.deepStrictEqual([...reachable].sort(), [...vs.STATES].sort(), 'every state is reachable from closed');
  for (const st of vs.STATES) {
    assert.ok(Object.keys(vs.TRANSITIONS[st] || {}).length > 0, `${st} must have a way out`);
  }
  ok('every state is reachable and every state has an exit — no dead ends in the graph');
}

// ── session transcript is session-scoped ──────────────────────────────────────────────────────────
{
  const r = rig();
  r.sess.open({ via: 'tap' });
  exchange(r, { text: 'what is the weather', reply: 'Grey, sir.' });
  const t = r.sess.transcript();
  assert.ok(t.some((x) => x.role === 'user' && x.text === 'what is the weather'));
  assert.ok(t.some((x) => x.role === 'assistant' && x.text === 'Grey, sir.'));
  r.sess.close({ via: 'user' });
  assert.deepStrictEqual(r.sess.transcript(), [], 'closing a session drops its transcript — it is not chat history');
  ok('the session carries its own transcript, separate from the chat history, and drops it on close');
}

console.log(`\n✅ voicesession: ${pass} groups passed`);
