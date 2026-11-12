'use strict';
// ── THE BRAIN'S ATTIC ────────────────────────────────────────────────────────────────────────────
//
// Siddhant chose: prune on its own, AUTO-ARCHIVE, restorable for thirty days.
//
// The deciding was already autonomous. Every synapse cycle the Gardener decays and prunes edges,
// merges duplicates, and drops file nodes whose file is gone. What was wrong was what "prune" meant.
// In the graph it flipped a status and nothing ever left: on 2026-11-12 the live store held 1,442
// pruned nodes still carrying their text and their 1536-float vectors — 36 MB of a 104 MB sidecar
// spent on things already judged unnecessary, re-read and re-parsed at every launch. In the semantic
// store it meant the opposite and was worse: records were filtered out and the file saved over, with
// no copy anywhere. One store could not forget and the other could not remember.
//
// This gives both the same meaning. Pruned material is MOVED: its payload (text + vector) goes into a
// dated, gzipped archive, and what stays behind is a small tombstone. The tombstone matters — the
// Gardener relies on a pruned id still existing so the Connector never re-proposes what was removed —
// so the id, type and label stay and only the weight leaves. Within the retention window anything can
// be put back exactly as it was. After it, the archive file is deleted and the tombstone remains.
//
// What is NEVER archived on its own initiative: nothing here decides to prune. It only moves what
// something else already pruned. Memories, projects and findings are pruned by him or by a duplicate
// merge that keeps the richer copy; this module does not widen that.
//
// Vectors are stored as base64 Float32 — a quarter of the size of the decimal text they arrive as,
// and exact to the precision the embedding model produced.
//
// Pure apart from the injected `fs`-shaped directory: decisions take `now` as an argument.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULTS = { retainDays: 30 };
const DAY = 86400000;

