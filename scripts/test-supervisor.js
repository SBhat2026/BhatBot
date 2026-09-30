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
    laneFor: over.laneFor,
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

  // ── TWO LANES ───────────────────────────────────────────────────────────────────────────────────
  //
  // The local lane exists because of a measurement, so the tests are about the measurement's
  // consequence: local is serial, cloud is parallel, and the two do not borrow each other's slots.
  {
    let maxLocal = 0, maxCloud = 0, sawLocal = 0, sawCloud = 0;
    const live = { local: 0, cloud: 0 };
    const { sup } = rig({
      laneFor: (p) => (/^local/.test(p.text) ? 'local' : 'cloud'),
      runAgent: async ({ lane }) => {
        live[lane]++;
        if (lane === 'local') { sawLocal++; maxLocal = Math.max(maxLocal, live.local); }
        else { sawCloud++; maxCloud = Math.max(maxCloud, live.cloud); }
        await new Promise((r) => setTimeout(r, 15));
        live[lane]--;
        return { status: 'done', summary: 'ok', spendUsd: 0 };
      },
    });
    await sup.run({ goal: 'g', width: 3, plan: [
      'local grind one', 'local grind two', 'local grind three',
      'research alpha', 'write the code for beta', 'browse for gamma', 'remember delta', 'design epsilon',
    ] });
    ok(sawLocal === 3 && sawCloud === 5, `every item ran in the lane it was assigned (local ${sawLocal}, cloud ${sawCloud})`);
    ok(maxLocal === 1, `the local lane is exactly one wide — a second local agent buys nothing, it just halves both (peak ${maxLocal})`);
    ok(maxCloud > 1, `the cloud lane still runs in parallel beside it (peak ${maxCloud})`);
    ok(maxCloud <= 3, `and the cloud lane still honours its arbitrated width (peak ${maxCloud})`);
  }

  // The whole point of the second lane is that it adds throughput rather than dividing it: a run with
  // a local lane must have MORE than `width` agents alive at some instant, or the lane is decoration.
  {
    let peak = 0, n = 0;
    const { sup } = rig({
      laneFor: (p) => (/^local/.test(p.text) ? 'local' : 'cloud'),
      runAgent: async () => { n++; peak = Math.max(peak, n); await new Promise((r) => setTimeout(r, 20)); n--; return { status: 'done', summary: 'ok' }; },
    });
    await sup.run({ goal: 'g', width: 2, plan: ['local a', 'local b', 'research c', 'write code d', 'browse e'] });
    ok(peak === 3, `the local slot is additive, not carved out of the cloud width: width 2 + 1 local ran ${peak} at once`);
  }

  // A local agent is not one of the five. If it took a codename the office would render two FORGEs and
  // the roster would stop meaning "one of each".
  {
    const names = [];
    let snap = null;
    const { sup } = rig({
      laneFor: () => 'local',
      runAgent: async ({ name, lane }) => { names.push({ name, lane }); snap = sup.roster(); return { status: 'done', summary: 'ok' }; },
    });
    await sup.run({ goal: 'g', plan: ['write the code for a thing'] });
    ok(names.length === 1 && names[0].lane === 'local' && names[0].name === 'MULE',
      'the local slot has its own name and does not consume one of the five codenames');
    ok(snap && snap.length === 1 && snap[0].lane === 'local',
      'and roster() carries the lane, so the office can render the free slot differently from the five paid ones');
  }

  // Default behaviour: a caller that knows nothing about lanes must get exactly today's behaviour.
  {
    const lanes = new Set();
    const { sup } = rig({ runAgent: async ({ lane }) => { lanes.add(lane); return { status: 'done', summary: 'ok' }; } });
    await sup.run({ goal: 'g', plan: ['research a', 'write code b'] });
    ok(lanes.size === 1 && lanes.has('cloud'), 'with no laneFor injected every item is cloud — lanes are opt-in');
  }

  // A throwing laneFor must not take the run down with it. The tier readers it consults shell out.
  {
    const lanes = [];
    const { sup } = rig({
      laneFor: () => { throw new Error('ioreg went away'); },
      runAgent: async ({ lane }) => { lanes.push(lane); return { status: 'done', summary: 'ok' }; },
    });
    const r = await sup.run({ goal: 'g', plan: ['research a', 'research b'] });
    ok(r.ok && lanes.length === 2 && lanes.every((l) => l === 'cloud'),
      'a throwing laneFor falls back to cloud rather than failing the run');
  }

  // The leak this refactor was really about: `workItem`'s catch path returns no `role`, so decrementing
  // from the RESULT left a role pinned at 1 forever — one desk dark for the rest of the run.
  {
    let started = 0;
    const { sup } = rig({
      runAgent: async ({ goal }) => {
        started++;
        if (goal === 'write the code for the first thing') throw new Error('thrown, not returned');
        return { status: 'done', summary: 'ok' };
      },
    }, { maxItemAttempts: 1, maxConsecutiveFailures: 9 });
    const r = await sup.run({ goal: 'g', width: 2, plan: [
      'write the code for the first thing', 'write the code for the second thing', 'write the code for the third thing',
    ] });
    ok(started === 3, `a thrown worker releases its role slot: all three coding items ran, not just the first (${started})`);
    ok(r.done.length === 2 && r.blocked.length === 1,
      `and the two healthy items are still delivered while only the thrower is blocked (${r.done.length} done, ${r.blocked.length} blocked)`);
  }

  // Status events have to distinguish the lanes, because "3 in flight" cannot be checked against a
  // width of 2 without knowing one of them was free.
  {
    const { sup, events } = rig({
      laneFor: (p) => (/^local/.test(p.text) ? 'local' : 'cloud'),
      runAgent: async () => { await new Promise((r) => setTimeout(r, 15)); return { status: 'done', summary: 'ok' }; },
    });
    await sup.run({ goal: 'g', width: 2, plan: ['local a', 'research b', 'write code c'] });
    const withLanes = events.filter((e) => e.type === 'progress' && e.lanes);
    ok(withLanes.length > 0, 'progress reports the two lanes separately');
    // The invariant that makes them useful: the lane counters must SUM to in-flight. If they drift,
    // "3 in flight against width 2" is unreadable — you cannot tell an over-run from a free local slot.
    ok(withLanes.every((e) => e.lanes.cloud + e.lanes.local === e.inFlight),
      'and the two lane counters always sum to in-flight, so either can be checked against width');
    ok(withLanes.every((e) => e.lanes.local <= 1 && e.lanes.cloud <= 2),
      'with neither lane ever over its own ceiling');
  }

  // ── what it decided while he was asleep ─────────────────────────────────────────────────────────
  //
  // Quiet hours are 22:30–06:30, so an overnight run gets zero calls and every human need falls back
  // to its stated assumption. The per-item note already records that, but one line inside a forty-item
  // plan is not a report. This is the field he reads over breakfast.
  {
    // Nobody is awake: the escalation is never answered, so the idle wait times out and the run
    // proceeds on the assumption — the overnight path exactly.
    const escalations = {
      ask: async () => ({ id: 'esc_night1', question: 'Which citation style?', assumption: 'APA' }),
      isAnswered: () => null,
      get: (id) => (id === 'esc_night1' ? { id, question: 'Which citation style?', assumption: 'APA' } : null),
      pending: () => [{ id: 'esc_night1', question: 'Which citation style?', assumption: 'APA' }],
      wait: async () => ({ answered: false, timedOut: true }),
    };
    const { sup } = rig({
      escalations,
      runAgent: async ({ goal }) => (goal === 'format the bibliography'
        ? { status: 'blocked', summary: 'need a call', need: { kind: 'human', question: 'Which citation style?', assumption: 'APA' } }
        : { status: 'done', summary: 'fine' }),
    }, { idleWaitMs: 10, maxItemAttempts: 2 });
    const r = await sup.run({ goal: 'g', plan: ['format the bibliography', 'research something else'], width: 2 });

    ok(Array.isArray(r.assumed), 'the report has an aggregate `assumed` list');
    ok(r.assumed.length === 1, `and it lists the decision exactly once, however many attempts it took (${r.assumed.length})`);
    const a = r.assumed[0] || {};
    ok(a.assumption === 'APA', `each entry says what was assumed (${a.assumption})`);
    ok(/citation style/i.test(a.question || ''), `and the question it would have asked (${a.question})`);
    ok(/bibliography/.test(a.text || ''), `and which item it was for (${a.text})`);
  }

  // An ANSWERED question is not an assumption. If it were, the morning field would be a list of
  // everything that happened and therefore useless.
  {
    const escalations = {
      ask: async () => ({ id: 'esc_day1', question: 'Which account?', assumption: 'the primary one' }),
      isAnswered: () => ({ status: 'answered', answer: 'the savings account', question: 'Which account?' }),
      get: (id) => ({ id, question: 'Which account?', assumption: 'the primary one' }),
      pending: () => [],
      wait: async () => ({ answered: true }),
    };
    const { sup } = rig({
      escalations,
      runAgent: async ({ goal }) => (goal === 'reconcile the ledger'
        ? { status: 'blocked', summary: 'need a call', need: { kind: 'human', question: 'Which account?', assumption: 'the primary one' } }
        : { status: 'done', summary: 'fine' }),
    }, { idleWaitMs: 10, maxItemAttempts: 3 });
    const r = await sup.run({ goal: 'g', plan: ['reconcile the ledger', 'research something else'], width: 2 });
    ok(r.assumed.length === 0, `a question he actually answered is not listed as an assumption (${r.assumed.length})`);
  }

  // ── the stall wall is a DURATION ────────────────────────────────────────────────────────────────
  //
  // `stallTicks: 40` at `tickDelayMs: 250` is ten seconds, which meant something different the moment
  // the loop's tick rate changed: under a readiness gate with idle ensemble slots the loop makes many
  // more cheap passes, so the same 40 arrives far sooner, and a DAG legitimately waiting on one long
  // in-flight dependency looks exactly like a wedged run. Nothing in the suite exercised this at all.
  {
    // Every item comes back 'todo' with no progress: the plan digest never changes. A real stall.
    const { sup, events } = rig({ runAgent: async () => ({ status: 'todo', summary: '' }) },
      { stallMs: 120, tickDelayMs: 1, maxItemAttempts: 999, maxConsecutiveFailures: 999 });
    const t0 = Date.now();
    const r = await sup.run({ goal: 'g', plan: ['a task that never moves'] });
    const ms = Date.now() - t0;
    ok(r.stoppedBecause === 'stalled', `a plan that never moves stops as 'stalled' (${r.stoppedBecause})`);
    ok(ms >= 100, `and it waited the configured DURATION rather than a pass count (${ms}ms >= 100)`);
    ok(ms < 4000, `without waiting the ten-minute default (${ms}ms)`);
    const ev = events.find((e) => e.type === 'stalled');
    ok(ev && ev.stalledMs >= 100 && ev.wallMs === 120,
      `and it says how long it stood still and against what wall (${ev && ev.stalledMs}ms vs ${ev && ev.wallMs}ms)`);
  }

  // The wall must not fire while work is genuinely in flight — that is the DAG's normal mid-layer
  // state, and tripping there would kill long-running items for being slow.
  {
    const { sup } = rig({
      runAgent: async () => { await new Promise((r) => setTimeout(r, 300)); return { status: 'done', summary: 'slow but real' }; },
    }, { stallMs: 80, tickDelayMs: 1 });
    const r = await sup.run({ goal: 'g', plan: ['one genuinely slow item'] });
    ok(r.ok && r.done.length === 1,
      `an item slower than the stall wall is not a stall — work in flight is work (${r.stoppedBecause})`);
  }

  // Back-compat: a caller that set stallTicks meant "this many idle passes", which at its own tick
  // rate is exactly that many milliseconds. Their intent has to survive the change of mechanism.
  {
    const { sup } = rig({ runAgent: async () => ({ status: 'todo', summary: '' }) },
      { stallTicks: 50, tickDelayMs: 4, maxItemAttempts: 999, maxConsecutiveFailures: 999 });
    const t0 = Date.now();
    const r = await sup.run({ goal: 'g', plan: ['a task that never moves'] });
    const ms = Date.now() - t0;
    ok(r.stoppedBecause === 'stalled' && ms >= 180 && ms < 4000,
      `an explicit stallTicks is honoured as ticks×delay (50×4ms → stopped at ${ms}ms)`);
  }

  // ── the custodian reviews while there is still time ─────────────────────────────────────────────
  //
  // Reviewing once, after four hours and the whole spend, is an autopsy. A doubt at the first layer
  // boundary is worth ten times the same doubt at the end, because everything downstream inherits
  // whatever this layer got wrong.
  {
    const calls = [];
    const { sup, events } = rig({
      review: async (a) => { calls.push({ interim: !!a.interim, done: a.doneCount, remaining: a.remainingCount }); return { verdict: 'accept' }; },
      runAgent: async () => ({ status: 'done', summary: 'ok' }),
    }, { interimReviewMinDone: 3, width: 1 });
    const plan = Array.from({ length: 12 }, (_, i) => 'research topic number ' + (i + 1));
    const r = await sup.run({ goal: 'g', plan });
    const interim = calls.filter((c) => c.interim);
    ok(interim.length >= 2, `the custodian is consulted DURING the run, not only at the end (${interim.length} interim)`);
    ok(interim.every((c) => c.remaining > 0), 'every interim review still had work left to influence');
    ok(calls.filter((c) => !c.interim).length === 1, 'and the final review still happens exactly once');
    ok(r.done.length === 12, 'while the run itself completes normally');
    // The gate has to be the threshold, not every completion, or a 40-item run buys 40 model calls.
    ok(interim.length <= 4, `and it is bounded rather than firing per item (${interim.length} for 12 items at a threshold of 3)`);
  }

  // A doubt raised mid-run has to reach BOTH the report and the blackboard — a doubt that only lands
  // in the final JSON changes nothing about the work that follows it.
  {
    let boardSaw = '';
    const { sup, events } = rig({
      review: async (a) => (a.interim ? { verdict: 'revise', reason: 'the sources are all from one author' } : { verdict: 'accept' }),
      runAgent: async ({ context }) => { if (/one author/.test(context || '')) boardSaw = context; return { status: 'done', summary: 'ok' }; },
    }, { interimReviewMinDone: 3, width: 1 });
    const r = await sup.run({ goal: 'g', plan: Array.from({ length: 10 }, (_, i) => 'research topic ' + (i + 1)) });
    ok(r.doubts.length === 1, `the same doubt is recorded once, not once per boundary (${r.doubts.length})`);
    ok(r.doubts[0].raised >= 2, `with a count of how many boundaries it survived unaddressed (${r.doubts[0].raised})`);
    ok(/one author/.test(r.doubts[0].reason || ''), 'with the reason it gave');
    ok(r.doubts[0].afterDone >= 3, `and where in the run it was raised (after ${r.doubts[0].afterDone} done)`);
    ok(events.some((e) => e.type === 'doubt' && e.interim), 'it emits a doubt event marked interim');
    ok(/one author/.test(boardSaw), 'and later agents actually read it off the blackboard');
  }

  // A reviewer that throws must not take the run with it — it is an advisor, not a dependency.
  {
    const { sup } = rig({
      review: async (a) => { if (a.interim) throw new Error('reviewer exploded'); return { verdict: 'accept' }; },
      runAgent: async () => ({ status: 'done', summary: 'ok' }),
    }, { interimReviewMinDone: 3, width: 1 });
    const r = await sup.run({ goal: 'g', plan: Array.from({ length: 8 }, (_, i) => 'research topic ' + (i + 1)) });
    ok(r.ok && r.done.length === 8, `a throwing interim reviewer does not stop the run (${r.stoppedBecause})`);
  }

  // ── the multi-hour chain, with the lease in the way ─────────────────────────────────────────────
  //
  // Hours are chained by parking on the wall clock and resuming, and the mission lease is new to that
  // path: park() hands the lease back and resume() must take it again. A lease that stuck across a
  // park would make hop two report "already running in pid N" and the chain would die silently at the
  // first boundary — which is exactly the shape of the bug the spend cap had.
  {
    const { sup, missions } = rig({
      runAgent: async () => { await new Promise((r) => setTimeout(r, 6)); return { status: 'done', summary: 'ok', spendUsd: 0.01 }; },
    });
    const plan = Array.from({ length: 9 }, (_, i) => 'research topic ' + (i + 1));
    // Three short hops, none of which can finish the plan alone.
    const hop1 = await sup.run({ goal: 'a long job', plan, wallClockMs: 14, budgetUsd: 4 });
    ok(hop1.stoppedBecause === 'wall-clock', `hop 1 parks on the clock (${hop1.stoppedBecause})`);
    const id = hop1.missionId;

    const held = missions.attach(id);
    ok(held && held.lease() === null, 'and the park hands the lease back, so the next hop can take it');

    let done = hop1.done.length, hops = 1;
    for (let i = 0; i < 6 && done < 9; i++) {
      const r = await sup.resume(id, { wallClockMs: 14 });
      ok(r.ok !== undefined && !r.leaseHeldBy, `hop ${hops + 1} is not refused by a stale lease (${r.error || 'ran'})`);
      done = r.done.length; hops++;
      if (r.stoppedBecause === 'complete') break;
    }
    ok(done === 9, `the chain finishes all nine items across ${hops} hops (${done})`);

    const meta = missions.attach(id).meta;
    ok((meta.resumeCount || 0) === hops - 1,
      `and each hop counted as exactly one resume, so the circuit breaker stays honest (${meta.resumeCount} for ${hops} hops)`);
  }

  // The declared budget is the ceiling, not the $5 global default. Hours are chained by resuming, so a
  // run opened with $12 used to be retired at about hop two and told "spend limit ($5)" — a limit
  // nobody chose for it, reported as an expiry.
  {
    const { sup, missions } = rig({ runAgent: async () => ({ status: 'done', summary: 'ok', spendUsd: 3.0 }) });
    const r = await sup.run({ goal: 'an expensive long job', plan: ['research a', 'research b', 'research c'], wallClockMs: 8, budgetUsd: 12 });
    const due = missions.dueForResume({ maxSpendUsd: 5, defaultBackoffMs: 0 });
    const expired = due.expired.find((e) => e.id === r.missionId);
    ok(!expired || !/spend limit \(\$5\)/.test(expired.reason),
      `a run that declared $12 is not retired against the $5 default (${expired ? expired.reason : 'still resumable'})`);
  }

  // A RETRY MUST BE ABLE TO CHANGE LANES. main.js deliberately sends a retry to the cloud: an item the
  // local model already failed is the least likely thing for it to succeed at the second time, and a
  // lane that keeps re-serving its own failures is a livelock with a progress bar. The first version of
  // laneAssign memoized per item for the life of the run, which pinned the item to the lane that had
  // just failed it and made the caller's rule unreachable — a rule that looks implemented and cannot
  // fire. Nothing caught it, so this does.
  {
    const seen = [];
    let attempt = 0;
    const { sup } = rig({
      // Exactly the real rule now: the attempt NUMBER decides, not a word in a model-written note.
      laneFor: (item, role, ctx) => ((ctx && ctx.attempt) > 1 ? 'cloud' : 'local'),
      runAgent: async ({ lane }) => {
        seen.push(lane);
        if (++attempt === 1) return { status: 'partial', summary: 'got nowhere on the local model' };
        return { status: 'done', summary: 'ok' };
      },
    }, { maxItemAttempts: 3, maxConsecutiveFailures: 9 });
    const r = await sup.run({ goal: 'g', plan: ['research something local-capable'] });
    ok(seen[0] === 'local', `the first attempt went to the free lane (${seen[0]})`);
    ok(seen.length >= 2 && seen[1] === 'cloud',
      `and the RETRY moved to the cloud rather than being pinned to the lane that just failed it (${seen.join(' → ')})`);
    ok(r.ok, 'and the item finishes');
  }

  // The other half of the same decision: within ONE pass the answer must not change, or an item can be
  // admitted as cloud and launched as local and overrun the single local slot.
  {
    let flip = 0, peakLocal = 0, live = 0;
    const { sup } = rig({
      laneFor: () => (++flip % 2 ? 'local' : 'cloud'),   // a tier flapping on every single call
      runAgent: async ({ lane }) => {
        if (lane === 'local') { live++; peakLocal = Math.max(peakLocal, live); }
        await new Promise((r) => setTimeout(r, 12));
        if (lane === 'local') live--;
        return { status: 'done', summary: 'ok' };
      },
    });
    await sup.run({ goal: 'g', width: 4, plan: Array.from({ length: 10 }, (_, i) => 'research item ' + (i + 1)) });
    ok(peakLocal <= 1, `even with laneFor changing its mind on every call, the local slot is never overrun (peak ${peakLocal})`);
  }

  // ── width zero is a CLOUD number ────────────────────────────────────────────────────────────────
  //
  // When cost is the binding constraint, stopping the whole run throws away the one lane that cannot
  // make the problem worse — exactly when it is the only lane that can still make progress. This is
  // the single most valuable thing about having a free lane, and it did not work: the width-zero wall
  // stopped the run before the local lane got a look.
  {
    const lanes = [];
    const { sup, events } = rig({
      widthCaps: { costpilot: () => 0 },        // the money ran out; the machine is fine
      laneFor: (item, role) => (role === 'research' ? 'local' : 'cloud'),
      runAgent: async ({ lane }) => { lanes.push(lane); return { status: 'done', summary: 'ok' }; },
    }, { width: 3 });
    const r = await sup.run({ goal: 'g', plan: ['research a', 'research b', 'research c'] });
    ok(lanes.length === 3 && lanes.every((l) => l === 'local'),
      `with cloud width at zero the free lane carries on alone (${lanes.length} items, lanes: ${[...new Set(lanes)].join(',')})`);
    ok(r.stoppedBecause === 'complete', `and the run completes instead of parking as throttled (${r.stoppedBecause})`);
    ok(events.some((e) => e.type === 'throttled-to-local'), 'and it says that is what it is doing');
  }

  // The other side: when there is no local-capable work, width zero still stops the run. A free lane
  // that cannot take the work is not a reason to spin.
  {
    const { sup } = rig({
      widthCaps: { costpilot: () => 0 },
      laneFor: () => 'cloud',                   // nothing is local-capable
      runAgent: async () => ({ status: 'done', summary: 'ok' }),
    }, { width: 3 });
    const r = await sup.run({ goal: 'g', plan: ['research a', 'research b'] });
    ok(r.stoppedBecause === 'throttled', `with no local-capable work, width zero still parks the run (${r.stoppedBecause})`);
  }

  // And when the MACHINE is in trouble rather than the budget, everything goes cloud and the run stops
  // as it always did — adding a 9.6GB resident model to a memory emergency is not a recovery plan.
  {
    const { sup } = rig({
      widthCaps: { tier: () => 0 },
      laneFor: () => 'cloud',                   // what main.js does when governor.critical fires
      runAgent: async () => ({ status: 'done', summary: 'ok' }),
    }, { width: 3 });
    const r = await sup.run({ goal: 'g', plan: ['research a'] });
    ok(r.stoppedBecause === 'throttled', `a machine emergency still stops the run outright (${r.stoppedBecause})`);
  }

  // ── work finished during the DRAIN is recorded ──────────────────────────────────────────────────
  //
  // When a wall trips, in-flight items are allowed to finish rather than be orphaned — the money is
  // spent either way. But the results used to be awaited and thrown away, so the item finished, the
  // artifact was written, the tokens were paid for, and the plan still said `doing`. Hours are chained
  // by parking on the clock and resuming, so that loss happened at EVERY hour boundary and the next
  // hop re-ran completed work.
  {
    const ran = [];
    const { sup, missions, events } = rig({
      runAgent: async ({ goal }) => {
        ran.push(goal);
        await new Promise((r) => setTimeout(r, 25));   // still in flight when the clock runs out
        return { status: 'done', summary: 'finished during the drain', spendUsd: 0 };
      },
    });
    // The wall trips while both items are mid-flight.
    const r = await sup.run({ goal: 'g', width: 2, plan: ['research a', 'write the code for b'], wallClockMs: 5 });
    ok(r.stoppedBecause === 'wall-clock', `the clock stopped it (${r.stoppedBecause})`);
    ok(events.some((e) => e.type === 'draining'), 'it drained rather than orphaning the work');

    // Not a fixed number: how many are mid-flight when the clock trips depends on timing, and one of
    // these two may already have been collected by the normal path. The invariant is that everything
    // which WAS in flight is recorded — nothing finished is dropped.
    const drained = events.find((e) => e.type === 'drained');
    ok(drained && drained.of >= 1 && drained.recorded === drained.of,
      `and RECORDED everything that finished during the drain (${drained && drained.recorded} of ${drained && drained.of})`);
    ok(r.done.length === 2, `so the report credits the finished work (${r.done.length} done)`);

    // The durable record is what a resume reads, so it is the one that actually has to be right.
    const onDisk = missions.attach(r.missionId).plan.read();
    ok(onDisk.filter((p) => p.status === 'done').length === 2,
      `and the plan on disk says done, so the next hop does not pay for it twice (${onDisk.map((p) => p.status).join(',')})`);

    // A resume must now find nothing left to do.
    const r2 = await sup.resume(r.missionId, { wallClockMs: 5000 });
    ok(ran.length === 2, `the resumed hop re-ran nothing (${ran.length} worker calls in total, not ${ran.length + 2})`);
    ok(r2.stoppedBecause === 'complete', `and it completes immediately (${r2.stoppedBecause})`);
  }

  // ── stats(): what the MACHINERY is doing ────────────────────────────────────────────────────────
  //
  // Correctness and throughput are different questions and this suite only ever asked the first. The
  // run carries six individually-correct brakes — width arbiter, one-per-role cap, single local slot,
  // admission, tier ladder, costpilot — and a stack of correct brakes is how a system degrades
  // monotonically while every test passes. A run arbitrated to width 5 that averages 1.4 agents is a
  // bug that nothing here would have caught.
  {
    const seen = [];
    const { sup } = rig({
      runAgent: async () => { await new Promise((r) => setTimeout(r, 30)); return { status: 'done', summary: 'ok' }; },
    });
    ok(sup.stats().width === 0 && sup.stats().bindingConstraint === null,
      'stats() is safe to read before a run and claims nothing it does not know');
    // SAMPLED FROM OUTSIDE, on a timer, which is how the instrument is actually used. Reading it from
    // inside runAgent measures the wrong instant: the worker runs before its own item is registered,
    // so the peak is always one short — and five roles all reporting one-short is how a healthy run
    // gets diagnosed as idle.
    const tick = setInterval(() => { try { seen.push(sup.stats()); } catch {} }, 5);
    // Five distinct roles, so ensemble mode can genuinely run several at once.
    await sup.run({ goal: 'g', width: 5, plan: ['research a', 'write the code for b', 'browse for c', 'remember d', 'design e'] });
    clearInterval(tick);
    ok(seen.length > 0 && seen.every((x) => x.width === 5), 'it reports the arbitrated width during the run');
    const peak = Math.max(...seen.map((x) => x.inFlight));
    ok(peak >= 3, `and the live in-flight count, so utilisation can be computed (peak seen ${peak} of 5)`);
    ok(seen.every((x) => x.bindingConstraint === 'spec'), 'and names the constraint that is holding the brake');
  }

  // The name matters more than the number: "who lowered my width" is otherwise an evening of guessing.
  {
    const { sup } = rig({ widthCaps: { admission: () => 2, costpilot: () => 4 } }, { width: 5 });
    let st = null;
    const { sup: s2 } = rig({
      widthCaps: { admission: () => 2, costpilot: () => 4 },
      runAgent: async () => { st = s2.stats(); return { status: 'done', summary: 'ok' }; },
    }, { width: 5 });
    await s2.run({ goal: 'g', width: 5, plan: ['research a'] });
    ok(st && st.width === 2 && st.bindingConstraint === 'admission',
      `the TIGHTEST cap wins and is named, not just applied (width ${st && st.width} by ${st && st.bindingConstraint})`);
  }

  // A held item is throughput the per-role cap is costing. It has to be visible or the cap is
  // unfalsifiable: a run can look healthy while four of five desks sit on work they are not allowed
  // to start.
  {
    let held = 0;
    const { sup } = rig({
      runAgent: async () => { held = Math.max(held, sup.stats().heldForRole); await new Promise((r) => setTimeout(r, 20)); return { status: 'done', summary: 'ok' }; },
    }, { width: 4 });
    // Four items, all the same role: ensemble mode allows one in flight, so three are ready-but-held.
    await sup.run({ goal: 'g', width: 4, plan: ['research a', 'research b', 'research c', 'write the code for d'] });
    ok(held >= 1, `items ready but held by their role are counted, so the cap's cost is measurable (${held})`);
  }

  // The reviewer runs at a quiescence point, so every millisecond it takes is a millisecond nobody is
  // working. An advisor is an efficiency question too.
  {
    let st = null;
    const { sup } = rig({
      review: async (a) => { await new Promise((r) => setTimeout(r, 25)); return { verdict: 'accept' }; },
      runAgent: async () => { st = sup.stats(); return { status: 'done', summary: 'ok' }; },
    }, { interimReviewMinDone: 3, width: 1 });
    await sup.run({ goal: 'g', plan: Array.from({ length: 8 }, (_, i) => 'research topic ' + (i + 1)) });
    const after = sup.stats();
    ok(after.reviews >= 1 && after.reviewMs >= 20,
      `time spent in the custodian is attributed, not invisible (${after.reviews} review(s), ${after.reviewMs}ms)`);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} supervisor: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
