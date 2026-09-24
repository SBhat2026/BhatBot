'use strict';
// ── SUPERVISOR — the loop that keeps a fleet working for an hour without you ────────────────────────
//
// Everything needed for a long unattended run already existed in this repo and nothing drove it.
// lib/mission.js journals, parks and resumes; lib/fleet.js spawns and reaps; lib/admission.js paces;
// lib/escalate.js asks for help; lib/toolforge.js builds the missing capability. What was missing was
// the thing that decides, minute after minute, what happens next — and gives up in a bounded, honest
// way when it should.
//
// ── WHAT PROGRESS MEANS, AND WHY THAT IS THE WHOLE DESIGN ─────────────────────────────────────────
//
// Progress is A CHANGE IN THE PLAN. Not a tick, not a model reply, not an agent saying it is working.
// This distinction is load-bearing because the failure it prevents has already happened here twice:
// the call gate livelocked itself by counting blocked attempts as calls, and the first fan-out run
// burned its whole budget because every turn looked like activity. An agent that answers beautifully
// while the plan stands still has done nothing, and after `stallTicks` of it the run stops and says so
// rather than spending four hours proving it.
//
// ── ASK, THEN KEEP WORKING ────────────────────────────────────────────────────────────────────────
//
// An escalation never blocks the loop. The item that needed the answer is parked, every OTHER item
// keeps moving, and only when nothing else is actionable does the run wait — with a timeout, after
// which it proceeds on the assumption the escalation stated. A run that freezes for an hour because
// Siddhant is in a lecture is a run that did not work.
//
// ── FOUR DURABLE WALLS ────────────────────────────────────────────────────────────────────────────
//
// wall clock · spend · ticks · consecutive failures. All four live in mission.json, not in RAM, so a
// crash-loop cannot reset them — which is the difference between "resumable" and "runaway". The point
// of a wall is that hitting it is a normal, reported outcome, not a crash.
//
// ── WHEN IT CANNOT DO SOMETHING ───────────────────────────────────────────────────────────────────
//
// The agent says which, in its envelope, and the supervisor routes it:
//   need.kind === 'tool'   → forge one (lib/toolforge: tested in a sandbox before it counts)
//   need.kind === 'human'  → escalate (lib/escalate: a call unless the calendar says he is in class)
//   need.kind === 'decompose' → split the item and carry on
// Anything else is a failure with a stated reason, retried up to maxItemAttempts and then left blocked
// with the reason recorded — because an item that quietly disappears is worse than one marked blocked.
//
// Pure + DI, no Electron: the GUI injects the real agent runner, the tests inject a fake, and
// scripts/soak-supervisor.js drives it against a local Ollama model for an hour at zero API cost.
// See scripts/test-supervisor.js.

const designation = require('./designation');

const DEFAULTS = {
  width: 3,                        // agents in flight at once
  budgetUsd: 2.0,                  // hard wall for the whole run
  itemBudgetUsd: 0.35,             // per attempt, so one item cannot eat the run
  wallClockMs: 60 * 60 * 1000,     // one hour — the run length Siddhant asked to be able to rely on
  tickDelayMs: 250,                // between scheduling passes; not a poll of anything slow
  stallTicks: 40,                  // scheduling passes with no plan change before we stop and say why
  maxTicks: 20000,
  maxItemAttempts: 2,              // one retry. Two is a loop with extra steps (lib/custodian's rule).
  maxConsecutiveFailures: 5,
  idleWaitMs: 5 * 60 * 1000,       // how long to wait on an answer when NOTHING else is actionable
  planMax: 40,
};

// The codenames the fleet already uses, so a supervised run and a drone run name agents the same way.
let CODENAMES = [];
try { CODENAMES = require('./agents/roles').CODENAMES || []; } catch { CODENAMES = []; }
const FALLBACK_NAMES = ['VALE', 'ORRIN', 'SABLE', 'QUILL', 'BRAM', 'IVO', 'NOOR', 'TARN', 'WREN', 'CASS'];

const STOP_REASONS = ['complete', 'wall-clock', 'budget', 'stalled', 'failures', 'ticks', 'stopped', 'blocked'];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** A stable digest of the plan's SHAPE and STATE — what "progress" is measured against. */
function planDigest(items) {
  return (items || []).map((p) => `${p.status}:${p.text}`).join('|');
}

