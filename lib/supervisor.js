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
const blackboard = require('./blackboard');
const mission = require('./mission');

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
//
// CODENAMES is an OBJECT — `{coding:'FORGE', research:'ORACLE', browser:'SCOUT', memory:'VAULT',
// creative:'ATELIER', orchestrator:'OVERMIND'}` — and this file used it as an ARRAY. `.length` on an
// object is `undefined`, so the `CODENAMES.length ? … : FALLBACK_NAMES` test below was always falsy
// and every supervised agent that has ever run was called VALE or ORRIN. The five real codenames, the
// ones the office legend and the drone fleet already use, had never once appeared in a long run —
// while the comment above claimed they did.
let ROLE_CODENAME = {};
try { ROLE_CODENAME = require('./agents/roles').CODENAMES || {}; } catch { ROLE_CODENAME = {}; }
const CODENAMES = Object.entries(ROLE_CODENAME).filter(([r]) => r !== 'orchestrator').map(([, n]) => n);
const FALLBACK_NAMES = ['VALE', 'ORRIN', 'SABLE', 'QUILL', 'BRAM', 'IVO', 'NOOR', 'TARN', 'WREN', 'CASS'];

// ── THE FIVE ROLES ────────────────────────────────────────────────────────────────────────────────
//
// lib/agents/roles and lib/agents/orchestrator.js already enforce exactly five workers with an
// orchestrator above them — `enum: ['coding','research','browser','memory','creative']`. This file
// classified free text into one of NINE designations instead, so a supervised agent was never one of
// the five and the codenames they were given went unused.
//
// ONE CLASSIFICATION, TWO DERIVED FACTS. The item's text is classified once into a designation, and
// that designation decides BOTH its tools and its colour (as it always has) AND, through this map,
// which of the five roles owns it. Adding a third taxonomy is how the two tool tables and the two
// classifiers already in this repo came to disagree; this deliberately adds none.
//
// The four designations with no role of their own map by what the work IS, not by what it is called:
// science and comms are both finding-things-out, forging a tool is coding, and orchestrating inside a
// supervised run should not happen at all (the supervisor is the orchestrator) so it falls to research
// like any other unclassified reading.
const ROLES = ['coding', 'research', 'browser', 'memory', 'creative'];
const DESIGNATION_ROLE = {
  code: 'coding', forge: 'coding',
  research: 'research', science: 'research', comms: 'research', orchestrate: 'research', general: 'research',
  browser: 'browser',
  memory: 'memory',
  create: 'creative',
};
const roleOf = (desig) => DESIGNATION_ROLE[desig] || 'research';

