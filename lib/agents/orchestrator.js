'use strict';
// Orchestrator (Phase 3). Plan a goal into tasks, dispatch each to a stateless agent,
// integrate ONLY the structured result (summary line + state_updates), persist, and keep a
// bounded working set. Context stays flat regardless of project size. See ARCHITECTURE.md §3/§4.
const fs = require('fs');
const path = require('path');
const ctx = require('../context');
const router = require('../router');
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
  if (/\b(research|find|look up|docs|compare)\b/.test(g)) return 'research';
  if (/\b(open|click|browser|website|render|screenshot|visual)\b/.test(g)) return 'browser';
  if (/\b(mesh|3d|image|render model|texture)\b/.test(g)) return 'creative';
  if (/\b(remember|recall|memory|summari[sz]e)\b/.test(g)) return 'memory';
  return 'research';
}

// Main loop. Each iteration: pop a queued task → run agent → integrate → maybe enqueue
// agent-proposed next tasks. Working set bounded; checkpoint every N integrations.
async function run(goal, { wsDir, config = {}, adapters = {}, maxTasks = 30, checkpointEvery = 5, onStep } = {}) {
  const doc = loadTasks(wsDir);
  for (const t of await plan(goal, { wsDir, config, adapters })) {
    doc.tasks.push({ id: 't_' + String(++doc.seq).padStart(4, '0'), agent: t.agent, goal: t.goal, expects: t.expects || 'answer', components: t.components || null, status: 'queued', parent: null });
  }
  saveTasks(wsDir, doc);

  let working = [];      // bounded RAM: recent result summary lines
  let done = 0;
  while (done < maxTasks) {
    const t = doc.tasks.find((x) => x.status === 'queued');
    if (!t) break;
    t.status = 'in_progress'; saveTasks(wsDir, doc);

    const task = protocol.buildTask({ id: t.id, agent: t.agent, goal: t.goal, expects: t.expects, context: { components: t.components } });
    let result;
    try { result = await runAgent(task, { wsDir, config, adapters }); }
    catch (e) { result = protocol.buildResult({ task_id: t.id, agent: t.agent, status: 'failed', summary: 'agent error: ' + e.message }); }

    try { protocol.applyResult(wsDir, result); } catch (e) { /* never let a bad result kill the run */ }
    if (result.memory_writes && adapters.memWrite) { for (const w of result.memory_writes) { try { await adapters.memWrite(w); } catch {} } }

    t.status = result.status === 'ok' ? 'done' : (result.status === 'needs_input' ? 'blocked' : 'failed');
    t.summary = result.summary;
    // Enqueue agent-proposed follow-ups (orchestrator owns the decision to accept).
    for (const n of (result.next || [])) {
      if (n.agent && ROLES[n.agent]) doc.tasks.push({ id: 't_' + String(++doc.seq).padStart(4, '0'), agent: n.agent, goal: n.goal, expects: n.expects || 'answer', components: n.components || null, status: 'queued', parent: t.id });
    }
    saveTasks(wsDir, doc);

    working = ctx.prune([...working, `${t.id} ${t.agent}: ${result.summary}`]);
    done++;
    if (onStep) onStep({ task: t, result, working });
    if (done % checkpointEvery === 0) ctx.checkpoint(wsDir, doc.tasks.filter((x) => x.status !== 'done'));
    if (t.status === 'blocked') break;   // needs user input
  }

  const open = doc.tasks.filter((x) => x.status === 'queued' || x.status === 'in_progress' || x.status === 'blocked');
  ctx.checkpoint(wsDir, open);
  return { completed: done, open: open.length, working, blocked: doc.tasks.some((x) => x.status === 'blocked') };
}

module.exports = { run, plan, inferAgent };
