'use strict';
// ── DOCKER adapter (FORGE / Phase 2 preferred repo lane) ──────────────────────────────────────────
// Runs a cloned repo's install/test/build inside a container — a STRONGER isolation lane layered on
// the untrusted-code wall (lib/sandboxexec.js), auto-selected by repoauto when the daemon is present.
// A container gives real filesystem + network + memory isolation with clean teardown (`--rm`).
//
// DECISION — thin wrapper over the docker CLI (not dockerode): zero npm dep, matches the codebase's
// "shell out + probe" convention, and the CLI is the stable surface. Everything probes first and
// DEGRADES: no daemon → available()=false and repoauto falls back to the sandbox floor with a note.
//
// Pure-ish (child_process only); DI for the runner is unnecessary — it's the docker binary. Headless-
// safe: the test only calls available() (never requires Docker to be installed).
const { spawn, execFile } = require('child_process');

function available(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const p = execFile('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: timeoutMs }, (err, stdout) => {
      resolve(!err && !!String(stdout || '').trim());
    });
    p.on('error', () => resolve(false));
  });
}

// run — one containerized command. opts:
//   { image, mount (host dir → /w), cmd (array or string), workdir='/w', memory='4g', cpus='2',
//     network='bridge'|'none', timeoutMs=600000, env={} (NON-secret only), platform }
// Returns { code, stdout, stderr, timedOut, image }. Never inherits BhatBot's env — only `env` (which
// the caller must keep secret-free; the wall's discipline applies to containers too).
function run(opts = {}) {
  const { image, mount, workdir = '/w', memory = '4g', cpus = '2', network = 'bridge', timeoutMs = 600000, platform } = opts;
  if (!image) return Promise.resolve({ code: -1, stderr: 'docker.run: image required' });
  const args = ['run', '--rm', `--memory=${memory}`, `--cpus=${cpus}`, `--network=${network}`, '-w', workdir];
  if (mount) args.push('-v', `${mount}:/w`);
  if (platform) args.push('--platform', platform);
  for (const [k, v] of Object.entries(opts.env || {})) args.push('-e', `${k}=${v}`);
  args.push(image);
  const cmd = Array.isArray(opts.cmd) ? opts.cmd : (opts.cmd ? ['sh', '-lc', String(opts.cmd)] : []);
  args.push(...cmd);
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false;
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    const cap = 8 * 1024 * 1024;
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + '\n' + e.message, timedOut, image, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, image }); });
  });
}

// Per-stack base image guess for repoauto (kept small + current-ish; caller can override).
function baseImageFor(stack) {
  return ({ node: 'node:24-slim', python: 'python:3.13-slim', rust: 'rust:1-slim', go: 'golang:1-alpine' })[stack] || 'debian:stable-slim';
}

// install-hint surfaced when the daemon is absent.
const INSTALL_HINT = 'Docker not running. Install Docker Desktop (https://docker.com) or `brew install --cask docker`, then launch it. BhatBot will use the container lane automatically once `docker info` responds; until then it uses the scrubbed-subprocess sandbox floor.';

module.exports = { available, run, baseImageFor, INSTALL_HINT };
