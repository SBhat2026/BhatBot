'use strict';
// Speaker verification wrapper — shells out to the isolated voiceid venv (resemblyzer d-vectors).
// Lets BhatBot answer "is this really Siddhant speaking?" from an audio clip, as an auth factor
// that augments the spoken command-mode passphrase. Degrades gracefully: every call returns a
// plain object and never throws, so callers don't need to guard on the venv being installed.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, '..', 'scripts', 'voiceid');
const VENV = process.env.BHATBOT_VOICEID_VENV || path.join(os.homedir(), '.bhatbot', 'voiceid-venv');
const PY = path.join(VENV, 'bin', 'python');
const PROFILE = path.join(os.homedir(), '.bhatbot', 'voiceid', 'owner.json');

function ready() { return fs.existsSync(PY); }
function isEnrolled() { return fs.existsSync(PROFILE); }

function run(script, args, timeoutMs) {
  return new Promise((resolve) => {
    if (!ready()) return resolve({ ok: false, error: 'voiceid venv missing — run scripts/voiceid/setup.sh' });
    const p = spawn(PY, [path.join(DIR, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve({ ok: false, error: 'voiceid timeout' }); }, timeoutMs || 120000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => { clearTimeout(t); const line = out.trim().split('\n').filter(Boolean).pop() || ''; try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: err.slice(0, 300) || 'no json from voiceid' }); } });
    p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
  });
}

// ── THE RESIDENT DAEMON ────────────────────────────────────────────────────────────────────────
//
// `run('verify.py')` imports torch and builds the encoder on every call: 1.7 s warm, 5.8 s cold, per
// utterance, measured on the M5 — and main.js awaited it AFTER speech-to-text, so every single thing
// said to BhatBot waited that long before its words reached the model. The load is the entire cost;
// the embedding is ~50 ms. scripts/voiceid/server.py loads once and answers over stdin/stdout.
//
// One process, lazily started, restarted on death, and NEVER the only road: any failure falls back to
// the one-shot script, which is slow and correct. A speed-up that can turn "is this Siddhant" into an
// exception is not a speed-up.
let _d = null;               // { proc, pending: Map<id,{resolve,timer}>, buf, ready: Promise<boolean> }
let _nextId = 1, _starts = 0, _lastStartAt = 0;

function daemon() {
  if (_d && _d.proc && _d.proc.exitCode === null && !_d.dead) return _d;
  if (!ready()) return null;
  // A daemon that dies on launch must not be respawned on every utterance: three quick deaths and it
  // rests for a minute, during which the one-shot path carries the load.
  const now = Date.now();
  if (now - _lastStartAt < 60000 && _starts >= 3) return null;
  if (now - _lastStartAt >= 60000) _starts = 0;
  _starts++; _lastStartAt = now;

  const proc = spawn(PY, [path.join(DIR, 'server.py')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, BHATBOT_VOICEID_PROFILE: PROFILE } });
  const d = { proc, pending: new Map(), buf: '', dead: false, ready: null };
  let readyResolve; d.ready = new Promise((r) => { readyResolve = r; });
  const die = () => {
    if (d.dead) return; d.dead = true;
    for (const [, p] of d.pending) { clearTimeout(p.timer); p.resolve(null); }   // null → caller falls back
    d.pending.clear(); readyResolve(false);
    if (_d === d) _d = null;
  };
  proc.stdout.on('data', (chunk) => {
    d.buf += chunk;
    let i;
    while ((i = d.buf.indexOf('\n')) >= 0) {
      const line = d.buf.slice(0, i).trim(); d.buf = d.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === null || msg.id === undefined) { if (msg.fatal) die(); else if (msg.ready) readyResolve(true); continue; }
      const p = d.pending.get(msg.id);
      if (p) { clearTimeout(p.timer); d.pending.delete(msg.id); p.resolve(msg); }
    }
  });
  proc.on('error', die); proc.on('close', die);
  if (proc.stdin) proc.stdin.on('error', () => {});
  if (proc.unref) proc.unref();
  _d = d;
  return d;
}

function ask(op, extra, timeoutMs) {
  const d = daemon();
  if (!d) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = _nextId++;
    const timer = setTimeout(() => { d.pending.delete(id); resolve(null); }, timeoutMs || 8000);
    d.pending.set(id, { resolve, timer });
    try { d.proc.stdin.write(JSON.stringify({ id, op, ...(extra || {}) }) + '\n'); }
    catch { clearTimeout(timer); d.pending.delete(id); resolve(null); }
  });
}

/** Start the daemon and pay its model load now, so the first real utterance does not. */
async function warm() {
  const d = daemon();
  if (!d) return false;
  const ok = await Promise.race([d.ready, new Promise((r) => setTimeout(() => r(false), 30000))]);
  return !!ok;
}
function stop() { if (_d && _d.proc) { try { _d.proc.kill(); } catch {} } _d = null; }

async function enroll(samplePaths = []) { return run('enroll.py', samplePaths, 300000); }
async function verify(clipPath) {
  if (!isEnrolled()) return { ok: false, error: 'not enrolled' };
  const fast = await ask('verify', { clip: clipPath }, 8000);
  if (fast && fast.ok) return { ...fast, via: 'daemon' };
  const slow = await run('verify.py', [clipPath], 120000);
  return slow && typeof slow === 'object' ? { ...slow, via: 'oneshot' } : slow;
}

module.exports = { ready, isEnrolled, enroll, verify, warm, stop, PROFILE };
