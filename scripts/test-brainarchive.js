#!/usr/bin/env node
'use strict';
// lib/brainarchive.js — pruned material is MOVED, not flagged and not deleted.
//
// Before this, "prune" meant two opposite things. In the graph it flipped a status and nothing ever
// left: 1,442 pruned nodes were still carrying 36 MB of vectors. In the semantic store it filtered
// records out and saved over the file, with no copy anywhere. One could not forget, the other could
// not remember. Siddhant chose: auto-archive, restorable for thirty days.
//   node scripts/test-brainarchive.js      (wired into npm run verify)
const fs = require('fs'), os = require('os'), path = require('path');
const A = require('../lib/brainarchive');
const { createBrain } = require('../lib/brain');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-archive-'));
const DAY = 86400000;
const vec = (seed, n = 1536) => Array.from({ length: n }, (_, i) => Math.sin(seed * 31 + i) * 0.05);
const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

// ── vectors survive the trip exactly ──────────────────────────────────────────────────────────────
{
  const v = vec(7);
  const back = A.decodeVec(A.encodeVec(v));
  ok(back.length === v.length, 'a vector round-trips at full length');
  ok(back.every((x, i) => Math.abs(x - v[i]) < 1e-7), 'and to float32 precision — which is all an embedding ever had');
  ok(A.encodeVec(v).length < JSON.stringify(v).length / 3, `base64 float32 is under a third of the decimal text (${A.encodeVec(v).length} vs ${JSON.stringify(v).length} chars)`);
  ok(A.encodeVec(null) === null && A.encodeVec([]) === null && A.decodeVec(null) === null, 'a missing vector stays missing rather than becoming an empty one');
}

// ── the graph: payload leaves, tombstone stays ────────────────────────────────────────────────────
{
  const dir = path.join(TMP, 'graph');
  const b = createBrain({ dir });
  const t0 = Date.parse('2026-11-12T12:00:00Z');
  for (let i = 0; i < 6; i++) b.upsertNode({ type: 'file', ref: `/repo/f${i}.js`, label: `f${i}.js`, text: 'x'.repeat(500), embedding: vec(i) }, t0);
  b.upsertNode({ type: 'memory', ref: 'm1', label: 'he prefers APA', text: 'citation style: APA', embedding: vec(99) }, t0);
  const ids = b.nodes({ type: 'file' }).map((n) => n.id);
  b.prune('node', ids[0]); b.prune('node', ids[1]); b.prune('node', ids[2]);
  // The vector sidecar only rewrites when a vector changed, so make the first save a real one.
  b.save();
  const before = size(b.vecFile);

  const r = A.compactGraph(b, { now: t0 });
  ok(r.archived === 3, `the three pruned nodes are archived (${r.archived})`);
  ok(r.file && fs.existsSync(path.join(dir, 'archive', r.file)), 'into a dated archive file on disk');
  ok(r.bytesFreed > 3 * 1536 * 10, `and it reports roughly what that frees (${Math.round(r.bytesFreed / 1024)}KB)`);

  const tomb = b.getNode(ids[0]);
  ok(tomb && tomb.status === 'pruned', 'the tombstone STAYS — the Gardener needs the id to exist so the Connector never re-proposes it');
  ok(!tomb.embedding && tomb.text === '', 'but it no longer carries the vector or the text');
  ok(tomb.label === 'f0.js' && tomb.meta.archived && tomb.meta.archived.file === r.file, 'it keeps its label and says where the rest went');
  ok(size(b.vecFile) < before * 0.75, `the vector file on disk actually shrank (${Math.round(before / 1024)}KB → ${Math.round(size(b.vecFile) / 1024)}KB)`);

  const live = b.getNode(ids[4]);
  ok(Array.isArray(live.embedding) && live.embedding.length === 1536 && live.text.length === 500, 'a live node is untouched');
  const mem = b.nodes({ type: 'memory' })[0];
  ok(mem.status !== 'pruned' && Array.isArray(mem.embedding), 'and a memory he gave it is untouched — this module prunes nothing, it only moves what was pruned');

  ok(A.compactGraph(b, { now: t0 }).archived === 0, 'a second pass finds nothing left to move — it is idempotent');

  // Survives a restart: the whole point of a file.
  const b2 = createBrain({ dir });
  ok(b2.getNode(ids[0]).status === 'pruned' && !b2.getNode(ids[0]).embedding, 'after a reload the tombstone is still slim');
  ok(Array.isArray(b2.getNode(ids[4]).embedding), 'and the live vectors still load');

  // ── restore ──
  const res = A.restoreGraph(b2, ids[0], { now: t0 + 5 * DAY });
  ok(res.ok && res.from === r.file, `a pruned node can be put back inside the window (from ${res.from})`);
  const back = b2.getNode(ids[0]);
  ok(back.status === 'confirmed' && back.text.length === 500 && back.embedding.length === 1536, 'with its text and its vector');
  ok(back.embedding.every((x, i) => Math.abs(x - vec(0)[i]) < 1e-7), 'and the vector is the SAME vector, not a re-embedding');
  ok(!back.meta.archived && back.meta.restoredAt, 'the tombstone marker is gone and the restore is recorded');
  ok(!A.restoreGraph(b2, 'file:nope', { now: t0 }).ok, 'restoring something that never existed fails cleanly');

  // ── the window closes ──
  ok(A.expire(dir, { now: t0 + 10 * DAY }).removed.length === 0, 'nothing expires inside thirty days');
  const stat = fs.statSync(path.join(dir, 'archive', r.file));
  const gone = A.expire(dir, { now: stat.mtimeMs + 31 * DAY });
  ok(gone.removed.length === 1 && gone.bytes > 0, `after thirty days the archive file is deleted (${gone.removed.length})`);
  const late = A.restoreGraph(b2, ids[1], { now: stat.mtimeMs + 31 * DAY });
  ok(!late.ok && /expired/.test(late.why), `and a restore then says the archive has expired rather than pretending (${late.why})`);
  ok(b2.getNode(ids[1]).status === 'pruned', 'while the tombstone remains, so it still cannot be re-proposed');
}

