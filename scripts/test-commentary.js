'use strict';
// Tests for lib/commentary.js — the observer voice.
//
// Two things are being protected, and they pull against each other. The commentary has to say
// enough that you never open a log, and little enough that you do not switch it off. Most of these
// assertions are about the second half, because a narration nobody listens to reports nothing.

const assert = require('assert');
const cm = require('../lib/commentary');

let pass = 0;
const ok = (m) => { console.log('✅ ' + m); pass++; };

function rig(config = {}, { speaking = false } = {}) {
  let t = 100000;
  let isSpeaking = speaking;
  const said = [];
  const c = cm.createCommentary({
    now: () => t,
    isSpeaking: () => isSpeaking,
    speak: (text, o) => said.push({ text, ...o }),
    config,
  });
  return {
    c, said,
    advance: (ms) => { t += ms; },
    setSpeaking: (v) => { isSpeaking = v; },
    texts: () => said.map((s) => s.text),
  };
}

// ── the register: observer, not actor ─────────────────────────────────────────────────────────────
{
  const r = rig();
  r.c.observe({ kind: 'tool', name: 'run_shell', detail: 'the test suite' });
  r.advance(20000);
  r.c.observe({ kind: 'agent', name: 'launched', count: 4 });
  r.advance(20000);
  r.c.observe({ kind: 'loop', name: 'triage', count: 4 });

  const all = r.texts().join(' ');
  assert.ok(all.length > 0, 'something was said');
  // The whole point of this layer: he is reporting on the household, not narrating his own verbs.
  assert.ok(!/\bI'm\b|\bI am\b|\bI'll\b|\bI've\b/i.test(all),
    `commentary must not be first person — got: ${all}`);
  assert.ok(!/working on it|one moment|bear with/i.test(all),
    'commentary must not fall back to content-free filler — that is what it replaces');
  ok(`the observer voice never says "I" — ${JSON.stringify(r.texts())}`);
}

// ── it carries real numbers, not vague progress ───────────────────────────────────────────────────
{
  const r = rig();
  r.c.observe({ kind: 'agent', name: 'launched', count: 4 });
  assert.match(r.texts()[0], /four/i, 'the count is in the line');
  r.advance(20000);
  r.c.observe({ kind: 'agent', name: 'returned', outstanding: 2 });
  assert.match(r.texts()[1], /two still out/i, 'and so is what remains');
  r.advance(20000);
  r.c.observe({ kind: 'agent', name: 'returned', outstanding: 0 });
  assert.match(r.texts()[2], /all back/i);
  ok('agent lines carry the real counts — "four agents are out", "two still out", "all back"');
}

// ── most tools are simply not news ────────────────────────────────────────────────────────────────
{
  const r = rig();
  for (const t of ['read_file', 'list_directory', 'save_memory', 'ask_ai', 'health', 'ops_status', 'news']) {
    r.c.observe({ kind: 'tool', name: t });
    r.advance(30000);
  }
  // read_file/list_directory/save_memory coalesce (and need 3 of a kind); the rest are QUIET.
  assert.ok(r.said.length <= 1, `a handful of ordinary tool calls should be near-silent, got ${r.texts().join(' / ')}`);
  ok('ordinary tool calls are not announced — silence is the default');
}

// ── ...but a burst of them is one line with a count ───────────────────────────────────────────────
{
  const r = rig();
  for (let i = 0; i < 9; i++) { r.c.observe({ kind: 'tool', name: 'read_file' }); r.advance(300); }
  assert.strictEqual(r.said.length, 1, `nine reads must be ONE line, got ${r.said.length}`);
  assert.match(r.texts()[0], /reading through the project/i);
  assert.match(r.texts()[0], /\b3 files\b/, 'and it reports the count it had reached when it spoke');
  ok(`nine file reads become one line: "${r.texts()[0]}"`);
}

// ── a burst does not re-announce itself ───────────────────────────────────────────────────────────
{
  const r = rig();
  for (let i = 0; i < 40; i++) { r.c.observe({ kind: 'tool', name: 'fetch_url' }); r.advance(100); }
  assert.strictEqual(r.said.length, 1, 'forty fetches is still one line');
  ok('a long burst speaks once, not once per item — the runaway-loop case');
}

// ── it never talks over the answer ────────────────────────────────────────────────────────────────
{
  const r = rig();
  r.setSpeaking(true);
  for (const e of [
    { kind: 'tool', name: 'run_shell' },
    { kind: 'agent', name: 'launched', count: 3 },
    { kind: 'failure', name: 'the brief', permanent: true },
  ]) { r.c.observe(e); r.advance(20000); }
  assert.strictEqual(r.said.length, 0, 'nothing may be said while the reply itself is being spoken');

  r.setSpeaking(false);
  r.c.observe({ kind: 'agent', name: 'launched', count: 3 });
  assert.strictEqual(r.said.length, 1, 'and it resumes once he stops');
  ok('commentary never speaks over the answer — not even an urgent line');
}

