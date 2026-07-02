#!/usr/bin/env node
'use strict';
// Safety-rail tests for the ON-DEMAND self-improvement governor (lib/selfdrive.js). It can modify
// BhatBot's own source unattended, so its rails are security-critical and tested adversarially:
// desire selection (automatable + LOCAL/STRUCTURAL + non-frozen + not-blocked), frozen-zone PREFLIGHT
// (block before any write), ECHO severe-concern halt, verify-or-revert + blocked_attempt 3-strike,
// NEVER-pushes, frozen-hash integrity (self-caused frozen edit → halt), combined daily cap, and the
// budget sleep/halt plan. Pure policy (deps injected). Temp $HOME isolates state. In `npm run verify`.
//   node scripts/test-selfdrive.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-selfdrive-'));
process.env.HOME = TMP;
const REPO = path.resolve(__dirname, '..');
const sd = require('../lib/selfdrive');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };
const ON = () => ({});                                    // enabled by default, autostart off
const OFF = () => ({ selfDrive: { enabled: false } });
const clearState = () => { try { fs.unlinkSync(sd.STATE_PATH); } catch {} try { fs.unlinkSync(sd.HASH_PATH); } catch {} };
const writeState = (s) => { fs.mkdirSync(path.dirname(sd.STATE_PATH), { recursive: true }); fs.writeFileSync(sd.STATE_PATH, JSON.stringify(s)); };

// A runCycle deps harness: records shell commands + whether FORGE ran; configurable plan/verify.
function harness(over = {}) {
  const cmds = []; const resolved = []; const state = { forgeCalled: false };
  const deps = {
    reflect: over.reflect || (async () => ({ desires: over.desires || [{ id: 'speedup', rank: 1, impact: 'high', aspiration: 'be faster', implementation: { summary: 'cache', modules_affected: ['lib/x.js'] } }] })),
    listResolvedIds: over.listResolvedIds || (() => new Set()),
    classify: over.classify || ((d) => ({ automatable: true, level: 'LOCAL', files: (d.implementation && d.implementation.modules_affected) || ['lib/x.js'], frozen: false })),
    research: over.research || (async () => 'research report'),
    plan: over.plan || (async () => ({ brief: 'plan', files: ['lib/x.js'], verify: 'npm run verify', severity: 'low' })),
    forge: over.forge || (async () => { state.forgeCalled = true; return { success: true }; }),
    review: over.review,   // optional REVIEWER stage (absent → skipped)
    verify: over.verify || (async () => ({ success: true, exitCode: 0 })),
    snapshot: () => ({ performance: { avg_latency_ms: 100 } }),
    telemetryDelta: () => ({ net: 1, improved: ['avg_latency_ms -10'], regressed: [] }),
    resolveDesire: (id, o) => resolved.push({ id, helped: o.helped, summary: o.summary }),
    runShell: over.runShell || (async (cmd) => { cmds.push(cmd); return { stdout: /diff --name-only/.test(cmd) ? 'lib/x.js\n' : '', success: true }; }),
    notify: () => {}, broadcast: () => {}, proj: TMP,
  };
  return { deps, cmds, resolved, state };
}
const session = () => ({ id: 'sd-test', branch: 'self-drive-test', focus: '', cycles: [], activeDesire: null });

