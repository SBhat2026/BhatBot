'use strict';
// Orchestrator (Phase 3). Plan a goal into tasks, dispatch each to a stateless agent,
// integrate ONLY the structured result (summary line + state_updates), persist, and keep a
// bounded working set. Context stays flat regardless of project size. See ARCHITECTURE.md §3/§4.
const fs = require('fs');
const path = require('path');
const ctx = require('../context');
const router = require('./select');
const protocol = require('./protocol');
const { runAgent } = require('./base');
const { ROLES } = require('./roles');
const blackboard = require('../blackboard');

function loadTasks(wsDir) { try { return JSON.parse(fs.readFileSync(path.join(wsDir, 'tasks.json'), 'utf8')); } catch { return { seq: 0, tasks: [] }; } }
function saveTasks(wsDir, doc) { fs.writeFileSync(path.join(wsDir, 'tasks.json'), JSON.stringify(doc, null, 2)); }

async function plan(goal, { wsDir, config, adapters }) {
  const planTask = protocol.buildTask({ id: 'plan', agent: 'orchestrator', goal, expects: 'report' });
  const choice = await router.pick({ ...planTask, class: 'planning' }, { config, adapters });
  const messages = [{ role: 'user', content: JSON.stringify({ goal }) }];
  let raw;
  try { raw = await router.run(choice, { messages, system: ROLES.orchestrator.system, task: planTask, schema: PLAN_SCHEMA, schemaName: 'plan' }, adapters); }
  catch { return [{ agent: inferAgent(goal), goal, expects: 'answer' }]; }
  // A schema-constrained reply parses directly; the regex stays as the fallback for backends with
  // no structured-output surface (this planner can run on local Ollama models via router.pick).
  //
  // The fallback matters more here than anywhere else in the codebase: when this parse fails, the
  // whole plan collapses to a SINGLE inferred task, so a wide parallel fan-out silently becomes one
  // agent doing everything — the fan-out looks like it ran, and nothing reports that it didn't.
  const text = String(raw.text || '');
  const tasksOf = (p) => (p && Array.isArray(p.tasks) && p.tasks.length ? p.tasks : null);
  try { const t = tasksOf(JSON.parse(text)); if (t) return t; } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { const t = tasksOf(JSON.parse(m[0])); if (t) return t; } catch {} }
  return [{ agent: inferAgent(goal), goal, expects: 'answer' }];
}

