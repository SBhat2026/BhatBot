'use strict';
// ---------------------------------------------------------------------------
// SELF-DRIVE (Phase 6) — on-demand, budget-governed autonomous self-improvement.
//
// This is the highest-blast-radius capability in the system: it can modify BhatBot's own source. The
// design priority is SAFE AUTONOMY — it must run unattended without the possibility of weakening its
// own guardrails, corrupting working state, or burning runaway budget. The rails come FIRST; the speed
// second. The entire safety model is `lib/risk.js` + the frozen zone + verify-or-revert — they are the
// belt, not belt-and-suspenders.
//
// ACTIVATION (Siddhant, 2026-06-28): NOT a perpetual background loop. BhatBot does not constantly
// update itself. A session runs only when:
//   1. Siddhant explicitly asks ("improve yourself" / "run selfdrive" / "work on yourself tonight").
//   2. BhatBot determines its own capabilities are insufficient for a task (capability-gap trigger).
//   3. Siddhant asks what it would like to improve about itself → that reflection SANCTIONS autonomous
//      implementation of those desires, without further permission, UNLESS he explicitly says otherwise.
// A session is a finite run of cycles; it halts on: budget exhausted, daily cap, no actionable desires,
// or an explicit stop. It NEVER pushes to a remote — the work lives on a local per-session branch
// until a human merges it.
//
// ONE CYCLE:
//   REFLECT  → buildSelfPortrait + reflect → pick top actionable, unresolved, non-blocked, LOCAL/
//              STRUCTURAL desire whose files are readable + not frozen.
//   PIPELINE → SCOUT (research) → ORACLE+ECHO (plan + adversarial review; severe concern → halt desire)
//              → [risk.checkFrozen preflight gate] → FORGE (claude_code writes) → ATLAS (verify) →
//              MEDIC (resolveDesire + telemetry delta).
//   VERIFY   → npm run verify must pass; else revert the working tree (stay on branch), mark
//              blocked_attempt (NOT permanent failure). 3 blocked attempts → human_review_needed.
//   BUDGET   → before each cycle, ensure OTPM headroom; if short, sleep until the window resets, resume.
//
// Pure policy + injected deps (so it is testable headless). main.js wires the pipeline (orchestrator /
// claude_code / introspect / reflect) and the probes.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const risk = require('./risk');

const HOME = path.join(os.homedir(), '.bhatbot');
const STATE_PATH = path.join(HOME, 'selfdrive.json');
const LOCK_PATH = path.join(HOME, '.selfdrive.lock');
const HASH_PATH = path.join(HOME, 'frozen-hashes.json');
const SESSIONS_PATH = path.join(HOME, 'selfdrive-sessions.jsonl');

const DEFAULTS = {
  enabled: true,             // the feature is AVAILABLE (a session can be started) ...
  autostart: false,          // ... but it is NEVER a perpetual loop — no background timer (user rule).
  actOnReflection: true,     // "what would you improve?" sanctions autonomous implementation.
  capabilityGapTrigger: true,// a detected capability gap may start a focused session.
  maxCyclesPerSession: 5,
  dailyCap: 3,               // COMBINED selfdrive + selfheal fixes per day (shared with selfheal).
  cooldownMin: 15,           // gap between cycles within a session
  maxAttemptsPerDesire: 3,   // blocked this many times → human_review_needed, stop retrying
  minImpact: 'low',
  verify: 'npm run verify',
  budgetBufferOut: 12000,    // need this much Sonnet OTPM headroom to start a cycle
  maxSleepMin: 20,           // cap a single budget sleep; longer → halt the session
  // NOTE: there is intentionally no `push` option. selfdrive NEVER pushes to a remote.
};

const IMPACT_RANK = { low: 1, medium: 2, high: 3 };

