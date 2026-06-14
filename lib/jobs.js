'use strict';
// Job bus (Pass 37). Single in-RAM registry for background work: a delegated project is a
// `project` job, every orchestrator task under it is a `task` job. Everything that wants to
// observe progress (Activity panel cards via IPC, the spoken plain-English relay, the chat
// model's live BACKGROUND JOBS context block) subscribes here instead of poking the
// orchestrator. Also carries the control plane back the other way: cancel requests and
// plain-English steering notes that the orchestrator polls between batches.
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(30);
const jobs = new Map();      // id -> job (insertion order = creation order)
let seq = 0;

const ACTIVE = ['queued', 'running', 'blocked'];
const FINAL = ['done', 'failed', 'cancelled'];

function emit(event, j) {
  try { emitter.emit('job', { event, job: snapshot(j) }); } catch {}
}
// Public copies never expose the internal guidance queue.
function snapshot(j) { const { guidance, ...pub } = j; return { ...pub, pendingGuidance: guidance.length }; }

function create({ name, kind = 'task', agent = null, parent = null, workspace = null } = {}) {
  const id = 'job_' + String(++seq).padStart(3, '0');
  const j = {
    id, name: String(name || 'task').slice(0, 120), kind, agent, parent, workspace,
    status: 'queued', progress: 0, note: '', cancelRequested: false,
    createdAt: Date.now(), updatedAt: Date.now(), endedAt: null, guidance: [],
  };
  jobs.set(id, j);
  prune();
  emit('created', j);
  return snapshot(j);
}

function update(id, patch = {}) {
  const j = jobs.get(id);
  if (!j) return null;
  // A cancelled job is final — a late result from an in-flight agent must not resurrect it.
  if (j.status === 'cancelled' && patch.status && patch.status !== 'cancelled') return snapshot(j);
  Object.assign(j, patch, { updatedAt: Date.now() });
  if (patch.progress != null) j.progress = Math.max(0, Math.min(1, Number(patch.progress) || 0));
  if (FINAL.includes(j.status) && !j.endedAt) { j.endedAt = Date.now(); if (j.status === 'done') j.progress = 1; }
  emit('updated', j);
  return snapshot(j);
}

function get(id) { const j = jobs.get(id); return j ? snapshot(j) : null; }
function list() { return [...jobs.values()].map(snapshot); }
function active() { return [...jobs.values()].filter((j) => ACTIVE.includes(j.status)).map(snapshot); }
function children(id) { return [...jobs.values()].filter((j) => j.parent === id).map(snapshot); }

// Cancel a job and cascade to its children. Queued work dies immediately; running agents
// can't be killed mid-await, so they get cancelRequested and the orchestrator stops
// scheduling new batches (the final-status guard above swallows their late results).
function requestCancel(id) {
  const j = jobs.get(id);
  if (!j) return false;
  j.cancelRequested = true;
  if (j.status === 'queued') update(id, { status: 'cancelled', note: 'cancelled by user' });
  else if (!FINAL.includes(j.status)) { update(id, { status: 'cancelled', note: 'cancel requested' }); }
  for (const c of [...jobs.values()].filter((x) => x.parent === id)) requestCancel(c.id);
  return true;
}
function isCancelled(id) { const j = jobs.get(id); return !!(j && j.cancelRequested); }

// Steering notes ride on the PROJECT job; the orchestrator drains them between batches and
// injects them as constraints into every subsequent task.
function addGuidance(id, text) {
  const j = jobs.get(id);
  if (!j || !String(text || '').trim()) return false;
  j.guidance.push(String(text).trim().slice(0, 500));
  j.updatedAt = Date.now();
  emit('guided', j);
  return true;
}
function takeGuidance(id) { const j = jobs.get(id); return j ? j.guidance.splice(0) : []; }

function onUpdate(cb) { emitter.on('job', cb); return () => emitter.off('job', cb); }

// Keep the registry bounded: drop the oldest FINISHED jobs past 100 entries.
function prune(max = 100) {
  if (jobs.size <= max) return;
  for (const [id, j] of jobs) {
    if (jobs.size <= max) break;
    if (FINAL.includes(j.status)) jobs.delete(id);
  }
}

module.exports = { create, update, get, list, active, children, requestCancel, isCancelled, addGuidance, takeGuidance, onUpdate };
