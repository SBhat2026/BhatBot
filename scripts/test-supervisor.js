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
    widthCaps: over.widthCaps,
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

  // ── WAITING MUST NOT SPEND THE CHAINING ALLOWANCE ────────────────────────────────────────────────
  // The run parks itself while it waits for an answer, which is honest — it really is parked, and a
  // crash mid-wait should be recoverable. But resumeCount is the circuit breaker that decides how many
  // times a long job may be picked back up, and going through missions.resume() to carry on would
  // spend a tenth of that allowance on two pauses the run made on purpose.
  {
    const dir = TMP();
    const missions = createMissions({ dir: path.join(dir, 'missions') });
    const escalations = createEscalations({ dir: TMP(), now: () => DAYTIME, notify: async () => ({ sent: true, via: 'call' }), opts: { maxPerHour: 99 } });
    const sup = createSupervisor({
      missions, escalations, onEvent: () => {},
      runAgent: async () => ({ status: 'blocked', summary: 'ask', need: { kind: 'human', question: 'which one?', assumption: 'the first' } }),
    }, { ...fastOpts, idleWaitMs: 40, maxItemAttempts: 1 });

    const r = await sup.run({ goal: 'g', plan: ['needs a decision'] });
    const meta = (missions.attach(r.missionId) || {}).meta || {};
    ok((meta.resumeCount || 0) === 0,
      `an internal wait does not count as a resume (resumeCount ${meta.resumeCount || 0} after waiting)`);
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

  // ── AN AGENT THAT KEEPS ASKING THE SAME QUESTION MUST NOT RUN FOREVER ────────────────────────────
  // Found by an hour-long soak and by nothing else. Refunding an attempt for getting an answer is
  // right; refunding it EVERY time is a livelock. The item escalates, the question dedupes onto an
  // escalation that is already answered, applyAnswers unblocks it immediately, the attempt comes
  // back, and it escalates again. Three such items took all three worker slots and held them for half
  // an hour — 591 journal entries across three of eight hundred items, while 779 never got a turn.
  //
  // The stall wall could not see it, and that is the instructive part: the plan WAS changing on every
  // pass, blocked → todo → blocked. Progress by the letter of the definition, livelock by any other
  // measure. So the bound cannot be another progress heuristic — it has to be a count nothing can
  // give back.
  {
    const escalations = createEscalations({ dir: TMP(), now: () => DAYTIME, notify: async () => ({ sent: true, via: 'call' }), opts: { maxPerHour: 99 } });
    let calls = 0;
    const { sup } = rig({
      escalations,
      // A pathological worker: it is TOLD the answer and asks again anyway. A real agent can do this,
      // so the supervisor has to be able to survive it.
      runAgent: async ({ goal }) => {
        calls++;
        if (goal === 'the one that never stops asking') {
          return { status: 'blocked', summary: 'asking again', need: { kind: 'human', question: 'which style?', assumption: 'APA' } };
        }
        return { status: 'done', summary: 'ok', spendUsd: 0 };
      },
    }, { maxItemAttempts: 2, idleWaitMs: 50, width: 1 });

    // Answer it the instant it is asked, which is what makes the loop tight.
    const answerer = setInterval(() => { try { if (escalations.pending().length) escalations.answer('Chicago'); } catch {} }, 5);
    const t0 = Date.now();
    const r = await sup.run({ goal: 'g', plan: ['the one that never stops asking', 'a', 'b', 'c'], wallClockMs: 15000 });
    clearInterval(answerer);
    const ms = Date.now() - t0;

    ok(r.stoppedBecause !== 'wall-clock', `the run ended on its own rather than being cut off by the clock (${r.stoppedBecause}, ${ms}ms)`);
    ok(calls < 12, `the asking item was run a bounded number of times (${calls} worker calls in total)`);
    ok(r.done.length === 3, 'and the OTHER three items were all finished — one greedy item did not starve the rest');
    ok(r.blocked.length === 1 && /attempts/.test(r.blocked[0].why), 'the asking item is reported blocked with its attempt count');
  }

  // ── FORGING AND ASKING ARE NOT FAILED ATTEMPTS ───────────────────────────────────────────────────
  // maxItemAttempts is two: one go and one retry. An item that stopped to BUILD A TOOL, or to ASK a
  // question, was not tried and found wanting — it was tried and found to need something that now
  // exists. Charging it an attempt means it gets one real go after building its own tool, which is the
  // opposite of what forging is for, and an answer that arrives for an item already out of tries.
  {
    const forge = createForge({ dir: TMP(), sandbox: realSandbox });
    let n = 0;
    const { sup } = rig({
      forge,
      runAgent: async () => {
        n++;
        if (n === 1) return { status: 'blocked', summary: 'x', need: { kind: 'tool', name: 'doubler', purpose: 'Double a number.', code: 'return Number(input.n) * 2;', tests: [{ input: { n: 3 }, expected: 6 }] } };
        if (n === 2) return { status: 'partial', summary: 'nearly' };          // a REAL attempt
        return { status: 'done', summary: 'used it', spendUsd: 0 };
      },
    }, { maxItemAttempts: 2 });
    const r = await sup.run({ goal: 'g', plan: ['needs a tool then two goes'] });
    ok(r.ok && n === 3,
      `forging did not cost one of the two attempts (${n} worker calls: forge, a real try, then success)`);
  }
  {
    const escalations = createEscalations({ dir: TMP(), now: () => DAYTIME, notify: async () => ({ sent: true, via: 'call' }), opts: { maxPerHour: 99 } });
    let n = 0;
    const { sup } = rig({
      escalations,
      runAgent: async () => {
        n++;
        if (n === 1) return { status: 'blocked', summary: 'x', need: { kind: 'human', question: 'which?', assumption: 'the first' } };
        if (n === 2) return { status: 'partial', summary: 'nearly' };          // a REAL attempt
        return { status: 'done', summary: 'done', spendUsd: 0 };
      },
    }, { maxItemAttempts: 2, idleWaitMs: 2000 });
    const answerSoon = setInterval(() => { if (escalations.pending().length) { escalations.answer('the second one'); clearInterval(answerSoon); } }, 10);
    const r = await sup.run({ goal: 'g', plan: ['needs an answer then two goes'] });
    clearInterval(answerSoon);
    ok(r.ok && n === 3, `asking did not cost one of the two attempts either (${n} worker calls)`);
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

  // ── PARALLEL HAS TO BE SMARTER, NOT JUST FASTER ──────────────────────────────────────────────────
  // Three agents working three items at once run completely blind to each other unless something
  // carries what one learns to the others. The one that discovers the API needs an account cannot warn
  // the two about to hit the same wall, and the plan finds out three items later.
  //
  // The supervisor posts on the workers' BEHALF rather than handing them a tool, because an agent that
  // forgets to post is the normal case and a coordination channel that only works when everyone
  // remembers to use it does not work.
  {
    const seenContext = [];
    const { sup } = rig({
      runAgent: async ({ goal, context, board }) => {
        seenContext.push({ goal, context: context || '', hasBoard: !!board });
        await new Promise((r) => setTimeout(r, 5));
        return goal === 'the one that learns something'
          ? { status: 'done', summary: 'the endpoint needs an account token' }
          : { status: 'done', summary: 'fine' };
      },
    }, { width: 1 });
    const r = await sup.run({ goal: 'g', plan: ['the one that learns something', 'a later item', 'a third item'] });

    ok(r.boardFile && /blackboard\.jsonl$/.test(r.boardFile), 'the run has a blackboard, and the report says where it is');
    ok(fs.existsSync(r.boardFile), 'and it is a real file, so the run can be read back after the fact');
    const posts = fs.readFileSync(r.boardFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(posts.length >= 6, `both ends of every item are posted (${posts.length} posts for 3 items)`);
    ok(posts.some((p) => p.kind === 'status' && /starting/.test(p.text)), 'a status when an item starts');
    ok(posts.some((p) => p.kind === 'finding' && /account token/.test(p.text)),
      'and a FINDING carrying what was actually learned, not just that something finished');

    // The point of all of it: a LATER agent can see it.
    const later = seenContext.find((c) => c.goal === 'a third item');
    ok(later && /account token/.test(later.context),
      'an agent launched later sees what an earlier one learned — this is the whole reason the board exists');
    ok(seenContext.every((c) => c.hasBoard), 'every worker is handed the board too, so it can post more than the supervisor knows');

    // The FIRST agent cannot have seen anything, which is the control: if it had, the context would be
    // coming from somewhere other than the board and the assertion above would prove nothing.
    ok(!/account token/.test(seenContext[0].context), 'the first agent saw nothing — the board is the source, not the plan text');
  }

  // A failure is posted as a NEED rather than a finding: a sibling about to hit the same wall wants to
  // know it is there, and that is a different signal from "here is what I learned".
  {
    const { sup } = rig({ runAgent: async ({ goal }) => (goal === 'a' ? { status: 'blocked', summary: 'the token is missing' } : { status: 'done', summary: 'ok' }) },
      { maxItemAttempts: 1 });
    const r = await sup.run({ goal: 'g', plan: ['a', 'b'] });
    const posts = fs.readFileSync(r.boardFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(posts.some((p) => p.kind === 'need' && /token is missing/.test(p.text)),
      'a blocked item posts a NEED — a wall a sibling is about to hit is a different signal from a lesson');
  }
  {
    // A partial is a lesson, not a wall. If it posted a need, "need" would mean "an item did not
    // finish" — which the plan already says — and the signal that somebody is about to walk into
    // something would be buried under it.
    const { sup } = rig({ runAgent: async ({ goal }) => (goal === 'a' ? { status: 'partial', summary: 'got halfway, the schema is nested' } : { status: 'done', summary: 'ok' }) },
      { maxItemAttempts: 1 });
    const r = await sup.run({ goal: 'g', plan: ['a', 'b'] });
    const posts = fs.readFileSync(r.boardFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const partial = posts.find((p) => /schema is nested/.test(p.text));
    ok(partial && partial.kind === 'finding', 'a PARTIAL posts a finding — half-learned is still learned');
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

  // ── A ROUGH PATCH IS NOT A BROKEN RUN ────────────────────────────────────────────────────────────
  // A 62-minute soak died on this: 256 items verified, then five consecutive model timeouts during a
  // burst of unrelated load, and the consecutive-failure wall retired it as though nothing had ever
  // worked. The streak alone cannot tell "everything is broken" from "half an hour of success and a
  // bad minute", and only the first is what that wall is for.
  {
    let n = 0;
    const { sup } = rig({
      // Thirty successes, then a burst of five failures, then fine again.
      runAgent: async () => {
        n++;
        if (n > 30 && n <= 35) return { status: 'failed', summary: 'model timed out' };
        return { status: 'done', summary: 'ok' };
      },
    }, { maxConsecutiveFailures: 5, maxItemAttempts: 3, width: 1 });
    // 36 items, deliberately under the 40-item planMax — an earlier version of this asked for 45 and
    // then asserted that 40+ finished, which the cap makes arithmetically impossible.
    const r = await sup.run({ goal: 'g', plan: Array.from({ length: 36 }, (_, i) => `read the paper, part ${i}`) });
    ok(r.stoppedBecause !== 'failures',
      `a run with a track record survives a five-failure burst (stopped: ${r.stoppedBecause})`);
    ok(r.done.length >= 30, `and gets on with the work (${r.done.length} of 36 done)`);
  }
  {
    // But a run where the recent window really IS mostly failures still stops — the wall has to keep
    // working, or it has just been deleted.
    const { sup } = rig({ runAgent: async () => ({ status: 'failed', summary: 'exploded' }) },
      { maxConsecutiveFailures: 5, maxItemAttempts: 9, width: 1 });
    const r = await sup.run({ goal: 'g', plan: Array.from({ length: 20 }, (_, i) => `item ${i}`) });
    ok(r.stoppedBecause === 'failures', `a genuinely broken run still stops (${r.stoppedBecause})`);
  }

  // ── ONE ARBITER, AND IT SAYS WHO BOUND IT ────────────────────────────────────────────────────────
  // Admission, the cost pilot and the machine tier all want to set the agent count. Two of them will
  // eventually disagree, and without a single owner the loser is an evening spent asking "who lowered
  // my width".
  {
    // Exactly one place in the file computes it. A second would be the whole bug.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'supervisor.js'), 'utf8');
    const sites = (src.match(/function widthNow\(/g) || []).length;
    ok(sites === 1, `exactly one function decides width (found ${sites})`);
    ok(/bindingConstraint/.test(src), 'and it names what bound it');
  }
  {
    let cap = 5;
    const seen = [];
    const { sup, events } = rig({
      widthCaps: { admission: () => cap },
      runAgent: async () => { await new Promise((r) => setTimeout(r, 12)); return { status: 'done', summary: 'ok' }; },
    }, { width: 5 });
    const items = Array.from({ length: 14 }, (_, i) => `read the paper on electrode wear, part ${i}`);
    const p = sup.run({ goal: 'g', plan: items });
    setTimeout(() => { cap = 1; }, 40);      // admission tightens mid-run
    const r = await p;
    ok(r.ok, 'the run finishes while a cap moves under it');
    const widths = events.filter((e) => e.type === 'width');
    ok(widths.length >= 2, `width changed during the run (${widths.map((w) => w.value).join(' → ')})`);
    ok(widths.some((w) => w.value === 1 && w.bindingConstraint === 'admission'),
      'and the narrowing is attributed to admission, not left anonymous');
    void seen;
  }
  {
    // Nothing can raise width above what the run asked for.
    const { sup, events } = rig({ widthCaps: { generous: () => 99 } }, { width: 2 });
    await sup.run({ goal: 'g', plan: ['read a', 'read b', 'read c'] });
    const w = events.filter((e) => e.type === 'width');
    ok(w.every((x) => x.value <= 2), 'a cap above the request cannot raise it');
    ok(w.length && w[0].bindingConstraint === 'spec', 'and the request itself is named as the binding constraint');
  }
  {
    // An absent or broken controller has NO opinion — it must not be able to stop the run by
    // defaulting to zero.
    const { sup } = rig({ widthCaps: { broken: () => { throw new Error('nope'); }, silent: () => null } }, { width: 3 });
    const r = await sup.run({ goal: 'g', plan: ['read a', 'read b'] });
    ok(r.ok && r.done.length === 2, 'a controller that throws or abstains is ignored rather than obeyed');
  }
  {
    // A cap of ZERO is a request to stop launching — drain and park, do not spin.
    const { sup } = rig({ widthCaps: { tier: () => 0 } }, { width: 3, stallTicks: 500 });
    const t0 = Date.now();
    const r = await sup.run({ goal: 'g', plan: ['read a', 'read b'], wallClockMs: 4000 });
    ok(r.stoppedBecause === 'throttled', `width 0 parks the run rather than spinning (${r.stoppedBecause})`);
    ok(Date.now() - t0 < 3000, 'and it does so promptly rather than waiting out the clock');
    ok(r.open.length === 2, 'with the work left open for a resume');
  }

  // ── ALL ONE ROLE, OR ONE OF EACH. NOTHING BETWEEN. ──────────────────────────────────────────────
  {
    // THE INVARIANT, checked continuously rather than at the end. In ensemble mode two agents of the
    // same role must never be in flight at once — that is the "nothing in between" state.
    let worst = 0, sawEnsemble = false;
    const live = new Map();
    const { sup, events } = rig({
      runAgent: async ({ role, id }) => {
        live.set(id, role);
        const counts = {};
        for (const r of live.values()) counts[r] = (counts[r] || 0) + 1;
        worst = Math.max(worst, Math.max(...Object.values(counts)));
        await new Promise((r) => setTimeout(r, 12));
        live.delete(id);
        return { status: 'done', summary: 'ok' };
      },
    }, { width: 5 });

    const r = await sup.run({ goal: 'g', plan: [
      'write the migration code', 'read the papers on electrode wear', 'click through the staging site',
      'remember the decision about the schema', 'render the diagram',
      'write the second migration', 'read two more papers', 'render a second diagram',
    ] });
    sawEnsemble = events.some((e) => e.type === 'mode' && e.to === 'ensemble');
    ok(r.ok && r.done.length === 8, 'an eight-item, five-role plan completes');
    ok(sawEnsemble, 'and it announced ensemble mode');
    ok(worst === 1, `never two agents of the same role at once (worst concurrent same-role count: ${worst})`);
  }
  {
    // UNIFORM: a single-role plan lets all five work it, because there is nothing else to be.
    let worst = 0;
    const live = new Map();
    const { sup, events } = rig({
      runAgent: async ({ role, id }) => {
        live.set(id, role);
        const counts = {};
        for (const r of live.values()) counts[r] = (counts[r] || 0) + 1;
        worst = Math.max(worst, Math.max(...Object.values(counts)));
        await new Promise((r) => setTimeout(r, 15));
        live.delete(id);
        return { status: 'done', summary: 'ok' };
      },
    }, { width: 5 });
    const r = await sup.run({ goal: 'g', plan: Array.from({ length: 10 }, (_, i) => `read the paper on electrode wear, part ${i}`) });
    ok(r.ok && r.done.length === 10, 'a single-role plan completes');
    ok(worst > 1, `and all five may work it — ${worst} agents of the one role ran at once, which uniform mode is for`);
    ok(events.some((e) => e.type === 'mode' && e.to === 'uniform'), 'and it announced uniform mode');
  }
  {
    // UNIFORM → ENSEMBLE. Two items that both classify as `code`, the first of which discovers
    // research work — so a second role appears WHILE coding work is still open. That is the only shape
    // that genuinely transitions: a single item discovering a second role does not, because by the
    // next pass the first is done and the plan is single-role again, just a different one.
    //
    // The strings are chosen against the real classifier, not against what they sound like — an
    // earlier version of this test used "write the second migration", which classifies as `general`
    // and therefore `research`, so the plan was two roles from the start and the assertion passed
    // while the comment above it described something that never happened.
    const { sup, events } = rig({
      runAgent: async ({ goal }) => {
        await new Promise((r) => setTimeout(r, 8));
        return goal === 'write the migration code'
          ? { status: 'done', summary: 'found more', newItems: ['read the papers on electrode wear'] }
          : { status: 'done', summary: 'ok' };
      },
    }, { width: 5 });
    await sup.run({ goal: 'g', plan: ['write the migration code', 'refactor the loop'] });
    const modes = events.filter((e) => e.type === 'mode');
    ok(modes[0] && modes[0].to === 'uniform', `it starts uniform on a two-coding-item plan (${modes.map((m) => m.to).join(' → ')})`);
    ok(modes.some((m) => m.to === 'ensemble'), 'and switches to ensemble when a second role appears mid-run');
    const toEnsemble = modes.find((m) => m.to === 'ensemble');
    ok(toEnsemble && toEnsemble.histogram && Object.keys(toEnsemble.histogram).length >= 2,
      'carrying the role histogram that caused it — a run that reshapes its cast silently is unexplainable later');
  }
  {
    // Agents are named for the ROLE they fill, so the name means the same thing all run.
    const seen = [];
    const { sup } = rig({ runAgent: async ({ name, role }) => { seen.push([role, name]); return { status: 'done', summary: 'ok' }; } }, { width: 5 });
    await sup.run({ goal: 'g', plan: ['write the code', 'read the papers', 'write more code'] });
    const byRole = new Map(seen);
    ok(byRole.get('coding') === 'FORGE' && byRole.get('research') === 'ORACLE',
      `the role decides the name (${seen.map((x) => x.join('=')).join(', ')})`);
    const coding = seen.filter(([r]) => r === 'coding').map(([, n]) => n);
    ok(new Set(coding).size === 1, 'and two coding items are worked by the same name, not two invented ones');
  }

  // ── DEPENDENCIES ─────────────────────────────────────────────────────────────────────────────────
  // The whole point of Phase 1. These are written BEFORE the gate exists, because the most dangerous
  // one of them passes trivially today and starts failing the moment the gate is wrong.
  {
    // THE FALSE COMPLETE. `loop()` reports 'complete' when nothing is open, nothing is in flight and
    // nothing is doing. Narrow "open" to "READY" and a plan whose remaining todos are all waiting on a
    // dependency reports complete, closes the mission and returns ok:true with the work never started.
    // Two nodes are enough to catch it, and this is the assertion that has to exist first.
    const order = [];
    const { sup } = rig({
      runAgent: async ({ goal }) => { order.push(goal); await new Promise((r) => setTimeout(r, 10)); return { status: 'done', summary: 'ok' }; },
    }, { width: 3 });
    const r = await sup.run({ goal: 'g', plan: [
      { id: 't1', text: 'first', needs: [] },
      { id: 't2', text: 'second', needs: ['t1'] },
    ] });
    ok(r.ok && r.stoppedBecause === 'complete', `a two-node chain completes (${r.stoppedBecause})`);
    ok(r.done.length === 2, `BOTH items ran — a run that reports complete with work unstarted is the trap (done: ${r.done.length})`);
    ok(order.join(',') === 'first,second', `and in dependency order (got ${order.join(',')})`);
  }
  {
    // A diamond: t1 → (t2, t3) → t4. t4 must start after BOTH middles, and the middles may overlap.
    // Timestamps, not array positions — `started.indexOf(x) < finished.indexOf(y)` compares offsets in
    // two different arrays and means nothing. Overlap is a claim about the clock, so measure the clock.
    const started = [], finished = [];
    const at = {};
    const { sup } = rig({
      runAgent: async ({ goal }) => {
        started.push(goal); at[goal + ':start'] = Date.now();
        await new Promise((r) => setTimeout(r, goal === 't2' ? 40 : 10));
        finished.push(goal); at[goal + ':end'] = Date.now();
        return { status: 'done', summary: 'ok' };
      },
    }, { width: 4 });
    const r = await sup.run({ goal: 'g', plan: [
      { id: 't1', text: 't1', needs: [] },
      { id: 't2', text: 't2', needs: ['t1'] },
      { id: 't3', text: 't3', needs: ['t1'] },
      { id: 't4', text: 't4', needs: ['t2', 't3'] },
    ] });
    ok(r.ok && r.done.length === 4, 'the diamond completes');
    ok(at['t4:start'] >= at['t2:end'] && at['t4:start'] >= at['t3:end'],
      't4 started after BOTH t2 and t3 finished — the assertion the whole phase exists for');
    ok(at['t3:start'] < at['t2:end'],
      'and t3 ran WHILE its slow cousin was still going — rolling refill survived, the wave barrier did not come back');
    ok(at['t2:start'] >= at['t1:end'] && at['t3:start'] >= at['t1:end'],
      'and neither middle started before the item they both depend on finished');
  }
  {
    // A dead dependency must propagate, and must not take independent branches down with it.
    const { sup } = rig({
      runAgent: async ({ goal }) => (goal === 'doomed' ? { status: 'failed', summary: 'exploded' } : { status: 'done', summary: 'ok' }),
    }, { maxItemAttempts: 1, width: 3 });
    const r = await sup.run({ goal: 'g', plan: [
      { id: 't1', text: 'doomed', needs: [] },
      { id: 't2', text: 'downstream', needs: ['t1'] },
      { id: 't3', text: 'unrelated', needs: [] },
    ] });
    ok(r.done.includes('unrelated'), 'an independent branch finishes anyway');
    const dead = r.blocked.find((b) => b.text === 'downstream');
    ok(!!dead, 'the dependent item is blocked, not silently dropped');
    ok(dead && /t1/.test(dead.why), `and the reason names what it was waiting for (got "${dead && dead.why}")`);
  }
  {
    // A cycle must be refused with a reason. Hanging forever is the alternative.
    const { sup } = rig({ runAgent: async () => ({ status: 'done', summary: 'ok' }) });
    const r = await sup.run({ goal: 'g', plan: [
      { id: 't1', text: 'a', needs: ['t2'] },
      { id: 't2', text: 'b', needs: ['t1'] },
    ] });
    ok(!r.ok && /cycle/i.test(r.stoppedBecause + ' ' + (r.error || '')),
      `a cyclic plan is refused rather than hanging (${r.stoppedBecause})`);
  }
  {
    // Legacy plans — no ids anywhere — must behave exactly as they always have.
    const { sup } = rig({ runAgent: async () => ({ status: 'done', summary: 'ok' }) });
    const r = await sup.run({ goal: 'g', plan: ['one', 'two', 'three'] });
    ok(r.ok && r.done.length === 3, 'a plan with no ids runs exactly as before');
  }

  // ── THE ROSTER THE SIBLINGS SEE IS THE ONE THAT IS ACTUALLY HERE ─────────────────────────────────
  // fleetStatusBlock has always taken `activeAgents` to prune dead agents out, and no caller in the
  // repo ever passed it — while a fresh codename is minted per item, so the roster grew one finished
  // agent at a time and every one of them rode into every later worker's context. Measured at 120
  // items: ~3,000 tokens of agents that were long gone.
  {
    const seen = [];
    const { sup } = rig({
      runAgent: async ({ goal, context }) => { seen.push({ goal, context: context || '' }); return { status: 'done', summary: 'ok' }; },
    }, { width: 1 });
    await sup.run({ goal: 'g', plan: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'] });

    const last = seen[seen.length - 1].context;
    const roster = last.split('\n').filter((l) => l.startsWith('•'));
    ok(roster.length <= 1,
      `the last worker saw ${roster.length} agent(s) on the roster, not five finished ones — ${JSON.stringify(roster).slice(0, 120)}`);
    // The findings still come through: pruning the roster must not silence the lateral channel.
    ok(/alpha/.test(last) || /finding/.test(last), 'and it still sees what its siblings learned');
  }

  // ── TOKENS REACH THE JOURNAL ─────────────────────────────────────────────────────────────────────
  // mission.step() has accepted tokensIn/tokensOut since it was written and nobody ever passed them, so
  // every journal row ever recorded has `undefined` for both. Nothing can predict a run's cost from a
  // history that never recorded one.
  {
    const dir = TMP();
    const missions = createMissions({ dir: path.join(dir, 'missions') });
    const sup = createSupervisor({
      missions, onEvent: () => {},
      runAgent: async () => ({ status: 'done', summary: 'ok', spendUsd: 0.02, tokensIn: 8200, tokensOut: 430 }),
    }, fastOpts);
    const r = await sup.run({ goal: 'g', plan: ['a', 'b'] });
    const rows = missions.attach(r.missionId).journal();
    ok(rows.length === 2, 'both items journalled');
    ok(rows.every((x) => x.tokensIn === 8200 && x.tokensOut === 430),
      `and each row carries its token counts (got ${JSON.stringify(rows.map((x) => [x.tokensIn, x.tokensOut]))})`);
  }

  // ── THE FIVE REAL CODENAMES ──────────────────────────────────────────────────────────────────────
  // CODENAMES is an object; this file used it as an array, so `.length` was undefined, the guard was
  // always falsy, and every supervised agent that has ever run was called VALE or ORRIN. The names the
  // office legend and the drone fleet already use had never appeared in a long run.
  {
    const { CODENAMES } = require('../lib/agents/roles');
    const names = [];
    const { sup } = rig({ runAgent: async ({ name }) => { names.push(name); return { status: 'done', summary: 'ok' }; } }, { width: 1 });
    await sup.run({ goal: 'g', plan: ['a', 'b', 'c'] });
    const real = Object.entries(CODENAMES).filter(([r]) => r !== 'orchestrator').map(([, n]) => n);
    ok(names.every((n) => real.some((c) => n.startsWith(c))),
      `agents are named from the real roster (got ${names.join(', ')}; expected from ${real.join(', ')})`);
    ok(!names.includes('VALE'), 'and not from the fallback list that the broken guard always selected');
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
