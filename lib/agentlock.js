'use strict';
// ── AGENT LOCK (Pass B2) ──────────────────────────────────────────────────────────────────────────
// The one thing standing between "works for an hour" and "works for eight".
//
// THE BUG CLASS. `dispatchTurn` serializes *turns* through a promise chain (main.js ~6070) — the fix
// that stopped the truncated "<s"/"I" replies. But that chain only covers turns. Six background
// timers fire on their own clocks:
//     scheduler 30s · patrol 5m · self-heal 15m · health 15m+ · ambient 30m · synapse hydrateMin
// and every one of them can call into agent paths that read and write module-level singletons
// (`agentState`, `currentMode`, `pendingGuidance`, `_activeTools`, `ttsStream*`). A background tick
// landing mid-turn corrupts exactly those globals. `tickScheduler` guards with
// `if (agentState !== 'idle') return`, which is a CHECK, not a lock: the turn can start one tick
// after the check passes, and two background ticks can still overlap each other.
//
// THE FIX. One lock, three access modes, no unbounded queue:
//   • run(name, fn)      — exclusive. Foreground turns take this. Queues (fair, FIFO).
//   • tryRun(name, fn)   — exclusive, but SKIP if busy. Every background tick takes this.
//   • isBusy()           — cheap read for the "should I even build the payload" check.
//
// WHY SKIP, NOT QUEUE, FOR BACKGROUND. A periodic tick that queues behind a 40-minute agent run is
// worse than one that skips: by the time it runs its premise is stale, and N deferred ticks all fire
// at once when the lock drops — a thundering herd on the exact machine that was already busy. Timers
// are idempotent by construction (the next one is ~seconds to ~minutes away), so skipping is free.
// Skips are counted per holder so the pattern is visible in telemetry rather than silent.
//
// PRIORITY. Background work must never starve a foreground turn, so `run()` (foreground) is never
// blocked by a *pending* background tick — `tryRun` refuses the moment the lock is held OR a
// foreground waiter exists. A background tick already in flight still completes; that's bounded by
// its own timeout.
//
// TIMEOUT. Every holder gets a deadline. A hung background tick that never resolves would otherwise
// wedge the lock permanently and silently kill all proactive work — the exact failure this module
// exists to prevent. On timeout the lock is force-released and the event recorded; the orphaned
// promise is left to settle on its own (we cannot cancel it, but we can stop it holding the world).
//
// RE-ENTRANCY — the trap this design walks straight into if you don't handle it. `tickScheduler`
// runs under the lock AND calls into the agent (that is its entire job: run due schedules through
// dispatchTurn). dispatchTurn also takes the lock. A naive mutex therefore has the scheduler waiting
// on a lock it is itself holding — a permanent wedge of the whole app, triggered by the most routine
// path in the system. So the lock is RE-ENTRANT: AsyncLocalStorage tags everything running inside a
// holder, and a nested acquire runs straight through instead of queueing. ALS is used rather than a
// flag because it propagates correctly across `await` boundaries and concurrent chains, which a
// module-level boolean does not.
//
// Pure + DI (`now`, `log`), no Electron — runs headless and in tests. See scripts/test-agentlock.js.
const { AsyncLocalStorage } = require('async_hooks');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;    // 10m: longer than any tick, shorter than a wedge
const FG_TIMEOUT_MS = 6 * 60 * 60 * 1000;     // 6h: a foreground turn may legitimately run for hours
const STAT_MAX = 40;                          // per-holder skip counters, bounded

function createAgentLock({ now = () => Date.now(), log = () => {} } = {}) {
  let held = null;                 // { name, kind, since, deadline }
  let fgWaiting = 0;               // foreground callers queued behind the lock
  const waiters = [];              // FIFO of { resolve } for run()
  const skips = new Map();         // name -> { skipped, lastSkipAt, lastHolder }
  let timeouts = 0, acquired = 0, reentered = 0;
  const als = new AsyncLocalStorage();   // set while executing inside a holder

  function bump(name, holder) {
    let s = skips.get(name);
    if (!s) {
      if (skips.size >= STAT_MAX) skips.delete(skips.keys().next().value);
      s = { skipped: 0, lastSkipAt: 0, lastHolder: '' };
      skips.set(name, s);
    }
    s.skipped++; s.lastSkipAt = now(); s.lastHolder = holder;
  }

  // Force-release a wedged holder. Called from the deadline check on the NEXT acquisition attempt
  // rather than a timer, so the lock needs no interval of its own (one less thing to leak).
  function reapIfExpired() {
    if (!held) return;
    if (now() < held.deadline) return;
    timeouts++;
    log(`[lock] force-released "${held.name}" after ${Math.round((now() - held.since) / 1000)}s — deadline exceeded`);
    held = null;
    pump();
  }

  function pump() {
    if (held || !waiters.length) return;
    const w = waiters.shift();
    w.resolve();
  }

  function release() {
    held = null;
    pump();
  }

  async function acquire(name, kind, timeoutMs) {
    reapIfExpired();
    if (held) {
      await new Promise((resolve) => waiters.push({ resolve }));
    }
    held = { name: String(name || 'anon'), kind, since: now(), deadline: now() + timeoutMs };
    acquired++;
    return held;
  }

  // Exclusive + queued. For foreground turns and anything whose result the user is waiting on.
  // Re-entrant: a call made from inside an existing holder (scheduler → dispatchTurn) runs through
  // rather than deadlocking on the lock its own caller is holding.
  async function run(name, fn, { timeoutMs = FG_TIMEOUT_MS } = {}) {
    const outer = als.getStore();
    if (outer) { reentered++; return await fn(); }
    fgWaiting++;
    try {
      await acquire(name, 'fg', timeoutMs);
    } finally { fgWaiting--; }
    try { return await als.run({ name, kind: 'fg' }, fn); }
    finally { release(); }
  }

  // Exclusive + skip-if-busy. For every background tick. Returns
  // { ran: true, value } or { ran: false, reason } — never throws for contention, so a caller can
  // stay a one-liner: `await lock.tryRun('ambient', tick)`.
  async function tryRun(name, fn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    reapIfExpired();
    const outer = als.getStore();
    if (outer) { reentered++; try { return { ran: true, value: await fn() }; } catch (e) { return { ran: true, error: e }; } }
    if (held || fgWaiting > 0 || waiters.length) {
      const holder = held ? held.name : 'foreground-pending';
      bump(String(name || 'anon'), holder);
      return { ran: false, reason: 'busy', holder };
    }
    held = { name: String(name || 'anon'), kind: 'bg', since: now(), deadline: now() + timeoutMs };
    acquired++;
    try { return { ran: true, value: await als.run({ name, kind: 'bg' }, fn) }; }
    catch (e) { return { ran: true, error: e }; }
    finally { release(); }
  }

  function isBusy() { reapIfExpired(); return !!held || fgWaiting > 0; }
  function holder() { reapIfExpired(); return held ? { ...held } : null; }

  function stats() {
    const bySkip = [...skips.entries()]
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => b.skipped - a.skipped);
    return {
      held: holder(), fgWaiting, queued: waiters.length,
      acquired, timeouts, reentered, skips: bySkip,
      totalSkipped: bySkip.reduce((n, s) => n + s.skipped, 0),
    };
  }

  return { run, tryRun, isBusy, holder, stats };
}

module.exports = { createAgentLock, DEFAULT_TIMEOUT_MS, FG_TIMEOUT_MS };
