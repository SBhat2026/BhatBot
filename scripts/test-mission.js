#!/usr/bin/env node
'use strict';
// Tests for lib/mission.js — the durable mission layer that lets work outlive a single agentLoop turn.
// Covers the five things a mission has to get right or it is worse than useless:
//   1. the GOAL round-trips VERBATIM through park→resume (it exists precisely because trimHistory
//      summarizes the head of history away);
//   2. the step JOURNAL survives a torn/corrupt line instead of throwing (losing one step beats
//      losing the run) and stays bounded;
//   3. REPLAY memoizes by (tool, args) signature and goes cold at the first divergence;
//   4. reapOrphans parks a dead process's mission and leaves a live one alone (crash recovery);
//   5. the durable CIRCUIT BREAKERS (resumeCount / spendUsd / age) are read off disk, so a restart
//      cannot reset them.
// Injected clock + temp $HOME → no sleeping, no real filesystem. Wired into `npm run verify`.
//   node scripts/test-mission.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mission-'));
const { createMissions, renderAnchor, renderPlan, parsePlan, digestResult, JOURNAL_MAX_BYTES } = require('../lib/mission');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

let CLOCK = 1_700_000_000_000;
const now = () => CLOCK;
const tick = (ms) => { CLOCK += ms; };
const M = createMissions({ dir: path.join(TMP, 'missions'), now });

// ---- open / meta ----
const GOAL = 'Refactor lib/fleet.js so the spend envelope actually caps launches — and do NOT touch main.js';
const m1 = M.open({ goal: GOAL, traceId: 't_abc', budgetUsd: 5 });
ok(typeof m1.id === 'string' && m1.id.startsWith('m_'), 'open: returns an m_-prefixed id');
ok(m1.meta.goal === GOAL, 'open: goal stored verbatim');
ok(m1.meta.status === 'running' && m1.meta.stepsUsed === 0 && m1.meta.resumeCount === 0, 'open: starts running with zeroed counters');
ok(m1.meta.traceId === 't_abc' && m1.meta.budgetUsd === 5, 'open: carries traceId + budget');
ok(fs.existsSync(path.join(m1.dir, 'mission.json')), 'open: mission.json written to disk');
ok(!fs.existsSync(path.join(m1.dir, 'mission.json.tmp')), 'open: no leftover .tmp (atomic rename completed)');

// ---- plan artifact ----
m1.plan.set(['read lib/fleet.js', 'find the envelope check', { text: 'add a bounded pool', status: 'doing' }, 'add a test']);
let plan = m1.plan.read();
ok(plan.length === 4 && plan[0].text === 'read lib/fleet.js', 'plan.set: items persist in order');
ok(plan[2].status === 'doing', 'plan.set: honours an explicit status');
m1.plan.mark(0, 'done');
m1.plan.mark(3, 'blocked', 'needs the pool first');
plan = m1.plan.read();
ok(plan[0].status === 'done', 'plan.mark: marks an item done');
ok(plan[3].status === 'blocked' && plan[3].note === 'needs the pool first', 'plan.mark: records a blocked reason');
ok(m1.plan.mark(99, 'done') === null, 'plan.mark: out-of-range index → null, no throw');
ok(m1.plan.mark(0, 'bogus') === null, 'plan.mark: unknown status → null, no throw');
const dig = m1.plan.digest();
ok(dig.total === 4 && dig.done === 1 && dig.open.length === 3, 'plan.digest: counts done vs open');
// plan.md is markdown on purpose — it must survive a hand-edit.
ok(parsePlan(renderPlan(plan)).length === 4, 'plan: render → parse round-trips');
ok(parsePlan('- [x] done thing\n- [ ] todo thing\nnot a plan line\n').length === 2, 'parsePlan: ignores non-item lines');

// ---- journal ----
m1.step({ name: 'read_file', input: { path: 'lib/fleet.js' }, result: { success: true, content: 'x'.repeat(5000) }, ms: 12 });
m1.step({ name: 'web_search', input: { q: 'bounded concurrency node' }, result: { success: true, results: [1, 2] }, ms: 400 });
m1.step({ name: 'run_shell', input: { cmd: 'npm test' }, result: { success: false, error: 'boom' }, ms: 900 });
let j = m1.journal();
ok(j.length === 3, 'step: three rows journaled');
ok(j[0].seq === 1 && j[2].seq === 3, 'step: seq increments');
ok(j[2].status === 'error', 'step: a {success:false} result is journaled as an error');
ok(j[0].bytes > 5000 && j[0].head.length <= 400, 'step: a large result is digested, not stored whole');
ok(typeof j[0].sha === 'string' && j[0].sha.length === 12, 'step: digest carries a content sha');
ok(m1.meta.stepsUsed === 3, 'step: stepsUsed tracked on the mission');

// A torn append (hard kill mid-write) must be skipped, not thrown.
fs.appendFileSync(path.join(m1.dir, 'journal.jsonl'), '{"seq":4,"name":"trunc');
ok(m1.journal().length === 3, 'journal: a corrupt trailing line is skipped, not thrown');
m1.step({ name: 'list_directory', input: { path: '.' }, result: { success: true } });
ok(m1.journal().length === 4, 'journal: appends still work after a corrupt line');