/**
 * createSupervisor(deps, opts)
 *
 * deps:
 *   missions   — a lib/mission.js store (createMissions({...}))
 *   runAgent   — async ({ id, name, designation, goal, item, context, budgetUsd, maxTurns }) → envelope
 *                envelope: { status: 'done'|'partial'|'blocked'|'failed', summary, spendUsd?, turns?,
 *                            need?: { kind:'tool'|'human'|'decompose', ...}, newItems?: [text] }
 *   decompose  — async ({ goal }) → [plan item text]      (a model in the app; a fake in tests)
 *   escalations— a lib/escalate.js instance (optional; without it a 'human' need becomes blocked)
 *   forge      — a lib/toolforge.js instance (optional; without it a 'tool' need becomes blocked)
 *   now, sleep, log, onEvent
 */
function createSupervisor(deps = {}, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || (() => {});
  const onEvent = deps.onEvent || (() => {});
  const missions = deps.missions;
  const runAgent = deps.runAgent;
  const decompose = deps.decompose || (async ({ goal }) => [String(goal)]);
  const escalations = deps.escalations || null;
  const forge = deps.forge || null;
  // A cooperative stop, checked once per scheduling pass. Killing mid-tool would orphan the spend,
  // which is the one outcome with no upside — so a stop drains what is in flight and parks, exactly
  // like every other wall.
  const shouldStop = deps.shouldStop || (() => false);
  // THE LAST THING BETWEEN A RUN AND "IT IS DONE". lib/custodian.js already guards the drone fan-out
  // and was wired into nothing else — which left the biggest fan-out in the app, an hour of
  // unattended work, reporting "nine done" with nobody having asked whether nine done items answer
  // the question that was asked. Injected, optional, and its verdict is ATTACHED rather than
  // substituted: the report goes back either way and a doubt rides alongside it.
  const review = deps.review || null;
  if (!missions) throw new Error('supervisor needs a missions store');
  if (typeof runAgent !== 'function') throw new Error('supervisor needs runAgent');

  // The live roster. Kept in RAM on purpose: it is what the office renders, and it is reconstructed
  // from the plan on resume rather than trusted across a crash (an agent from a dead process is not
  // working, whatever the file says).
  const agents = new Map();
  let nameSeq = 0;
  function nextName() {
    const pool = CODENAMES.length ? CODENAMES : FALLBACK_NAMES;
    return pool[nameSeq++ % pool.length] + (nameSeq > pool.length ? '-' + Math.ceil(nameSeq / pool.length) : '');
  }

  function emit(type, extra = {}) {
    try { onEvent({ type, at: now(), ...extra }); } catch {}
  }
  /** Push one agent's whole visible state at once, so the office never renders a half-update. */
  function emitAgent(a) {
    emit('agent', {
      id: a.id, name: a.name, designation: a.designation,
      color: designation.get(a.designation).glow,
      state: a.state, task: a.task, step: a.step, since: a.since, itemIndex: a.itemIndex,
    });
  }

  // ── need routing ────────────────────────────────────────────────────────────────────────────────
  /**
   * A worker came back saying it could not proceed. This is where "build a tool or ask for help"
   * actually happens, and it returns what the ITEM should become.
   */
  async function serveNeed(need, ctx) {
    const kind = String((need && need.kind) || '').toLowerCase();

    if (kind === 'tool') {
      if (!forge) return { status: 'blocked', note: `needs a tool (${need.name || 'unnamed'}) and no forge is wired` };
      emit('forging', { name: need.name, purpose: need.purpose, item: ctx.itemIndex });
      const r = await forge.forge({ ...need, forgedFor: ctx.itemText, missionId: ctx.missionId });
      if (r.ok) {
        log(`[supervisor] forged ${r.tool.name} for "${ctx.itemText.slice(0, 60)}"`);
        emit('forged', { name: r.tool.name, item: ctx.itemIndex, cases: r.cases.length });
        // The item is not done — it is now DOABLE. Back to todo with the new tool named in the note so
        // the next attempt is told what it gained.
        return { status: 'todo', note: `forged ${r.tool.name} — retry with it`, retry: true };
      }
      emit('forge-failed', { name: need.name, item: ctx.itemIndex, stage: r.stage });
      // A forge that failed on its own tests is a capability gap the agent could not close by itself,
      // which is exactly when a human is the right escalation — not another attempt.
      return await serveNeed({
        kind: 'human',
        question: `I tried to build a tool (${need.name || 'unnamed'}) for "${ctx.itemText.slice(0, 120)}" and it failed its own tests: ${(r.errors || []).join('; ').slice(0, 300)}. How should I handle this?`,
        assumption: 'skip this item and report it as blocked',
      }, ctx);
    }

    if (kind === 'human') {
      if (!escalations) return { status: 'blocked', note: `needs Siddhant (${String(need.question || '').slice(0, 120)}) and no escalation channel is wired` };
      const e = await escalations.ask({
        question: need.question || `I am stuck on "${ctx.itemText.slice(0, 120)}" — how should I proceed?`,
        why: need.why || '', assumption: need.assumption || '', options: need.options || [],
        agent: ctx.agentName, missionId: ctx.missionId, urgency: need.urgency,
      });
      emit('escalated', { id: e.id, item: ctx.itemIndex, question: e.question, via: e.via, deduped: !!e.deduped });
      // ASKED, NOT WAITING. The item is blocked on that id; every other item keeps moving, and the
      // loop only waits when it has nothing else to do.
      return { status: 'blocked', note: `waiting on ${e.id}`, waitingOn: e.id, assumption: e.assumption || need.assumption || '' };
    }

    if (kind === 'decompose') {
      const parts = (need.items || []).map(String).filter(Boolean).slice(0, 8);
      if (!parts.length) return { status: 'blocked', note: 'asked to decompose but offered no sub-items' };
      return { status: 'done', note: `split into ${parts.length}`, addItems: parts };
    }

    return { status: 'blocked', note: String((need && need.note) || 'the worker reported a need this supervisor does not know how to serve').slice(0, 200) };
  }

  // ── one item, one agent ─────────────────────────────────────────────────────────────────────────
  async function workItem(h, index, item, ctxBlock) {
    const id = 'sa_' + index + '_' + now().toString(36).slice(-4);
    const desig = designation.classify(item.text);
    const a = {
      id, name: nextName(), designation: desig, itemIndex: index,
      state: 'thinking', task: item.text, step: '', since: now(),
    };
    agents.set(id, a);
    emitAgent(a);
    h.plan.mark(index, 'doing', a.name);

    let env = {};
    const t0 = now();
    try {
      a.state = 'working'; emitAgent(a);
      env = await runAgent({
        id, name: a.name, designation: desig, goal: item.text, item, itemIndex: index,
        context: ctxBlock, missionId: h.id,
        budgetUsd: opts.itemBudgetUsd, maxTurns: opts.maxTurns || 12,
        onStep: (s) => { a.step = String(s || '').slice(0, 160); emitAgent(a); },
      }) || {};
    } catch (e) {
      env = { status: 'failed', summary: String((e && e.message) || e).slice(0, 300) };
    }
    const ms = now() - t0;
    const spend = Number(env.spendUsd) || 0;
    if (spend) h.spend(spend);
    h.step({ name: `item:${index}`, input: { text: item.text }, result: env, ms, status: env.status === 'failed' ? 'error' : 'ok' });

    a.state = env.status === 'done' ? 'done' : env.status === 'failed' ? 'error' : 'idle';
    a.step = String(env.summary || '').slice(0, 160);
    emitAgent(a);

    const ctx = { itemIndex: index, itemText: item.text, missionId: h.id, agentName: a.name };
    let outcome;
    if (env.status === 'done') outcome = { status: 'done', note: String(env.summary || '').slice(0, 200) };
    else if (env.need) outcome = await serveNeed(env.need, ctx);
    else if (env.status === 'partial') outcome = { status: 'todo', note: String(env.summary || 'partial').slice(0, 200), retry: true };
    else outcome = { status: 'failed', note: String(env.summary || 'failed with no reason given').slice(0, 200) };

    // New items an agent discovered are real work and belong in the plan — capped, because an agent
    // that can grow its own plan without limit has an unbounded run.
    const extra = [...(env.newItems || []), ...(outcome.addItems || [])].map(String).filter(Boolean);

    agents.delete(id);
    emit('agent-gone', { id });
    return { ...outcome, spend, ms, extra, turns: env.turns || 0, agentName: a.name, designation: desig };
  }

  // ── the run ─────────────────────────────────────────────────────────────────────────────────────
  /**
   * run({ goal, plan?, budgetUsd?, wallClockMs?, width? }) → report
   *
   * Returns when the plan is finished or a wall is hit. Never throws for an ordinary outcome: the
   * report says which wall, what is done, what is blocked and what is still waiting on Siddhant.
   */
  async function run(spec = {}) {
    const goal = String(spec.goal || '').trim();
    if (!goal) throw new Error('a supervised run needs a goal');
    const budgetUsd = Number.isFinite(spec.budgetUsd) ? spec.budgetUsd : opts.budgetUsd;
    const wallClockMs = Number.isFinite(spec.wallClockMs) ? spec.wallClockMs : opts.wallClockMs;
    const width = Math.max(1, Math.min(12, spec.width || opts.width));

    let items = (spec.plan || []).map(String).filter(Boolean);
    if (!items.length) {
      emit('planning', { goal });
      try { items = (await decompose({ goal })) || []; } catch (e) { log('[supervisor] decompose failed: ' + (e && e.message)); items = []; }
      items = items.map(String).map((s) => s.trim()).filter(Boolean).slice(0, opts.planMax);
    }
    // A goal nobody could decompose is still a goal: one item, worked directly. Refusing to start
    // because the planner had a bad minute is the wrong failure.
    if (!items.length) items = [goal];

    const h = missions.open({ goal, budgetUsd, plan: items, kind: 'supervised' });
    emit('run-start', { missionId: h.id, goal, plan: h.plan.read().map((p) => p.text), budgetUsd, wallClockMs, width });
    return loop(h, { budgetUsd, wallClockMs, width, startedAt: now() });
  }

  /** resume(missionId) — pick a parked run back up with its walls intact. */
  async function resume(missionId, spec = {}) {
    const h = missions.resume(missionId);
    if (!h) return { ok: false, error: 'no such mission' };
    const m = h.meta || {};
    emit('run-resume', { missionId, goal: m.goal, resumeCount: m.resumeCount });
    // An agent from a dead process is not working, whatever plan.md says. Anything left `doing` by the
    // run that died goes back to todo — otherwise the item is neither runnable nor finishable and the
    // resumed run idles until it trips the stall wall, blaming itself for a crash that already happened.
    healDoing(h);
    // An answer may have arrived while it was parked; unblock anything that was waiting on it.
    applyAnswers(h);
    return loop(h, {
      budgetUsd: Number.isFinite(m.budgetUsd) ? m.budgetUsd : opts.budgetUsd,
      wallClockMs: Number.isFinite(spec.wallClockMs) ? spec.wallClockMs : opts.wallClockMs,
      width: Math.max(1, Math.min(12, spec.width || opts.width)),
      startedAt: now(),
    });
  }

  /**
   * Any item blocked on an escalation that has since been answered goes back to todo, with the answer
   * in its note so the next attempt can see it. This is what makes "run with my further input until
   * the task is finished" true rather than aspirational.
   */
  /** Anything still marked `doing` belongs to a process that is gone. Make it runnable again. */
  function healDoing(h) {
    let n = 0;
    h.plan.read().forEach((p, i) => {
      if (p.status !== 'doing') return;
      h.plan.mark(i, 'todo', `${p.note ? p.note + ' — ' : ''}the run working on this one died`);
      n++;
    });
    if (n) emit('healed', { items: n });
    return n;
  }

  function applyAnswers(h) {
    if (!escalations) return 0;
    let n = 0;
    const items = h.plan.read();
    items.forEach((p, i) => {
      const m = /waiting on (esc_[a-z0-9]+)/i.exec(p.note || '');
      if (!m || p.status !== 'blocked') return;
      const ans = escalations.isAnswered(m[1]);
      if (!ans) return;
      // SAY WHICH IT IS. An escalation can come back two ways: Siddhant actually answered, or nobody
      // was awake and it fell back to its own stated assumption. Writing "Siddhant said: APA" into the
      // plan when he was asleep puts a fabrication into the durable record and into the next agent's
      // context — and it is the report, in the morning, that has to be able to tell them apart.
      const spoke = ans.status === 'answered';
      const note = spoke
        ? `Siddhant said: ${String(ans.answer).slice(0, 140)}${ans.assumed ? ' (which question he meant was a guess)' : ''}`
        : `no answer — proceeding on the assumption: ${String(ans.answer).slice(0, 140)}`;
      h.plan.mark(i, 'todo', note);
      emit('unblocked', { item: i, escalation: m[1], answer: String(ans.answer).slice(0, 200), assumed: !!ans.assumed, fromSiddhant: spoke });
      n++;
    });
    return n;
  }

  async function loop(h, cfg) {
    const { budgetUsd, wallClockMs, width, startedAt } = cfg;
    const inFlight = new Map();     // itemIndex → promise
    const attempts = new Map();     // itemIndex → count
    let ticks = 0, consecutiveFailures = 0, lastDigest = null, stallFor = 0;
    let stop = null;
    let waitedForAnswer = 0;

    const spent = () => Number((h.meta || {}).spendUsd) || 0;
    const elapsed = () => now() - startedAt;

    while (!stop) {
      ticks++;
      h.heartbeat();

      // ── walls, checked before anything is launched ────────────────────────────────────────────
      if (shouldStop()) stop = 'stopped';
      else if (elapsed() >= wallClockMs) stop = 'wall-clock';
      else if (spent() >= budgetUsd) stop = 'budget';
      else if (ticks > opts.maxTicks) stop = 'ticks';
      else if (consecutiveFailures >= opts.maxConsecutiveFailures) stop = 'failures';
      if (stop) {
        // Let whatever is already in flight finish rather than orphaning its spend: the money is
        // spent either way, and a discarded result is the one outcome with no upside.
        if (inFlight.size) { emit('draining', { reason: stop, inFlight: inFlight.size }); await Promise.allSettled([...inFlight.values()]); }
        break;
      }

      applyAnswers(h);
      let plan = h.plan.read();

      // ── progress ─────────────────────────────────────────────────────────────────────────────
      // A change in the PLAN, not a tick and not a reply. An agent can talk beautifully for an hour
      // without moving anything, and this is what notices.
      const digest = planDigest(plan);
      if (digest !== lastDigest) { lastDigest = digest; stallFor = 0; }
      else if (!inFlight.size) stallFor++;      // only idle ticks count; work in flight is not a stall
      if (stallFor >= opts.stallTicks) { stop = 'stalled'; break; }

      const open = plan.map((p, i) => ({ ...p, i })).filter((p) => p.status === 'todo');
      const doing = plan.filter((p) => p.status === 'doing').length;
      const blocked = plan.map((p, i) => ({ ...p, i })).filter((p) => p.status === 'blocked');
      const done = plan.filter((p) => p.status === 'done').length;

      if (!open.length && !inFlight.size && !doing) {
        if (!blocked.length) { stop = 'complete'; break; }

        // NOTHING ELSE TO DO. Only now is waiting the right move — and only for a bounded time, after
        // which every blocked item falls back to the assumption its escalation stated.
        const waitingIds = blocked.map((p) => (/waiting on (esc_[a-z0-9]+)/i.exec(p.note || '') || [])[1]).filter(Boolean);
        if (waitingIds.length && escalations && waitedForAnswer < 2) {
          waitedForAnswer++;
          emit('waiting', { on: waitingIds, ms: opts.idleWaitMs, blocked: blocked.length });
          h.park(`waiting on ${waitingIds.join(', ')}`);
          const got = await Promise.race([
            ...waitingIds.map((id) => escalations.wait(id, opts.idleWaitMs)),
            sleep(opts.idleWaitMs).then(() => ({ answered: false, timedOut: true })),
          ]);
          missions.resume(h.id);
          if (got && got.answered) { emit('answer-arrived', {}); continue; }

          // Timed out. Proceed on the stated assumptions and SAY SO — this is the branch that makes an
          // hour-long run survive being ignored.
          for (const p of blocked) {
            const eid = (/waiting on (esc_[a-z0-9]+)/i.exec(p.note || '') || [])[1];
            const e = eid && escalations.get ? escalations.get(eid) : null;
            const assumption = (e && e.assumption) || '';
            if (assumption) { h.plan.mark(p.i, 'todo', `no answer — proceeding on the assumption: ${assumption}`); emit('assumed', { item: p.i, assumption }); }
          }
          continue;
        }
        stop = 'blocked';
        break;
      }

      // ── launch ───────────────────────────────────────────────────────────────────────────────
      const ctxBlock = h.anchor();
      while (inFlight.size < width && open.length) {
        const next = open.shift();
        const tried = attempts.get(next.i) || 0;
        if (tried >= opts.maxItemAttempts) {
          h.plan.mark(next.i, 'blocked', `${tried} attempts, still not done — ${String(next.note || '').slice(0, 120)}`);
          emit('gave-up', { item: next.i, attempts: tried, text: next.text });
          continue;
        }
        attempts.set(next.i, tried + 1);
        const p = workItem(h, next.i, next, ctxBlock).then((r) => ({ i: next.i, r })).catch((e) => ({ i: next.i, r: { status: 'failed', note: String((e && e.message) || e), spend: 0, extra: [] } }));
        inFlight.set(next.i, p);
      }

      if (!inFlight.size) { await sleep(opts.tickDelayMs); continue; }

      // ── collect one ──────────────────────────────────────────────────────────────────────────
      const { i, r } = await Promise.race([...inFlight.values()]);
      inFlight.delete(i);

      if (r.status === 'done') { h.plan.mark(i, 'done', r.note); consecutiveFailures = 0; }
      else if (r.status === 'todo') { h.plan.mark(i, 'todo', r.note); consecutiveFailures = 0; }
      else if (r.status === 'blocked') { h.plan.mark(i, 'blocked', r.note); consecutiveFailures = 0; }
      else { h.plan.mark(i, 'todo', r.note); consecutiveFailures++; }

      if (r.extra && r.extra.length) {
        const cur = h.plan.read();
        const known = new Set(cur.map((p) => p.text));
        const add = r.extra.filter((t) => !known.has(t)).slice(0, Math.max(0, opts.planMax - cur.length));
        if (add.length) {
          h.plan.set([...cur, ...add.map((t) => ({ text: t, status: 'todo', note: 'found while working' }))]);
          emit('plan-grew', { added: add, by: r.agentName });
        }
      }

      h.checkpoint();
      const d = h.plan.digest();
      emit('progress', { missionId: h.id, done: d.done, total: d.total, blocked: h.plan.read().filter((p) => p.status === 'blocked').length,
        spentUsd: +spent().toFixed(4), elapsedMs: elapsed(), inFlight: inFlight.size });
    }

    // ── the report ────────────────────────────────────────────────────────────────────────────────
    const plan = h.plan.read();
    const doneItems = plan.filter((p) => p.status === 'done');

    // Only worth asking when there is something to judge. A run that finished nothing has already
    // said so plainly, and a reviewer's opinion of an empty deliverable is noise.
    let custody = null;
    if (review && doneItems.length) {
      try {
        custody = await review({
          goal: (h.meta || {}).goal,
          deliverable: doneItems.map((p) => `${p.text}${p.note ? ' — ' + p.note : ''}`).join('\n'),
          trace: plan.map((p) => `[${p.status}] ${p.text}`),
        });
        if (custody && custody.verdict && custody.verdict !== 'accept') emit('doubt', { verdict: custody.verdict, reason: custody.reason || custody.question || '' });
      } catch (e) { custody = { verdict: 'error', reason: 'the reviewer threw: ' + String((e && e.message) || e).slice(0, 160) }; }
    }

    const report = {
      ok: stop === 'complete',
      missionId: h.id,
      goal: (h.meta || {}).goal,
      stoppedBecause: stop,
      done: plan.filter((p) => p.status === 'done').map((p) => p.text),
      blocked: plan.filter((p) => p.status === 'blocked').map((p) => ({ text: p.text, why: p.note })),
      open: plan.filter((p) => p.status === 'todo' || p.status === 'doing').map((p) => p.text),
      spentUsd: +spent().toFixed(4),
      elapsedMs: elapsed(),
      ticks,
      waitingOnSiddhant: escalations ? escalations.pending().map((e) => ({ id: e.id, question: e.question, assumption: e.assumption })) : [],
      forged: forge ? forge.list().filter((t) => t.missionId === h.id).map((t) => t.name) : [],
      // Shown to whoever reads the report, never used to rewrite it. A check whose result is not put
      // in front of the decider is not a check.
      custodian: custody ? { verdict: custody.verdict, reason: custody.reason || null, question: custody.question || null, missing: custody.missing || null } : null,
    };
    // 'complete' closes the mission; every other stop PARKS it, because a wall is a pause and the
    // difference matters: a parked mission is one `resume` away, a closed one is over.
    if (stop === 'complete') h.close('done');
    else h.park(`stopped: ${stop}`);

    for (const a of agents.values()) emit('agent-gone', { id: a.id });
    agents.clear();
    emit('run-end', report);
    log(`[supervisor] ${h.id} ${stop} — ${report.done.length} done, ${report.blocked.length} blocked, $${report.spentUsd}, ${Math.round(report.elapsedMs / 1000)}s`);
    return report;
  }

  /** The live roster, for the office and the agent cards. */
  function roster() {
    return [...agents.values()].map((a) => ({
      id: a.id, name: a.name, designation: a.designation, label: designation.get(a.designation).label,
      color: designation.get(a.designation).glow, state: a.state, task: a.task, step: a.step, since: a.since,
    }));
  }

  return { run, resume, loop, roster, applyAnswers, healDoing, opts, DEFAULTS };
}

module.exports = { createSupervisor, DEFAULTS, STOP_REASONS, planDigest };
