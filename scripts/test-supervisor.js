#!/usr/bin/env node
'use strict';
// Tests for lib/supervisor.js — the loop that keeps a fleet working for an hour without Siddhant.
//
// The assertions that matter are about what happens when things go WRONG, because an unattended hour
// is mostly things going wrong:
//   • an agent that talks beautifully and moves nothing must trip the stall wall, not run for an hour.
//     Progress is a change in the PLAN. This repo has livelocked twice on counting the wrong thing —
//     the call gate counted blocked attempts as calls, and the first fan-out run counted turns as work.
//   • an escalation must NOT block the loop; everything else keeps moving and only a genuinely idle
//     run waits, with a timeout, after which it proceeds on the stated assumption.
//   • every wall (clock, spend, ticks, consecutive failures) must actually stop it, and stopping must
//     be a report rather than a throw.
//   • a crashed run must be resumable, with its walls intact and its half-done item runnable again.
//
//   node scripts/test-supervisor.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSupervisor, planDigest } = require('../lib/supervisor');
const { createMissions } = require('../lib/mission');
const { createEscalations } = require('../lib/escalate');
const { createForge } = require('../lib/toolforge');
const realSandbox = require('../lib/sandbox');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const TMP = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sup-test-'));
// Real time, tiny delays: the loop's own pacing is what is under test, so a fake clock would hide it.
const fastOpts = { tickDelayMs: 1, idleWaitMs: 60, stallTicks: 8 };

// 14:00 local, for the ESCALATION clock only. Escalations stop ringing between 23:00 and 07:00 and
// fall back to their assumption instead, so a suite that let them read the wall clock would pass in
// the afternoon and fail overnight — which it did, at 03:40, on exactly the two assertions about
// calling him. The loop's own timing stays real; only the "what time is it for Siddhant" clock is fixed.
const DAYTIME = 1758600000000 + 14 * 3600 * 1000;

function rig(over = {}, opts = {}) {
  const dir = TMP();
  const events = [];
  const missions = createMissions({ dir: path.join(dir, 'missions') });
  const sup = createSupervisor({
    missions,
    runAgent: over.runAgent || (async ({ goal }) => ({ status: 'done', summary: 'did ' + goal, spendUsd: 0.01 })),
    decompose: over.decompose || (async ({ goal }) => [goal]),
    escalations: over.escalations,
    forge: over.forge,
    review: over.review,
    onEvent: (e) => events.push(e),
    log: over.log || (() => {}),
    sleep: over.sleep,
    now: over.now,
  }, { ...fastOpts, ...opts });
  return { sup, missions, events, dir };
}

