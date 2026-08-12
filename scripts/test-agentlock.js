'use strict';
// Pass B2 — agent lock. The claim under test: a background tick can never interleave with a
// foreground turn, background ticks skip instead of queueing, and a wedged holder cannot park the
// world forever.
const assert = require('assert');
const path = require('path');
const { createAgentLock } = require(path.join(__dirname, '..', 'lib', 'agentlock'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }

(async () => {
  console.log('[agentlock]');

  // 1. Background tick DEFERS while a foreground turn holds the lock — the W7 contention fix.
  {
    const lock = createAgentLock();
    const order = [];
    const fg = lock.run('turn', async () => { order.push('fg-start'); await sleep(60); order.push('fg-end'); });
    await sleep(10);
    const r = await lock.tryRun('ambient', async () => { order.push('bg-ran'); });
    assert.strictEqual(r.ran, false, 'background tick must not run during a foreground turn');
    assert.strictEqual(r.holder, 'turn');
    await fg;
    assert.deepStrictEqual(order, ['fg-start', 'fg-end'], 'no interleaving');
    ok('background tick defers to a live foreground turn (no interleave)');
  }

  // 2. Two background ticks cannot overlap each other either.
  {
    const lock = createAgentLock();
    let inside = 0, maxInside = 0;
    const tick = async () => { inside++; maxInside = Math.max(maxInside, inside); await sleep(30); inside--; };
    const [a, b] = await Promise.all([lock.tryRun('patrol', tick), lock.tryRun('synapse', tick)]);
    assert.strictEqual(maxInside, 1, 'two background ticks overlapped');
    assert.ok(a.ran !== b.ran, 'exactly one of the two should have run');
    ok('concurrent background ticks are mutually exclusive');
  }

  // 3. Foreground QUEUES (never skips) and is not starved by a pending background tick.
  {
    const lock = createAgentLock();
    const order = [];
    const first = lock.run('turn-1', async () => { await sleep(40); order.push('t1'); });
    const second = lock.run('turn-2', async () => { order.push('t2'); });
    await Promise.all([first, second]);
    assert.deepStrictEqual(order, ['t1', 't2'], 'foreground turns must serialize in order');
    ok('foreground turns queue FIFO rather than skipping');
  }

  // 4. A background tick is refused while a foreground caller is WAITING, not just holding —
  //    otherwise a bg tick could jump the queue ahead of the user.
  {
    const lock = createAgentLock();
    const held = lock.run('turn-a', async () => { await sleep(50); });
    await sleep(5);
    const waiter = lock.run('turn-b', async () => {});
    await sleep(5);
    const r = await lock.tryRun('ambient', async () => {});
    assert.strictEqual(r.ran, false, 'bg must not jump ahead of a queued foreground turn');
    await Promise.all([held, waiter]);
    ok('background never jumps a queued foreground turn');
  }

  // 5. Skips are COUNTED, not silent — an invisible governor is an unmaintainable one.
  {
    const lock = createAgentLock();
    const fg = lock.run('turn', async () => { await sleep(40); });
    await sleep(5);
    await lock.tryRun('ambient', async () => {});
    await lock.tryRun('ambient', async () => {});
    await lock.tryRun('patrol', async () => {});
    await fg;
    const s = lock.stats();
    assert.strictEqual(s.totalSkipped, 3);
    const amb = s.skips.find((x) => x.name === 'ambient');
    assert.strictEqual(amb.skipped, 2, 'per-holder skip counts must accumulate');
    ok('skips are counted per holder and visible in stats()');
  }

  // 6. A wedged holder is force-released at its deadline. Without this a single hung tick silently
  //    kills ALL proactive work for the life of the process — the exact failure this module prevents.
  {
    let t = 1000;
    const lock = createAgentLock({ now: () => t });
    let released = false;
    lock.tryRun('hung', () => new Promise(() => {}), { timeoutMs: 5000 });   // never resolves
    await sleep(5);
    assert.strictEqual(lock.isBusy(), true, 'hung tick should hold the lock');
    t += 6000;                                                               // past the deadline
    const r = await lock.tryRun('ambient', async () => { released = true; });
    assert.strictEqual(r.ran, true, 'lock must be reclaimable after the deadline');
    assert.strictEqual(released, true);
    assert.strictEqual(lock.stats().timeouts, 1);
    ok('a hung holder is force-released at its deadline');
  }

  // 7. A throwing background tick must release the lock, not poison it.
  {
    const lock = createAgentLock();
    const r = await lock.tryRun('bad', async () => { throw new Error('boom'); });
    assert.strictEqual(r.ran, true);
    assert.ok(r.error && /boom/.test(r.error.message), 'error is reported, not thrown');
    assert.strictEqual(lock.isBusy(), false, 'lock released after a throwing tick');
    const after = await lock.tryRun('good', async () => 42);
    assert.strictEqual(after.value, 42);
    ok('a throwing tick releases the lock and reports the error');
  }

  // 8. A throwing FOREGROUND turn rethrows (the caller must see it) but still releases.
  {
    const lock = createAgentLock();
    await assert.rejects(() => lock.run('turn', async () => { throw new Error('fg-boom'); }), /fg-boom/);
    assert.strictEqual(lock.isBusy(), false, 'lock released after a throwing foreground turn');
    ok('a throwing foreground turn rethrows and still releases');
  }

  // 9. THE DEADLOCK TRAP. tickScheduler runs UNDER the lock and its whole job is to push due
  //    schedules through dispatchTurn — which also takes the lock. A non-reentrant mutex wedges the
  //    entire app on the most routine path in the system. This must complete, not hang.
  {
    const lock = createAgentLock();
    let ran = false;
    const dispatchTurn = () => lock.run('turn', async () => { ran = true; return 'done'; });
    const r = await Promise.race([
      lock.tryRun('scheduler', async () => dispatchTurn()),
      sleep(1500).then(() => 'TIMEOUT'),
    ]);
    assert.notStrictEqual(r, 'TIMEOUT', 'scheduler → dispatchTurn deadlocked the lock');
    assert.strictEqual(ran, true);
    assert.strictEqual(r.value, 'done');
    assert.strictEqual(lock.isBusy(), false, 'lock fully released after the nested call');
    assert.strictEqual(lock.stats().reentered, 1, 're-entry should be counted');
    ok('scheduler → dispatchTurn re-enters instead of deadlocking');
  }

  // 10. Re-entrancy survives await boundaries (why this uses AsyncLocalStorage, not a boolean).
  {
    const lock = createAgentLock();
    const deep = async () => { await sleep(10); return lock.run('inner', async () => { await sleep(10); return 'deep'; }); };
    const r = await Promise.race([
      lock.run('outer', async () => { await sleep(10); return deep(); }),
      sleep(1500).then(() => 'TIMEOUT'),
    ]);
    assert.strictEqual(r, 'deep', 'nested acquire across awaits must not deadlock');
    assert.strictEqual(lock.isBusy(), false);
    ok('re-entrancy propagates across await boundaries');
  }

  // 11. Re-entrancy must NOT leak to a sibling chain — an unrelated background tick started while a
  //     turn is in flight is still a genuine contender and must skip.
  {
    const lock = createAgentLock();
    let leaked = false;
    const fg = lock.run('turn', async () => { await sleep(60); });
    await sleep(10);
    const r = await lock.tryRun('ambient', async () => { leaked = true; });
    assert.strictEqual(r.ran, false, 'ALS context must not leak into a sibling async chain');
    assert.strictEqual(leaked, false);
    await fg;
    ok('re-entrancy does not leak to sibling chains');
  }

  console.log(`[agentlock] ${pass} assertions passed`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