// ---- anchor (the highest-leverage piece) ----
const anchor = m1.anchor({ maxSteps: 120 });
ok(anchor.includes(GOAL), 'anchor: contains the goal VERBATIM (this is the whole point)');
ok(anchor.includes('MISSION ANCHOR'), 'anchor: carries its marker header');
ok(anchor.includes('add a bounded pool'), 'anchor: lists open plan items');
ok(!anchor.includes('read lib/fleet.js'), 'anchor: omits completed plan items (keeps it bounded)');
ok(/DONE SO FAR/.test(anchor) && anchor.includes('run_shell'), 'anchor: shows recent journal steps');
ok(anchor.includes('run_shell ✗'), 'anchor: flags a failed step so the model does not retry it blindly');
ok(/step 4 of 120/.test(anchor), 'anchor: reports step budget');
ok(!/resume/i.test(anchor.split('\n').find((l) => l.startsWith('NOTE:')) || ''), 'anchor: no resume note on a first attempt');

// renderAnchor is pure — testable with no fs at all, and must stay bounded as a run grows.
const big = renderAnchor({
  goal: 'g', plan: Array.from({ length: 50 }, (_, i) => ({ text: 'item ' + i, status: 'todo' })),
  recent: Array.from({ length: 50 }, (_, i) => ({ name: 'tool' + i, head: 'x'.repeat(500) })),
});
ok((big.match(/^ {2}\[/gm) || []).length === 10, 'renderAnchor: caps open plan items at 10');
ok((big.match(/^ {2}·/gm) || []).length === 5, 'renderAnchor: caps recent steps at 5');
ok(big.includes('and 40 more open'), 'renderAnchor: says how many items it elided (no silent truncation)');
ok(big.length < 3000, 'renderAnchor: stays bounded even with a 50-item plan and 50 steps');
ok(renderAnchor({ goal: 'g' }).includes('g'), 'renderAnchor: works with no plan and no journal');
const resumedAnchor = renderAnchor({ goal: 'g', resumed: true, resumeCount: 2, lastError: 'rate-budget: paced out' });
ok(/attempt 3/.test(resumedAnchor) && /rate-budget/.test(resumedAnchor), 'renderAnchor: a resumed run states the attempt + why the last one stopped');

// ---- history + park ----
const history = [{ role: 'user', content: GOAL }, { role: 'assistant', content: 'on it' }];
m1.saveHistory(history);
ok(JSON.stringify(m1.history()) === JSON.stringify(history), 'saveHistory/history: round-trips');
m1.spend(1.25);
ok(m1.meta.spendUsd === 1.25, 'spend: accumulates on the mission');

tick(1000);
m1.park('rate-budget: over the per-minute cap', history);
ok(m1.meta.status === 'parked' && m1.meta.parkedAt === CLOCK, 'park: status + parkedAt set');
ok(/rate-budget/.test(m1.meta.lastError), 'park: records why it parked');
ok(fs.existsSync(path.join(m1.dir, 'checkpoint.json')), 'park: writes a checkpoint');
const cp = JSON.parse(fs.readFileSync(path.join(m1.dir, 'checkpoint.json'), 'utf8'));
ok(Array.isArray(cp.open_tasks) && Array.isArray(cp.next_actions) && typeof cp.state_digest === 'string',
  'checkpoint: matches the lib/context.js resume-token shape');
ok(cp.open_tasks.length === 3, 'checkpoint: open_tasks excludes completed plan items');

// ---- resume: the goal MUST survive ----
const r1 = M.resume(m1.id);
ok(r1 && r1.meta.status === 'running', 'resume: flips parked → running');
ok(r1.meta.resumeCount === 1, 'resume: bumps the durable resume counter');
ok(r1.meta.goal === GOAL, 'resume: goal survived VERBATIM (the drift fix)');
ok(JSON.stringify(r1.history()) === JSON.stringify(history), 'resume: history restored');
ok(r1.plan.read().length === 4, 'resume: plan restored');
ok(r1.journal().length === 4, 'resume: journal restored');
ok(r1.anchorResume().includes('RESUMED run'), 'anchorResume: flags the run as resumed');

// ---- replay memoization ----
const rep = r1.replay();
ok(rep.size === 3, 'replay: only successful steps are cached (the failed run_shell is excluded)');
ok(rep.get('read_file', { path: 'lib/fleet.js' }) !== null, 'replay: hits on the same (tool, args) signature');
ok(rep.get('read_file', { path: 'OTHER.js' }) === null, 'replay: misses on different args');
ok(rep.get('run_shell', { cmd: 'npm test' }) === null, 'replay: a failed step is never replayed');
ok(rep.get('web_search', { q: 'bounded concurrency node' }).head.length > 0, 'replay: returns the cached digest');
rep.diverge();
ok(rep.active === false && rep.get('read_file', { path: 'lib/fleet.js' }) === null,
  'replay: goes cold at the first divergence (a changed run is no longer a faithful replay)');

// ---- orphan reaping (crash recovery) ----
const dead = M.open({ goal: 'killed mid-run' });
const alive = M.open({ goal: 'still going' });
tick(10 * 60 * 1000);          // both heartbeats now 10 min old…
alive.heartbeat();             // …but this one just checked in
const reaped = M.reapOrphans({ staleMs: 5 * 60 * 1000 });
ok(reaped.includes(dead.id), 'reapOrphans: parks a mission whose process died');
ok(!reaped.includes(alive.id), 'reapOrphans: leaves a live mission alone');
ok(M.attach(dead.id).meta.status === 'parked', 'reapOrphans: dead mission is now resumable');
ok(/process died/.test(M.attach(dead.id).meta.lastError), 'reapOrphans: records the reason');
ok(M.attach(alive.id).meta.status === 'running', 'reapOrphans: live mission stays running');

// ---- durable circuit breakers ----
{
  const B = createMissions({ dir: path.join(TMP, 'breakers'), now });
  const rate = B.open({ goal: 'rate-parked' });
  rate.park('rate-budget: paced out');
  // A rate park must wait a full OTPM window, not the short default backoff.
  ok(B.dueForResume().ready.length === 0, 'dueForResume: a just-parked mission is still cooling down');
  tick(10000);
  ok(B.dueForResume().ready.length === 0, 'dueForResume: a rate-budget park waits the long (90s) backoff');
  tick(85000);
  ok(B.dueForResume().ready.some((x) => x.id === rate.id), 'dueForResume: eligible once the rate window drains');

  const step = B.open({ goal: 'step-parked' });
  step.park('step-budget');
  tick(6000);
  ok(B.dueForResume().ready.some((x) => x.id === step.id), 'dueForResume: a step-budget park uses the short backoff');

  // Each breaker must fire off DISK state, so a restart cannot reset it.
  const spent = B.open({ goal: 'spendy' }); spent.spend(9.99); spent.park('step-budget'); tick(60000);
  const spentVerdict = B.dueForResume({ maxSpendUsd: 5 });
  ok(!spentVerdict.ready.some((x) => x.id === spent.id) && spentVerdict.expired.some((x) => x.id === spent.id && /spend/.test(x.reason)),
    'dueForResume: over the dollar cap → expired, not ready');

  const looper = B.open({ goal: 'looper' });
  for (let i = 0; i < 20; i++) { looper.park('step-budget'); B.resume(looper.id); }
  looper.park('step-budget'); tick(60000);
  ok(B.attach(looper.id).meta.resumeCount === 20, 'resume: counter persisted across 20 park/resume cycles');
  const loopVerdict = B.dueForResume({ maxResumes: 20 });
  ok(loopVerdict.expired.some((x) => x.id === looper.id && /resume limit/.test(x.reason)), 'dueForResume: over the resume cap → expired');

  const old = B.open({ goal: 'ancient' }); old.park('step-budget');
  tick(25 * 3600 * 1000);
  ok(B.dueForResume({ maxAgeHours: 24 }).expired.some((x) => x.id === old.id && /age/.test(x.reason)), 'dueForResume: past the age limit → expired');
}

// ---- list / attach / close / discard / prune ----
ok(M.attach('m_nonexistent') === null, 'attach: unknown id → null, no throw');
ok(M.list().length >= 3, 'list: enumerates missions');
ok(M.list({ status: 'parked' }).every((x) => x.status === 'parked'), 'list: filters by status');
r1.close('done');
ok(M.attach(r1.id).meta.status === 'done' && M.attach(r1.id).meta.endedAt, 'close: sets status + endedAt');
r1.close('nonsense-status');
ok(M.attach(r1.id).meta.status === 'done', 'close: an unknown status falls back to done');

const throwaway = M.open({ goal: 'trivial two-step chat turn' });
const tid = throwaway.id;
ok(throwaway.discard() === true && M.attach(tid) === null, 'discard: removes a mission entirely (short turns must not litter disk)');

tick(20 * 86400000);
const pruned = M.prune({ maxAgeDays: 14 });
ok(pruned.includes(r1.id), 'prune: drops a finished mission past the age cutoff');
ok(!pruned.includes(dead.id), 'prune: keeps parked missions regardless of age (they are still resumable)');

// ---- journal size guard ----
{
  const G = createMissions({ dir: path.join(TMP, 'guard'), now });
  const g = G.open({ goal: 'noisy' });
  fs.writeFileSync(path.join(g.dir, 'journal.jsonl'), 'x'.repeat(JOURNAL_MAX_BYTES + 1024));
  g.step({ name: 'read_file', input: {}, result: { success: true } });
  ok(fs.statSync(path.join(g.dir, 'journal.jsonl')).size < JOURNAL_MAX_BYTES, 'journal: truncated once past the size cap');
  ok(g.journal().length === 1, 'journal: still usable after truncation');
}

// ---- digestResult edge cases ----
ok(digestResult(undefined).bytes === 0, 'digestResult: undefined → empty, no throw');
ok(digestResult('plain string').head === 'plain string', 'digestResult: handles a raw string');
{
  const circular = {}; circular.self = circular;
  ok(typeof digestResult(circular).head === 'string', 'digestResult: a circular object degrades instead of throwing');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