// What the planner must return. Enforced via output_config.format where the backend supports it,
// so a chatty preamble or a ```json fence can no longer collapse the plan.
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          agent: { type: 'string', enum: ['coding', 'research', 'browser', 'memory', 'creative'] },
          goal: { type: 'string' },
          expects: { type: 'string', enum: ['patch', 'facts', 'report', 'artifact', 'answer'] },
          components: { type: 'array', items: { type: 'string' } },
          needs: { type: 'array', items: { type: 'string' } },
          overlaps: { type: 'array', items: { type: 'string' } },
          why: { type: 'string' },
        },
        required: ['id', 'agent', 'goal', 'expects'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

function inferAgent(goal) {
  const g = goal.toLowerCase();
  if (/\b(code|fix|implement|refactor|test|bug|function)\b/.test(g)) return 'coding';
  // 3D / model artifacts are checked BEFORE browser so "render a model" / "STL" don't get
  // swallowed by the browser rule's bare "render" (a routing gap the perf eval surfaced).
  if (/\b(mesh|3d|stl|obj|glb|gltf|cad|voxel|3d ?print|printable)\b/.test(g) || /\brender\b.*\b(model|mesh|gear|part|object|scene|stl)\b/.test(g)) return 'creative';
  if (/\b(research|find|look up|docs|compare)\b/.test(g)) return 'research';
  if (/\b(open|click|browser|website|render|screenshot|visual)\b/.test(g)) return 'browser';
  if (/\b(image|picture|logo|texture|illustration)\b/.test(g)) return 'creative';
  if (/\b(remember|recall|memory|summari[sz]e)\b/.test(g)) return 'memory';
  return 'research';
}

// Main loop. Each iteration: take up to `concurrency` queued tasks → run their agents in
// PARALLEL (Promise.allSettled — one failure never sinks the batch) → integrate results
// sequentially (state/tasks.json writes are not concurrent-safe) → maybe enqueue
// agent-proposed next tasks. Working set bounded; checkpoint every N integrations.
// Pass 37 hooks: onTask(t, phase, extra) mirrors task lifecycle to the job bus
// (phase ∈ queued|start|event|done), shouldStop() polls for a user cancel between batches,
// getGuidance() drains plain-English steering notes that become constraints on every
// subsequent task.
async function run(goal, { wsDir, config = {}, adapters = {}, maxTasks = 30, checkpointEvery = 5, concurrency = 3, onStep, onTask, shouldStop, getGuidance, planFn, runAgentFn } = {}) {
  const doc = loadTasks(wsDir);
  const _plan = planFn || plan;          // DI seams (headless tests inject deterministic plan/agent)
  const _runAgent = runAgentFn || runAgent;
  // T6 DAG enqueue: the planner emits its OWN local ids (t1,t2…) + `needs` edges referencing them.
  // Two passes — assign real ids first, then remap each task's needs to real ids. Backward compatible:
  // a task with no `needs` is ready immediately (the old flat-list behavior).
  const planned = await _plan(goal, { wsDir, config, adapters });
  const idMap = {};
  for (const t of planned) { const real = 't_' + String(++doc.seq).padStart(4, '0'); t._realId = real; if (t.id != null) idMap[String(t.id)] = real; }
  for (const t of planned) {
    const needs = (Array.isArray(t.needs) ? t.needs : []).map((n) => idMap[String(n)]).filter(Boolean);
    // `overlaps` marks duplication the planner chose ON PURPOSE — a second agent on the same goal to
    // verify a high-stakes answer, to attack it from a different angle, or to race a route that may
    // stall. Carried through so downstream can tell an intentional second opinion from an accidental
    // repeat: without it, two agreeing agents look like wasted spend rather than corroboration, and
    // the natural "fix" is to dedupe away exactly the redundancy that was the point.
    const overlaps = (Array.isArray(t.overlaps) ? t.overlaps : []).map((n) => idMap[String(n)]).filter(Boolean);
    const nt = {
      id: t._realId, agent: t.agent, goal: t.goal, expects: t.expects || 'answer',
      components: t.components || null, needs, status: 'queued', parent: null,
      ...(overlaps.length ? { overlaps, why: String(t.why || '').slice(0, 200) } : {}),
    };
    doc.tasks.push(nt);
    if (onTask) try { onTask(nt, 'queued'); } catch {}
  }
  saveTasks(wsDir, doc);

  // T5 blackboard: shared live state for this run. Use the one main.js injected, else make one per wsDir.
  const board = adapters.board || blackboard.createBlackboard({ dir: wsDir });
  const byId = (id) => doc.tasks.find((z) => z.id === id);
  const isDone = (id) => { const x = byId(id); return !!(x && x.status === 'done'); };
  const isDead = (id) => { const x = byId(id); return !!(x && (x.status === 'failed' || x.status === 'blocked')); };

  let working = [];      // bounded RAM: recent result summary lines
  let done = 0;
  const guidance = [];   // accumulated user steering, applied to all future tasks
  let cancelled = false;
  let stopLaunching = false;   // cancelled, or a task is waiting on the user — drain, don't abandon

  // ── ROLLING, NOT WAVE-BY-WAVE ───────────────────────────────────────────────────────────────────
  // This used to collect a batch of ready tasks, `await Promise.allSettled` on all of them, and only
  // then recompute what had become ready. That is a barrier, and it costs exactly what a barrier
  // always costs: a wave containing a 4-second lookup and a 90-second build holds the 4-second
  // result hostage for 86 seconds, so a task depending only on the fast one starts a minute and a
  // half late for no reason. With a fan-out of three, most of the fleet is idle most of the time —
  // which is also why the office looked empty even while work was genuinely in flight.
  //
  // Now: launch whatever is ready up to `concurrency`, wait for the FIRST one to land, process it,
  // and immediately refill the slot. Same width, same accounting, no idle waiting. A dependent task
  // starts the moment its own dependencies are satisfied rather than when its slowest cousin is.
  const inflight = new Map();   // taskId → Promise<{ t, status, value|reason }>
  const launch = (t) => {
    t.status = 'in_progress';
    if (onTask) try { onTask(t, 'start'); } catch {}
    try { board.post({ agent: t.agent, taskId: t.id, kind: 'status', text: 'started: ' + String(t.goal || '').slice(0, 120) }); } catch {}
    // Dependency results: inject THIS task's satisfied-needs summaries explicitly (bounded), so a
    // synthesis node actually sees what its upstream nodes produced. Peers are read at LAUNCH time,
    // so a task starting now sees findings that landed since the previous task started — with the
    // barrier gone, that is strictly fresher than the per-wave snapshot it replaces.
    const depSummaries = (t.needs || []).map((id) => { const d = byId(id); return d && d.summary ? `${id} (${d.agent}): ${d.summary}` : null; }).filter(Boolean);
    const peers = [...depSummaries, ...working.slice(-6)].slice(0, 8);
    const task = protocol.buildTask({ id: t.id, agent: t.agent, goal: t.goal, expects: t.expects, context: { components: t.components, constraints: guidance.slice(), peers } });
    // Per-task adapters: board handle for cross-agent relay + the event tap for job cards.
    const perTask = { ...adapters, board, onEvent: (ev) => { try { adapters.onEvent && adapters.onEvent(ev); } catch {} if (onTask) try { onTask(t, 'event', ev); } catch {} } };
    // Settle-shaped and self-identifying: Promise.race needs to know WHICH task landed, and must
    // never reject, or one agent error would abandon every sibling still in flight.
    inflight.set(t.id, Promise.resolve()
      .then(() => _runAgent(task, { wsDir, config, adapters: perTask }))
      .then((value) => ({ t, status: 'fulfilled', value }), (reason) => ({ t, status: 'rejected', reason })));
  };

  while (done < maxTasks) {
    if (shouldStop && shouldStop()) { cancelled = true; stopLaunching = true; }
    if (getGuidance) { try { const g = getGuidance(); if (g && g.length) guidance.push(...g); } catch {} }

    // A dead dependency (failed/blocked need) blocks its dependents with a reason — surfaced, never
    // silently dropped. This does NOT halt the whole run: independent branches keep going.
    for (const t of doc.tasks.filter((x) => x.status === 'queued')) {
      const dead = (t.needs || []).find(isDead);
      if (dead) { t.status = 'blocked'; t.blockedReason = `dependency ${dead} did not complete`; if (onTask) try { onTask(t, 'done', { status: 'blocked', summary: t.blockedReason }); } catch {} }
    }

    // Ready set = queued tasks whose every `needs` is done. Admission (main.js) still gates real width.
    if (!stopLaunching) {
      for (const t of doc.tasks.filter((x) => x.status === 'queued' && (x.needs || []).every(isDone))) {
        if (inflight.size >= Math.max(1, concurrency)) break;
        if (done + inflight.size >= maxTasks) break;
        launch(t);
      }
    }
    saveTasks(wsDir, doc);   // persist starts + dead-dep blocks even if we break with nothing runnable

    // Nothing running and nothing launchable → done, or waiting on an unsatisfiable/cyclic dep.
    if (!inflight.size) break;

    const s = await Promise.race([...inflight.values()]);
    inflight.delete(s.t.id);

    {
      const t = s.t;
      const result = s.status === 'fulfilled' ? s.value
        : protocol.buildResult({ task_id: t.id, agent: t.agent, status: 'failed', summary: 'agent error: ' + String((s.reason && s.reason.message) || s.reason) });

      try { protocol.applyResult(wsDir, result); }
      catch (e) { try { console.warn(`[orchestrator] ${t.id}: applyResult failed — state_updates were NOT written: ${e.message}`); } catch {} }
      // A swallowed memory write is worse than a loud one: the agent reported the fact as saved, the
      // summary says it saved it, and nothing did. Count the failures and say so once per task
      // rather than per write, so a broken memory backend is visible without flooding the log.
      if (result.memory_writes && adapters.memWrite) {
        let failed = 0, lastErr = '';
        for (const w of result.memory_writes) {
          try { await adapters.memWrite(w); }
          catch (e) { failed++; lastErr = (e && e.message) || String(e); }
        }
        if (failed) {
          try { console.warn(`[orchestrator] ${t.id}: ${failed}/${result.memory_writes.length} memory write(s) FAILED (${lastErr}) — the agent reported these as saved`); } catch {}
          result.memoryWriteFailures = failed;
        }
      }

      t.status = result.status === 'ok' ? 'done' : (result.status === 'needs_input' ? 'blocked' : 'failed');
      if (result.status === 'needs_input') t.needsInput = true;   // only THIS kind of block halts the run
      t.summary = result.summary;
      // Enqueue agent-proposed follow-ups (orchestrator owns the decision to accept).
      for (const n of (result.next || [])) {
        if (n.agent && ROLES[n.agent]) {
          const nt = { id: 't_' + String(++doc.seq).padStart(4, '0'), agent: n.agent, goal: n.goal, expects: n.expects || 'answer', components: n.components || null, needs: [], status: 'queued', parent: t.id };
          doc.tasks.push(nt);
          if (onTask) try { onTask(nt, 'queued'); } catch {}
        }
      }

      working = ctx.prune([...working, `${t.id} ${t.agent}: ${result.summary}`]);
      done++;
      if (onStep) onStep({ task: t, result, working });
      if (onTask) try { onTask(t, 'done', { status: result.status, summary: result.summary }); } catch {}
      if (done % checkpointEvery === 0) ctx.checkpoint(wsDir, doc.tasks.filter((x) => x.status !== 'done'));
    }
    saveTasks(wsDir, doc);
    // A task needs user input → stop LAUNCHING, but keep draining what is already running. Abandoning
    // in-flight agents would throw away work that is seconds from landing, and their results would
    // never be applied — the run would report fewer completions than actually happened.
    if (doc.tasks.some((x) => x.needsInput)) stopLaunching = true;
  }

  const open = doc.tasks.filter((x) => x.status === 'queued' || x.status === 'in_progress' || x.status === 'blocked');
  ctx.checkpoint(wsDir, open);
  return { completed: done, open: open.length, working, cancelled, blocked: doc.tasks.some((x) => x.needsInput) };
}

module.exports = { run, plan, inferAgent };