// ── pacing ────────────────────────────────────────────────────────────────────────────────────────
{
  const r = rig({ minGapMs: 9000 });
  r.c.observe({ kind: 'tool', name: 'generate_image' });
  r.advance(1000);
  r.c.observe({ kind: 'tool', name: 'make_model' });
  assert.strictEqual(r.said.length, 1, 'a second notable line inside the gap waits');
  r.advance(9000);
  r.c.observe({ kind: 'tool', name: 'simulate' });
  assert.strictEqual(r.said.length, 2, 'and lands once the gap has passed');
  ok('notable lines are paced — no more than one every nine seconds');
}

// ── ...but urgent skips the gap ───────────────────────────────────────────────────────────────────
{
  const r = rig({ minGapMs: 9000 });
  r.c.observe({ kind: 'tool', name: 'generate_image' });     // notable
  r.advance(500);
  r.c.observe({ kind: 'failure', name: 'the morning brief', permanent: true, detail: 'the account is out of credit' });
  assert.strictEqual(r.said.length, 2, 'a permanent failure does not wait its turn');
  assert.match(r.texts()[1], /stopped for good/i);
  assert.match(r.texts()[1], /out of credit/i, 'and says what would unblock it');
  ok('a permanent failure interrupts the pacing — it is the class of thing that otherwise sits in a log for sixteen days');
}

// ── a runaway loop is not a runaway voice ─────────────────────────────────────────────────────────
{
  const r = rig({ minGapMs: 0, maxPerMinute: 5 });
  for (let i = 0; i < 50; i++) {
    r.c.observe({ kind: 'failure', name: 'thing ' + i, permanent: true });
    r.advance(200);
  }
  assert.ok(r.said.length <= 5, `the per-minute ceiling must hold even for urgent lines, got ${r.said.length}`);
  r.advance(61000);
  r.c.observe({ kind: 'failure', name: 'later', permanent: true });
  assert.ok(r.said.length > 5, 'and the window rolls');
  ok('even ALWAYS lines obey a hard per-minute ceiling — 50 failures produce 5 sentences, not 50');
}

// ── the same fact is not reported twice ───────────────────────────────────────────────────────────
{
  const r = rig({ minGapMs: 0 });
  for (let i = 0; i < 5; i++) {
    r.c.observe({ kind: 'tool', name: 'smart_login', detail: 'github', once: 'login:github' });
    r.advance(15000);
  }
  assert.strictEqual(r.said.length, 1, 'a `once` key collapses repeats of the same fact');
  r.c.reset();
  r.c.observe({ kind: 'tool', name: 'smart_login', detail: 'github', once: 'login:github' });
  assert.strictEqual(r.said.length, 2, 'and a new turn starts fresh');
  ok('a fact stated once is not restated until the turn resets');
}

// ── the Custodian's pause always gets through ─────────────────────────────────────────────────────
{
  const r = rig({ minGapMs: 60000, maxPerMinute: 1 });
  r.c.observe({ kind: 'tool', name: 'generate_image' });     // uses the whole per-minute budget
  r.c.observe({ kind: 'needs_input', detail: 'two readings of "the second one"' });
  const last = r.said.at(-1);
  assert.strictEqual(last.kind, 'needs_input', 'a stop-and-ask must never be rate-limited away');
  assert.match(last.text, /wants you/i);
  ok('"it has stopped and wants you" is the one line no limit may swallow');
}

// ── mute ──────────────────────────────────────────────────────────────────────────────────────────
{
  const r = rig({ minGapMs: 0 });
  r.c.mute(true);
  for (const e of [{ kind: 'agent', name: 'launched', count: 3 }, { kind: 'needs_input', detail: 'x' }]) r.c.observe(e);
  assert.strictEqual(r.said.length, 0, 'mute silences everything, including the urgent');
  assert.strictEqual(r.c.isMuted(), true);
  r.c.mute(false);
  r.c.observe({ kind: 'agent', name: 'launched', count: 3 });
  assert.strictEqual(r.said.length, 1);
  ok('mute is absolute and reversible — a focus mode has to actually be silent');
}

