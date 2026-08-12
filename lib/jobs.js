'use strict';
// Job bus (Pass 37). Single registry for background work: a delegated project is a `project` job,
// every orchestrator task under it is a `task` job. Everything that wants to observe progress
// (Activity panel cards via IPC, the spoken plain-English relay, the chat model's live BACKGROUND
// JOBS context block) subscribes here instead of poking the orchestrator. Also carries the control
// plane back the other way: cancel requests and plain-English steering notes that the orchestrator
// polls between batches.
//
// ── DURABILITY (Pass B1) ─────────────────────────────────────────────────────────────────────────
// This registry was a bare `Map` with zero writes: any crash, quit, or auto-update during an
// hours-long run silently dropped every in-flight job — no record, no resume, no way to even tell
// the user what was lost. `lib/mission.js` made *turns* durable; jobs were the remaining hole.
//
// Storage mirrors lib/blackboard.js exactly (append-only JSONL + in-memory authority), because that
// pattern is already the house convention here — crash-safe, human-inspectable, zero schema, zero
// daemon. Specifics:
//   • EVENT LOG, NOT STATE DUMP. Each create/update appends one line. Replaying the file in order
//     reconstructs state, so a torn final write costs one update, never the whole registry.
//   • THROTTLED PROGRESS. `update()` fires constantly with fractional progress. Persisting each one
//     would put a synchronous write on a hot path. Status/note/terminal changes always persist;
//     progress-only churn coalesces to one write per PROGRESS_MS per job.
//   • INTERRUPTED ON BOOT. Any job still in an ACTIVE status when the log ends did not finish — the
//     process died under it. It reloads as `interrupted` (a distinct status, not `failed`) so it can
//     be reported or resumed rather than vanishing or lying about having failed.
//   • SEQUENCE CONTINUATION. `seq` restarts at 0 each boot. Reloading jobs without advancing it past
//     the highest known id would mint `job_001` on top of a reloaded `job_001` and corrupt the
//     registry. hydrate() advances `seq` to max(seen).
//   • BOUNDED FILE. prune() keeps the in-RAM view at 100; the log compacts past COMPACT_BYTES by
//     rewriting only live + recent-final jobs, via an atomic rename.
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const emitter = new EventEmitter();
emitter.setMaxListeners(30);
const jobs = new Map();      // id -> job (insertion order = creation order)
let seq = 0;

const ACTIVE = ['queued', 'running', 'blocked'];
const FINAL = ['done', 'failed', 'cancelled', 'interrupted'];

const PROGRESS_MS = 2000;               // coalesce progress-only writes to 1 per job per 2s
const COMPACT_BYTES = 4 * 1024 * 1024;  // compact the log past 4MB
const KEEP_FINAL = 200;                 // finished jobs retained through a compaction

let FILE = path.join(os.homedir(), '.bhatbot', 'jobs.jsonl');
let persistOn = true;
let hydrated = false;
const lastWrite = new Map();            // id -> ts of last persisted progress-only update

// ── persistence ──────────────────────────────────────────────────────────────────────────────────
function append(op, j) {
  if (!persistOn) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const { guidance, ...rest } = j;
    fs.appendFileSync(FILE, JSON.stringify({ op, ts: Date.now(), job: rest }) + '\n');
  } catch {}
}

// Persist unless this is pure progress churn we've already written recently.
function persist(op, j, patch) {
  if (!persistOn) return;
  const keys = patch ? Object.keys(patch) : [];
  const onlyProgress = keys.length > 0 && keys.every((k) => k === 'progress');
  if (onlyProgress) {
    const last = lastWrite.get(j.id) || 0;
    if (Date.now() - last < PROGRESS_MS) return;
  }
  lastWrite.set(j.id, Date.now());
  append(op, j);
  maybeCompact();
}

function maybeCompact() {
  try {
    if (!persistOn) return;
    if (fs.statSync(FILE).size < COMPACT_BYTES) return;
    const live = [...jobs.values()].filter((j) => ACTIVE.includes(j.status));
    const recent = [...jobs.values()].filter((j) => FINAL.includes(j.status)).slice(-KEEP_FINAL);
    const lines = [...recent, ...live]
      .map((j) => { const { guidance, ...rest } = j; return JSON.stringify({ op: 'compact', ts: Date.now(), job: rest }) + '\n'; });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, lines.join(''));
    fs.renameSync(tmp, FILE);                 // atomic swap — a crash mid-compact leaves the old log
  } catch {}
}

// hydrate — replay the log, then mark anything still ACTIVE as `interrupted`. Idempotent; call once
// at boot BEFORE anything creates a job. Returns the interrupted jobs, for reporting/resume.
function hydrate({ file, enabled } = {}) {
  if (file) FILE = file;
  if (enabled === false) persistOn = false;
  if (hydrated) return interrupted();
  hydrated = true;
  let raw = '';
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  let maxSeq = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const j = rec && rec.job;
    if (!j || !j.id) continue;
    const m = /^job_(\d+)$/.exec(j.id);
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]) || 0);
    const prev = jobs.get(j.id);
    jobs.set(j.id, { ...(prev || {}), ...j, guidance: [] });   // guidance is an in-RAM control plane
  }
  seq = Math.max(seq, maxSeq);
  const orphans = [];
  for (const j of jobs.values()) {
    if (!ACTIVE.includes(j.status)) continue;
    j.status = 'interrupted';
    j.note = (j.note ? j.note + ' · ' : '') + 'interrupted by restart';
    j.endedAt = j.endedAt || Date.now();
    j.interruptedAt = Date.now();
    orphans.push(snapshot(j));
    append('interrupted', j);
  }
  prune();
  return orphans;
}

function interrupted() { return [...jobs.values()].filter((j) => j.status === 'interrupted').map(snapshot); }

function emit(event, j) {
  try { emitter.emit('job', { event, job: snapshot(j) }); } catch {}
}
// Public copies never expose the internal guidance queue.
function snapshot(j) { const { guidance, ...pub } = j; return { ...pub, pendingGuidance: (guidance || []).length }; }

function create({ name, kind = 'task', agent = null, parent = null, workspace = null } = {}) {
  const id = 'job_' + String(++seq).padStart(3, '0');
  const j = {
    id, name: String(name || 'task').slice(0, 120), kind, agent, parent, workspace,
    status: 'queued', progress: 0, note: '', cancelRequested: false,
    createdAt: Date.now(), updatedAt: Date.now(), endedAt: null, guidance: [],
  };
  jobs.set(id, j);
  prune();
  persist('created', j);
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
  persist('updated', j, patch);
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
    if (FINAL.includes(j.status)) { jobs.delete(id); lastWrite.delete(id); }
  }
}

// Test seam: point at a scratch file and wipe RAM state.
function _reset({ file, enabled = true } = {}) {
  jobs.clear(); lastWrite.clear(); seq = 0; hydrated = false; persistOn = enabled;
  if (file) FILE = file;
}

module.exports = {
  create, update, get, list, active, children, requestCancel, isCancelled,
  addGuidance, takeGuidance, onUpdate,
  hydrate, interrupted, _reset,
  get file() { return FILE; },
  ACTIVE, FINAL,
};
