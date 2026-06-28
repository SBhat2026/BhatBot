'use strict';
// ---------------------------------------------------------------------------
// SELF-DRIVE (Phase 6) — PROACTIVE autonomous self-improvement governor.
//
// selfheal.js is REACTIVE: it waits for BhatBot to make a mistake (a tool fails, a self-test breaks)
// and patches it. self-drive is the opposite: it has no failure to react to. On a timer, while idle,
// it asks "what do I want to be better at?" (the Desire Engine — introspect → reflect), picks the
// single most valuable unresolved desire, drives a MULTI-AGENT pipeline to implement it, verifies the
// result, and — if it passes — keeps + commits (+ pushes, in aggressive mode) it, then records whether
// it helped. Then it does it again. It runs until the rate-limit budget is spent, skips while
// throttled, and resumes the moment the OTPM window recovers. This is how BhatBot improves itself with
// no prompting from Siddhant beyond turning it on.
//
// THE 5-ROLE PIPELINE (Siddhant's spec — researcher / planner / optimizer / shell / coder):
//   1. SCOUT   (researcher) — reads the relevant source for the desire, finds root cause + options.
//   2. ORACLE  (planner)    ─┐ run as an ENSEMBLE in parallel, then synthesized into ONE
//   3. ECHO    (optimizer)  ─┘ implementation brief + a concrete `verify` command.
//   4. FORGE   (coder)      ─┐ the brief is handed to the verify-gated Claude Code fixer (runFix),
//   5. ATLAS   (shell)      ─┘ which writes the edits AND runs the verify command (keep-or-revert).
// Roles 1-3 are injected via `deps.pipeline` (main wires orchestrator.fleet/ensemble); roles 4-5 are
// `deps.runFix` (= selfFix, which already owns the write+verify+revert loop). Pure policy here.
//
// AUTONOMY POSTURE (Siddhant chose AGGRESSIVE 2026-06-28): enabled by default, commits locally AND
// PUSHES on green, higher daily cap, works on an isolated `self-drive` branch (so main is never
// dirtied mid-flight and the diff is reviewable). HARD RAILS that survive even aggressive mode:
//   • verify-gate — runFix reverts any change that doesn't pass `npm run verify`.
//   • FROZEN ZONE — a fix touching secrets/config OR its OWN guardrails (selfdrive.js, selfheal.js,
//     risk.js, verify-syntax.js) is reverted. This is the one rail that does NOT relax: the loop must
//     not be able to weaken its own kill-switch or verify gate (the recursive-self-improvement footgun).
//   • idle-only, daily cap, cooldown, one desire at a time, every cycle audited + relayed.
//
// Pure + DI like selfheal: cycle()/tick() take loadConfig + injected deps; no side effects on its own.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_PATH = path.join(os.homedir(), '.bhatbot', 'selfdrive.json');
const ATTEMPT_TTL_MS = 36 * 60 * 60 * 1000;   // don't re-attempt the same desire within ~1.5 days

const DEFAULTS = {
  enabled: true,           // AGGRESSIVE: on by default (toggle config.selfDrive.enabled = false)
  branch: 'self-drive',    // isolated working branch; main stays clean
  push: true,              // AGGRESSIVE: push the branch to origin on a verified green
  maxPerDay: 12,           // AGGRESSIVE: high ceiling (cost is still bounded per-cycle + budget-paced)
  cooldownMin: 20,         // gap between cycles
  cycleMin: 30,            // timer cadence (the driver ticks this often; a cycle runs at most once/cooldown)
  maxRounds: 3,            // Claude Code fix rounds per desire before giving up + reverting
  minImpact: 'low',        // skip desires below this impact (low|medium|high)
  // verify gate a change MUST pass (exit 0) or it auto-reverts. Full suite, not just parse.
  verify: 'npm run verify',
  // FROZEN even in aggressive mode — secrets + the loop's own guardrails. It cannot edit these.
  frozen: [
    '.env', 'credentials', 'config.json',
    'lib/selfdrive.js', 'lib/selfheal.js', 'lib/risk.js', 'scripts/verify-syntax.js',
  ],
  skipPerms: true,         // coder runs Claude Code with --dangerously-skip-permissions (unattended)
};

const IMPACT_RANK = { low: 1, medium: 2, high: 3 };