// ── a store that DELETES gets the same safety ─────────────────────────────────────────────────────
{
  const dir = path.join(TMP, 'sem');
  const t0 = Date.parse('2026-11-12T12:00:00Z');
  const dropped = [{ id: 'ep1', kind: 'episodic', text: 'asked about the weather', embedding: vec(1, 384), ts: t0 - 60 * DAY }, { id: 'ep2', kind: 'episodic', text: 'dup', embedding: vec(2, 384) }];
  const file = A.archiveRecords(dir, 'semantic', dropped, { now: t0 });
  ok(file && /^semantic-/.test(file), 'records about to be dropped are archived first');
  const back = A.restoreRecord(dir, 'semantic', 'ep1', { now: t0 + DAY });
  ok(back && back.text === 'asked about the weather' && back.embedding.length === 384 && back.kind === 'episodic', 'and one can be fetched back whole');
  ok(!('vec' in back) && !('archivedAt' in back), 'in its original shape, without the archive bookkeeping');
  ok(A.restoreRecord(dir, 'semantic', 'missing', { now: t0 }) === null, 'asking for one that was never archived returns nothing');
  ok(A.archiveRecords(dir, 'semantic', [], { now: t0 }) === null, 'archiving nothing writes no file');
}

// ── the weekly digest ─────────────────────────────────────────────────────────────────────────────
{
  const dir = path.join(TMP, 'digest');
  const t0 = Date.now();
  ok(/nothing archived/.test(A.digest(dir, { now: t0 }).line), 'with nothing archived the digest says so in one line');
  A.archiveRecords(dir, 'semantic', [{ id: 'a' }, { id: 'b' }, { id: 'c' }], { now: t0 });
  const d = A.digest(dir, { now: t0 + 1000 });
  ok(d.moved === 3 && d.restorable === 3, `it counts what left this week and what can still come back (${d.moved}/${d.restorable})`);
  ok(/archived 3 items this week/.test(d.line) && /30 days/.test(d.line), `in a sentence he can read: "${d.line}"`);
}

// ── the wiring ────────────────────────────────────────────────────────────────────────────────────
{
  const sem = fs.readFileSync(path.join(__dirname, '..', 'lib', 'semantic.js'), 'utf8');
  const i = sem.indexOf('function maintain(');
  const body = sem.slice(i, i + 2400);
  ok(/archiveRecords\(/.test(body), 'the semantic store archives what it drops');
  ok(body.indexOf('archiveRecords(') < body.indexOf('saveStore(store)'), 'and does so BEFORE saving the smaller store — write-ahead, so a crash duplicates rather than loses');
  const syn = fs.readFileSync(path.join(__dirname, '..', 'lib', 'synapse.js'), 'utf8');
  ok(/brainarchive\.compactGraph\(/.test(syn) && /brainarchive\.expire\(/.test(syn), 'the synapse cycle compacts the graph and closes expired archives');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✅' : '❌'} brainarchive: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
