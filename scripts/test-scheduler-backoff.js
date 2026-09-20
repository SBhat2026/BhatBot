'use strict';
// Tests for the scheduler backoff (lib/scheduler.js markFailed/due/clearBlock) and the file-pruning
// half of lib/memmaint.js pruneRunDirs.
//
// THE REGRESSION THESE LOCK DOWN. A failed schedule used to stay due, so the next worker tick ran it
// again: 680 consecutive failures of "Morning brief" between 2026-09-04 and 2026-09-20, 15–28 per
// day, each writing an unread result file, against an error that said the account was out of credit.
// Two things had to be true for that: a failure left the schedule due, and nothing bounded the
// results directory. Both are asserted here.
//
// The store is redirected to a temp dir so this never touches ~/.bhatbot/schedules.json.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sched-'));
process.env.HOME = TMP;                       // scheduler resolves STORE from homedir at require time
fs.mkdirSync(path.join(TMP, '.bhatbot'), { recursive: true });

const scheduler = require('../lib/scheduler');
const failkind = require('../lib/failkind');
const memmaint = require('../lib/memmaint');

assert.ok(scheduler.STORE.startsWith(TMP), `test must not touch the real store (got ${scheduler.STORE})`);

let pass = 0;
const ok = (m) => { console.log('✅ ' + m); pass++; };

const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);
function freshSchedule() {
  try { fs.unlinkSync(scheduler.STORE); } catch {}
  scheduler.save([{
    id: 's_test', title: 'Morning brief', prompt: 'brief me', kind: 'daily', at: '07:00',
    enabled: true, nextRun: T0 - 1000, createdAt: new Date(T0).toISOString(),
  }]);
}

// ── the core regression ───────────────────────────────────────────────────────────────────────────
{
  freshSchedule();
  assert.strictEqual(scheduler.due(T0).length, 1, 'precondition: the schedule is due');

  const CREDIT = '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}';
  const v = failkind.classify(CREDIT);
  const b = scheduler.markFailed('s_test', { when: T0, error: CREDIT, kind: v.kind, backoffMs: (n) => failkind.backoffMs(v.kind, n) });

  assert.strictEqual(b.streak, 1);
  assert.strictEqual(b.firstOfStreak, true, 'the first failure of a streak must be reported');
  assert.strictEqual(scheduler.due(T0).length, 0, 'a just-failed schedule must NOT still be due');
  assert.strictEqual(scheduler.due(T0 + 60e3).length, 0, 'still parked a minute later');
  assert.strictEqual(scheduler.due(T0 + 5 * 3600e3).length, 0, 'still parked five hours later');
  assert.strictEqual(scheduler.due(T0 + 6 * 3600e3 + 1).length, 1, 'due again once the 6h window expires');
  ok('a permanent failure parks the schedule for 6h instead of leaving it due every tick');
}

// ── the occurrence is not silently swallowed ──────────────────────────────────────────────────────
{
  const s = scheduler.load()[0];
  assert.strictEqual(s.nextRun, T0 - 1000, 'markFailed must NOT advance nextRun — the run did not happen');
  assert.ok(!s.lastRun, 'a failed run is not a run');
  assert.strictEqual(s.lastError.kind, failkind.PERMANENT);
  assert.match(s.lastError.message, /credit/i, 'the cause is recorded for the Health panel');
  ok('a parked schedule keeps its occurrence and records why it failed');
}

// ── report once per streak, not once per attempt ──────────────────────────────────────────────────
{
  const b2 = scheduler.markFailed('s_test', { when: T0 + 6 * 3600e3 + 2, error: 'still broke', kind: failkind.PERMANENT, backoffMs: 6 * 3600e3 });
  assert.strictEqual(b2.streak, 2);
  assert.strictEqual(b2.firstOfStreak, false, 'the second failure must NOT re-notify — this is the 680-file bug');
  ok('only the first failure of a streak reports; the rest are silent');
}