function cfgFrom(loadConfig) {
  const c = (loadConfig && loadConfig()) || {};
  const sd = c.selfDrive || {};
  return { ...DEFAULTS, ...sd, frozen: sd.frozen || DEFAULTS.frozen };
}
function enabled(loadConfig) { return cfgFrom(loadConfig).enabled === true; }

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } }
function saveState(s) {
  try { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch {}
}
function today() { return new Date().toISOString().slice(0, 10); }

function attempted(s, id) { const t = (s.attempts || {})[id]; return t && (Date.now() - t) < ATTEMPT_TTL_MS; }
function markAttempt(id) { const s = loadState(); s.attempts = s.attempts || {}; s.attempts[id] = Date.now();
  for (const k of Object.keys(s.attempts)) if (Date.now() - s.attempts[k] > ATTEMPT_TTL_MS) delete s.attempts[k]; saveState(s); }
function recordCycle(loadConfig) {
  const cfg = cfgFrom(loadConfig); const s = loadState();
  if (s.day !== today()) { s.day = today(); s.countToday = 0; }
  s.countToday = (s.countToday || 0) + 1;
  s.cooldownUntil = Date.now() + cfg.cooldownMin * 60 * 1000;
  s.lastCycleAt = Date.now();
  saveState(s);
}

// Can a cycle run right now? deps.probe() → {idle,treeClean}; deps.budgetOk() → {ok,reason}.
function gate(loadConfig, { idle, treeClean, budget }) {
  const cfg = cfgFrom(loadConfig);
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!idle) return { ok: false, reason: 'agent busy' };
  if (!treeClean) return { ok: false, reason: 'git tree dirty' };
  if (budget && budget.ok === false) return { ok: false, reason: 'rate budget spent: ' + (budget.reason || 'throttled') };
  const s = loadState();
  if (s.day === today() && (s.countToday || 0) >= cfg.maxPerDay) return { ok: false, reason: 'daily cap reached' };
  if (s.cooldownUntil && Date.now() < s.cooldownUntil) return { ok: false, reason: 'cooldown' };
  return { ok: true };
}

// Choose the most valuable desire to act on: highest impact, then best (lowest) rank, skipping ones
// already resolved or attempted recently. `desires` = reflect() output; `resolvedIds` from history.
function pickDesire(desires, resolvedIds, loadConfig) {
  const cfg = cfgFrom(loadConfig); const s = loadState();
  const floor = IMPACT_RANK[cfg.minImpact] || 1;
  const eligible = (desires || []).filter((d) => d && d.id
    && !resolvedIds.has(d.id)
    && !attempted(s, d.id)
    && (IMPACT_RANK[d.impact] || 1) >= floor);
  eligible.sort((a, b) =>
    (IMPACT_RANK[b.impact] || 1) - (IMPACT_RANK[a.impact] || 1)
    || (a.rank || 99) - (b.rank || 99));
  return eligible[0] || null;
}

// Frozen-zone check on a set of changed paths → the offending paths (empty = clean).
function frozenViolations(changedPaths, loadConfig) {
  const cfg = cfgFrom(loadConfig);
  return (changedPaths || []).filter((f) => cfg.frozen.some((z) => f.includes(z)));
}

