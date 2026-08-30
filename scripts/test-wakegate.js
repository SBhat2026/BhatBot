#!/usr/bin/env node
'use strict';
// WAKE GATES (scripts/listen.py) — the two decisions that stop "the slightest sound" waking BhatBot.
//
// listen.py needs a microphone, openWakeWord and a Vosk model to RUN, none of which belong in a test
// suite. But the two decisions that matter are pure functions of numbers and a string, so they were
// lifted to module scope specifically to be checkable here. Everything below imports the real file —
// no reimplementation, so the test cannot drift away from the thing it is testing.
//
// It also checks structure with the AST rather than with grep. That distinction has bitten this
// codebase twice: a grep-shaped assertion happily matches the COMMENT describing the bug.
//
// Run: node scripts/test-wakegate.js   (wired into npm run verify)
const { execFileSync } = require('child_process');
const path = require('path');

const LISTEN = path.join(__dirname, 'listen.py');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('❌ ' + m); } };

function py(code) {
  return execFileSync('python3', ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: path.dirname(LISTEN) },
  }).trim();
}

// Python must exist for this to mean anything; saying so beats passing vacuously.
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); }
catch { console.log('⏭  wake gates skipped — python3 unavailable'); process.exit(0); }

const probe = `
import json, listen as L

# ── the loudness bar ────────────────────────────────────────────────────────────────────────────
out = {}
out['bar_quiet_room'] = L.wake_bar(0.001)          # silent room → the absolute floor governs
out['bar_noisy_room'] = L.wake_bar(0.02)           # noisy room → the relative margin governs
out['floor'] = L.WAKE_RMS_MIN
out['margin'] = L.WAKE_RMS_MARGIN

# ── the phrase gate ─────────────────────────────────────────────────────────────────────────────
cases = [
  'bought bot', 'bought bot open spotify', 'hey bought bot', 'bot bot', 'hey but bot',
  'but bot', 'i but bot', 'what about bought bot', 'and but bot then', '', 'jarvis', 'hey jarvis',
]
out['accepts'] = {c: bool(L.accepts(c)) for c in cases}
out['grammar'] = L.VOSK_GRAMMAR_PHRASES
out['accept_list'] = L.ACCEPT_PHRASES
out['engines'] = L.ENGINES
out['conf'] = L.WAKE_CONF
print(json.dumps(out))
`;
const R = JSON.parse(py(probe));

// ── the loudness bar ────────────────────────────────────────────────────────────────────────────
ok(R.bar_quiet_room === R.floor, 'in a silent room the absolute floor is the bar');
ok(R.bar_noisy_room > R.floor, 'in a noisy room the bar rises above the floor rather than staying fixed');
ok(Math.abs(R.bar_noisy_room - 0.02 * R.margin) < 1e-9, 'the noisy-room bar is room tone × the margin');
ok(R.floor >= 0.015, 'the absolute floor is high enough to exclude room tone (which runs 0.001-0.01)');
ok(R.margin >= 2, 'the relative margin is a real multiple, not a rounding error');

// ── the phrase gate ─────────────────────────────────────────────────────────────────────────────
const A = R.accepts;
ok(A['bought bot'] === true, 'the primary rendering of the name is accepted');
ok(A['bought bot open spotify'] === true, 'the name followed by a command is accepted');
ok(A['hey bought bot'] === true, '"hey" + the name is accepted');
ok(A['bot bot'] === true, 'the doubled rendering is accepted');
ok(A['hey but bot'] === true, '"hey but bot" is accepted — the "hey" makes it distinctive');

// The decoy. This is the whole design: a constrained grammar forces every utterance onto its nearest
// member, so removing "but bot" would push those matches onto an ACCEPTED phrase instead. It stays in
// the grammar to absorb them, and stays out of the accept list so absorbing them costs nothing.
ok(R.grammar.includes('but bot'), 'the decoy phrase is still IN the grammar, to absorb near-misses');
ok(!R.accept_list.includes('but bot'), 'and is NOT in the accept list');
ok(A['but bot'] === false, 'so a bare "but bot" no longer wakes it');

ok(A['i but bot'] === false, 'the phrase must OPEN the utterance');
ok(A['what about bought bot'] === false, 'the name mid-sentence is talking ABOUT it, not to it');
ok(A['and but bot then'] === false, 'the decoy mid-sentence is still refused');
ok(A[''] === false, 'empty input is refused');

// ── one wake word ───────────────────────────────────────────────────────────────────────────────
ok(A['jarvis'] === false && A['hey jarvis'] === false, 'Jarvis is no longer a wake word');
ok(!R.grammar.some((p) => /jarvis/.test(p)), 'and is not in the grammar at all');
ok(!R.engines.includes('oww'), 'openWakeWord (whose model IS "hey jarvis") is off by default');
ok(R.conf > 0 && R.conf < 1, 'a per-word confidence threshold is set');

// ── STRUCTURE, checked with the AST so a comment cannot satisfy it ──────────────────────────────
// The bug this replaces: RMS was computed inside `if BARGE and _tts_active`, i.e. only while BhatBot
// was speaking — so on the wake path there was no loudness measurement to threshold at all.
const astProbe = `
import ast, json
src = open(${JSON.stringify(LISTEN)}).read()
tree = ast.parse(src)
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
loop = next(n for n in ast.walk(fn) if isinstance(n, ast.While))
# statements DIRECTLY in the loop body, not nested inside any branch
direct = [ast.dump(s) for s in loop.body]
print(json.dumps({
  'rms_at_top': any("id='rms'" in d and 'Assign' in d for d in direct),
  'recent_at_top': any("attr='append'" in d and "id='recent_rms'" in d for d in direct),
  'fire_calls_loud': any(
      isinstance(n, ast.Call) and getattr(n.func, 'id', '') == 'loud_enough'
      for f in ast.walk(fn) if isinstance(f, ast.FunctionDef) and f.name == 'fire'
      for n in ast.walk(f)),
}))
`;
const S = JSON.parse(py(astProbe));
ok(S.rms_at_top, 'RMS is computed on EVERY frame, not only inside the barge-in branch');
ok(S.recent_at_top, 'and every frame feeds the rolling window the gate reads');
ok(S.fire_calls_loud, 'fire() consults the loudness gate before emitting a wake');

console.log(`\n${fail ? '❌' : '✅'} wake gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