// ── arithmetic: the actual reduction ──────────────────────────────────────────────────────────────
{
  // Sixteen days of the old behaviour at a 30-minute tick.
  const oldAttempts = 16 * 24 * 2;
  const newAttempts = 16 * (24 * 3600e3 / failkind.backoffMs(failkind.PERMANENT));
  assert.ok(newAttempts < oldAttempts / 10, `expected a >10× reduction, got ${oldAttempts} → ${newAttempts}`);
  assert.ok(newAttempts <= 64, `16 days should now cost at most 64 attempts, got ${newAttempts}`);
  ok(`the same 16-day outage costs ${newAttempts} attempts instead of ${oldAttempts}`);
}

// ── transient failures back off gently and still recover ──────────────────────────────────────────
{
  freshSchedule();
  const v = failkind.classify('fetch failed');
  assert.strictEqual(v.kind, failkind.TRANSIENT);
  const b = scheduler.markFailed('s_test', { when: T0, error: 'fetch failed', kind: v.kind, backoffMs: (n) => failkind.backoffMs(v.kind, n) });
  assert.strictEqual(b.blockedUntil, T0 + 60e3, 'first transient failure waits one minute, not six hours');
  assert.strictEqual(scheduler.due(T0 + 61e3).length, 1, 'and is due again right after');

  // Escalating streak.
  scheduler.markFailed('s_test', { when: T0, error: 'fetch failed', kind: v.kind, backoffMs: (n) => failkind.backoffMs(v.kind, n) });
  const s = scheduler.load()[0];
  assert.strictEqual(s.blockedUntil, T0 + 120e3, 'the second transient failure waits twice as long');
  ok('transient failures back off from one minute and escalate, rather than parking for hours');
}

// ── success clears everything ─────────────────────────────────────────────────────────────────────
{
  scheduler.markRan('s_test', T0 + 200e3);
  const s = scheduler.load()[0];
  assert.strictEqual(s.blockedUntil, undefined, 'a success lifts the backoff');
  assert.strictEqual(s.failStreak, undefined, 'a success resets the streak');
  assert.strictEqual(s.lastError, undefined, 'a success clears the recorded error');
  assert.ok(s.lastRun, 'and records the run');
  assert.ok(s.nextRun > T0 + 200e3, 'and advances to the next occurrence');
  ok('a successful run clears the backoff, the streak and the error');
}

// ── a disabled or blocked schedule is visible, not silent ─────────────────────────────────────────
{
  freshSchedule();
  scheduler.markFailed('s_test', { when: T0, error: 'no key', kind: failkind.PERMANENT, backoffMs: 6 * 3600e3 });
  const parked = scheduler.blocked(T0 + 1000);
  assert.strictEqual(parked.length, 1, 'blocked() surfaces it for the Health panel');
  assert.strictEqual(parked[0].id, 's_test');
  scheduler.clearBlock('s_test');
  assert.strictEqual(scheduler.blocked(T0 + 1000).length, 0);
  assert.strictEqual(scheduler.due(T0).length, 1, 'clearBlock makes it immediately runnable again');
  ok('a parked schedule is listable and can be un-parked by hand');
}

// ── deferral parks the WORKER but never the app ───────────────────────────────────────────────────
{
  freshSchedule();
  // The worker ran it, did everything it could, and hit the part that needs Mail.app.
  const b = scheduler.markDeferred('s_test', { when: T0, needs: 'Mail.app and the Gmail credential' });
  assert.strictEqual(b.scope, 'worker');

  assert.strictEqual(scheduler.due(T0 + 1000, { host: 'worker' }).length, 0,
    'the worker must not re-run a task it already established it cannot finish');
  assert.strictEqual(scheduler.due(T0 + 1000, { host: 'app' }).length, 1,
    'the desktop app — the only host that CAN finish it — must still see it as due');
  assert.strictEqual(scheduler.due(T0 + 1000).length, 1,
    'an unscoped caller sees anything not blocked for everyone');
  ok('a deferral parks the worker and leaves the app free to pick it up immediately');
}

// ── the deferral saving, as arithmetic ────────────────────────────────────────────────────────────
{
  // 350 deferrals were recorded over 16 days at a 30-minute tick. With a 6h worker park:
  const oldPerDay = 48;
  const newPerDay = 24 * 3600e3 / (6 * 3600e3);
  assert.strictEqual(newPerDay, 4);
  assert.ok(newPerDay < oldPerDay / 10, 'deferral attempts drop by more than 10×');
  ok(`deferrals drop from ~${oldPerDay}/day to ${newPerDay}/day, each one a paid web-search preamble`);
}