// Run ONE full self-improvement cycle for the top desire. deps:
//   reflect()            → { desires }                         (introspect → Opus desire engine)
//   listResolvedIds()    → Set<string>                          (already-acted-on desires)
//   resolveDesire(id, outcome, {telemetryDelta})                (close the loop)
//   pipeline(desire)     → { brief, verify? }   async           (SCOUT + ORACLE + ECHO multi-agent)
//   runFix({problem,verify,files,apply,maxRounds,skipPerms}) → { success, ... }  (FORGE + ATLAS)
//   runShell(cmd, cwd)   → { stdout, stderr, success, exitCode }
//   notify(text), proj
async function cycle(loadConfig, deps) {
  const cfg = cfgFrom(loadConfig);
  const { reflect, listResolvedIds, resolveDesire, pipeline, runFix, runShell, notify, proj } = deps;

  // 1. REFLECT — what do I want to improve?
  const rf = await reflect();
  const desires = (rf && rf.desires) || [];
  if (!desires.length) return { ran: false, reason: 'no desires (' + ((rf && rf.error) || 'empty') + ')' };
  const resolvedIds = (listResolvedIds && listResolvedIds()) || new Set();
  const desire = pickDesire(desires, resolvedIds, loadConfig);
  if (!desire) return { ran: false, reason: 'no eligible desire (all resolved/attempted/below minImpact)' };
  markAttempt(desire.id);
  recordCycle(loadConfig);
  if (notify) notify(`🚀 self-drive: working on “${String(desire.aspiration || desire.id).slice(0, 90)}”`);

  // 2. ISOLATE — work on the self-drive branch (created from current HEAD if missing).
  try { await runShell(`git checkout -B ${JSON.stringify(cfg.branch).replace(/"/g, '')}`, proj); } catch {}

  // 3. PIPELINE — SCOUT research + ORACLE/ECHO plan (multi-agent, injected). Produces the brief.
  let brief = '', verify = cfg.verify;
  try {
    const p = await pipeline(desire);
    brief = (p && p.brief) || '';
    if (p && p.verify) verify = p.verify;
  } catch (e) { brief = ''; if (notify) notify(`🚀 self-drive: pipeline error — ${e.message}; proceeding from the desire alone`); }

  // 4+5. FORGE + ATLAS — implement + verify (keep-or-revert), unattended.
  const problem = [
    `Implement this self-improvement for BhatBot: ${desire.aspiration || desire.id}.`,
    desire.implementation && desire.implementation.summary ? `Intended approach: ${desire.implementation.summary}` : '',
    brief ? `\nImplementation brief from the planning agents (follow it):\n${String(brief).slice(0, 6000)}` : '',
  ].filter(Boolean).join('\n');
  const files = (desire.implementation && [].concat(desire.implementation.modules_affected || [], desire.implementation.new_modules || []).join(' ')) || '';

  let res;
  try {
    res = await runFix({ problem, verify, files, apply: true, maxRounds: cfg.maxRounds, skipPerms: cfg.skipPerms });
  } catch (e) { res = { success: false, error: e.message }; }

  if (!res || !res.success) {
    if (resolveDesire) resolveDesire(desire.id, { summary: 'attempted; not implemented (verify failed / reverted)', helped: false });
    if (notify) notify(`🚀 self-drive: couldn't land “${desire.id}” (reverted). ${(res && res.error) ? res.error.slice(0, 120) : ''}`);
    return { ran: true, fixed: false, desire: desire.id, res };
  }

  // FROZEN-ZONE guard — revert wholesale if the change touched secrets/guardrails.
  const diff = await runShell('git diff --name-only', proj);
  const changed = String((diff && diff.stdout) || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const bad = frozenViolations(changed, loadConfig);
  if (bad.length) {
    await runShell('git checkout -- . && git clean -fd', proj);
    if (resolveDesire) resolveDesire(desire.id, { summary: 'reverted — touched frozen guardrail/secret paths: ' + bad.join(', '), helped: false });
    if (notify) notify(`🚀 self-drive: “${desire.id}” touched FROZEN paths (${bad.join(', ')}) — reverted.`);
    return { ran: true, fixed: false, frozen: bad, desire: desire.id };
  }

  // KEEP — commit locally, then push (aggressive).
  const msg = `self-drive: ${String(desire.aspiration || desire.id).slice(0, 64)}\n\n[auto] desire: ${desire.id}; verified by: ${verify}\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`;
  await runShell('git add -A && git commit -m ' + JSON.stringify(msg), proj);
  let pushed = false;
  if (cfg.push) {
    try { const pr = await runShell(`git push -u origin ${cfg.branch}`, proj, 120000); pushed = !!(pr && pr.success !== false); } catch {}
  }
  if (resolveDesire) resolveDesire(desire.id, { summary: 'implemented + verified on branch ' + cfg.branch + (pushed ? ' (pushed)' : ' (local)'), helped: true });
  if (notify) notify(`✅ self-drive: implemented + verified “${desire.id}” on ${cfg.branch}${pushed ? ' (pushed)' : ' (local commit)'}. Changed: ${changed.slice(0, 8).join(', ')}.`);
  return { ran: true, fixed: true, pushed, desire: desire.id, changed };
}

// One driver tick: gate, then (if open) run a cycle. deps additionally provides probe()+budgetOk().
async function tick(loadConfig, deps) {
  if (!enabled(loadConfig)) return { skipped: 'disabled' };
  const probe = deps.probe ? await deps.probe() : { idle: true, treeClean: true };
  const budget = deps.budgetOk ? deps.budgetOk() : { ok: true };
  const g = gate(loadConfig, { ...probe, budget });
  if (!g.ok) return { gated: g.reason };
  return cycle(loadConfig, deps);
}

function status(loadConfig) {
  const cfg = cfgFrom(loadConfig); const s = loadState();
  return {
    enabled: cfg.enabled, branch: cfg.branch, push: cfg.push,
    maxPerDay: cfg.maxPerDay, cooldownMin: cfg.cooldownMin, cycleMin: cfg.cycleMin,
    minImpact: cfg.minImpact, frozen: cfg.frozen, skipPerms: cfg.skipPerms,
    today: s.day === today() ? (s.countToday || 0) : 0,
    cooldownActive: !!(s.cooldownUntil && Date.now() < s.cooldownUntil),
    lastCycleAt: s.lastCycleAt ? new Date(s.lastCycleAt).toISOString() : null,
    recentAttempts: Object.keys(s.attempts || {}).slice(-10),
  };
}

module.exports = { DEFAULTS, cfgFrom, enabled, gate, pickDesire, frozenViolations, cycle, tick, status, STATE_PATH };