(async () => {
  // ── the happy path ───────────────────────────────────────────────────────────────────────────────
  {
    const seen = [];
    const { sup, events } = rig({ runAgent: async ({ goal, name, designation }) => { seen.push({ goal, name, designation }); return { status: 'done', summary: 'ok', spendUsd: 0.01 }; } });
    const r = await sup.run({ goal: 'ship the thing', plan: ['research the options', 'write the code', 'render a diagram'] });
    ok(r.ok && r.stoppedBecause === 'complete', 'a plan whose items all succeed completes');
    ok(r.done.length === 3 && r.blocked.length === 0 && r.open.length === 0, 'every item is reported done');
    ok(Math.abs(r.spentUsd - 0.03) < 1e-6, 'spend is accumulated from the workers, not guessed');

    // The designations are what the office colours agents by, so they have to be right per item.
    const byGoal = Object.fromEntries(seen.map((s) => [s.goal, s.designation]));
    ok(byGoal['research the options'] === 'research' && byGoal['write the code'] === 'code' && byGoal['render a diagram'] === 'create',
      'each item is classified into its own designation, which is what the office colours by');
    ok(new Set(seen.map((s) => s.name)).size === 3, 'each item got its own named agent');

    const agentEvents = events.filter((e) => e.type === 'agent');
    ok(agentEvents.length >= 3 && agentEvents.every((e) => e.color && /^#/.test(e.color)),
      'every agent event carries the colour the UI should paint it, so the renderer never classifies');
    ok(events.some((e) => e.type === 'run-start') && events.some((e) => e.type === 'run-end'), 'the run brackets itself with events');
    ok(events.filter((e) => e.type === 'progress').length === 3, 'progress is emitted per completed item');
  }

  // ── it plans when it is not given a plan ─────────────────────────────────────────────────────────
  {
    const { sup } = rig({ decompose: async ({ goal }) => [`step one of ${goal}`, `step two of ${goal}`] });
    const r = await sup.run({ goal: 'do a big thing' });
    ok(r.done.length === 2, 'with no plan supplied it decomposes the goal');

    // A planner having a bad minute must not stop the run starting: a goal is still a goal.
    const { sup: s2 } = rig({ decompose: async () => { throw new Error('planner is down'); } });
    const r2 = await s2.run({ goal: 'still worth attempting' });
    ok(r2.ok && r2.done.length === 1 && r2.done[0] === 'still worth attempting',
      'a failed decompose falls back to working the goal directly rather than refusing to start');
  }

  // ── THE STALL WALL ───────────────────────────────────────────────────────────────────────────────
  {
    // An agent that always says "partial" is the shape of a real failure: every turn looks like
    // activity, the transcript grows, and the plan never moves. maxItemAttempts stops the item and the
    // run then has nothing runnable left.
    const { sup } = rig({ runAgent: async () => ({ status: 'partial', summary: 'making progress, honestly', spendUsd: 0.001 }) }, { maxItemAttempts: 2 });
    const r = await sup.run({ goal: 'g', plan: ['a task that never finishes'] });
    ok(!r.ok && (r.stoppedBecause === 'blocked' || r.stoppedBecause === 'stalled'), `an agent that never finishes an item stops the run (${r.stoppedBecause})`);
    ok(r.blocked.length === 1 && /attempts/.test(r.blocked[0].why), 'the item is reported blocked with the attempt count, not silently dropped');
    ok(r.spentUsd < 0.01, 'and it cost almost nothing, because it stopped instead of grinding');
  }

  // ── walls ────────────────────────────────────────────────────────────────────────────────────────
  {
    // SPEND. One expensive item, then the wall.
    const { sup } = rig({ runAgent: async () => ({ status: 'done', summary: 'expensive', spendUsd: 0.6 }) });
    const r = await sup.run({ goal: 'g', plan: ['a', 'b', 'c', 'd', 'e'], budgetUsd: 1.0 });
    ok(r.stoppedBecause === 'budget', 'the spend wall stops the run');
    ok(r.spentUsd >= 1.0 && r.open.length > 0, 'it stops WITH work outstanding and says so, rather than pretending to be done');

    // WALL CLOCK.
    const { sup: s2 } = rig({ runAgent: async () => { await new Promise((r2) => setTimeout(r2, 20)); return { status: 'done', summary: 'slow', spendUsd: 0 }; } });
    const r2 = await s2.run({ goal: 'g', plan: Array.from({ length: 50 }, (_, i) => 'item ' + i), wallClockMs: 120, width: 1 });
    ok(r2.stoppedBecause === 'wall-clock', 'the wall clock stops the run');
    ok(r2.done.length > 0 && r2.open.length > 0, 'the clock wall keeps what was finished and reports the rest as open');

    // CONSECUTIVE FAILURES.
    const { sup: s3 } = rig({ runAgent: async () => ({ status: 'failed', summary: 'exploded' }) }, { maxConsecutiveFailures: 3, maxItemAttempts: 9 });
    const r3 = await s3.run({ goal: 'g', plan: ['a', 'b', 'c', 'd', 'e', 'f'] });
    ok(r3.stoppedBecause === 'failures', 'a run where everything fails stops on consecutive failures rather than retrying forever');

    // A worker that THROWS is a failed item, not a crashed run.
    const { sup: s4 } = rig({ runAgent: async () => { throw new Error('kaboom'); } }, { maxConsecutiveFailures: 2, maxItemAttempts: 1 });
    const r4 = await s4.run({ goal: 'g', plan: ['x', 'y', 'z'] });
    ok(r4 && r4.stoppedBecause, 'a worker that throws produces a report, not an exception out of run()');
  }

  // ── escalation does not block the loop ───────────────────────────────────────────────────────────
  {
    const sent = [];
    const escalations = createEscalations({ dir: TMP(), now: () => DAYTIME, notify: async (m, u, o) => { sent.push({ m, u, o }); return { sent: true, via: 'call' }; }, opts: { maxPerHour: 99 } });
    const order = [];
    const { sup } = rig({
      escalations,
      runAgent: async ({ goal }) => {
        order.push(goal);
        if (goal === 'the one that needs a decision') {
          return { status: 'blocked', summary: 'need a call', need: { kind: 'human', question: 'Which account?', assumption: 'the primary one' } };
        }
        await new Promise((r) => setTimeout(r, 5));
        return { status: 'done', summary: 'fine', spendUsd: 0.001 };
      },
    });
    const t0 = Date.now();
    const r = await sup.run({ goal: 'g', plan: ['the one that needs a decision', 'independent work A', 'independent work B'], width: 2 });
    const ms = Date.now() - t0;

    ok(sent.length === 1 && sent[0].u === 'call', 'the blocked item escalated, asking to call');
    ok(order.includes('independent work A') && order.includes('independent work B'),
      'the OTHER items were worked anyway — an escalation must not freeze the run');
    ok(r.done.length === 2, 'the independent work finished');
    // The escalated item was retried once on the assumption after the idle wait, which is the correct
    // end state for a question nobody answered: proceed, and say what you assumed.
    ok(r.waitingOnSiddhant.length + r.blocked.length >= 1, 'the escalated item is still reported as needing him');
    ok(ms < 4000, `the whole run took ${ms}ms — it waited its bounded idle window, not indefinitely`);
  }

  // ── an answer unblocks the item ──────────────────────────────────────────────────────────────────
  {
    const escalations = createEscalations({ dir: TMP(), now: () => DAYTIME, notify: async () => ({ sent: true, via: 'telegram' }), opts: { maxPerHour: 99 } });
    let asked = 0;
    const { sup, events } = rig({
      escalations,
      runAgent: async ({ goal, context }) => {
        if (goal === 'needs input') {
          asked++;
          if (asked === 1) return { status: 'blocked', summary: 'ask him', need: { kind: 'human', question: 'Which one?', assumption: 'the first' } };
          // The second attempt must be able to SEE the answer, or unblocking achieved nothing.
          return { status: 'done', summary: 'used his answer', spendUsd: 0 };
        }
        return { status: 'done', summary: 'ok', spendUsd: 0 };
      },
    }, { idleWaitMs: 2000 });

    // Answer it shortly after the escalation goes out.
    const answerSoon = setInterval(() => { if (escalations.pending().length) { escalations.answer('use the Princeton one'); clearInterval(answerSoon); } }, 10);
    const r = await sup.run({ goal: 'g', plan: ['needs input'] });
    clearInterval(answerSoon);

    ok(r.ok && r.done.length === 1, 'an answer that arrives mid-run unblocks the item and the run finishes');
    ok(asked === 2, 'the item was retried after the answer, not abandoned');
    const unblocked = events.find((e) => e.type === 'unblocked');
    ok(unblocked && /Princeton/.test(unblocked.answer), 'the unblock event carries what he actually said');
    ok(unblocked && unblocked.fromSiddhant === true,
      'and marks it as HIS answer rather than an assumption — writing "Siddhant said" when he was asleep puts a fabrication in the durable record');
  }

  // ── an answer nobody gave is not an answer he gave ───────────────────────────────────────────────
  {
    const NIGHT = 1758600000000 + 3 * 3600 * 1000;    // 03:00 local — he is asleep
    const escalations = createEscalations({ dir: TMP(), now: () => NIGHT, notify: async () => ({ sent: true, via: 'telegram' }), opts: { maxPerHour: 99 } });
    let attempt = 0;
    let seenContext = '';
    const { sup, events } = rig({
      escalations,
      runAgent: async ({ goal, item }) => {
        attempt++;
        if (attempt === 1) return { status: 'blocked', summary: 'ask', need: { kind: 'human', question: 'Which style?', assumption: 'APA' } };
        seenContext = (item && item.note) || '';
        return { status: 'done', summary: 'proceeded', spendUsd: 0 };
      },
    }, { idleWaitMs: 200 });
    const r = await sup.run({ goal: 'g', plan: ['needs a decision at 3am'] });

    ok(r.ok, 'a question asked at 3am does not stall the run until morning');
    const u = events.find((e) => e.type === 'unblocked');
    ok(u && u.fromSiddhant === false, 'the unblock is marked as NOT from Siddhant');
    ok(/no answer — proceeding on the assumption/.test(seenContext),
      `the plan note says it was an assumption, so the next agent is not told he said something he did not (got "${seenContext}")`);
  }

  // ── it forges a tool it does not have ───────────────────────────────────────────────────────────
  {
    const forge = createForge({ dir: TMP(), sandbox: realSandbox });
    let attempt = 0;
    const { sup, events } = rig({
      forge,
      runAgent: async ({ goal }) => {
        attempt++;
        if (attempt === 1) {
          return { status: 'blocked', summary: 'no tool for this',
            need: { kind: 'tool', name: 'roman_numeral', purpose: 'Convert an integer to Roman numerals.',
              code: 'const M=[[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]]; let n=Number(input.n),out=""; for(const [v,s] of M){ while(n>=v){out+=s;n-=v;} } return out;',
              tests: [{ input: { n: 1994 }, expect: { equals: 'MCMXCIV' } }, { input: { n: 4 }, expect: { equals: 'IV' } }] } };
        }
        return { status: 'done', summary: 'used the forged tool', spendUsd: 0 };
      },
    });
    const r = await sup.run({ goal: 'g', plan: ['write MCMXCIV somewhere'] });
    ok(r.ok, 'the run finished after forging the tool it was missing');
    ok(r.forged.includes('roman_numeral'), 'the report names what it built');
    ok(events.some((e) => e.type === 'forged'), 'and says so as it happens, so the office can show it');
    const call = await forge.run('roman_numeral', { n: 2026 });
    ok(call.success && call.result === 'MMXXVI', 'the forged tool is real and still works afterwards');
  }

  // ── a forge that fails its own tests becomes a question, not another attempt ─────────────────────
  {
    const forge = createForge({ dir: TMP(), sandbox: realSandbox });
    const sent = [];
    const escalations = createEscalations({ dir: TMP(), now: () => DAYTIME, notify: async (m) => { sent.push(m); return { sent: true, via: 'telegram' }; }, opts: { maxPerHour: 99 } });
    const { sup } = rig({ forge, escalations,
      runAgent: async () => ({ status: 'blocked', summary: 'x', need: { kind: 'tool', name: 'broken_tool', purpose: 'p', code: 'return 1;', tests: [{ input: {}, expect: { equals: 2 } }] } }),
    }, { maxItemAttempts: 1, idleWaitMs: 40 });
    await sup.run({ goal: 'g', plan: ['needs a tool that cannot be built'] });
    ok(sent.length === 1 && /failed its own tests/.test(sent[0]),
      'a tool that fails its own tests escalates to Siddhant instead of being retried — the agent could not close the gap itself');
  }

  // ── an agent may grow the plan, but not without limit ────────────────────────────────────────────
  {
    const { sup, events } = rig({
      runAgent: async ({ goal }) => goal === 'the root task'
        ? { status: 'done', summary: 'found more work', newItems: ['a discovered task', 'another discovered task'] }
        : { status: 'done', summary: 'ok' },
    });
    const r = await sup.run({ goal: 'g', plan: ['the root task'] });
    ok(r.done.length === 3, 'work an agent discovers is added to the plan and then actually done');
    ok(events.some((e) => e.type === 'plan-grew'), 'plan growth is an event, so it is visible rather than surprising');

    const { sup: s2 } = rig({ runAgent: async () => ({ status: 'done', summary: 'more', newItems: ['x' + Math.random(), 'y' + Math.random()] }) }, { planMax: 6 });
    const r2 = await s2.run({ goal: 'g', plan: ['seed'] });
    ok(r2.done.length + r2.open.length + r2.blocked.length <= 6, 'an agent that keeps discovering work cannot grow the plan past planMax');
  }

  // ── resume ───────────────────────────────────────────────────────────────────────────────────────
  {
    const dir = TMP();
    const missions = createMissions({ dir: path.join(dir, 'missions') });
    const mk = (runAgent, o = {}) => createSupervisor({ missions, runAgent, decompose: async ({ goal }) => [goal], onEvent: () => {} }, { ...fastOpts, ...o });

    // First run: the clock wall stops it partway.
    const s1 = mk(async () => { await new Promise((r) => setTimeout(r, 15)); return { status: 'done', summary: 'ok', spendUsd: 0.01 }; });
    const r1 = await s1.run({ goal: 'a long job', plan: ['one', 'two', 'three', 'four', 'five'], wallClockMs: 40, width: 1 });
    ok(r1.stoppedBecause === 'wall-clock' && r1.open.length > 0, 'the first pass stopped at the wall with work left');
    ok(missions.list({ status: 'parked' }).some((m) => m.id === r1.missionId), 'a wall PARKS the mission — it is one resume away, not over');

    // Resume: the rest gets done, and the spend it already made is still on the meter.
    const s2 = mk(async () => ({ status: 'done', summary: 'ok', spendUsd: 0.01 }));
    const r2 = await s2.resume(r1.missionId, { wallClockMs: 30000 });
    ok(r2.ok && r2.done.length === 5, 'the resumed run finishes every item, including the ones the first pass did');
    ok(r2.spentUsd > r1.spentUsd, 'spend carried across the restart — a wall a crash-loop could reset is not a wall');
    ok((missions.attach(r1.missionId).meta || {}).resumeCount === 1, 'the resume counter is durable, which is what stops a runaway');

    ok((await mk(async () => ({ status: 'done' })).resume('m_nonexistent')).ok === false, 'resuming a mission that does not exist says so');
  }

  // ── a half-done item from a dead process is runnable again ───────────────────────────────────────
  {
    const dir = TMP();
    const missions = createMissions({ dir: path.join(dir, 'missions') });
    const sup = createSupervisor({ missions, runAgent: async () => ({ status: 'done', summary: 'ok' }), onEvent: () => {} }, fastOpts);
    const h = missions.open({ goal: 'interrupted', plan: ['was in flight when the app died', 'untouched'] });
    h.plan.mark(0, 'doing', 'VALE');
    h.park('process died');
    const r = await sup.resume(h.id, { wallClockMs: 20000 });
    ok(r.ok && r.done.length === 2,
      'an item left `doing` by a dead process is made runnable again — otherwise it is neither runnable nor finishable and the run stalls blaming itself for a crash');
  }

  // ── THE PARK REASON IS A CONTRACT ────────────────────────────────────────────────────────────────
  // main.js decides whether to AUTO-CONTINUE a parked run by reading its lastError. A run that ran out
  // of TIME has more to do and picking it up is the whole point of "several hours". A run that ran out
  // of MONEY, or failed five times running, or was stopped by hand, would hit the same wall seconds
  // after resuming — auto-continuing it is a 30-second loop that spends real money to learn nothing.
  // That decision is only sound if the reason is recorded verbatim, so this pins it.
  {
    const cases = [
      ['wall-clock', { plan: ['a', 'b', 'c', 'd'], wallClockMs: 30 }, async () => { await new Promise((r) => setTimeout(r, 20)); return { status: 'done', summary: 'ok' }; }],
      ['budget', { plan: ['a', 'b', 'c'], budgetUsd: 0.05 }, async () => ({ status: 'done', summary: 'ok', spendUsd: 0.06 })],
    ];
    for (const [want, spec, runAgent] of cases) {
      const dir = TMP();
      const missions = createMissions({ dir: path.join(dir, 'missions') });
      const sup = createSupervisor({ missions, runAgent, onEvent: () => {} }, { ...fastOpts, width: 1 });
      const r = await sup.run({ goal: 'g', ...spec });
      const meta = (missions.attach(r.missionId) || {}).meta || {};
      ok(r.stoppedBecause === want, `a ${want} wall reports itself as "${want}"`);
      ok(String(meta.lastError).includes(want),
        `and records "${want}" verbatim in lastError, which is what decides whether to auto-continue (got "${meta.lastError}")`);
    }
  }

  // ── a cooperative stop ───────────────────────────────────────────────────────────────────────────
  {
    let stopNow = false;
    const dir = TMP();
    const missions = createMissions({ dir: path.join(dir, 'missions') });
    let started = 0;
    const sup = createSupervisor({
      missions, onEvent: () => {}, shouldStop: () => stopNow,
      runAgent: async () => { started++; if (started === 2) stopNow = true; await new Promise((r) => setTimeout(r, 5)); return { status: 'done', summary: 'ok', spendUsd: 0 }; },
    }, { ...fastOpts, width: 1 });
    const r = await sup.run({ goal: 'g', plan: ['a', 'b', 'c', 'd', 'e'] });
    ok(r.stoppedBecause === 'stopped', 'a stop request stops the run at the next scheduling pass');
    ok(r.done.length === 2 && r.open.length === 3,
      'it drains what was already in flight rather than orphaning that spend — the money is gone either way and a discarded result has no upside');
    ok(missions.list({ status: 'parked' }).some((m) => m.id === r.missionId), 'a stopped run is parked, so it can be resumed');
  }

  // ── SOMEBODY ASKS WHETHER NINE DONE ITEMS ANSWER THE QUESTION ────────────────────────────────────
  // lib/custodian.js guarded the drone fan-out and nothing else, which left the biggest fan-out in the
  // app — an hour of unattended work — reporting "nine done" with nobody having asked whether those
  // nine answer what was asked. Its verdict is ATTACHED, never substituted: a reviewer that can
  // rewrite the report is not a reviewer, it is a second author.
  {
    let asked = null;
    const { sup, events } = rig({
      review: async (q) => { asked = q; return { verdict: 'sendback', reason: 'none of this touches the actual question' }; },
    });
    const r = await sup.run({ goal: 'find out why the calls fail', plan: ['read the logs', 'check the webhook'] });

    ok(asked && asked.goal === 'find out why the calls fail', 'the reviewer is given the goal VERBATIM, not a paraphrase of it');
    ok(asked.deliverable.includes('read the logs') && asked.trace.length === 2, 'and what was actually done, plus the whole plan as trace');
    ok(r.custodian && r.custodian.verdict === 'sendback', "the verdict rides along with the report");
    ok(r.done.length === 2 && r.ok, 'and the report itself is unchanged — a doubt is attached, never substituted');
    ok(events.some((e) => e.type === 'doubt'), 'a non-accept verdict is an event, so the doubt is visible while it happens rather than only in the JSON');

    // An ACCEPT should not produce a doubt event, or the signal means nothing.
    const { sup: s2, events: e2 } = rig({ review: async () => ({ verdict: 'accept' }) });
    const r2 = await s2.run({ goal: 'g', plan: ['a'] });
    ok(r2.custodian.verdict === 'accept' && !e2.some((e) => e.type === 'doubt'), 'an accept is recorded quietly');

    // A reviewer that throws must not take the run's report with it — the work still happened.
    const { sup: s3 } = rig({ review: async () => { throw new Error('judge is down'); } });
    const r3 = await s3.run({ goal: 'g', plan: ['a'] });
    ok(r3.ok && r3.custodian.verdict === 'error' && /judge is down/.test(r3.custodian.reason),
      'a reviewer that throws is recorded as an error and the report survives it');

    // Nothing finished → nothing to judge. A reviewer's opinion of an empty deliverable is noise.
    let calledOnNothing = false;
    const { sup: s4 } = rig({
      review: async () => { calledOnNothing = true; return { verdict: 'accept' }; },
      runAgent: async () => ({ status: 'failed', summary: 'no' }),
    }, { maxConsecutiveFailures: 2, maxItemAttempts: 1 });
    await s4.run({ goal: 'g', plan: ['a', 'b'] });
    ok(!calledOnNothing, 'a run that finished nothing is not sent for review — it has already said so plainly');

    // And with no reviewer wired at all, the run is exactly as it was.
    const { sup: s5 } = rig({});
    const r5 = await s5.run({ goal: 'g', plan: ['a'] });
    ok(r5.ok && r5.custodian === null, 'with no reviewer the report carries null rather than a fabricated approval');
  }

  // ── planDigest is what progress is measured against ──────────────────────────────────────────────
  {
    const a = [{ text: 'x', status: 'todo' }, { text: 'y', status: 'todo' }];
    ok(planDigest(a) === planDigest([{ text: 'x', status: 'todo' }, { text: 'y', status: 'todo' }]), 'the same plan digests the same');
    ok(planDigest(a) !== planDigest([{ text: 'x', status: 'done' }, { text: 'y', status: 'todo' }]), 'a status change is progress');
    ok(planDigest(a) !== planDigest([...a, { text: 'z', status: 'todo' }]), 'a new item is progress');
    // A note is NOT progress: an agent that keeps rewriting its own notes is exactly the failure the
    // stall wall exists to catch, so the digest must ignore them.
    ok(planDigest(a) === planDigest([{ text: 'x', status: 'todo', note: 'thinking about it' }, { text: 'y', status: 'todo' }]),
      'a changed NOTE is not progress — an agent narrating itself is not an agent working');
  }

  // ── the roster is what the office renders ────────────────────────────────────────────────────────
  {
    let snapshot = null;
    const { sup } = rig({ runAgent: async () => { snapshot = sup.roster(); return { status: 'done', summary: 'ok' }; } });
    await sup.run({ goal: 'g', plan: ['research something'] });
    ok(snapshot && snapshot.length === 1 && snapshot[0].designation === 'research' && /^#/.test(snapshot[0].color) && snapshot[0].label === 'Research',
      'roster() gives the office a name, a designation, its label and its colour for every live agent');
    ok(sup.roster().length === 0, 'and it is empty once the run is over — a finished agent is not on the floor');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} supervisor: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
