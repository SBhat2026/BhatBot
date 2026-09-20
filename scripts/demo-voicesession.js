#!/usr/bin/env node
'use strict';
// ── LIVE DEMO: the voice session ──────────────────────────────────────────────────────────────────
// Drives lib/voicesession.js through a real conversation and prints what the machine does, in time,
// while actually SPEAKING the butler's lines.
//
// This is the real module, not a mock of it — the same file main.js will call. What is simulated is
// the world around it: the microphone, the endpointer, and the model's reply timing. Everything
// state-related is genuine, so what you hear and see is what the wired version will do.
//
// AUDIO IS FREE. Two sources, in order:
//   1. ~/.bhatbot/voice/acks/*.mp3 — lines already rendered in the ElevenLabs JARVIS voice. Nine of
//      them exist and several are register lines verbatim, so they cost nothing to replay.
//   2. Kokoro, locally, voice `bm_george` (en-gb) — the same local TTS main.js falls back to. Also
//      free, and British, which is the point.
// No API call is made by this script. Run it with --silent to skip audio entirely.
//
//   node scripts/demo-voicesession.js              # the conversation, spoken
//   node scripts/demo-voicesession.js --silent     # the conversation, printed only
//   node scripts/demo-voicesession.js --registers  # speak every line in the register library
//   node scripts/demo-voicesession.js --fast       # no real-time pauses

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const vs = require(path.join(ROOT, 'lib', 'voicesession'));

const ARGV = process.argv.slice(2);
const SILENT = ARGV.includes('--silent');
const FAST = ARGV.includes('--fast');
const REGISTERS_ONLY = ARGV.includes('--registers');

const ACKS_DIR = path.join(os.homedir(), '.bhatbot', 'voice', 'acks');
const KOKORO_DIR = path.join(os.homedir(), '.bhatbot', 'kokoro');

// ── colour, because a state machine is much easier to read in one ────────────────────────────────
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  grey: (s) => `\x1b[90m${s}\x1b[0m`,
};
const STATE_COLOUR = {
  closed: C.grey, listening: C.cyan, thinking: C.amber, speaking: C.green,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 40) : ms));

// ── audio ─────────────────────────────────────────────────────────────────────────────────────────

const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

let ackIndex = [];
try { ackIndex = JSON.parse(fs.readFileSync(path.join(ACKS_DIR, 'index.json'), 'utf8')); } catch {}

/** An already-rendered ElevenLabs clip for this exact line, if one exists. */
function prerendered(text) {
  const want = slug(text);
  const hit = ackIndex.find((a) => slug(a.text) === want);
  if (!hit) return null;
  const f = path.join(ACKS_DIR, `${hit.slug}.mp3`);
  return fs.existsSync(f) ? f : null;
}

// Kokoro, kept warm across the demo so each line does not pay the ~1.2s model load.
let kok = null, kokBuf = '', kokId = 1;
const kokPending = new Map();

function resolvePython() {
  for (const p of ['python3', '/opt/homebrew/bin/python3']) {
    try {
      const r = spawnSync(p, ['-c', 'import kokoro_onnx'], { timeout: 8000 });
      if (r.status === 0) return p;
    } catch {}
  }
  return null;
}

function kokoroStart() {
  if (kok) return kok;
  const py = resolvePython();
  if (!py || !fs.existsSync(path.join(KOKORO_DIR, 'kokoro-v1.0.onnx'))) return (kok = Promise.resolve(null));
  kok = new Promise((resolve) => {
    const proc = spawn(py, [path.join(ROOT, 'scripts', 'kokoro_worker.py'), KOKORO_DIR]);
    let settled = false;
    proc.stderr.on('data', () => {});
    proc.stdout.on('data', (d) => {
      kokBuf += d.toString();
      let nl;
      while ((nl = kokBuf.indexOf('\n')) >= 0) {
        const line = kokBuf.slice(0, nl).trim(); kokBuf = kokBuf.slice(nl + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.ready && !settled) { settled = true; resolve(proc); continue; }
        if (m.fatal && !settled) { settled = true; resolve(null); continue; }
        const p = kokPending.get(m.id);
        if (p) { kokPending.delete(m.id); p(m); }
      }
    });
    proc.on('error', () => { if (!settled) { settled = true; resolve(null); } });
    proc.on('close', () => { for (const [, p] of kokPending) p({ error: 'worker exited' }); kokPending.clear(); });
    setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 30000);
  });
  return kok;
}

