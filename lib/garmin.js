'use strict';
// lib/garmin.js — node side of the Garmin link. Spawns the Python worker (~/.bhatbot/garmin-venv,
// scripts/garmin_worker.py) which uses garminconnect 0.3.x (the same library the eddmann
// garmin-connect-mcp wraps). BhatBot has no MCP *client*, so this native worker is the
// codebase-consistent path (mirrors lib/simulate.js → sim-venv). Credentials never reach the model:
// the email comes from config.garmin.email and the password from the macOS Keychain (injected
// keychainRead), used only for a one-time login; thereafter cached OAuth tokens are reused.
//
// Pulls are cached to ~/.bhatbot/health/history.jsonl (one normalized row per sync) so the proactive
// monitor + the trend analysis (lib/health.js) work offline and the panel renders instantly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = path.join(os.homedir(), '.bhatbot');
const VENV_PY = path.join(HOME, 'garmin-venv', 'bin', 'python');
const TOKENS = path.join(HOME, 'garmin', 'tokens');
const HEALTH_DIR = path.join(HOME, 'health');
const HISTORY = path.join(HEALTH_DIR, 'history.jsonl');
const WORKER = path.join(__dirname, '..', 'scripts', 'garmin_worker.py');

function venvReady() { try { return fs.existsSync(VENV_PY); } catch { return false; } }
function tokensExist() { try { return fs.readdirSync(TOKENS).length > 0; } catch { return false; } }
// available = the venv is set up AND we have cached tokens (i.e. garmin-setup.sh was run).
function available() { return venvReady() && tokensExist(); }

// Run one worker request → resolved JSON. Never throws (returns {ok:false,error}).
function run(req, timeoutMs = 60000) {
  return new Promise((resolve) => {
    if (!venvReady()) return resolve({ ok: false, error: 'garmin-venv missing — run scripts/garmin-setup.sh' });
    let out = '', err = '';
    let done = false;
    const finish = (o) => { if (!done) { done = true; resolve(o); } };
    let proc;
    try { proc = spawn(VENV_PY, [WORKER, JSON.stringify(req)], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return finish({ ok: false, error: 'spawn failed: ' + e.message }); }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish({ ok: false, error: 'garmin worker timeout' }); }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', () => { clearTimeout(timer); try { finish(JSON.parse(out.trim() || '{}')); } catch { finish({ ok: false, error: (err || out || 'no output').slice(0, 200) }); } });
    proc.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
  });
}

// Credentials for a (one-time) login. keychainRead(service, account) is injected by main.js.
function creds(loadConfig, keychainRead) {
  const c = (loadConfig && loadConfig()) || {};
  const email = (c.garmin && c.garmin.email) || '';
  let password = '';
  try { if (email && keychainRead) { const r = keychainRead('bhatbot-garmin', email); password = (r && (r.password || r.secret || r)) || ''; } } catch {}
  return { email, password };
}

async function login(loadConfig, keychainRead, mfa) {
  const { email, password } = creds(loadConfig, keychainRead);
  if (!email) return { ok: false, error: 'no garmin email in config.garmin.email' };
  return run({ action: 'login', email, password, mfa }, 90000);
}

function readHistory(n = 120) {
  try {
    return fs.readFileSync(HISTORY, 'utf8').trim().split('\n').slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function latest() { const h = readHistory(2); return h.length ? h[h.length - 1] : null; }

// Pull today's biometrics (+ recent activities), append a normalized row to history.jsonl, return it.
// authRefresh creds are only needed if tokens expired; passed through so a stale-token pull can re-auth.
async function sync(loadConfig, keychainRead, { activities = 3 } = {}) {
  const { email, password } = creds(loadConfig, keychainRead);
  const r = await run({ action: 'daily', email, password }, 90000);
  if (!r || !r.ok || !r.daily) return { ok: false, error: (r && r.error) || 'no data', needsSetup: !available() };
  const row = { ...r.daily, synced_at: new Date().toISOString() };
  let acts = [];
  try { const a = await run({ action: 'activities', email, password, limit: activities }, 60000); if (a && a.ok) acts = a.activities || []; } catch {}
  row.activities = acts;
  try { fs.mkdirSync(HEALTH_DIR, { recursive: true }); fs.appendFileSync(HISTORY, JSON.stringify(row) + '\n'); } catch {}
  return { ok: true, daily: row };
}

async function status(loadConfig, keychainRead) {
  if (!venvReady()) return { ok: false, configured: false, reason: 'garmin-venv not set up — run scripts/garmin-setup.sh' };
  if (!tokensExist()) return { ok: false, configured: false, reason: 'not logged in — run scripts/garmin-setup.sh (one-time, handles MFA)' };
  const { email, password } = creds(loadConfig, keychainRead);
  const r = await run({ action: 'status', email, password }, 45000);
  return { ok: !!(r && r.ok), configured: true, name: r && r.name, error: r && r.error, last_sync: (latest() || {}).synced_at || null };
}

module.exports = { available, venvReady, tokensExist, run, creds, login, sync, status, readHistory, latest, HISTORY, HEALTH_DIR, TOKENS, VENV_PY };