// ── state ───────────────────────────────────────────────────────────────────────────────────────
function cfgFrom(loadConfig) {
  const c = (loadConfig && loadConfig()) || {};
  const sd = c.selfDrive || {};
  return { ...DEFAULTS, ...sd };
}
function enabled(loadConfig) { return cfgFrom(loadConfig).enabled === true; }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch {} }
function today() { return new Date().toISOString().slice(0, 10); }

// ── frozen-zone hash integrity ────────────────────────────────────────────────────────────────
// Baseline-hash every frozen file. Before each session, re-hash + compare. A change made by a HUMAN
// (the common case — Siddhant edits risk.js) re-baselines silently. A change attributable to selfdrive
// itself (the file changed AND we are on a self-drive branch with selfdrive in its commits) means a
// frozen edit slipped past risk.js — that must be impossible, so HALT and alert loudly. This catches a
// bug in risk.js before it compounds across sessions.
function hashFile(proj, rel) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(proj, rel))).digest('hex'); }
  catch { return null; }
}
function frozenHashes(proj) {
  const out = {};
  for (const rel of risk.FROZEN_ZONE) { if (rel === '.env' || rel === 'credentials' || rel === 'config.json') continue; const h = hashFile(proj, rel); if (h) out[rel] = h; }
  return out;
}
function loadBaseline() { try { return JSON.parse(fs.readFileSync(HASH_PATH, 'utf8')); } catch { return null; } }
function saveBaseline(h) { try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(HASH_PATH, JSON.stringify({ at: new Date().toISOString(), hashes: h }, null, 2)); } catch {} }

// → { ok, halt, changed, reason }. selfCaused decided by the caller's git probe (was a frozen file
// touched on a self-drive branch). If no baseline yet, establish one and pass.
function checkFrozenIntegrity(proj, { selfCausedPaths = [] } = {}) {
  const current = frozenHashes(proj);
  const base = loadBaseline();
  if (!base || !base.hashes) { saveBaseline(current); return { ok: true, established: true, changed: [] }; }
  const changed = Object.keys(current).filter((k) => base.hashes[k] && base.hashes[k] !== current[k]);
  const selfChanged = changed.filter((c) => selfCausedPaths.some((p) => p.includes(c)));
  if (selfChanged.length) return { ok: false, halt: true, changed, selfChanged, reason: 'a FROZEN file was modified by selfdrive (' + selfChanged.join(', ') + ') — risk.js gate breach' };
  if (changed.length) { saveBaseline(current); return { ok: true, rebaselined: changed, changed }; }
  return { ok: true, changed: [] };
}

// ── locking (mutual exclusion with selfheal) ─────────────────────────────────────────────────────
function acquireLock(session) { try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(LOCK_PATH, JSON.stringify(session || { at: Date.now() })); } catch {} }
function releaseLock() { try { fs.unlinkSync(LOCK_PATH); } catch {} }
function lockActive() { try { return (Date.now() - fs.statSync(LOCK_PATH).mtimeMs) < 2 * 60 * 60 * 1000; } catch { return false; } }

// ── daily cap (COMBINED with selfheal) ────────────────────────────────────────────────────────────
function sdToday(s) { return s.day === today() ? (s.countToday || 0) : 0; }
function combinedCount(loadConfig, deps) {
  const s = loadState();
  let healCount = 0; try { healCount = (deps.selfhealDayCount && deps.selfhealDayCount()) || 0; } catch {}
  return sdToday(s) + healCount;
}
function recordCycle() { const s = loadState(); if (s.day !== today()) { s.day = today(); s.countToday = 0; } s.countToday = sdToday(s) + 1; s.lastCycleAt = Date.now(); saveState(s); }

// blocked-attempt tracking → human_review_needed after maxAttemptsPerDesire
function attemptCount(id) { const s = loadState(); return ((s.attempts || {})[id]) || 0; }
function markAttempt(id) { const s = loadState(); s.attempts = s.attempts || {}; s.attempts[id] = (s.attempts[id] || 0) + 1; saveState(s); return s.attempts[id]; }

