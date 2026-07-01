#!/usr/bin/env node
'use strict';
// bhat-monitor — read-only observability for a self-drive (or any) session. Aggregates every signal
// that shows what BhatBot is doing, so an operator (or Claude Code) can autonomously watch progress
// and catch problems without the GUI:
//   • HTTP /health + /activity  → live thinking/tool/notify stream (self-drive notify() lands here)
//   • ~/.bhatbot/logs/app.log   → console tee (errors, [mcp] token line, stack traces)
//   • ~/.bhatbot/logs/events.jsonl → runtime-state event stream
//   • ~/.bhatbot/selfdrive.json  → daily count / attempts / lastCycleAt
//   • ~/.bhatbot/selfdrive-sessions.jsonl → completed session records
//   • ~/.bhatbot/.selfdrive.lock → is a session holding the lock right now
//   • git → current branch + self-drive-* branches + their commits
//
// The mcpToken is vaulted, so this resolves it from $BHATBOT_MCP_TOKEN or by scraping the app.log
// `[mcp] listening on …/mcp/<token>` line (same trick bhatctl documents). All read-only.
//
//   node scripts/bhat-monitor.js                 # human-readable snapshot
//   node scripts/bhat-monitor.js --json          # machine-readable snapshot (for automated watch)
//   node scripts/bhat-monitor.js --log [N]       # last N lines of app.log (default 40)
//   node scripts/bhat-monitor.js --activity [N]  # last N live activity events (needs app up)
//   node scripts/bhat-monitor.js --token         # print the resolved mcp token (for bhatctl)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const HOME = path.join(os.homedir(), '.bhatbot');
const LOG = path.join(HOME, 'logs', 'app.log');
const EVENTS = path.join(HOME, 'logs', 'events.jsonl');
const SD_STATE = path.join(HOME, 'selfdrive.json');
const SD_SESSIONS = path.join(HOME, 'selfdrive-sessions.jsonl');
const SD_LOCK = path.join(HOME, '.selfdrive.lock');
const CONFIG = path.join(HOME, 'config.json');
const PROJ = path.join(__dirname, '..');

function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function tail(p, n) { try { return fs.readFileSync(p, 'utf8').trim().split('\n').slice(-n); } catch { return []; } }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function sh(cmd) { try { return execSync(cmd, { cwd: PROJ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }

// Resolve the mcp token: env first, else scrape the newest `[mcp] listening on …/mcp/<token>` line.
function resolveToken() {
  const env = (process.env.BHATBOT_MCP_TOKEN || '').trim();
  if (env) return env;
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => /\[mcp\] listening/.test(l));
    const m = lines.length && lines[lines.length - 1].match(/mcp\/([A-Za-z0-9_-]{8,})/);
    if (m) return m[1];
  } catch {}
  return null;
}
function port() { const c = readJson(CONFIG, {}); return c.mcpPort || 8788; }

async function httpHealth() {
  const t = resolveToken(); if (!t) return { up: false, reason: 'no token' };
  try {
    const r = await fetch(`http://127.0.0.1:${port()}/health`, { headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(2500) });
    return { up: r.ok };
  } catch (e) { return { up: false, reason: e.message }; }
}
async function activity(n) {
  const t = resolveToken(); if (!t) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port()}/api/${t}/activity?since=0`, { headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.events || []).slice(-n);
  } catch { return null; }
}

function lockRunning() {
  if (!exists(SD_LOCK)) return false;
  try { return (Date.now() - fs.statSync(SD_LOCK).mtimeMs) < 2 * 60 * 60 * 1000; } catch { return false; }
}

async function snapshot() {
  const health = await httpHealth();
  const state = readJson(SD_STATE, {});
  const sessions = tail(SD_SESSIONS, 3).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  const sdBranches = sh('git branch --list "self-drive-*"').split('\n').map((s) => s.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
  const lastSdBranch = sdBranches[sdBranches.length - 1];
  const sdCommits = lastSdBranch ? sh(`git log --oneline ${lastSdBranch} ^main 2>/dev/null | head -20`).split('\n').filter(Boolean) : [];
  return {
    at: new Date().toISOString(),
    app_up: health.up, app_reason: health.reason,
    self_drive_running: lockRunning(),
    daily_count: state.day === new Date().toISOString().slice(0, 10) ? (state.countToday || 0) : 0,
    attempts: state.attempts || {},
    last_cycle_at: state.lastCycleAt ? new Date(state.lastCycleAt).toISOString() : null,
    git_branch: branch,
    self_drive_branches: sdBranches,
    latest_branch_commits: sdCommits,
    recent_sessions: sessions.map((s) => ({ branch: s.branch, halted: s.reason_halted, resolved: s.desires_resolved, blocked: s.desires_blocked, ended: s.ended_at })),
  };
}

(async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--token')) { const t = resolveToken(); console.log(t || '(no token — app not started / no BHATBOT_MCP_TOKEN)'); process.exit(t ? 0 : 1); }
  if (argv.includes('--log')) { const n = parseInt(argv[argv.indexOf('--log') + 1]) || 40; console.log(tail(LOG, n).join('\n')); return; }
  if (argv.includes('--activity')) {
    const n = parseInt(argv[argv.indexOf('--activity') + 1]) || 30;
    const ev = await activity(n);
    if (!ev) { console.error('✗ activity unavailable (app down or token unresolved)'); process.exit(1); }
    for (const e of ev) console.log(`${new Date(e.t).toLocaleTimeString()}  ${e.kind || 'event'}  ${String(e.text || '').slice(0, 140)}`);
    return;
  }
  const snap = await snapshot();
  if (argv.includes('--json')) { console.log(JSON.stringify(snap, null, 2)); return; }
  const y = (b) => b ? '\x1b[32myes\x1b[0m' : '\x1b[31mno\x1b[0m';
  console.log(`── BhatBot monitor  ${snap.at}`);
  console.log(`app up:              ${y(snap.app_up)}${snap.app_reason ? '  (' + snap.app_reason + ')' : ''}`);
  console.log(`self-drive running:  ${y(snap.self_drive_running)}`);
  console.log(`fixes today:         ${snap.daily_count}   last cycle: ${snap.last_cycle_at || '—'}`);
  console.log(`git branch:          ${snap.git_branch}`);
  if (snap.self_drive_branches.length) console.log(`self-drive branches: ${snap.self_drive_branches.join(', ')}`);
  if (snap.latest_branch_commits.length) { console.log(`landed commits (${snap.latest_branch_commits.length}):`); snap.latest_branch_commits.forEach((c) => console.log('   • ' + c)); }
  if (Object.keys(snap.attempts).length) console.log(`blocked attempts:    ${JSON.stringify(snap.attempts)}`);
  if (snap.recent_sessions.length) { console.log('recent sessions:'); snap.recent_sessions.forEach((s) => console.log(`   ${s.branch}  halted=${s.halted}  resolved=${s.resolved}  blocked=${s.blocked}`)); }
})();
