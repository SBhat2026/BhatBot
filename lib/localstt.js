'use strict';
// lib/localstt.js — node side of the OFFLINE speech-to-text fallback. Spawns the mlx-whisper worker
// (~/.bhatbot/mlx-venv, scripts/whisper_worker.py) so voice transcription works with NO cloud key, or
// when the cloud STT call fails. Mirrors lib/garmin.js / lib/simulate.js (venv-worker pattern).
// Apple-Silicon only (mlx). transcribeAudio() in main.js calls this; both desktop + phone benefit.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = path.join(os.homedir(), '.bhatbot');
const VENV = path.join(HOME, 'mlx-venv');
const VENV_PY = path.join(VENV, 'bin', 'python');
const WORKER = path.join(__dirname, '..', 'scripts', 'whisper_worker.py');
const DEFAULT_MODEL = 'mlx-community/whisper-base.en-mlx';

// Ready = the venv python + worker exist AND mlx_whisper is installed in the venv. Cheap fs checks
// (no python spawn) so it's safe to call from getVoiceConfig on every voice arm.
function venvReady() {
  try {
    if (!fs.existsSync(VENV_PY) || !fs.existsSync(WORKER)) return false;
    const lib = path.join(VENV, 'lib');
    if (!fs.existsSync(lib)) return false;
    const py = fs.readdirSync(lib).find((d) => d.startsWith('python'));
    if (!py) return false;
    return fs.existsSync(path.join(lib, py, 'site-packages', 'mlx_whisper'));
  } catch { return false; }
}
function available() { return process.platform === 'darwin' && venvReady(); }

// Transcribe a raw audio buffer. Writes a temp file (the worker's ffmpeg decodes any container),
// spawns the worker, resolves { text } or { error }. execPath = a PATH string that includes ffmpeg.
function transcribe(buf, ext, opts = {}) {
  const { model, prompt, language, execPath, timeoutMs = 120000 } = opts;
  return new Promise((resolve) => {
    if (!available()) return resolve({ error: 'local STT not set up (run scripts/whisper-setup.sh)' });
    let tmp;
    try {
      tmp = path.join(os.tmpdir(), 'bhatbot-stt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + (ext || 'webm'));
      fs.writeFileSync(tmp, buf);
    } catch (e) { return resolve({ error: 'temp write failed: ' + e.message }); }
    const reqJson = JSON.stringify({ audio_path: tmp, model: model || DEFAULT_MODEL, prompt, language });
    const env = { ...process.env };
    if (execPath) env.PATH = execPath;
    let so = '', se = '', done = false;
    const finish = (o) => { if (done) return; done = true; try { fs.unlinkSync(tmp); } catch {} resolve(o); };
    let p;
    try { p = spawn(VENV_PY, [WORKER, reqJson], { env }); }
    catch (e) { return finish({ error: 'spawn failed: ' + e.message }); }
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish({ error: 'local STT timed out' }); }, timeoutMs);
    p.stdout.on('data', (d) => { so += d; });
    p.stderr.on('data', (d) => { se += d; });
    p.on('error', (e) => { clearTimeout(killer); finish({ error: e.message }); });
    p.on('close', () => {
      clearTimeout(killer);
      let j; try { j = JSON.parse((so || '').trim() || '{}'); } catch { j = { error: 'bad worker output: ' + (se || so).slice(0, 200) }; }
      finish(j);
    });
  });
}

module.exports = { available, venvReady, transcribe, VENV_PY, WORKER, DEFAULT_MODEL };