const encodeVec = (v) => (Array.isArray(v) && v.length ? Buffer.from(new Float32Array(v).buffer).toString('base64') : null);
const decodeVec = (b64) => {
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  // Copy out of the pooled Buffer: a Float32Array VIEW over it would be tied to the pool's lifetime
  // and alignment, and the callers expect a plain array they can hold.
  return Array.from(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
};

function archiveDir(base) { return path.join(base, 'archive'); }

/** Write one archive file. Atomic, so a crash leaves a complete file or none. → filename */
function writeArchive(base, kind, rows, now) {
  if (!rows.length) return null;
  const dir = archiveDir(base);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${kind}-${new Date(now).toISOString().replace(/[:.]/g, '-')}.jsonl.gz`;
  const body = zlib.gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'));
  const tmp = path.join(dir, name + '.tmp');
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, path.join(dir, name));
  return name;
}

function readArchive(base, name) {
  try {
    return zlib.gunzipSync(fs.readFileSync(path.join(archiveDir(base), name))).toString('utf8')
      .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Every archive file, newest first, with its age. */
function list(base, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(archiveDir(base)).filter((f) => f.endsWith('.jsonl.gz')); } catch { return []; }
  return names.map((name) => {
    let st = null; try { st = fs.statSync(path.join(archiveDir(base), name)); } catch {}
    return { name, kind: name.split('-')[0], bytes: st ? st.size : 0, at: st ? st.mtimeMs : 0, ageDays: st ? Math.floor((now - st.mtimeMs) / DAY) : null };
  }).sort((a, b) => b.at - a.at);
}

/**
 * compactGraph(brain, { now }) → { archived, bytesFreed, file }
 *
 * Moves the payload of every pruned node that still carries one. `brain` is a lib/brain.js store.
 * Order is write-ahead: the archive is on disk BEFORE anything is stripped from the live graph, so a
 * crash between the two leaves a duplicate (harmless) rather than a loss (unrecoverable).
 */
function compactGraph(brain, { now = Date.now() } = {}) {
  const heavy = brain.nodes({ status: 'pruned' }).filter((n) => (Array.isArray(n.embedding) && n.embedding.length) || (n.text && n.text.length));
  if (!heavy.length) return { archived: 0, bytesFreed: 0, file: null };
  let bytes = 0;
  const rows = heavy.map((n) => {
    // What it weighs in the live files today: ~17 characters per float as decimal text, plus the text.
    bytes += (Array.isArray(n.embedding) ? n.embedding.length * 17 : 0) + String(n.text || '').length;
    return { store: 'graph', id: n.id, type: n.type, ref: n.ref, label: n.label, text: n.text || '', vec: encodeVec(n.embedding),
      importance: n.importance, createdAt: n.createdAt, updatedAt: n.updatedAt, meta: n.meta || {}, archivedAt: now };
  });
  const file = writeArchive(brain.dir, 'graph', rows, now);
  for (const n of heavy) {
    brain.upsertNode({ id: n.id, type: n.type, ref: n.ref, label: n.label, text: '', embedding: null, status: 'pruned', _revive: true,
      meta: { ...(n.meta || {}), archived: { file, at: now } } }, now);
  }
  brain.save();
  return { archived: heavy.length, bytesFreed: bytes, file };
}

/**
 * restoreGraph(brain, id, { now }) → { ok, from } | { ok:false, why }
 * Puts a pruned node back exactly as it was. Looks in the archive its tombstone names first, then in
 * every archive newest-first, so a restore still works if the tombstone's pointer was lost.
 */
function restoreGraph(brain, id, { now = Date.now() } = {}) {
  const tomb = brain.getNode(id);
  const hinted = tomb && tomb.meta && tomb.meta.archived && tomb.meta.archived.file;
  const files = [hinted, ...list(brain.dir, now).filter((f) => f.kind === 'graph').map((f) => f.name)].filter(Boolean);
  for (const name of [...new Set(files)]) {
    const row = readArchive(brain.dir, name).find((r) => r.id === id);
    if (!row) continue;
    // `archived: null`, not a deleted key: upsertNode MERGES meta onto what is already there, so
    // leaving the key out would keep the tombstone's marker on a node that is alive again.
    brain.upsertNode({ id: row.id, type: row.type, ref: row.ref, label: row.label, text: row.text, embedding: decodeVec(row.vec),
      importance: row.importance, status: 'confirmed', _revive: true, meta: { ...(row.meta || {}), archived: null, restoredAt: now } }, now);
    brain.save();
    return { ok: true, from: name };
  }
  return { ok: false, why: tomb ? 'its archive has expired or is missing — the tombstone is all that is left' : 'no such node' };
}

/**
 * archiveRecords(base, kind, records, { now }) → filename
 * For stores that DELETE (the semantic store's maintain()). Call it with what is about to be dropped,
 * BEFORE dropping it.
 */
function archiveRecords(base, kind, records, { now = Date.now() } = {}) {
  const rows = (records || []).map((r) => {
    const { embedding, vector, ...rest } = r || {};
    return { store: kind, ...rest, vec: encodeVec(embedding || vector), archivedAt: now };
  });
  return writeArchive(base, kind, rows, now);
}

/** restoreRecord(base, kind, id) → the record as it was (with `embedding` restored), or null. */
function restoreRecord(base, kind, id, { now = Date.now() } = {}) {
  for (const f of list(base, now).filter((x) => x.kind === kind)) {
    const row = readArchive(base, f.name).find((r) => r.id === id);
    if (!row) continue;
    const { vec, store, archivedAt, ...rest } = row;
    return { ...rest, embedding: decodeVec(vec) };
  }
  return null;
}

/** expire(base, { now, retainDays }) → { removed:[names], bytes } — the end of the restore window. */
function expire(base, { now = Date.now(), retainDays = DEFAULTS.retainDays } = {}) {
  const removed = []; let bytes = 0;
  for (const f of list(base, now)) {
    if (f.ageDays === null || f.ageDays < retainDays) continue;
    try { fs.rmSync(path.join(archiveDir(base), f.name), { force: true }); removed.push(f.name); bytes += f.bytes; } catch {}
  }
  return { removed, bytes };
}

/** One line for the weekly digest: what left, what can still come back, what is gone for good. */
function digest(base, { now = Date.now(), retainDays = DEFAULTS.retainDays, sinceDays = 7 } = {}) {
  const files = list(base, now);
  const recent = files.filter((f) => f.ageDays !== null && f.ageDays < sinceDays);
  const count = (fs_) => fs_.reduce((n, f) => n + readArchive(base, f.name).length, 0);
  const moved = count(recent);
  const restorable = count(files);
  const soon = files.filter((f) => f.ageDays !== null && retainDays - f.ageDays <= 7);
  return {
    moved, restorable, expiringSoon: count(soon), files: files.length,
    line: moved || restorable
      ? `Brain upkeep: archived ${moved} item${moved === 1 ? '' : 's'} this week · ${restorable} restorable for up to ${retainDays} days${soon.length ? ` · ${count(soon)} expire within a week` : ''}.`
      : 'Brain upkeep: nothing archived.',
  };
}

module.exports = { compactGraph, restoreGraph, archiveRecords, restoreRecord, expire, list, digest, encodeVec, decodeVec, DEFAULTS };
