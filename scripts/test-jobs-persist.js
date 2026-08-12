'use strict';
// Pass B1 — durable job bus. The claim under test: work in flight when the process dies comes back
// as `interrupted` rather than vanishing, and reloading cannot corrupt the id sequence.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JOBS = path.join(ROOT, 'lib', 'jobs.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bhatjobs-'));
const FILE = path.join(TMP, 'jobs.jsonl');

let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }

// Each "boot" is a fresh require of the module — the only honest way to test crash recovery.
function boot() {
  delete require.cache[require.resolve(JOBS)];
  const jobs = require(JOBS);
  jobs._reset({ file: FILE });
  return jobs;
}

console.log('[jobs-persist]');

// ── boot 1: create work, leave it running, then "crash" ──────────────────────────────────────────
{
  const jobs = boot();
  jobs.hydrate({ file: FILE });
  const proj = jobs.create({ name: 'refactor the planner', kind: 'project' });
  const t1 = jobs.create({ name: 'read planner.js', kind: 'task', parent: proj.id });
  const t2 = jobs.create({ name: 'write the patch', kind: 'task', parent: proj.id });
  jobs.update(proj.id, { status: 'running' });
  jobs.update(t1.id, { status: 'done', note: 'read 153 lines' });
  jobs.update(t2.id, { status: 'running', progress: 0.4 });
  assert.ok(fs.existsSync(FILE), 'the job log must exist on disk');
  ok('boot 1: jobs created and persisted while running');
}

// ── boot 2: the crash-recovery contract ─────────────────────────────────────────────────────────
{
  const jobs = boot();
  const orphans = jobs.hydrate({ file: FILE });

  assert.strictEqual(orphans.length, 2, 'the project + its running task should both be interrupted');
  const names = orphans.map((o) => o.name).sort();
  assert.deepStrictEqual(names, ['refactor the planner', 'write the patch']);

  // The finished task must NOT be resurrected as interrupted — that would be a lie about what happened.
  const done = jobs.list().find((j) => j.name === 'read planner.js');
  assert.strictEqual(done.status, 'done', 'a completed job must survive a restart as done');
  assert.strictEqual(done.note, 'read 153 lines', 'field-level state survives, not just status');

  // `interrupted` is distinct from `failed` — the work didn't fail, the process died under it.
  const orph = jobs.get(orphans[0].id);
  assert.strictEqual(orph.status, 'interrupted');
  assert.notStrictEqual(orph.status, 'failed');
  assert.ok(/interrupted by restart/.test(orph.note));
  assert.ok(orph.interruptedAt > 0 && orph.endedAt > 0);
  ok('boot 2: in-flight jobs reload as `interrupted`, finished jobs stay finished');

  // THE ID-COLLISION BUG: seq restarts at 0 each boot. Without advancing it past the highest
  // reloaded id, the next create() would mint job_001 on top of an existing job_001.
  const fresh = jobs.create({ name: 'post-restart work' });
  assert.strictEqual(fresh.id, 'job_004', 'seq must continue past the highest reloaded id');
  assert.strictEqual(jobs.list().filter((j) => j.id === 'job_001').length, 1, 'no duplicate ids');
  ok('boot 2: id sequence continues past reloaded jobs (no collision)');

  // Interrupted work is reportable, which is the whole point — it can be surfaced or resumed.
  assert.strictEqual(jobs.interrupted().length, 2);
  assert.strictEqual(jobs.active().length, 1, 'only the newly created job is active');
  ok('boot 2: interrupted work is queryable for report/resume');
}

// ── a torn final write must cost one update, not the registry ───────────────────────────────────
{
  fs.appendFileSync(FILE, '{"op":"updated","ts":1,"job":{"id":"job_00');   // truncated mid-write
  const jobs = boot();
  jobs.hydrate({ file: FILE });
  assert.ok(jobs.list().length >= 4, 'a torn trailing line must not sink the whole log');
  const done = jobs.list().find((j) => j.name === 'read planner.js');
  assert.strictEqual(done.status, 'done');
  ok('a torn trailing line is skipped, prior state intact');
}

