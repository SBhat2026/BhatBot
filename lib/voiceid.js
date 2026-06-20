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

async function enroll(samplePaths = []) { return run('enroll.py', samplePaths, 300000); }
async function verify(clipPath) { if (!isEnrolled()) return { ok: false, error: 'not enrolled' }; return run('verify.py', [clipPath], 120000); }

module.exports = { ready, isEnrolled, enroll, verify, PROFILE };