(async () => {
  // ---- posture: enabled, on-demand, NEVER pushes ----
  ok(sd.enabled(ON) === true, 'enabled: feature available by default');
  ok(sd.enabled(OFF) === false, 'enabled: false when disabled');
  ok(sd.DEFAULTS.autostart === false, 'posture: autostart FALSE (no perpetual loop — does not constantly self-update)');
  ok(!('push' in sd.DEFAULTS), 'posture: there is no push option — selfdrive NEVER pushes');
  ok(sd.status(ON).never_pushes === true, 'status: advertises never_pushes');

  // ---- pickDesire: automatable + LOCAL/STRUCTURAL + non-frozen + not-blocked, impact then rank ----
  clearState();
  const desires = [
    { id: 'guard', rank: 1, impact: 'high' },        // classified GUARDRAIL → skip
    { id: 'infra', rank: 1, impact: 'high' },        // INFRASTRUCTURE → skip
    { id: 'nonauto', rank: 1, impact: 'high' },      // not automatable → skip
    { id: 'good', rank: 2, impact: 'medium' },       // LOCAL automatable → pick
    { id: 'frozenfile', rank: 1, impact: 'high' },   // automatable but frozen → skip
  ];
  const classify = (d) => ({
    guard: { automatable: true, level: 'GUARDRAIL', files: [], frozen: false },
    infra: { automatable: true, level: 'INFRASTRUCTURE', files: [], frozen: false },
    nonauto: { automatable: false, level: 'LOCAL', files: [], frozen: false },
    good: { automatable: true, level: 'LOCAL', files: ['lib/x.js'], frozen: false },
    frozenfile: { automatable: true, level: 'LOCAL', files: ['lib/risk.js'], frozen: true },
  }[d.id]);
  ok(sd.pickDesire(desires, new Set(), classify, ON).desire.id === 'good', 'pickDesire: skips GUARDRAIL/INFRA/non-automatable/frozen, picks the automatable LOCAL one');
  ok(sd.pickDesire(desires, new Set(['good']), classify, ON) === null, 'pickDesire: null when the only eligible one is resolved');
  writeState({ attempts: { good: 3 } });   // hit max attempts
  ok(sd.pickDesire(desires, new Set(), classify, ON) === null, 'pickDesire: skips a desire blocked 3× (human_review_needed)');
  clearState();

  // ---- runCycle: happy path → forge runs, verify passes, commit, NO push, resolve(helped)+delta ----
  {
    const h = harness();
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.outcome === 'resolved' && h.state.forgeCalled, 'runCycle: happy path → FORGE ran, outcome resolved');
    ok(h.cmds.some((c) => /git commit/.test(c)), 'runCycle: commits locally');
    ok(!h.cmds.some((c) => /git push/.test(c)), 'runCycle: NEVER pushes');
    ok(h.resolved[0] && h.resolved[0].helped === true, 'runCycle: resolves helped with telemetry delta');
    ok(r.telemetry_delta && r.telemetry_delta.net === 1, 'runCycle: telemetry delta attached');
  }

  // ---- runCycle: FROZEN PREFLIGHT blocks BEFORE any write (plan proposes a frozen file) ----
  {
    const h = harness({ plan: async () => ({ brief: 'p', files: ['lib/x.js', 'lib/risk.js'], verify: 'npm run verify', severity: 'low' }) });
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.outcome === 'blocked_frozen' && !h.state.forgeCalled, 'runCycle: plan touching frozen zone → BLOCKED before FORGE ever runs');
    ok(!h.cmds.some((c) => /git commit/.test(c)), 'runCycle: frozen-blocked → no commit');
  }

  // ---- runCycle: selfdrive.js in plan files → unconditional block ----
  {
    const h = harness({ plan: async () => ({ brief: 'p', files: ['lib/selfdrive.js'], verify: 'npm run verify', severity: 'low' }) });
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.outcome === 'blocked_frozen' && !h.state.forgeCalled, 'runCycle: editing its OWN governor → unconditionally blocked');
  }

  // ---- runCycle: ECHO severe concern → halt the desire before FORGE ----
  {
    const h = harness({ plan: async () => ({ brief: 'p', files: ['lib/x.js'], verify: 'npm run verify', severity: 'severe' }) });
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.outcome === 'blocked' && !h.state.forgeCalled, 'runCycle: ECHO severe severity → desire halted, no write');
  }

  // ---- runCycle: verify FAILS → revert clean tree, blocked_attempt (not permanent), 3rd → human_review ----
  clearState();
  {
    const h = harness({ verify: async () => ({ success: false, exitCode: 1 }) });
    const r1 = await sd.runCycle(ON, h.deps, session());
    ok(r1.outcome === 'blocked_attempt', 'runCycle: verify fail (1st) → blocked_attempt');
    ok(h.cmds.some((c) => /checkout -- \. && git clean/.test(c)) && !h.cmds.some((c) => /git commit/.test(c)), 'runCycle: verify fail → reverted, never committed (tree never left dirty)');
    await sd.runCycle(ON, harness({ verify: async () => ({ success: false }) }).deps, session());  // 2nd
    const r3 = await sd.runCycle(ON, harness({ verify: async () => ({ success: false }) }).deps, session());  // 3rd
    ok(r3.outcome === 'human_review_needed', 'runCycle: 3rd failed attempt → human_review_needed');
  }

  // ---- runCycle: no actionable desire → noDesire + humanNeeded list ----
  clearState();
  {
    const h = harness({ desires: [{ id: 'x', rank: 1, impact: 'high' }], classify: () => ({ automatable: false, level: 'INFRASTRUCTURE', files: [], frozen: false }) });
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.noDesire === true && Array.isArray(r.humanNeeded), 'runCycle: no automatable desire → noDesire + humanNeeded list');
  }

  // ---- combined daily cap (selfdrive + selfheal share it) ----
  clearState();
  writeState({ day: new Date().toISOString().slice(0, 10), countToday: 1 });
  ok(sd.combinedCount(ON, { selfhealDayCount: () => 2 }) === 3, 'combinedCount: sums selfdrive + selfheal fixes');

  // ---- budget governor: low headroom → sleep; over cap → halt ----
  ok(sd.budgetPlan(ON, { budget: () => ({ outFree: 50000 }) }).ok === true, 'budgetPlan: ample OTPM → ok');
  ok(sd.budgetPlan(ON, { budget: () => ({ outFree: 100 }) }).ok === false, 'budgetPlan: low OTPM → not ok (sleep)');
  ok(sd.budgetPlan(ON, { budget: () => ({ outFree: 100 }), retryAfterMs: () => 99 * 60 * 1000 }).halt === true, 'budgetPlan: Retry-After beyond cap → halt the session');

  // ---- frozen-hash integrity (against the REAL repo) ----
  clearState();
  const i1 = sd.checkFrozenIntegrity(REPO, {});
  ok(i1.ok === true && i1.established === true, 'integrity: first run establishes a baseline');
  ok(sd.checkFrozenIntegrity(REPO, {}).changed.length === 0, 'integrity: unchanged frozen files → clean');
  // corrupt the baseline for a real frozen file, claim selfdrive caused it → must HALT
  const base = JSON.parse(fs.readFileSync(sd.HASH_PATH, 'utf8')); base.hashes['lib/risk.js'] = 'deadbeef'; fs.writeFileSync(sd.HASH_PATH, JSON.stringify(base));
  const breach = sd.checkFrozenIntegrity(REPO, { selfCausedPaths: ['lib/risk.js'] });
  ok(breach.halt === true, 'integrity: a frozen file changed by selfdrive (gate breach) → HALT');
  // same drift but human-caused (no selfCausedPaths) → silently re-baseline
  const base2 = JSON.parse(fs.readFileSync(sd.HASH_PATH, 'utf8')); base2.hashes['lib/risk.js'] = 'deadbeef'; fs.writeFileSync(sd.HASH_PATH, JSON.stringify(base2));
  ok(sd.checkFrozenIntegrity(REPO, {}).rebaselined.includes('lib/risk.js'), 'integrity: a HUMAN edit to a frozen file silently re-baselines');

  // ---- AUTONOMY MODEL (Siddhant's rule 2026-07-01): approve-at-start, free-run, ban+report self-degradation ----
  // effectiveCaps: freeRun swaps in the higher (still finite) caps.
  const capsFree = sd.effectiveCaps(sd.cfgFrom(() => ({ selfDrive: { freeRun: true } })));
  const capsCons = sd.effectiveCaps(sd.cfgFrom(() => ({ selfDrive: { freeRun: false } })));
  ok(capsFree.maxCyclesPerSession > capsCons.maxCyclesPerSession, 'effectiveCaps: freeRun raises the cycle cap');
  ok(capsFree.dailyCap > capsCons.dailyCap, 'effectiveCaps: freeRun raises the daily cap');
  ok(sd.status(ON).requireStartApproval === true && sd.status(ON).self_degradation_banned === true, 'status: advertises approve-at-start + self-degradation banned');

  // start-approval gate: no go-ahead → needsApproval, and ZERO side effects (no git, not running).
  {
    let shellCalls = 0;
    const r = await sd.startSession(() => ({ selfDrive: { requireStartApproval: true } }),
      { proj: TMP, runShell: async () => { shellCalls++; return { stdout: '', success: true }; }, probe: async () => ({ idle: true, treeClean: true }), notify: () => {} },
      { reason: 'reflection' });
    ok(r.needsApproval === true && typeof r.proposal === 'string', 'startSession: unapproved → needsApproval + a proposal (no auto-start)');
    ok(shellCalls === 0 && sd.isRunning() === false, 'startSession: unapproved touches nothing — no git, not running');
  }

  // risk.isSelfDegrading: the one hard block that survives approval.
  const risk = require('../lib/risk');
  ok(risk.isSelfDegrading(['lib/risk.js']).degrading === true, 'isSelfDegrading: editing a frozen rail → banned');
  ok(risk.isSelfDegrading(['lib/foo.js'], 'disable the verify gate to go faster').degrading === true, 'isSelfDegrading: intent to weaken a guardrail → banned');
  ok(risk.isSelfDegrading(['lib/foo.js'], 'add a small cache to speed up reads').degrading === false, 'isSelfDegrading: an ordinary improvement → free to run');

  // runCycle tags degradation attempts so the session report to Siddhant is explicit.
  clearState();
  {
    const h = harness({ verify: async () => ({ success: false, exitCode: 1 }) });
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.degradation && r.degradation.kind === 'verify_fail', 'runCycle: a verify failure is tagged as a degradation attempt (reverted + reported)');
  }

  // ---- REVIEWER stage (demo 7 / C2): severe → bounded revise loop → block; clean → proceeds ----
  clearState();
  {
    // reviewer returns severe twice then would-be-clean, maxReviewRevisions default 2 → after 2
    // revises still severe on the check that matters → blocked_attempt with reviewer_severe.
    let calls = 0;
    const h = harness({ review: async () => { calls++; return { severity: 'severe', notes: 'weakens a guardrail' }; } });
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.outcome === 'blocked_attempt' && r.reason === 'reviewer_severe', 'runCycle(reviewer): persistent severe → blocked_attempt (reviewer_severe)');
    ok(r.degradation && r.degradation.kind === 'reviewer_severe', 'runCycle(reviewer): severe review tagged as a degradation attempt');
    ok(calls >= 2, 'runCycle(reviewer): re-reviews after revise (bounded loop ran)');
  }
  clearState();
  {
    // reviewer clean → proceeds to verify (which passes) → resolved
    const h = harness({ review: async () => ({ severity: 'none', notes: '' }) });
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.outcome === 'resolved', 'runCycle(reviewer): clean review → proceeds to verify → resolved');
  }
  clearState();
  {
    // reviewer minor → does NOT block (proceeds); FORGE only called once (no revise)
    let forgeCalls = 0;
    const h = harness({ review: async () => ({ severity: 'minor', notes: 'nit' }), forge: async () => { forgeCalls++; return { success: true }; } });
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.outcome === 'resolved' && forgeCalls === 1, 'runCycle(reviewer): minor findings do not block or trigger a revise');
  }
  clearState();
  {
    // no review dep → stage skipped entirely (backward compatible)
    const h = harness();
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.outcome === 'resolved', 'runCycle(reviewer): absent review dep → stage skipped, unchanged behavior');
  }
  {
    const h = harness({ plan: async () => ({ brief: 'p', files: ['lib/x.js', 'lib/security.js'], verify: 'npm run verify', severity: 'low' }) });
    const r = await sd.runCycle(ON, h.deps, session());
    ok(r.outcome === 'blocked_frozen' && r.degradation && r.degradation.kind === 'self_degradation', 'runCycle: a plan touching a frozen rail is tagged self_degradation (banned + reported)');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