async function kokoroSay(text) {
  const proc = await kokoroStart();
  if (!proc) return null;
  const id = kokId++;
  const wav = await new Promise((resolve) => {
    kokPending.set(id, (m) => resolve(m.path || null));
    // bm_george / en-gb: the British male voice, which is the whole reason this is the local
    // fallback rather than a generic one.
    proc.stdin.write(JSON.stringify({ id, text, voice: 'bm_george', speed: 1.02, lang: 'en-gb' }) + '\n');
    setTimeout(() => { if (kokPending.delete(id)) resolve(null); }, 25000);
  });
  return wav;
}

function play(file) {
  return new Promise((resolve) => {
    // afplay is the macOS built-in. Never `say` — a second, wrong voice is exactly the rogue-voice
    // bug lib/static-prompt.js and main.js both warn about.
    const p = spawn('afplay', [file], { stdio: 'ignore' });
    p.on('close', resolve);
    p.on('error', resolve);
  });
}

let usedPrerendered = 0, usedKokoro = 0, usedNothing = 0;

async function utter(text) {
  if (SILENT) { usedNothing++; return 'silent'; }
  const clip = prerendered(text);
  if (clip) { usedPrerendered++; await play(clip); return 'elevenlabs (pre-rendered)'; }
  const wav = await kokoroSay(text);
  if (wav) { usedKokoro++; await play(wav); try { fs.unlinkSync(wav); } catch {} return 'kokoro bm_george'; }
  usedNothing++;
  return 'no audio available';
}

// ── the rig ───────────────────────────────────────────────────────────────────────────────────────

let t0 = Date.now();
const stamp = () => C.grey(`${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s`);

const speakQueue = [];
const session = vs.createVoiceSession({
  now: () => Date.now(),
  stopPlayback: () => console.log(`${stamp()}  ${C.red('✂  playback killed')}`),
  setWakeMute: (on) => console.log(`${stamp()}  ${C.grey(`wake-word self-mute ${on ? 'ON' : 'off'}`)}`),
  setWakeRequired: (on) => console.log(`${stamp()}  ${on ? C.amber('🔒 wake word REQUIRED again') : C.green('🔓 wake word no longer needed — session is open')}`),
  speak: (text, o) => speakQueue.push({ text, kind: o && o.kind }),
  onState: (from, to, why) => {
    const col = STATE_COLOUR[to] || ((s) => s);
    console.log(`${stamp()}  ${C.grey(from.padEnd(9))}→ ${col(C.bold(to.padEnd(9)))} ${C.grey(why)}`);
  },
});

/** Drain whatever the machine decided to say, and actually say it. */
async function drain() {
  while (speakQueue.length) {
    const { text, kind } = speakQueue.shift();
    process.stdout.write(`${stamp()}  ${C.green('🔊')} ${C.bold(`"${text}"`)} ${C.grey(`[${kind}]`)} `);
    const via = await utter(text);
    console.log(C.grey(`· ${via}`));
  }
}

function user(text) { console.log(`${stamp()}  ${C.cyan('🎙  you:')} ${text}`); }
function note(text) { console.log(`${stamp()}  ${C.grey('·  ' + text)}`); }
function reply(text) { console.log(`${stamp()}  ${C.grey('   reply: ' + text)}`); }

/** One ordinary exchange, with realistic timing. */
async function exchange({ said, replyText, thinkMs = 900, speakMs = 1400, work = false, ack = false }) {
  user(said);
  session.speechStart({ ms: 600 });
  await sleep(250);
  session.endpoint({ text: said });
  // An action that will take a beat gets acknowledged before the work starts, rather than leaving a
  // silence. These are the lines that are already rendered in the ElevenLabs voice, so this is also
  // where the demo stops being Kokoro and starts being the real one.
  if (ack) session.say('ack');
  await drain();
  await sleep(thinkMs);
  session.firstAudio();
  reply(replyText);
  await sleep(speakMs);
  if (work) session.noteWork(true);
  session.noteReply(replyText);
  session.ttsIdle();
  await drain();
}

// ── the script ────────────────────────────────────────────────────────────────────────────────────

