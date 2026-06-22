'use strict';
// ---------------------------------------------------------------------------
// Autonomous self-healing (#self_heal). DISABLED by default — does NOTHING unless
// config.selfHeal.enabled === true. When on, mistakes BhatBot detects in its OWN behavior are
// queued and fixed by self_fix (the built-in Claude Code), each gated by a `verify` command that
// must exit 0 or the change auto-reverts.
//
// Autonomy (chosen by Siddhant): auto-fix on `main`, verify-gated, keep-or-revert, commit LOCALLY,
// NEVER push. Triggers: repeated tool failures, user-flagged bugs, failing self-tests, runtime
// crashes. Hard rails (always on): one fix at a time, per-day cap, cooldown, clean-tree required,
// frozen-zone protection (a fix that edits a frozen path is reverted), every attempt notified,
// runs only while the agent is idle.
//
// This module is pure policy + state; the heavy lifting (running the fixer, git, notify, idle
// check) is INJECTED by main.js via `deps`, so it stays testable and side-effect-free on its own.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_PATH = path.join(os.homedir(), '.bhatbot', 'selfheal.json');
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;   // don't re-attempt the same mistake within a day

const DEFAULTS = {
  enabled: false,
  maxPerDay: 3,
  minFailures: 3,          // a tool must fail this many times in the window before a fix attempt
  windowMin: 180,          // failure-cluster lookback
  cooldownMin: 45,         // minimum gap between fix attempts
  maxRounds: 2,            // self_fix rounds per mistake
  frozen: [                // path substrings a fix must NOT modify (reverted if touched)
    'config.json', '.env', 'credentials', 'lib/selfheal.js', 'scripts/verify-syntax.js',
  ],
  triggers: { toolFailures: true, corrections: true, selfTests: true, runtimeErrors: true },
};

function cfgFrom(loadConfig) {
  const c = (loadConfig && loadConfig()) || {};
  const sh = c.selfHeal || {};
  return { ...DEFAULTS, ...sh, triggers: { ...DEFAULTS.triggers, ...(sh.triggers || {}) }, frozen: sh.frozen || DEFAULTS.frozen };
}
function enabled(loadConfig) { return cfgFrom(loadConfig).enabled === true; }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch {}
}
function today() { return new Date().toISOString().slice(0, 10); }

// In-memory queue of pending mistakes this process; `seen` (persisted) prevents re-attempting the
// same key within SEEN_TTL_MS even across restarts.
let QUEUE = [];

function isSeen(key) {
  const s = loadState(); const ts = (s.seen || {})[key];
  return ts && (Date.now() - ts) < SEEN_TTL_MS;
}
function markSeen(key) {
  const s = loadState(); s.seen = s.seen || {};
  s.seen[key] = Date.now();
  for (const k of Object.keys(s.seen)) if (Date.now() - s.seen[k] > SEEN_TTL_MS) delete s.seen[k];
  saveState(s);
}

// Add a mistake to the queue. m = { key, problem, verify, files?, source }. No-op if disabled,
// already queued, or attempted recently. `key` is the dedup identity.
function enqueue(m, loadConfig) {
  if (!enabled(loadConfig)) return { skipped: 'disabled' };
  const cfg = cfgFrom(loadConfig);
  if (m.source && cfg.triggers[m.source] === false) return { skipped: 'trigger off: ' + m.source };
  if (!m || !m.problem) return { skipped: 'no problem' };
  const key = m.key || m.problem.slice(0, 80);
  if (QUEUE.some((x) => x.key === key)) return { skipped: 'already queued' };
  if (isSeen(key)) return { skipped: 'attempted recently' };
  QUEUE.push({ key, problem: m.problem, verify: m.verify || 'node scripts/verify-syntax.js', files: m.files || '', source: m.source || 'manual', at: Date.now() });
  return { queued: true, key, depth: QUEUE.length };
}
function pending() { return QUEUE.slice(); }

// Cluster recent tool FAILURES from the audit log into mistakes (≥ minFailures of the same tool).
function clusterAudit(auditEvents, loadConfig) {
  const cfg = cfgFrom(loadConfig);
  if (!cfg.triggers.toolFailures) return [];
  const since = Date.now() - cfg.windowMin * 60 * 1000;
  const byTool = {};
  for (const e of (auditEvents || [])) {
    if (!e || e.ok !== false) continue;                            // audit logs ok:false on failure
    const t = new Date(e.ts || e.time || 0).getTime();
    if (t && t < since) continue;
    const tool = e.tool || e.name || 'unknown';
    const err = String((typeof e.result === 'string' ? e.result : (e.error || (e.result && e.result.error))) || '').slice(0, 120);
    (byTool[tool] = byTool[tool] || []).push(err);
  }
  const out = [];
  for (const [tool, errs] of Object.entries(byTool)) {
    if (errs.length < cfg.minFailures) continue;
    const sample = errs.find(Boolean) || '(no error text)';
    out.push({
      key: 'toolfail:' + tool,
      source: 'toolFailures',
      problem: `The "${tool}" tool has failed ${errs.length} times recently. Representative error: ${sample}. Diagnose the root cause in the BhatBot repo and fix it.`,
      verify: 'node scripts/verify-syntax.js',
    });
  }
  return out;
}

