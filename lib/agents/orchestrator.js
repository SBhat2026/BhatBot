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
async function run(goal, { wsDir, config = {}, adapters = {}, maxTasks = 30, checkpointEvery = 5, concurrency = 3, onStep, onTask, shouldStop, getGuidance } = {}) {
  const doc = loadTasks(wsDir);
  for (const t of await plan(goal, { wsDir, config, adapters })) {
    const nt = { id: 't_' + String(++doc.seq).padStart(4, '0'), agent: t.agent, goal: t.goal, expects: t.expects || 'answer', components: t.components || null, status: 'queued', parent: null };
    doc.tasks.push(nt);
    if (onTask) try { onTask(nt, 'queued'); } catch {}
  }
  saveTasks(wsDir, doc);

  let working = [];      // bounded RAM: recent result summary lines
  let done = 0;
  const guidance = [];   // accumulated user steering, applied to all future tasks
  let cancelled = false;
  while (done < maxTasks) {
    if (shouldStop && shouldStop()) { cancelled = true; break; }
    if (getGuidance) { try { const g = getGuidance(); if (g && g.length) guidance.push(...g); } catch {} }

    const batch = doc.tasks.filter((x) => x.status === 'queued').slice(0, Math.max(1, Math.min(concurrency, maxTasks - done)));
    if (!batch.length) break;
    for (const t of batch) { t.status = 'in_progress'; if (onTask) try { onTask(t, 'start'); } catch {} }
    saveTasks(wsDir, doc);

    const settled = await Promise.allSettled(batch.map((t) => {
      const task = protocol.buildTask({ id: t.id, agent: t.agent, goal: t.goal, expects: t.expects, context: { components: t.components, constraints: guidance.slice() } });
      // Per-task event tap so progress attributes to the right job card.
      const perTask = onTask
        ? { ...adapters, onEvent: (ev) => { try { adapters.onEvent && adapters.onEvent(ev); } catch {} try { onTask(t, 'event', ev); } catch {} } }
        : adapters;
      return runAgent(task, { wsDir, config, adapters: perTask });
    }));

    for (let i = 0; i < batch.length; i++) {
      const t = batch[i];
      const s = settled[i];
      const result = s.status === 'fulfilled' ? s.value
        : protocol.buildResult({ task_id: t.id, agent: t.agent, status: 'failed', summary: 'agent error: ' + String((s.reason && s.reason.message) || s.reason) });

      try { protocol.applyResult(wsDir, result); } catch (e) { /* never let a bad result kill the run */ }
      if (result.memory_writes && adapters.memWrite) { for (const w of result.memory_writes) { try { await adapters.memWrite(w); } catch {} } }

      t.status = result.status === 'ok' ? 'done' : (result.status === 'needs_input' ? 'blocked' : 'failed');
      t.summary = result.summary;
      // Enqueue agent-proposed follow-ups (orchestrator owns the decision to accept).
      for (const n of (result.next || [])) {
        if (n.agent && ROLES[n.agent]) {
          const nt = { id: 't_' + String(++doc.seq).padStart(4, '0'), agent: n.agent, goal: n.goal, expects: n.expects || 'answer', components: n.components || null, status: 'queued', parent: t.id };
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
    if (doc.tasks.some((x) => x.status === 'blocked')) break;   // needs user input
  }

  const open = doc.tasks.filter((x) => x.status === 'queued' || x.status === 'in_progress' || x.status === 'blocked');
  ctx.checkpoint(wsDir, open);
  return { completed: done, open: open.length, working, cancelled, blocked: doc.tasks.some((x) => x.status === 'blocked') };
}

module.exports = { run, plan, inferAgent };
