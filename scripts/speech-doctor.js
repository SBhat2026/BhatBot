#!/usr/bin/env node
'use strict';
// ── DOES BHATBOT ACTUALLY SAY WHAT IT MEANS TO SAY? ───────────────────────────────────────────────
// Synthesizes lines through the REAL local TTS and transcribes them back through the REAL local STT,
// then compares. No human in the loop, no cloud key, nothing mocked at either end.
//
// This exists because "did he speak, and what did he say" had exactly one instrument: asking
// Siddhant. That is a slow, expensive oracle, and it is the reason the broken phone calls took three
// rounds to diagnose — every layer I COULD inspect reported success.
//
//   npm run speech:doctor              # the standard battery
//   npm run speech:doctor -- "text"    # audit one specific line
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { audit } = require(path.join(ROOT, 'lib', 'speechaudit'));
const localstt = require(path.join(ROOT, 'lib', 'localstt'));
const speech = require(path.join(ROOT, 'lib', 'speech'));

// TEST THE PIPELINE, NOT A PIECE OF IT. The first run of this harness fed raw text straight to the
// TTS worker and reported that markdown gets pronounced — which was true of the worker and false of
// BhatBot, because the app normalises first. A check that skips a stage does not find bugs, it
// invents them. This is the stage every synthesis path goes through.
const asApp = (t) => speech.forSpeech(t);

const KDIR = path.join(os.homedir(), '.bhatbot', 'kokoro');
const PY = fs.existsSync(path.join(os.homedir(), '.bhatbot', 'kokoro-venv', 'bin', 'python'))
  ? path.join(os.homedir(), '.bhatbot', 'kokoro-venv', 'bin', 'python')
  : require(path.join(ROOT, 'lib', 'pythonbin')).resolve({ requires: 'kokoro_onnx' }).bin;

// One warm worker for the whole battery — the model load is ~1.2s and paying it per line would make
// the suite slow enough that nobody runs it, which is the failure mode of every check like this.
function startTts() {
  const proc = spawn(PY, [path.join(ROOT, 'scripts', 'kokoro_worker.py'), KDIR], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '', id = 0, fatal = null;
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try { const j = JSON.parse(line); const r = pending.get(j.id); if (r) { pending.delete(j.id); r(j); } } catch {}
    }
  });
  proc.stderr.on('data', (d) => { const t = d.toString(); if (/Traceback|ModuleNotFound/.test(t)) fatal = t.trim().split('\n').pop(); });
  proc.on('exit', () => { for (const [, r] of pending) r({ error: fatal || 'tts worker exited' }); pending.clear(); });
  return {
    speak: (text) => new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      try { proc.stdin.write(JSON.stringify({ id: n, text, voice: 'bm_george', speed: 1.0, lang: 'en-gb' }) + '\n'); }
      catch (e) { pending.delete(n); res({ error: e.message }); }
      setTimeout(() => { if (pending.has(n)) { pending.delete(n); res({ error: 'tts timeout' }); } }, 60000);
    }),
    stop: () => { try { proc.kill(); } catch {} },
    get fatal() { return fatal; },
  };
}

// The battery. Each line targets a failure mode that IS invisible from the string alone.
const CASES = [
  { name: 'a plain sentence', text: 'Good afternoon, sir. The fleet is back.' },
  // SSML is the app's own wrapper. If it leaks, the listener hears "speak" and "slash speak".
  { name: 'SSML does not get read aloud', text: '<speak>Triage archived four things.</speak>' },
  // Markdown reaches speech whenever a model answer is spoken verbatim.
  // Markdown reaches speech whenever a model answer is spoken verbatim. lib/speech handles emphasis;
  // this proves it rather than assuming it.
  { name: 'markdown is not pronounced', text: 'Three accounts connected — siddhantbhat3, and two more.' },
  // Numbers and units are where TTS most often diverges from the text.
  { name: 'numbers and units survive', text: 'It is 58 degrees with 89 percent humidity.' },
  // Long lines are where truncation hides.
  { name: 'a long line is not truncated', text: 'The morning brief is ready: three accounts checked, nothing urgent in any of them, one interesting paper about enzyme design, and no errors to report anywhere.' },
];

(async () => {
  console.log('\n── speech doctor ' + '─'.repeat(56));
  console.log(`  tts: kokoro (${path.basename(PY)})`);
  console.log(`  stt: ${localstt.available() ? localstt.DEFAULT_MODEL + ' (local, offline)' : 'UNAVAILABLE — run scripts/whisper-setup.sh'}`);
  if (!localstt.available()) { console.log('\n  Cannot audit speech without an STT. Nothing was tested.\n'); process.exit(2); }

  const tts = startTts();
  const transcribe = async (p) => {
    const r = await localstt.transcribe(fs.readFileSync(p), 'wav', {});
    return { text: (r && r.text) || '' };
  };

  const argLine = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const cases = argLine ? [{ name: 'custom', text: argLine }] : CASES;

  let failed = 0;
  for (const c of cases) {
    const r = await audit({ text: c.text, synthesize: (t) => tts.speak(asApp(t)), transcribe });
    const mark = r.ok ? '✓' : '✗';
    console.log(`\n  ${mark} ${c.name}`);
    console.log(`      meant : ${c.text.slice(0, 96)}`);
    console.log(`      heard : ${String(r.heard || '(nothing)').slice(0, 96)}`);
    console.log(`      ${r.stage}${r.score != null ? ` · ${(r.score * 100).toFixed(0)}% match` : ''}${r.bytes ? ` · ${r.bytes}B` : ''} — ${r.detail}`);
    if (!r.ok) failed++;
  }
  tts.stop();
  console.log(`\n  ${cases.length - failed}/${cases.length} lines came back as meant\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