// Gate: can we attempt a fix right now? Returns { ok, reason }.
function gate(loadConfig, { idle, treeClean }) {
  const cfg = cfgFrom(loadConfig);
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!idle) return { ok: false, reason: 'agent busy' };
  if (!treeClean) return { ok: false, reason: 'git tree dirty' };
  const s = loadState();
  if (s.day === today() && (s.countToday || 0) >= cfg.maxPerDay) return { ok: false, reason: 'daily cap reached' };
  if (s.cooldownUntil && Date.now() < s.cooldownUntil) return { ok: false, reason: 'cooldown' };
  return { ok: true };
}

function recordAttempt(loadConfig) {
  const cfg = cfgFrom(loadConfig); const s = loadState();
  if (s.day !== today()) { s.day = today(); s.countToday = 0; }
  s.countToday = (s.countToday || 0) + 1;
  s.cooldownUntil = Date.now() + cfg.cooldownMin * 60 * 1000;
  s.lastAttemptAt = Date.now();
  saveState(s);
}

// Attempt ONE queued mistake. deps = { runFix, notify, runShell, proj }.
//   runFix({problem, verify, files, apply:true, maxRounds}) -> { success, ... }   (= main.js selfFix)
//   runShell(cmd, cwd) -> { stdout, stderr, success, exitCode }
//   notify(text)
async function runOne(loadConfig, deps) {
  const cfg = cfgFrom(loadConfig);
  const m = QUEUE.shift();
  if (!m) return { ran: false, reason: 'empty queue' };
  markSeen(m.key);            // mark immediately so a crash mid-fix doesn't loop on it
  recordAttempt(loadConfig);
  const { runFix, notify, runShell, proj } = deps;
  try {
    if (notify) notify(`🩺 self-heal: attempting fix for ${m.source} — ${m.problem.slice(0, 90)}`);
    const res = await runFix({ problem: m.problem, verify: m.verify, files: m.files, apply: true, maxRounds: cfg.maxRounds });
    if (!res || !res.success) {
      if (notify) notify(`🩺 self-heal: could not fix (reverted) — ${m.problem.slice(0, 80)}`);
      return { ran: true, fixed: false, mistake: m, res };
    }
    // Frozen-zone guard: if the fix touched a protected path, revert the whole thing.
    const diff = await runShell('git diff --name-only', proj);
    const changed = String((diff && diff.stdout) || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const bad = changed.filter((f) => cfg.frozen.some((z) => f.includes(z)));
    if (bad.length) {
      await runShell('git checkout -- . && git clean -fd', proj);
      if (notify) notify(`🩺 self-heal: fix touched frozen files (${bad.join(', ')}) — reverted.`);
      return { ran: true, fixed: false, frozen: bad, mistake: m };
    }
    // Keep it: commit LOCALLY (never push).
    const msg = `self-heal: ${m.problem.slice(0, 68)}\n\n[auto] trigger: ${m.source}; verified by: ${m.verify}\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`;
    await runShell('git add -A && git commit -m ' + JSON.stringify(msg), proj);
    if (notify) notify(`🩺 self-heal: FIXED + verified + committed locally (not pushed) — ${m.problem.slice(0, 80)}. Changed: ${changed.join(', ')}. Restart to load.`);
    return { ran: true, fixed: true, changed, mistake: m };
  } catch (e) {
    return { ran: true, fixed: false, error: e && e.message, mistake: m };
  }
}

// One full cycle: refresh the queue from the audit log, then (if gated) attempt one fix.
// deps additionally provides readAudit() and idle/treeClean probes via deps.probe().
async function tick(loadConfig, deps) {
  if (!enabled(loadConfig)) return { skipped: 'disabled' };
  // refresh from audit clusters
  try { for (const m of clusterAudit(deps.readAudit ? deps.readAudit() : [], loadConfig)) enqueue(m, loadConfig); } catch {}
  if (!QUEUE.length) return { idle: true, queue: 0 };
  const probe = deps.probe ? await deps.probe() : { idle: true, treeClean: true };
  const g = gate(loadConfig, probe);
  if (!g.ok) return { gated: g.reason, queue: QUEUE.length };
  return runOne(loadConfig, deps);
}

function status(loadConfig) {
  const cfg = cfgFrom(loadConfig); const s = loadState();
  return {
    enabled: cfg.enabled, maxPerDay: cfg.maxPerDay, cooldownMin: cfg.cooldownMin,
    triggers: cfg.triggers, frozen: cfg.frozen,
    today: s.day === today() ? (s.countToday || 0) : 0,
    cooldownActive: !!(s.cooldownUntil && Date.now() < s.cooldownUntil),
    queue: QUEUE.map((m) => ({ source: m.source, problem: m.problem.slice(0, 80) })),
  };
}

module.exports = { DEFAULTS, cfgFrom, enabled, enqueue, pending, clusterAudit, gate, runOne, tick, status, STATE_PATH };