// ── every template renders without throwing, and reads like speech ────────────────────────────────
{
  const r = rig({ minGapMs: 0, maxPerMinute: 999 });
  const events = [
    ...Object.keys(cm.TOOL_SALIENCE).map((name) => ({ kind: 'tool', name, detail: 'x', count: 2, usd: 0.4 })),
    { kind: 'agent', name: 'launched', count: 3 }, { kind: 'agent', name: 'returned', outstanding: 1 },
    { kind: 'agent', name: 'stalled', name2: 1 }, { kind: 'agent', name: 'reaped' },
    { kind: 'loop', name: 'synapse', detail: '660 edges' }, { kind: 'loop', name: 'triage', count: 3 },
    { kind: 'loop', name: 'patrol' }, { kind: 'loop', name: 'backlog', detail: 'B1' },
    { kind: 'loop', name: 'gardener', detail: '292 decayed' },
    { kind: 'schedule', name: 'ran', name3: 'brief' }, { kind: 'schedule', name: 'parked', detail: 'no credit' },
    { kind: 'cost', usd: 0.04 }, { kind: 'cost', usd: 3.5 },
    { kind: 'failure', name: 'x', permanent: false }, { kind: 'toolbox', detail: 'science' },
    { kind: 'needs_input', detail: 'ambiguous' },
  ];
  for (const e of events) {
    assert.doesNotThrow(() => r.c.observe({ ...e, name: e.name, name2: undefined }), `event ${e.kind}/${e.name} must not throw`);
    r.advance(50);
  }
  for (const s of r.said) {
    assert.ok(s.text.length > 3 && s.text.length < 110, `"${s.text}" is not a spoken sentence`);
    assert.ok(/[.?]$/.test(s.text), `"${s.text}" should end in a full stop`);
    assert.ok(!/undefined|null|NaN|\[object/.test(s.text), `"${s.text}" has a rendering hole`);
    assert.ok(!/!/.test(s.text), `"${s.text}" — no exclamation marks`);
  }
  ok(`all ${r.said.length} rendered lines are clean, terminated sentences with no holes`);
}

// ── money reads as money ──────────────────────────────────────────────────────────────────────────
{
  const r = rig({ minGapMs: 0 });
  r.c.observe({ kind: 'cost', usd: 0.04 });
  assert.match(r.texts()[0], /4 cents/, 'small amounts are spoken as cents, not "$0.04"');
  r.c.observe({ kind: 'cost', usd: 12.5 });
  assert.match(r.texts()[1], /\$12\.50/, 'larger ones as dollars');
  ok('amounts are spoken the way a person says them — "4 cents", "$12.50"');
}

// ── summarize() answers "what's going on?" without a log ──────────────────────────────────────────
{
  const r = rig();
  assert.match(r.c.summarize({}), /nothing running/i, 'an idle system says so plainly');
  const s = r.c.summarize({ agentsOut: 3, tool: 'reading the repo', loops: ['the weaver'], parked: ['brief'], usdToday: 0.04 });
  assert.match(s, /three agents are out/i);
  assert.match(s, /reading the repo/);
  assert.match(s, /the weaver/);
  assert.match(s, /1 thing parked/i);
  assert.match(s, /4 cents/);
  assert.ok(!/undefined/.test(s));
  ok(`summarize answers the question directly: "${s}"`);
}


// ── IS IT WIRED, AND IS IT FREE? ─────────────────────────────────────────────────────────────────
// This module was written, tested, and required by nothing — so the only way to learn what BhatBot
// was doing remained reading ~/.bhatbot/logs, which is the exact thing it exists to replace. It now
// sits on the tool path, and two properties are what make that safe rather than reckless.
{
  const fs = require('fs');
  const path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/createCommentary\(/.test(main), 'main.js constructs the commentary layer');
  assert.ok(/function remark\(event\)/.test(main), 'with a fire-and-forget wrapper');
  assert.ok(/isSpeaking: \(\) => ttsActive/.test(main),
    'fed the REAL tts flag — speakDesktop() begins with stopDesktopTTS(), so an unguarded line would cut him off mid-answer');
  const exec = main.slice(main.indexOf('async function executeTool(name, input, opts'));
  assert.ok(/remark\(\{ kind: 'tool', name, input \}\)/.test(exec.slice(0, 2000)),
    'and it observes the tool path, which is where the news actually is');
  assert.ok(!/await remark\(/.test(main), 'NEVER awaited — a narration must not sit in a tool\'s latency');
  ok('the commentary layer is wired to the tool path, non-blocking, and cannot interrupt');
}
{
  // IT MUST NOT INTERRUPT. The rule the whole integration rests on.
  let said = [];
  const c = cm.createCommentary({ speak: (l) => said.push(l), isSpeaking: () => true });
  for (let i = 0; i < 5; i++) c.observe({ kind: 'tool', name: 'write_file', input: {} });
  assert.strictEqual(said.length, 0, 'it stays silent while he is already speaking');
  ok('commentary declines rather than talking over an answer in progress');
}
{
  // IT MUST BE FREE. It runs on every tool call, so anything measurable here is a latency
  // regression on the hot path — and reducing latency is a standing requirement, not a nicety.
  const c = cm.createCommentary({ speak: () => {}, isSpeaking: () => false });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 10000; i++) c.observe({ kind: 'tool', name: 'read_file', input: { path: '/x' } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 200, `10k observations took ${ms.toFixed(1)}ms — too slow for the tool path`);
  ok(`10,000 observations in ${ms.toFixed(1)}ms — free at the per-call scale it runs at`);
}

console.log(`\n✅ commentary: ${pass} groups passed`);