const STOP_REASONS = ['complete', 'wall-clock', 'budget', 'stalled', 'failures', 'ticks', 'stopped', 'blocked', 'cycle', 'throttled'];

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
  // ── ONE ARBITER ────────────────────────────────────────────────────────────────────────────────
  // Three things want to set the agent count: lib/admission.js (live OTPM), the cost pilot, and the
  // machine tier. Two of them would eventually fight, and the loser would be an evening spent asking
  // "who lowered my width". They are inputs to ONE function that takes the minimum and NAMES the
  // constraint that bound it, so the answer to that question is in the event stream.
  //
  // Each is optional and absent means "no opinion", never zero — a missing controller must not be able
  // to stop the run by defaulting to a cap of nothing.
  const widthCaps = deps.widthCaps || {};
  // The cost watcher, if one was wired. It is ticked from the loop so its "every fifteen minutes" is
  // measured against the run's own scheduling passes rather than against a timer nobody cancels when
  // the run ends — and it is entirely optional, because a supervisor that cannot run without a cost
  // pilot has made the pilot part of the machinery rather than an observer of it.
  const costpilot = deps.costpilot || null;
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
  /**
   * An agent is named after the ROLE it is filling, so the name means something across a whole run:
   * ORACLE is always the one doing research. A rotating pool gave every item a different name, which
   * is why the blackboard roster grew one dead agent per item and why the five real codenames — the
   * ones the office legend and the drone fleet already use — never appeared in a supervised run.
   */
  function nameFor(role) {
    const c = ROLE_CODENAME[role];
    if (c) return c;
    const pool = CODENAMES.length ? CODENAMES : FALLBACK_NAMES;
    return pool[nameSeq++ % pool.length];
  }

  function emit(type, extra = {}) {
    try { onEvent({ type, at: now(), ...extra }); } catch {}
  }
  /** Push one agent's whole visible state at once, so the office never renders a half-update. */
  function emitAgent(a) {
    emit('agent', {
      id: a.id, name: a.name, designation: a.designation,
      color: designation.get(a.designation).glow,
      role: a.role, state: a.state, task: a.task, step: a.step, since: a.since, itemIndex: a.itemIndex,
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
        // The item is not done — it is now DOABLE. Back to todo, with the new tool named in the note so
        // the next attempt is told what it gained, and NOT charged an attempt: it was not tried and
        // found wanting, it was tried and found to need a capability that now exists. Charging it
        // would leave a two-attempt item one real go after building its own tool, which is the
        // opposite of what forging is for.
        return { status: 'todo', note: `forged ${r.tool.name} — retry with it`, retry: true, refund: true };
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

      // ALREADY ANSWERED. A question can dedupe onto one a sibling asked ten minutes ago, or be
      // auto-assumed on the spot because it is 3am or because the interruption budget is spent. In all
      // three the answer exists now, and blocking the item on an escalation that is already settled
      // sends it round the loop — blocked, unblocked, blocked — for no gain. Hand it the answer.
      const known = escalations.isAnswered(e.id);
      if (known) {
        const spoke = known.status === 'answered';
        // The SAME event as the slower path, on purpose. Whoever is watching cares that this item got
        // its answer and whether the answer was really his — not which of two routes it arrived by.
        emit('unblocked', { item: ctx.itemIndex, escalation: e.id, answer: String(known.answer).slice(0, 200), assumed: !!known.assumed, fromSiddhant: spoke });
        return { status: 'todo', retry: true, refund: true,
          note: spoke
            ? `Siddhant said: ${String(known.answer).slice(0, 140)}`
            : `no answer — proceeding on the assumption: ${String(known.answer).slice(0, 140)}` };
      }

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

  // ── the blackboard ──────────────────────────────────────────────────────────────────────────────
  // WITHOUT THIS, PARALLEL IS ONLY FASTER, NOT SMARTER. Three agents working three items of one plan
  // at the same time run completely blind to each other: the one that discovers the API needs an
  // account cannot tell the two that are about to hit the same wall, and the plan finds out three
  // items later. lib/blackboard.js is the fleet's answer to exactly this and the supervisor had no
  // handle on it.
  //
  // The supervisor posts on the workers' BEHALF rather than handing them a tool: a status when an
  // item starts and its outcome when it ends. That needs no cooperation from the model — an agent
  // that forgets to post is the normal case, and a coordination channel that only works when every
  // agent remembers to use it does not work.
  // Post, and SHOW it. The office exists so the division of labour is readable across the room, and
  // the half that was missing is the agents talking to each other: without this they are three people
  // working silently at three desks, which looks the same whether they are coordinating or not.
  function say(board, a, kind, text) {
    try { board.post({ agent: a.name, taskId: 'item-' + a.itemIndex, kind, text }); } catch {}
    emit('said', { id: a.id, name: a.name, kind, text: String(text).slice(0, 160) });
  }

  function boardFor(h) {
    if (deps.board) return deps.board;
    try { return blackboard.createBlackboard({ dir: h.dir }); } catch { return null; }
  }

  // ── one item, one agent ─────────────────────────────────────────────────────────────────────────
  async function workItem(h, index, item, ctxBlock, board) {
    const id = 'sa_' + index + '_' + now().toString(36).slice(-4);
    // The designation comes from the text; the role comes from the designation unless the plan named
    // one. A planner that says `role: 'coding'` is making a scheduling claim and is believed.
    const desig = designation.classify(item.text);
    const role = ROLES.includes(item.role) ? item.role : roleOf(desig);
    const a = {
      id, name: nameFor(role), designation: desig, role, itemIndex: index,
      state: 'thinking', task: item.text, step: '', since: now(),
    };
    agents.set(id, a);
    emitAgent(a);
    h.plan.mark(index, 'doing', a.name);
    if (board) say(board, a, 'status', `starting: ${item.text}`);

    let env = {};
    const t0 = now();
    try {
      a.state = 'working'; emitAgent(a);
      env = await runAgent({
        id, name: a.name, designation: desig, role, goal: item.text, item, itemIndex: index,
        context: ctxBlock, missionId: h.id, board,
        budgetUsd: opts.itemBudgetUsd, maxTurns: opts.maxTurns || 12,
        onStep: (s) => { a.step = String(s || '').slice(0, 160); emitAgent(a); },
      }) || {};
    } catch (e) {
      env = { status: 'failed', summary: String((e && e.message) || e).slice(0, 300) };
    }
    const ms = now() - t0;
    const spend = Number(env.spendUsd) || 0;
    if (spend) h.spend(spend);
    // tokensIn/tokensOut have been accepted by mission.step() since it was written and passed by
    // nobody, so every journal row ever recorded carries `undefined` for both. Nothing can predict the
    // cost of a run from a history that never recorded one — this is where that history starts.
    h.step({
      name: `item:${index}`, input: { text: item.text }, result: env, ms,
      tokensIn: Number(env.tokensIn) || 0, tokensOut: Number(env.tokensOut) || 0,
      status: env.status === 'failed' ? 'error' : 'ok',
    });

    // A NEED is a WALL, not a slow patch. Done and partial both post findings — a partial with an
    // honest summary is exactly the kind of half-learned thing a sibling starting something similar
    // wants — while blocked and failed post needs, because those are the ones somebody else is about
    // to walk into. Calling a partial a need would make "need" mean "an item did not finish", which
    // is already in the plan and would drown the signal that is not.
    const stuck = env.status === 'blocked' || env.status === 'failed';
    if (board) say(board, a, stuck ? 'need' : 'finding', `${item.text} → ${env.status}: ${String(env.summary || '').slice(0, 180)}`);
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
    return { ...outcome, spend, ms, extra, turns: env.turns || 0, agentName: a.name, designation: desig, role, refund: !!outcome.refund };
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

    // A plan item is either a string (as it has always been) or {id, text, needs[], role}. Both go
    // through the same normaliser, so a caller that knows nothing about the graph keeps working.
    const asItem = (x) => (typeof x === 'string'
      ? { text: x.trim(), status: 'todo', note: '', id: '', needs: [], role: '' }
      : {
        text: String((x && x.text) || '').trim(), status: 'todo', note: '',
        id: String((x && x.id) || ''), role: String((x && x.role) || ''),
        needs: Array.isArray(x && x.needs) ? x.needs.map(String).filter(Boolean) : [],
      });

    let items = (spec.plan || []).map(asItem).filter((x) => x.text);
    // planMax guarded only the decomposed path, so `long_run{plan:[...]}` walked straight past it —
    // which is how a soak once put 800 items into a 40-item ceiling. A ceiling one caller can step
    // over is not a ceiling.
    if (items.length > opts.planMax) {
      emit('plan-capped', { given: items.length, kept: opts.planMax });
      items = items.slice(0, opts.planMax);
    }
    if (!items.length) {
      emit('planning', { goal });
      try { items = (await decompose({ goal })) || []; } catch (e) { log('[supervisor] decompose failed: ' + (e && e.message)); items = []; }
      items = items.map(asItem).filter((x) => x.text).slice(0, opts.planMax);
    }
    // A goal nobody could decompose is still a goal: one item, worked directly. Refusing to start
    // because the planner had a bad minute is the wrong failure.
    if (!items.length) items = [asItem(goal)];

    // A CYCLE IS REFUSED, NOT SURVIVED. Two items that need each other are never both ready, so the
    // readiness gate would simply never launch either and the run would idle into the stall wall and
    // report 'stalled' — true, and useless. Say what is actually wrong.
    const cycle = mission.cycleOf(items);
    if (cycle) {
      emit('plan-rejected', { reason: 'cycle', at: cycle });
      return {
        ok: false, stoppedBecause: 'cycle', error: `the plan has a dependency cycle at "${cycle}"`,
        done: [], blocked: [], open: items.map((i) => i.text), spentUsd: 0, elapsedMs: 0, ticks: 0,
        waitingOnSiddhant: [], forged: [], custodian: null,
      };
    }

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
    if (!escalations) return [];
    const unblocked = [];
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
      unblocked.push(i);
    });
    return unblocked;
  }

  /**
   * widthNow(requested) → { value, bindingConstraint }
   *
   * The only place an agent count is decided. `requested` is what the run asked for; everything else
   * can lower it and nothing can raise it above what was asked.
   */
  function widthNow(requested) {
    let value = Math.max(1, requested), binding = 'spec';
    for (const [name, fn] of Object.entries(widthCaps)) {
      let cap;
      try { cap = fn(); } catch { cap = null; }
      if (!Number.isFinite(cap)) continue;               // no opinion
      const c = Math.max(0, Math.floor(cap));
      if (c < value) { value = c; binding = name; }
    }
    return { value, bindingConstraint: binding };
  }

  async function loop(h, cfg) {
    const { wallClockMs, width: requestedWidth, startedAt } = cfg;
    // budgetUsd and width are re-read every pass rather than captured once, so a controller that
    // lowers either of them mid-run actually changes what the next pass does. They were constants,
    // which made every later phase's lever a no-op by construction.
    let budgetUsd = cfg.budgetUsd;
    let width = requestedWidth, lastBinding = null;
    const board = boardFor(h);
    const inFlight = new Map();     // itemIndex → promise
    const attempts = new Map();     // item KEY → count (refundable); see keyOf below
    // ONE REFUND PER ITEM, EVER.
    //
    // Found by an hour-long soak, which is the only thing that could have found it. Forging a tool or
    // getting an answer refunds an attempt, on the reasoning that the item was not tried and found
    // wanting. But an agent that keeps reporting the SAME need gets refunded every time: it escalates,
    // the question dedupes onto an escalation that is already answered, applyAnswers unblocks it
    // immediately, the attempt is refunded, and it escalates again. Three such items took all three
    // worker slots and held them for half an hour — 591 journal entries across three of eight hundred
    // items, while the other 779 never got a turn.
    //
    // The stall wall could not see it, and that is the instructive part: the plan WAS changing on
    // every pass, blocked → todo → blocked. It was progress by the letter of the definition and a
    // livelock by any other measure. So the bound cannot be another progress heuristic; it has to be a
    // hard count that nothing can give back.
    const refunded = new Set();     // itemIndex — has this item already had its one extra go?
    let ticks = 0, consecutiveFailures = 0, lastDigest = null, stallFor = 0;
    // A ROLLING WINDOW BESIDE THE STREAK, because the streak alone cannot tell two very different
    // situations apart: a run where nothing has ever worked, and a run that has worked for half an
    // hour and just hit a rough patch. A 62-minute soak died on this — 256 items verified, then five
    // consecutive model timeouts during a burst of unrelated load, and the wall retired it as though
    // the whole run were broken. That wall is for "everything is broken", and 2% of calls timing out
    // after 213 successes is not that.
    const recent = [];              // last N outcomes, true = failed
    const RECENT_MAX = 20;
    let mode = null;                 // 'uniform' | 'ensemble', announced on change
    let heldForRole = 0;             // ready items waiting only because their role is already busy
    const roleInFlight = new Map();  // role → how many of that role are running right now
    let stop = null;
    let waitedForAnswer = 0;

    const spent = () => Number((h.meta || {}).spendUsd) || 0;
    const elapsed = () => now() - startedAt;
    // KEYED BY IDENTITY, NOT POSITION.
    //
    // Both of these used the item's array index. That was defensible while the index WAS the identity,
    // and stops being so the moment items carry ids and plan.md is a file a human is invited to edit:
    // deleting one line re-points every attempt count and every spent refund at a different item, and
    // the two most safety-critical counters in the loop are the last place to want that. An item with
    // no id falls back to its text, which is stable under reordering even though it is not unique —
    // still strictly better than a position that changes when anything above it moves.
    const keyOf = (p) => (p && p.id) || `#${(p && p.text) || ''}`;

    /** Give an item one more go for gaining a capability or an answer — once, and never again. */
    function refund(k) {
      if (refunded.has(k)) return false;
      refunded.add(k);
      attempts.set(k, Math.max(0, (attempts.get(k) || 1) - 1));
      return true;
    }

    while (!stop) {
      ticks++;
      h.heartbeat();

      // The cost report, on its own cadence. Before the walls, so a run that is about to stop still
      // gets one last honest number rather than going quiet at the moment it matters most.
      if (costpilot) { try { costpilot.tick(); } catch {} }

      // Re-arbitrate before the walls are checked, so a narrowed width takes effect this pass.
      {
        const w = widthNow(requestedWidth);
        if (w.value !== width || w.bindingConstraint !== lastBinding) {
          emit('width', { from: width, value: w.value, bindingConstraint: w.bindingConstraint });
          width = w.value; lastBinding = w.bindingConstraint;
        }
        const b = Number(typeof cfg.budgetNow === 'function' ? cfg.budgetNow() : budgetUsd);
        if (Number.isFinite(b) && b !== budgetUsd) { emit('budget', { from: budgetUsd, to: b }); budgetUsd = b; }
      }

      // ── walls, checked before anything is launched ────────────────────────────────────────────
      // A controller may narrow width to ZERO — the tier ladder does this at `critical`. That is a
      // request to stop launching, not to spin: drain what is running and park, so the run can be
      // picked up when the machine recovers.
      if (width < 1 && !inFlight.size) { stop = 'throttled'; break; }
      if (shouldStop()) stop = 'stopped';
      else if (elapsed() >= wallClockMs) stop = 'wall-clock';
      else if (spent() >= budgetUsd) stop = 'budget';
      else if (ticks > opts.maxTicks) stop = 'ticks';
      // Both conditions, not either. The streak says "right now is bad"; the window says "and it is
      // not just a blip in an otherwise working run". A run with a track record gets to spend it.
      else if (consecutiveFailures >= opts.maxConsecutiveFailures
        && recent.length >= opts.maxConsecutiveFailures
        && recent.filter(Boolean).length > recent.length / 2) stop = 'failures';
      if (stop) {
        // Let whatever is already in flight finish rather than orphaning its spend: the money is
        // spent either way, and a discarded result is the one outcome with no upside.
        if (inFlight.size) { emit('draining', { reason: stop, inFlight: inFlight.size }); await Promise.allSettled([...inFlight.values()]); }
        break;
      }

      // An item that stopped to ASK was not tried and found wanting either, so getting its answer
      // gives it its attempts back. Otherwise the one attempt it had left is spent on the escalation
      // and the answer arrives for an item that is already out of tries.
      // Read fresh: applyAnswers runs before this pass's `plan` snapshot is taken, and it has just
      // mutated the file anyway.
      { const after = h.plan.read(); for (const i of applyAnswers(h)) refund(keyOf(after[i])); }
      let plan = h.plan.read();

      // ── progress ─────────────────────────────────────────────────────────────────────────────
      // A change in the PLAN, not a tick and not a reply. An agent can talk beautifully for an hour
      // without moving anything, and this is what notices.
      const digest = planDigest(plan);
      if (digest !== lastDigest) { lastDigest = digest; stallFor = 0; }
      else if (!inFlight.size) stallFor++;      // only idle ticks count; work in flight is not a stall
      if (stallFor >= opts.stallTicks) { stop = 'stalled'; break; }

      // ── readiness ────────────────────────────────────────────────────────────────────────────
      // OPEN and READY are different sets and conflating them is the single most dangerous thing in
      // this file. `open` is everything still to do; `ready` is the subset whose dependencies are
      // satisfied. Launch from `ready`. Decide completion from `open`. If completion were decided
      // from `ready`, a plan whose remaining todos are all waiting on a dependency that just landed
      // would report 'complete', close the mission and return ok:true with the work never started.
      const byId = new Map(plan.filter((p) => p.id).map((p) => [p.id, p]));
      const settled = (id) => { const d = byId.get(id); return !d || d.status === 'done'; };
      const deadDep = (p) => (p.needs || []).find((n) => { const d = byId.get(n); return d && (d.status === 'blocked' || d.status === 'failed'); });

      const open = plan.map((p, i) => ({ ...p, i })).filter((p) => p.status === 'todo');
      const ready = open.filter((p) => (p.needs || []).every(settled));
      const doing = plan.filter((p) => p.status === 'doing').length;
      const blocked = plan.map((p, i) => ({ ...p, i })).filter((p) => p.status === 'blocked');
      const done = plan.filter((p) => p.status === 'done').length;

      // A DEAD DEPENDENCY IS NOT A WAIT. An item whose need ended blocked or failed will never become
      // ready, so leaving it 'todo' would have it counted as open forever and the run would grind to
      // its stall wall. Name what it was waiting for — the alternative is an item that just stops
      // being mentioned. Independent branches are untouched.
      for (const p of open) {
        const dead = deadDep(p);
        if (!dead) continue;
        h.plan.mark(p.i, 'blocked', `dependency ${dead} did not complete`);
        emit('dep-dead', { item: p.i, id: p.id, needed: dead });
      }

      // ── the roster shape: all one role, or one of each. Nothing between. ─────────────────────
      //
      // The rule is forced rather than chosen. An item's role decides its tool grant, so the role is
      // intrinsic and only the SHAPE is up for decision. Under uniform(r), items of any other role are
      // unschedulable forever — the run would stop 'blocked' on work nobody is allowed to pick up.
      // Under ensemble, an unused slot simply idles, and an idle cloud slot costs nothing but elapsed
      // time, which in a DAG is dependency-bound anyway.
      //
      // So: one distinct role left to do → uniform. Otherwise → ensemble, at most one agent per role.
      // Re-read every pass but only ANNOUNCED when it changes, because a run that silently reshapes
      // its cast at hour two is unexplainable at hour four.
      const liveRoles = new Set(plan.filter((p) => p.status !== 'done')
        .map((p) => (ROLES.includes(p.role) ? p.role : roleOf(designation.classify(p.text)))));
      // An EMPTY set is not ensemble — it is a finished plan, and there is no roster left to shape.
      // Without this the last pass of every single-role run announced a switch to ensemble on its way
      // out the door, which is a transition that never happened.
      const nextMode = liveRoles.size === 0 ? mode : (liveRoles.size === 1 ? 'uniform' : 'ensemble');
      if (nextMode && nextMode !== mode) {
        const hist = {};
        for (const r2 of liveRoles) hist[r2] = plan.filter((p) => p.status !== 'done'
          && (ROLES.includes(p.role) ? p.role : roleOf(designation.classify(p.text))) === r2).length;
        emit('mode', { from: mode, to: nextMode, roles: [...liveRoles], histogram: hist });
        mode = nextMode;
      }

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
          h.unpark();      // the SAME attempt carrying on, not a new one — see mission.unpark()
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
      // The anchor plus whatever the siblings have learned. Read fresh each pass, so an agent
      // launched thirty seconds ago and one launched now do not see the same stale room.
      heldForRole = 0;
      let ctxBlock = h.anchor();
      // PRUNED TO THE AGENTS THAT ARE ACTUALLY HERE. `fleetStatusBlock({activeAgents})` has always had
      // that parameter for exactly this and no caller in the repo ever passed it — while nextName()
      // mints a fresh codename per item, so the roster grew one dead agent at a time. Measured at 120
      // items: 107 lines / ~3,000 tokens of agents that finished long ago, injected into every single
      // worker launch, against 7 lines / ~130 tokens once pruned.
      if (board) {
        try {
          // ALWAYS pass it, including empty. "Nobody else is working right now" is a true and useful
          // thing for a worker to be told; falling back to `null` on an empty roster would mean the
          // one moment the list is shortest is the moment it shows every agent that ever ran.
          const live = [...agents.values()].map((a) => a.name);
          const sib = board.fleetStatusBlock({ activeAgents: live });
          if (sib) ctxBlock += '\n\n' + sib;
        } catch {}
      }
      while (inFlight.size < width && ready.length) {
        // ONE PER ROLE in ensemble mode, and that single line is the whole invariant. A fixed slot
        // table would say the same thing with more bookkeeping; capping the in-flight count per role
        // gives "at most one of each of the five" at every instant while leaving the rolling
        // Promise.race refill exactly as it was — and reinstating a wave barrier to get a cohort would
        // undo a measured improvement (a layer with a 4-second lookup and a 90-second build holds the
        // fast result for 86 seconds).
        const idx = mode === 'ensemble'
          ? ready.findIndex((p) => (roleInFlight.get(ROLES.includes(p.role) ? p.role : roleOf(designation.classify(p.text))) || 0) === 0)
          : 0;
        if (idx < 0) { heldForRole = ready.length; break; }   // every ready item's role is already busy
        const next = ready.splice(idx, 1)[0];
        const key = keyOf(next);
        const tried = attempts.get(key) || 0;
        if (tried >= opts.maxItemAttempts) {
          h.plan.mark(next.i, 'blocked', `${tried} attempts, still not done — ${String(next.note || '').slice(0, 120)}`);
          emit('gave-up', { item: next.i, attempts: tried, text: next.text });
          continue;
        }
        attempts.set(key, tried + 1);
        const nrole = ROLES.includes(next.role) ? next.role : roleOf(designation.classify(next.text));
        roleInFlight.set(nrole, (roleInFlight.get(nrole) || 0) + 1);
        const p = workItem(h, next.i, next, ctxBlock, board).then((r) => ({ i: next.i, r })).catch((e) => ({ i: next.i, r: { status: 'failed', note: String((e && e.message) || e), spend: 0, extra: [] } }));
        inFlight.set(next.i, p);
      }

      // Nothing launched and nothing running, but work remains: every remaining item is waiting on a
      // dependency that is still in flight somewhere, or on an answer. Wait a tick and look again —
      // this is the normal state of a DAG mid-layer, not a stall.
      if (!inFlight.size) { await sleep(opts.tickDelayMs); continue; }

      // ── collect one ──────────────────────────────────────────────────────────────────────────
      const { i, r } = await Promise.race([...inFlight.values()]);
      inFlight.delete(i);
      if (r.role) roleInFlight.set(r.role, Math.max(0, (roleInFlight.get(r.role) || 1) - 1));

      if (r.refund) refund(keyOf(h.plan.read()[i]));
      recent.push(r.status === 'failed');
      if (recent.length > RECENT_MAX) recent.shift();
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
        spentUsd: +spent().toFixed(4), elapsedMs: elapsed(), inFlight: inFlight.size,
        // A half-empty room has two very different causes and the office should not have to guess.
        // `heldForRole` is work that is READY and waiting only because its role is already busy;
        // everything else idle is a role with genuinely nothing to do.
        mode, heldForRole, roles: Object.fromEntries([...roleInFlight].filter(([, n]) => n > 0)) });
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
      boardFile: board ? board.file : null,
      mode,
      cost: costpilot ? (() => { try { return costpilot.tick(true); } catch { return null; } })() : null,
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
      id: a.id, name: a.name, designation: a.designation, role: a.role, label: designation.get(a.designation).label,
      color: designation.get(a.designation).glow, state: a.state, task: a.task, step: a.step, since: a.since,
    }));
  }

  return { run, resume, loop, roster, applyAnswers, healDoing, opts, DEFAULTS };
}

module.exports = { createSupervisor, DEFAULTS, STOP_REASONS, planDigest };
