'use strict';
// Context manager (Phase 4). Guarantees flat, bounded context regardless of project age.
// Core idea: agents get freshly-ASSEMBLED context (state subset + top-k memory + task),
// never accumulated transcript. Plus checkpoints (resume tokens), working-set pruning,
// and subtree summarization. See ARCHITECTURE.md §4.
const fs = require('fs');
const path = require('path');
const State = require('./state');

const MAX_WORKING = 20; // hard cap on in-RAM result summaries the orchestrator keeps

function decisions(wsDir) { try { return JSON.parse(fs.readFileSync(path.join(wsDir, 'decisions.json'), 'utf8')).decisions || []; } catch { return []; } }

// Write a resume token: enough to restart a session cold with zero transcript.
function checkpoint(wsDir, openTasks = []) {
  const s = State.open(wsDir);
  const recent = decisions(wsDir).slice(-5).map((d) => d.id || d.what);
  const cp = {
    ts: new Date().toISOString(),
    version: s.version(),
    state_digest: s.digest(),
    open_tasks: openTasks.map((t) => ({ id: t.id, agent: t.agent, goal: t.goal, status: t.status })),
    recent_decisions: recent,
    next_actions: openTasks.filter((t) => t.status === 'queued' || t.status === 'in_progress').slice(0, 5).map((t) => t.goal),
  };
  const dir = path.join(wsDir, 'checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, cp.ts.replace(/[:.]/g, '-') + '.json'), JSON.stringify(cp, null, 2));
  return cp;
}

function resume(wsDir) {
  const dir = path.join(wsDir, 'checkpoints');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch {}
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
}

// Build the MINIMAL context for a single agent task. memFn(query,k) is supplied by
// lib/memory.js (vector retrieval); omitted → no memory section. Output stays ~O(task).
async function assemble({ wsDir, task, k = 4, memFn }) {
  const s = State.open(wsDir);
  const comps = (task.context && task.context.components) || null; // restrict to relevant components if known
  const snapshot = s.snapshot(comps);
  let memory = [];
  if (memFn) { try { memory = await memFn(task.goal, k); } catch { memory = []; } }
  return {
    state: snapshot,
    memory,
    files: (task.context && task.context.files) || [],
    constraints: (task.context && task.context.constraints) || [],
    peers: (task.context && task.context.peers) || [],   // recent sibling-agent findings, for cross-agent relay
    goal: task.goal,
  };
}

// Keep only the last MAX_WORKING result summaries in RAM; older truth is already on disk.
function prune(workingSet, max = MAX_WORKING) {
  if (workingSet.length <= max) return workingSet;
  return workingSet.slice(workingSet.length - max);
}

// Replace N child result lines with one rollup line when a subtree completes.
function summarizeSubtree(children) {
  const ok = children.filter((c) => c.status === 'ok').length;
  return `${ok}/${children.length} subtasks done: ${children.map((c) => c.summary).filter(Boolean).slice(0, 3).join(' | ')}`;
}

module.exports = { checkpoint, resume, assemble, prune, summarizeSubtree, MAX_WORKING };
