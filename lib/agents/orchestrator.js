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
  try { raw = await router.run(choice, { messages, system: ROLES.orchestrator.system, task: planTask }, adapters); }
  catch { return [{ agent: inferAgent(goal), goal, expects: 'answer' }]; }
  const m = String(raw.text || '').match(/\{[\s\S]*\}/);
  if (m) { try { const p = JSON.parse(m[0]); if (Array.isArray(p.tasks) && p.tasks.length) return p.tasks; } catch {} }
  return [{ agent: inferAgent(goal), goal, expects: 'answer' }];
}

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
    const nt = { id: t._realId, agent: t.agent, goal: t.goal, expects: t.expects || 'answer', components: t.components || null, needs, status: 'queued', parent: null };
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
  while (done < maxTasks) {
    if (shouldStop && shouldStop()) { cancelled = true; break; }
    if (getGuidance) { try { const g = getGuidance(); if (g && g.length) guidance.push(...g); } catch {} }

    // A dead dependency (failed/blocked need) blocks its dependents with a reason — surfaced, never
    // silently dropped. This does NOT halt the whole run: independent branches keep going.
    for (const t of doc.tasks.filter((x) => x.status === 'queued')) {
      const dead = (t.needs || []).find(isDead);
      if (dead) { t.status = 'blocked'; t.blockedReason = `dependency ${dead} did not complete`; if (onTask) try { onTask(t, 'done', { status: 'blocked', summary: t.blockedReason }); } catch {} }
    }
    saveTasks(wsDir, doc);   // persist dead-dep blocks even if we break with nothing runnable this pass
    // Ready set = queued tasks whose every `needs` is done. Admission (main.js) still gates real width.
    const ready = doc.tasks.filter((x) => x.status === 'queued' && (x.needs || []).every(isDone));
    const batch = ready.slice(0, Math.max(1, Math.min(concurrency, maxTasks - done)));
    if (!batch.length) break;   // nothing runnable (done, or waiting on an unsatisfiable/cyclic dep)
    for (const t of batch) {
      t.status = 'in_progress';
      if (onTask) try { onTask(t, 'start'); } catch {}
      try { board.post({ agent: t.agent, taskId: t.id, kind: 'status', text: 'started: ' + String(t.goal || '').slice(0, 120) }); } catch {}
    }
    saveTasks(wsDir, doc);

    const genericPeers = working.slice(-6);   // recent sibling findings (cross-agent relay)
    const settled = await Promise.allSettled(batch.map((t) => {
      // Dependency results: inject THIS task's satisfied-needs summaries explicitly (bounded), so a
      // synthesis node actually sees what its upstream nodes produced.
      const depSummaries = (t.needs || []).map((id) => { const d = byId(id); return d && d.summary ? `${id} (${d.agent}): ${d.summary}` : null; }).filter(Boolean);
      const peers = [...depSummaries, ...genericPeers].slice(0, 8);
      const task = protocol.buildTask({ id: t.id, agent: t.agent, goal: t.goal, expects: t.expects, context: { components: t.components, constraints: guidance.slice(), peers } });
      // Per-task adapters: board handle for cross-agent relay + the event tap for job cards.
      const perTask = { ...adapters, board, onEvent: (ev) => { try { adapters.onEvent && adapters.onEvent(ev); } catch {} if (onTask) try { onTask(t, 'event', ev); } catch {} } };
      return _runAgent(task, { wsDir, config, adapters: perTask });
    }));

    for (let i = 0; i < batch.length; i++) {
      const t = batch[i];
      const s = settled[i];
      const result = s.status === 'fulfilled' ? s.value
        : protocol.buildResult({ task_id: t.id, agent: t.agent, status: 'failed', summary: 'agent error: ' + String((s.reason && s.reason.message) || s.reason) });

      try { protocol.applyResult(wsDir, result); } catch (e) { /* never let a bad result kill the run */ }
      if (result.memory_writes && adapters.memWrite) { for (const w of result.memory_writes) { try { await adapters.memWrite(w); } catch {} } }

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
    if (doc.tasks.some((x) => x.needsInput)) break;   // a task needs user input → pause the run
  }

  const open = doc.tasks.filter((x) => x.status === 'queued' || x.status === 'in_progress' || x.status === 'blocked');
  ctx.checkpoint(wsDir, open);
  return { completed: done, open: open.length, working, cancelled, blocked: doc.tasks.some((x) => x.needsInput) };
}

module.exports = { run, plan, inferAgent };
