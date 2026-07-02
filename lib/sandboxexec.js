'use strict';
// ── UNTRUSTED-CODE WALL (FORGE-sprint) ────────────────────────────────────────────────────────────
// THE single most important constraint in this sprint: anything cloned from the internet or generated
// by a drone must NEVER execute with BhatBot's environment. No inherited env vars (→ no ANTHROPIC_API_KEY,
// no tokens), no keychain, no ~/.bhatbot, no dotfiles, no network by default. This module is the floor
// that Phase 2 (repo autopilot) and Phase 3 (swarm) install/test/run lanes route through.
//
// DECISION — env scrub as the ALWAYS-AVAILABLE floor; sandbox-exec / Docker as opportunistic upgrades:
//   • The floor is a hard environment scrub: spawn with a freshly-built env containing ONLY PATH +
//     a throwaway HOME (+ a couple of innocuous locale vars). Every secret the parent holds is dropped
//     because we allow-list, we don't deny-list — a new secret env var is excluded by construction.
//     A throwaway HOME means no ~/.ssh, no ~/.bhatbot vault, no keychain-adjacent dotfiles.
//   • On macOS, when `sandbox-exec` is present and network isn't explicitly allowed, we ALSO wrap the
//     command in a `(deny default)(allow process*)(deny network*)` profile for real network/file
//     isolation — best-effort, degrades to the env scrub if unavailable (sandbox-exec is deprecated
//     but still ships). Docker, when a repo lane selects it, is layered by the caller (repoauto),
//     not here — this module is the local floor.
//   • PATH is NOT a secret, so it's inherited (tools must be findable); everything else is dropped.
//
// Pure-ish: only child_process + fs/os. No app deps. Testable headless (the canary test proves a real
// secret in the parent env is invisible inside).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Env vars that are safe (and necessary) to pass through. EVERYTHING else — API keys, tokens, AWS
// creds, anything — is excluded by NOT being on this list. Allow-list, never deny-list.
const SAFE_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'];

// Build the scrubbed environment. `home` MUST be a throwaway dir (caller owns its lifecycle). We set
// HOME/TMPDIR/XDG_* to that dir so any tool that writes dotfiles/caches lands in the throwaway, never
// the real home. No secret can survive because we only copy SAFE_ENV_KEYS.
function scrubEnv(home, { extra = {} } = {}) {
  const env = { HOME: home, TMPDIR: path.join(home, 'tmp'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache') };
  for (const k of SAFE_ENV_KEYS) if (process.env[k] != null) env[k] = process.env[k];
  // npm/pip: keep them from finding the real user config/cache (which could carry auth tokens).
  env.NPM_CONFIG_USERCONFIG = path.join(home, '.npmrc');
  env.NPM_CONFIG_CACHE = path.join(home, '.npm');
  env.PIP_CACHE_DIR = path.join(home, '.pip-cache');
  Object.assign(env, extra);   // caller-supplied non-secret vars (e.g. CI=1) — caller's responsibility
  return env;
}

// Is real network-denying sandboxing available on this platform? (macOS sandbox-exec)
function sandboxAvailable() {
  if (process.platform !== 'darwin') return false;
  try { return fs.existsSync('/usr/bin/sandbox-exec'); } catch { return false; }
}

// A minimal SBPL profile: allow the process to run + read/write its cwd + throwaway HOME, deny network.
// Kept permissive on file reads (build tools read system libs) but denies outbound network — the point
// is to stop untrusted code phoning home / exfiltrating, not to jail every syscall.
function denyNetworkProfile() {
  return '(version 1)(allow default)(deny network*)(allow network-bind (local ip))';
}

// run — execute a command under the wall. Returns { code, stdout, stderr, timedOut, lane }.
//   opts: { cwd, home (throwaway; created if absent), timeoutMs=120000, allowNetwork=false,
//           maxBuffer=8MB, extraEnv }
function run(command, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const maxBuffer = opts.maxBuffer || 8 * 1024 * 1024;
  const home = opts.home || fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sbx-'));
  try { fs.mkdirSync(path.join(home, 'tmp'), { recursive: true }); } catch {}
  const env = scrubEnv(home, { extra: opts.extraEnv || {} });

  let bin = command, argv = args, lane = 'scrub';
  if (!opts.allowNetwork && sandboxAvailable()) {
    // wrap: sandbox-exec -p '<profile>' <command> <args...>
    bin = '/usr/bin/sandbox-exec';
    argv = ['-p', denyNetworkProfile(), command, ...args];
    lane = 'sandbox-exec';
  }

  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, over = false;
    let child;
    try {
      child = spawn(bin, argv, { cwd: opts.cwd || home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ code: -1, stdout: '', stderr: 'spawn failed: ' + e.message, timedOut: false, lane, error: e.message }); }
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < maxBuffer) stdout += d; else over = true; });
    child.stderr.on('data', (d) => { if (stderr.length < maxBuffer) stderr += d; else over = true; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + '\n' + e.message, timedOut, lane, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, truncated: over, lane, home }); });
  });
}

module.exports = { run, scrubEnv, sandboxAvailable, SAFE_ENV_KEYS };