// ── desire selection ────────────────────────────────────────────────────────────────────────────
// Highest impact then best rank among desires that are: unresolved, automatable, not blocked ≥cap
// times, risk LOCAL/STRUCTURAL, and whose files are not frozen. `classify(d)` (injected) bundles
// reflect.classifyActionability + risk.classifyDesire so this stays pure/testable.
//   → { desire, classification } | null
function pickDesire(desires, resolvedIds, classify, loadConfig) {
  const cfg = cfgFrom(loadConfig);
  const floor = IMPACT_RANK[cfg.minImpact] || 1;
  const ranked = (desires || [])
    .filter((d) => d && d.id && !resolvedIds.has(d.id) && (IMPACT_RANK[d.impact] || 1) >= floor)
    .filter((d) => attemptCount(d.id) < cfg.maxAttemptsPerDesire)
    .sort((a, b) => (IMPACT_RANK[b.impact] || 1) - (IMPACT_RANK[a.impact] || 1) || (a.rank || 99) - (b.rank || 99));
  for (const d of ranked) {
    const c = classify(d);
    if (c && c.automatable && (c.level === 'LOCAL' || c.level === 'STRUCTURAL') && !c.frozen) return { desire: d, classification: c };
  }
  return null;
}

// ── budget governor ─────────────────────────────────────────────────────────────────────────────
// deps.budget() → { outFree } for the pipeline's model (Sonnet). If headroom < buffer, sleep until the
// rolling 60s OTPM window plausibly resets (or the 429 Retry-After, whichever longer), capped.
function budgetPlan(loadConfig, deps) {
  const cfg = cfgFrom(loadConfig);
  let outFree = Infinity; try { outFree = (deps.budget && deps.budget().outFree); if (outFree == null) outFree = Infinity; } catch {}
  if (outFree >= cfg.budgetBufferOut) return { ok: true, outFree };
  let sleepMs = 60 * 1000;                                   // a fresh OTPM window
  try { const ra = deps.retryAfterMs && deps.retryAfterMs(); if (ra && ra > sleepMs) sleepMs = ra; } catch {}
  if (sleepMs > cfg.maxSleepMin * 60 * 1000) return { ok: false, halt: true, reason: 'budget sleep exceeds cap', sleepMs };
  return { ok: false, sleepMs, outFree };
}