async function conversation() {
  console.log(C.bold('\n  BhatBot — voice session, live\n'));
  console.log(C.grey('  The state machine is real (lib/voicesession.js). The microphone, the endpointer'));
  console.log(C.grey('  and the model timing are simulated. Audio is pre-rendered ElevenLabs where a clip'));
  console.log(C.grey('  exists, Kokoro bm_george otherwise. No API call is made.\n'));
  console.log(C.grey('  ' + '─'.repeat(74)));

  t0 = Date.now();

  // 1. Wake word opens it. This is the ONLY time it is needed.
  note('wake word heard — "Jarvis"');
  session.open({ via: 'wake' });
  await drain();

  // 2. An ordinary exchange. No wake word.
  await exchange({ said: 'what is on my calendar tomorrow', replyText: 'Two things, sir. A webinar at ten, and nothing else that deserves the name.' });

  // 3. Another — still no wake word. This is the felt difference.
  await exchange({
    said: 'move the webinar to the afternoon', work: true, ack: true, thinkMs: 1500,
    replyText: 'Moved to two o\'clock. I have not told anyone yet; say the word.',
  });

  // 3b. A second action, so the pre-rendered library gets a proper airing.
  await exchange({
    said: 'and put the standings on the second screen', work: true, ack: true, thinkMs: 1400,
    replyText: 'Up. Argentina still top, if you were wondering.',
  });

  // 4. He starts a long answer and you cut him off.
  console.log(C.grey('\n  ─ barge-in ' + '─'.repeat(27)));
  user('tell me everything about the fleet architecture');
  session.speechStart({ ms: 700 });
  await sleep(200);
  session.endpoint({ text: 'tell me everything about the fleet architecture' });
  await drain();
  await sleep(700);
  session.firstAudio();
  reply('The fleet runs scoped drones against a shared blackboard, each with its own budget envelope, and the admission ledger paces them against the live rate window so that—');
  await sleep(1600);
  user('— no, just the short version');
  session.speechStart({ ms: 620 });          // over the top → barge-in
  await drain();
  await sleep(200);
  session.endpoint({ text: 'just the short version' });
  await sleep(600);
  session.firstAudio();
  reply('Several agents, one shared notepad, one budget. That is the whole of it.');
  await sleep(1100);
  session.ttsIdle();
  await drain();

  // 5. A cough does not cut him off.
  console.log(C.grey('\n  ─ a cough is not an interruption ' + '─'.repeat(5)));
  user('what did I spend on the API today');
  session.speechStart({ ms: 500 });
  await sleep(200);
  session.endpoint({ text: 'what did I spend on the API today' });
  await sleep(700);
  session.firstAudio();
  reply('Four cents, sir. The worker has been unusually well behaved.');
  await sleep(500);
  note('*cough* (90ms of noise)');
  const cough = session.speechStart({ ms: 90 });
  console.log(`${stamp()}  ${C.grey(`ignored — ${cough.reason}; still ${STATE_COLOUR.speaking('speaking')}`)}`);
  await sleep(800);
  session.ttsIdle();
  await drain();

  // 6. Silence — nudge, then close.
  console.log(C.grey('\n  ─ you wander off ' + '─'.repeat(21)));
  note('(silence)');
  const s = session.status();
  // Re-run the idle logic against a fake future rather than waiting two real minutes.
  const future = Date.now() + 80000;
  const nudged = session.tick(future);
  if (nudged) { console.log(`${stamp()}  ${C.grey(`after ${Math.round(nudged.quiet / 1000)}s quiet → ${nudged.action}`)}`); await drain(); }
  const closed = session.tick(Date.now() + 130000);
  if (closed) console.log(`${stamp()}  ${C.grey(`after ${Math.round(closed.quiet / 1000)}s quiet → ${closed.action}`)}`);
  await drain();

  console.log(C.grey('\n  ' + '─'.repeat(74)));
  console.log(`\n  ${C.bold('state')}      ${STATE_COLOUR[session.state()](session.state())}`);
  console.log(`  ${C.bold('audio')}      ${usedPrerendered} pre-rendered · ${usedKokoro} kokoro · ${usedNothing} silent`);
  console.log(`  ${C.bold('cost')}       ${C.green('$0.00')} ${C.grey('— nothing left the machine')}`);
  console.log(`\n  ${C.grey('The wake word was needed once, at the very top, and never again.')}`);
  console.log(`  ${C.grey('The timeout closed in silence — there was nobody left to sign off to.')}\n`);
}

async function registers() {
  console.log(C.bold('\n  The register library — every line the butler has for a moment in a conversation\n'));
  for (const [kind, lines] of Object.entries(vs.REGISTERS)) {
    console.log(`  ${C.amber(kind)}`);
    for (const l of lines) {
      process.stdout.write(`    ${C.bold(`"${l}"`)} `);
      const via = await utter(l);
      console.log(C.grey(`· ${via}`));
    }
    console.log('');
  }
  console.log(`  ${C.bold('audio')}  ${usedPrerendered} pre-rendered · ${usedKokoro} kokoro · ${usedNothing} silent   ${C.bold('cost')} ${C.green('$0.00')}\n`);
}

(async () => {
  try {
    if (REGISTERS_ONLY) await registers();
    else await conversation();
  } catch (e) {
    console.error(C.red('demo failed: ' + (e && e.stack || e)));
    process.exitCode = 1;
  } finally {
    const proc = await kok;
    if (proc) { try { proc.stdin.end(); proc.kill(); } catch {} }
  }
})();