// ── progress churn is coalesced: the hot path must not do a write per tick ──────────────────────
{
  const F2 = path.join(TMP, 'churn.jsonl');
  const jobs = boot();
  jobs._reset({ file: F2 });
  jobs.hydrate({ file: F2 });
  const j = jobs.create({ name: 'noisy' });
  jobs.update(j.id, { status: 'running' });
  const before = fs.readFileSync(F2, 'utf8').split('\n').filter(Boolean).length;
  for (let i = 0; i < 500; i++) jobs.update(j.id, { progress: i / 500 });
  const after = fs.readFileSync(F2, 'utf8').split('\n').filter(Boolean).length;
  assert.ok(after - before <= 2, `500 progress updates wrote ${after - before} lines (expected ≤2)`);

  // ...but a STATUS change always persists immediately, even amid progress churn.
  jobs.update(j.id, { status: 'done' });
  const reboot = (() => { delete require.cache[require.resolve(JOBS)]; const m = require(JOBS); m._reset({ file: F2 }); m.hydrate({ file: F2 }); return m; })();
  assert.strictEqual(reboot.get(j.id).status, 'done', 'a terminal status must never be lost to throttling');
  ok('progress churn coalesces, terminal status always persists');
}

// ── cancellation semantics survive a restart ────────────────────────────────────────────────────
{
  const F3 = path.join(TMP, 'cancel.jsonl');
  const jobs = boot();
  jobs._reset({ file: F3 });
  jobs.hydrate({ file: F3 });
  const p = jobs.create({ name: 'parent', kind: 'project' });
  const c = jobs.create({ name: 'child', parent: p.id });
  jobs.update(p.id, { status: 'running' });
  jobs.update(c.id, { status: 'running' });
  jobs.requestCancel(p.id);
  assert.strictEqual(jobs.get(c.id).status, 'cancelled', 'cancel cascades to children');

  const reboot = (() => { delete require.cache[require.resolve(JOBS)]; const m = require(JOBS); m._reset({ file: F3 }); m.hydrate({ file: F3 }); return m; })();
  assert.strictEqual(reboot.get(p.id).status, 'cancelled', 'cancelled stays cancelled across a restart');
  assert.strictEqual(reboot.interrupted().length, 0, 'a cancelled job must not come back as interrupted');
  ok('cancellation cascades and survives a restart (never re-opened as interrupted)');
}

// ── persistence can be disabled without changing behaviour (headless/tests) ─────────────────────
{
  const F4 = path.join(TMP, 'off.jsonl');
  const jobs = boot();
  jobs._reset({ file: F4, enabled: false });
  const j = jobs.create({ name: 'ephemeral' });
  jobs.update(j.id, { status: 'running' });
  assert.strictEqual(fs.existsSync(F4), false, 'persistence:false must write nothing');
  assert.strictEqual(jobs.get(j.id).status, 'running', 'in-RAM behaviour unchanged');
  ok('persistence can be disabled; in-RAM semantics unchanged');
}

// ── the original in-RAM API is untouched (back-compat with main.js + test-pass39) ───────────────
{
  const jobs = boot();
  jobs._reset({ file: path.join(TMP, 'api.jsonl') });
  for (const fn of ['create', 'update', 'get', 'list', 'active', 'children', 'requestCancel', 'isCancelled', 'addGuidance', 'takeGuidance', 'onUpdate']) {
    assert.strictEqual(typeof jobs[fn], 'function', `missing API: ${fn}`);
  }
  const p = jobs.create({ name: 'p', kind: 'project' });
  jobs.addGuidance(p.id, 'prefer the cheap path');
  assert.strictEqual(jobs.get(p.id).pendingGuidance, 1, 'guidance count still exposed');
  assert.deepStrictEqual(jobs.takeGuidance(p.id), ['prefer the cheap path']);
  assert.strictEqual(jobs.get(p.id).guidance, undefined, 'the guidance queue is never leaked in a snapshot');
  ok('the pre-existing API surface is preserved exactly');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`[jobs-persist] ${pass} assertions passed`);