// ── one cycle ─────────────────────────────────────────────────────────────────────────────────────
// deps: reflect, listResolvedIds, classify, research, plan, forge, verify, snapshot, telemetryDelta,
//       resolveDesire, runShell, notify, broadcast, proj
async function runCycle(loadConfig, deps, session) {
  const cfg = cfgFrom(loadConfig);
  const { reflect, listResolvedIds, classify, research, plan, forge, verify, snapshot,
    telemetryDelta, resolveDesire, runShell, notify, broadcast, proj } = deps;
  const emit = (role, note, extra) => { try { broadcast && broadcast({ session: session.id, branch: session.branch, role, desire: session.activeDesire, note, ...extra }); } catch {} };

  // 1. REFLECT + PICK
  const before = (snapshot && snapshot()) || null;
  const rf = await reflect(session.focus);
  const desires = (rf && rf.desires) || [];
  const resolved = (listResolvedIds && listResolvedIds()) || new Set();
  const chosen = pickDesire(desires, resolved, classify, loadConfig);
  if (!chosen) {
    const human = desires.filter((d) => { const c = classify(d); return c && !c.automatable; }).map((d) => d.aspiration || d.id);
    return { noDesire: true, humanNeeded: human };
  }
  const { desire, classification } = chosen;
  session.activeDesire = desire.id;
  if (notify) notify(`🚀 self-drive: ${classification.level} desire — “${String(desire.aspiration || desire.id).slice(0, 80)}”`);
  emit('OVERMIND', 'selected desire', { level: classification.level });

  // 2. SCOUT — research (read-only)
  emit('SCOUT', 'researching');
  let report = '';
  try { report = (await research(desire, classification.files)) || ''; } catch (e) { report = ''; }

  // 3. ORACLE + ECHO — plan + adversarial review
  emit('ORACLE', 'planning');
  let planOut = {};
  try { planOut = (await plan(desire, report)) || {}; } catch (e) { planOut = {}; }
  if (risk.severeConcern(planOut.severity, classification.level)) {
    const n = markAttempt(desire.id);
    if (resolveDesire) resolveDesire(desire.id, { summary: `ECHO halted: ${String(planOut.concern || planOut.severity || 'severe risk').slice(0, 160)}`, helped: false });
    emit('ECHO', 'halted — severe concern', { severity: planOut.severity });
    return { outcome: 'blocked', desire: desire.id, reason: 'ECHO severe concern', attempts: n };
  }

  // 4. FROZEN-ZONE PREFLIGHT — block BEFORE any write (file-list inspection, not a CC instruction).
  const planFiles = [].concat(classification.files, planOut.files || []);
  const frozen = risk.checkFrozen(planFiles);
  if (frozen.blocked || planFiles.some((f) => String(f).includes('lib/selfdrive.js'))) {
    const n = markAttempt(desire.id);
    if (resolveDesire) resolveDesire(desire.id, { summary: 'BLOCKED by risk.js — plan touches frozen zone: ' + (frozen.hits.join(', ') || 'lib/selfdrive.js'), helped: false });
    if (notify) notify(`🛑 self-drive: “${desire.id}” BLOCKED — plan would edit frozen ${frozen.hits.join(', ') || 'lib/selfdrive.js'}. Never automated.`);
    emit('OVERMIND', 'BLOCKED — frozen zone', { hits: frozen.hits });
    return { outcome: 'blocked_frozen', desire: desire.id, hits: frozen.hits, attempts: n };
  }

  // 5. FORGE — the only writer. Drives claude_code (--dangerously-skip-permissions) on this branch.
  emit('FORGE', 'implementing');
  const verifyCmd = planOut.verify || cfg.verify;
  let forgeRes;
  try { forgeRes = await forge({ desire, classification, report, plan: planOut, verify: verifyCmd, proj }); }
  catch (e) { forgeRes = { success: false, error: e.message }; }

  // 6. ATLAS — verify (separate from FORGE: the judge is not the author). Fail → revert, blocked_attempt.
  emit('ATLAS', 'verifying', { verify: verifyCmd });
  let pass = false, vout = '';
  try { const v = await verify(verifyCmd, proj); pass = !!(v && v.success && (v.exitCode === 0 || v.exitCode == null)); vout = String((v && (v.stdout || v.error)) || '').slice(-400); } catch (e) { pass = false; vout = e.message; }
  // post-write frozen double-check (defense in depth — should already be impossible past the preflight)
  let changed = [];
  try { const d = await runShell('git diff --name-only', proj); changed = String((d && d.stdout) || '').split('\n').map((x) => x.trim()).filter(Boolean); } catch {}
  const postFrozen = risk.checkFrozen(changed);
  if (!pass || postFrozen.blocked || !forgeRes || forgeRes.success === false) {
    await runShell('git checkout -- . && git clean -fd', proj);     // never leave a dirty tree
    const n = markAttempt(desire.id);
    const blocked = n >= cfg.maxAttemptsPerDesire;
    const reason = postFrozen.blocked ? 'post-write frozen breach: ' + postFrozen.hits.join(', ') : (pass ? 'forge failed' : 'verify failed');
    if (resolveDesire) resolveDesire(desire.id, { summary: `${blocked ? 'human_review_needed' : 'blocked_attempt'} (${reason})`, helped: false });
    if (notify) notify(`↩ self-drive: “${desire.id}” ${reason} — reverted. ${blocked ? 'Marked human_review_needed.' : `Attempt ${n}/${cfg.maxAttemptsPerDesire}.`}`);
    emit('ATLAS', blocked ? 'human_review_needed' : 'reverted', { reason });
    return { outcome: blocked ? 'human_review_needed' : 'blocked_attempt', desire: desire.id, reason, attempts: n };
  }

  // 7. KEEP — commit LOCALLY (never push). Multiple cycles accrue on the one session branch.
  recordCycle();
  const msg = `self-drive: ${String(desire.aspiration || desire.id).slice(0, 64)}\n\n[auto] desire: ${desire.id}; level: ${classification.level}; verified by: ${verifyCmd}\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`;
  await runShell('git add -A && git commit -m ' + JSON.stringify(msg), proj);

  // 8. MEDIC — resolve with the telemetry delta (did it actually help?).
  emit('MEDIC', 'resolving');
  const after = (snapshot && snapshot()) || null;
  let delta = null; try { delta = (telemetryDelta && telemetryDelta(before, after)) || null; } catch {}
  if (resolveDesire) resolveDesire(desire.id, { summary: 'implemented + verified on ' + session.branch + ' (local, not pushed)', helped: true }, { telemetryDelta: delta });
  if (notify) notify(`✅ self-drive: implemented + verified “${desire.id}” on ${session.branch} (local commit). Changed: ${changed.slice(0, 6).join(', ')}.`);
  emit('MEDIC', 'resolved', { net: delta && delta.net });
  return { outcome: 'resolved', desire: desire.id, desire_aspiration: desire.aspiration, level: classification.level, files_changed: changed, telemetry_delta: delta };
}