// ── a permanent failure parks BOTH hosts ──────────────────────────────────────────────────────────
{
  freshSchedule();
  scheduler.markFailed('s_test', { when: T0, error: 'credit balance is too low', kind: failkind.PERMANENT, backoffMs: 6 * 3600e3, scope: 'all' });
  assert.strictEqual(scheduler.due(T0 + 1000, { host: 'worker' }).length, 0);
  assert.strictEqual(scheduler.due(T0 + 1000, { host: 'app' }).length, 0,
    'an empty account blocks the app too — it is not a host-specific problem');
  ok('a dead key or empty account parks every host, not just the worker');
}

// ── success clears the scope as well as the block ─────────────────────────────────────────────────
{
  scheduler.markRan('s_test', T0 + 1000);
  const s = scheduler.load()[0];
  assert.strictEqual(s.blockedScope, undefined, 'a stale scope must not survive a success');
  assert.strictEqual(scheduler.due(T0 + 2000, { host: 'worker' }).length, 0, 'and nextRun has advanced');
  ok('a successful run clears the scope along with the backoff');
}

// ── markFailed on an unknown id must not throw or corrupt the store ───────────────────────────────
{
  const before = JSON.stringify(scheduler.load());
  assert.strictEqual(scheduler.markFailed('s_nope', { when: T0 }), null);
  assert.doesNotThrow(() => scheduler.clearBlock('s_nope'));
  assert.strictEqual(JSON.stringify(scheduler.load()), before, 'the store is untouched');
  ok('an unknown schedule id is a no-op, not a crash');
}

// ── memmaint prunes FILES, bounded by age AND count ───────────────────────────────────────────────
{
  const dir = path.join(TMP, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  // 10 recent + 5 old, all matching the prefix, plus one that does not.
  for (let i = 0; i < 10; i++) {
    const f = path.join(dir, `s_abc-${1000 + i}.json`);
    fs.writeFileSync(f, '{}');
    fs.utimesSync(f, new Date(now - i * 1000), new Date(now - i * 1000));
  }
  for (let i = 0; i < 5; i++) {
    const f = path.join(dir, `s_old-${i}.json`);
    fs.writeFileSync(f, '{}');
    const old = new Date(now - 60 * 864e5);
    fs.utimesSync(f, old, old);
  }
  fs.writeFileSync(path.join(dir, 'keepme.txt'), 'x');

  const r = memmaint.pruneRunDirs(dir, { prefix: 's_', entryKind: 'file', maxAgeDays: 30, keepNewest: 6, now });
  const left = fs.readdirSync(dir);
  assert.strictEqual(r.removed.length, 9, `expected 5 aged + 4 over-cap removed, got ${r.removed.length}`);
  assert.strictEqual(left.filter((f) => f.startsWith('s_')).length, 6, 'exactly keepNewest survive');
  assert.ok(left.includes('keepme.txt'), 'a non-matching file is never touched');
  ok('schedule results are bounded by both age and count, and other files are left alone');
}

// ── the original directory behaviour is unchanged ─────────────────────────────────────────────────
{
  const dir = path.join(TMP, 'drones');
  fs.mkdirSync(path.join(dir, 'run-old'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'run-new'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'keep-me'), { recursive: true });
  const old = new Date(Date.now() - 60 * 864e5);
  fs.utimesSync(path.join(dir, 'run-old'), old, old);

  const r = memmaint.pruneRunDirs(dir, { prefix: 'run-', maxAgeDays: 14 });
  assert.deepStrictEqual(r.removed, ['run-old'], 'only the aged run dir goes');
  assert.ok(fs.existsSync(path.join(dir, 'run-new')));
  assert.ok(fs.existsSync(path.join(dir, 'keep-me')));
  ok('the existing run-directory pruning is unchanged by the file support');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n✅ scheduler backoff: ${pass} groups passed`);