// ── session ─────────────────────────────────────────────────────────────────────────────────────
let _running = false;
let _stop = null;            // 'graceful' | 'now'
function isRunning() { return _running; }
function requestStop(mode) { if (_running) _stop = (mode === 'now') ? 'now' : 'graceful'; return { ok: _running, mode: _stop }; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// startSession — the on-demand entry point. opts: { reason, focus, maxCycles }.
async function startSession(loadConfig, deps, opts = {}) {
  if (!enabled(loadConfig)) return { skipped: 'disabled' };
  if (_running) return { skipped: 'already running' };
  const cfg = cfgFrom(loadConfig);
  const proj = deps.proj;

  // Pre-flight integrity: a frozen file changed by selfdrive (gate breach) → refuse to start.
  let selfCaused = [];
  try { const log = await deps.runShell('git log --name-only --pretty=format:%s -n 50', proj); if (/self-drive:/.test(String(log && log.stdout))) selfCaused = String(log.stdout).split('\n').map((x) => x.trim()).filter(Boolean); } catch {}
  const integ = checkFrozenIntegrity(proj, { selfCausedPaths: selfCaused });
  if (integ.halt) { if (deps.notify) deps.notify('🛑 self-drive: ' + integ.reason + ' — refusing to run.'); return { halted: 'frozen_integrity', ...integ }; }

  // Probe idle + clean tree before we branch.
  const probe = deps.probe ? await deps.probe() : { idle: true, treeClean: true };
  if (!probe.idle) return { skipped: 'agent busy' };
  if (!probe.treeClean) return { skipped: 'git tree dirty' };
  if (combinedCount(loadConfig, deps) >= cfg.dailyCap) return { skipped: 'daily cap reached (combined with self-heal)' };

  const ts = new Date();
  const branch = 'self-drive-' + ts.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');   // self-drive-YYYYMMDD-HHmm
  const session = { id: 'sd-' + Date.now(), branch, started_at: ts.toISOString(), reason: opts.reason || 'manual', focus: opts.focus || '', cycles: [], activeDesire: null };

  _running = true; _stop = null;
  acquireLock(session);
  try {
    await deps.runShell(`git checkout -b ${branch}`, proj).catch(() => deps.runShell(`git checkout ${branch}`, proj));
    if (deps.notify) deps.notify(`🚀 self-drive session started (${session.reason}) on branch ${branch}.`);

    const maxCycles = Math.max(1, Math.min(opts.maxCycles || cfg.maxCyclesPerSession, cfg.maxCyclesPerSession));
    let halt = null;
    for (let i = 0; i < maxCycles; i++) {
      if (_stop) { halt = 'stopped:' + _stop; break; }
      // re-probe idle each cycle: if Siddhant came back, yield immediately.
      const p = deps.probe ? await deps.probe() : { idle: true };
      if (!p.idle) { halt = 'user_returned'; break; }
      if (combinedCount(loadConfig, deps) >= cfg.dailyCap) { halt = 'daily_cap'; break; }

      // budget gate (run-until-limit → sleep → resume)
      let bp = budgetPlan(loadConfig, deps);
      while (!bp.ok) {
        if (bp.halt || _stop) { halt = bp.halt ? 'budget_exhausted' : 'stopped:' + _stop; break; }
        if (deps.notify) deps.notify(`⏳ self-drive: OTPM headroom low — sleeping ${Math.round(bp.sleepMs / 1000)}s, then resuming.`);
        await sleep(bp.sleepMs);
        bp = budgetPlan(loadConfig, deps);
      }
      if (halt) break;

      const r = await runCycle(loadConfig, deps, session);
      if (r.noDesire) { halt = 'no_actionable_desires'; session.humanNeeded = r.humanNeeded; break; }
      session.cycles.push({ desire_id: r.desire, desire_aspiration: r.desire_aspiration, outcome: r.outcome, telemetry_delta: r.telemetry_delta, files_changed: r.files_changed, reason: r.reason });
      if (i < maxCycles - 1 && !_stop) await sleep(Math.min(cfg.cooldownMin, 5) * 1000);   // brief inter-cycle settle (short in-session)
    }
    session.reason_halted = halt || 'max_cycles';
  } catch (e) {
    session.reason_halted = 'error:' + e.message;
    try { await deps.runShell('git checkout -- . && git clean -fd', proj); } catch {}
  } finally {
    session.ended_at = new Date().toISOString();
    session.desires_resolved = session.cycles.filter((c) => c.outcome === 'resolved').length;
    session.desires_blocked = session.cycles.filter((c) => /blocked|human/.test(c.outcome || '')).length;
    try { fs.mkdirSync(HOME, { recursive: true }); fs.appendFileSync(SESSIONS_PATH, JSON.stringify(session) + '\n'); } catch {}
    releaseLock(); _running = false; _stop = null;
    if (deps.notify) deps.notify(`🏁 self-drive session done (${session.reason_halted}): ${session.desires_resolved} resolved, ${session.desires_blocked} blocked, branch ${session.branch} (local — review + merge when ready).`);
    if (deps.broadcast) try { deps.broadcast({ session: session.id, role: 'OVERMIND', note: 'session complete', done: true, resolved: session.desires_resolved }); } catch {}
  }
  return { ran: true, session };
}

function status(loadConfig) {
  const cfg = cfgFrom(loadConfig); const s = loadState();
  let lastSession = null; try { const lines = fs.readFileSync(SESSIONS_PATH, 'utf8').trim().split('\n'); lastSession = JSON.parse(lines[lines.length - 1]); } catch {}
  return {
    enabled: cfg.enabled, autostart: cfg.autostart, actOnReflection: cfg.actOnReflection,
    capabilityGapTrigger: cfg.capabilityGapTrigger, running: _running, never_pushes: true,
    dailyCap: cfg.dailyCap, today_combined_with_selfheal: sdToday(s), maxCyclesPerSession: cfg.maxCyclesPerSession,
    frozen_zone: risk.FROZEN_ZONE, lastSession: lastSession && { branch: lastSession.branch, reason_halted: lastSession.reason_halted, resolved: lastSession.desires_resolved, ended_at: lastSession.ended_at },
  };
}

module.exports = {
  DEFAULTS, cfgFrom, enabled, pickDesire, runCycle, startSession, requestStop, isRunning, status,
  checkFrozenIntegrity, frozenHashes, budgetPlan, lockActive, combinedCount,
  STATE_PATH, LOCK_PATH, HASH_PATH, SESSIONS_PATH,
};
