#!/usr/bin/env node
'use strict';
// Tests for the VANGUARD admission controller (lib/admission.js). This is the safety net that makes
// the Phase-5A parallel boost (fleetWidth max 12→24, ensemble→8, fleet→12) safe: raising the caps only
// lifts a CEILING — actual fleet width is budget-bound (width = floor(liveFree/perAgentOut)), and
// acquire() reserves before firing so concurrent agents self-throttle instead of convoy-stalling the
// OTPM window. Verifies clamping, budget-bound width, reservation subtraction, untracked→max, the
// wait→admit-on-release path, and the never-deadlock timeout-admit. Pure → plain node.
//   node scripts/test-admission.js
const { createAdmission } = require('../lib/admission');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };
const fastSleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));

(async () => {
  // ---- width(): budget-bound, clamped ----
  {
    let out = 50000;
    const a = createAdmission({ freeBudget: () => ({ inFree: Infinity, outFree: out }), sleep: fastSleep });
    ok(a.width('m', 4096, { min: 3, max: 24 }) === 12, 'width: floor(50000/4096)=12 (budget-bound, under the raised max)');
    out = 500000;
    ok(a.width('m', 4096, { min: 3, max: 24 }) === 24, 'width: huge budget → clamped to max (24)');
    out = 1000;
    ok(a.width('m', 4096, { min: 3, max: 24 }) === 3, 'width: tiny budget → clamped up to min (3)');
  }
  // ---- width(): untracked OTPM (Infinity) → max ----
  {
    const a = createAdmission({ freeBudget: () => ({ inFree: Infinity, outFree: Infinity }), sleep: fastSleep });
    ok(a.width('m', 4096, { min: 3, max: 24 }) === 24, 'width: untracked OTPM → max');
  }
  // ---- width(): subtracts outstanding reservations ----
  {
    const a = createAdmission({ freeBudget: () => ({ inFree: Infinity, outFree: 50000 }), sleep: fastSleep });
    await a.acquire('m', 0, 42000);   // reserve most of the budget
    ok(a.width('m', 4096, { min: 1, max: 24 }) === Math.floor(8000 / 4096), 'width: subtracts outstanding reservations (only ~8k free left → 1)');
  }

  // ---- acquire/release: reserve, then a second over-budget call waits, admits after release ----
  {
    const a = createAdmission({ freeBudget: () => ({ inFree: Infinity, outFree: 10000 }), sleep: fastSleep });
    const r1 = await a.acquire('m', 0, 8000);
    ok(r1.admitted && !r1.waited, 'acquire: first call admits immediately (budget free)');
    let r2done = false;
    const r2p = a.acquire('m', 0, 8000, { timeoutMs: 5000 }).then((r) => { r2done = true; return r; });
    await fastSleep(20);
    ok(!r2done, 'acquire: second over-budget call is HELD (waiting, not admitted)');
    a.release('m', 0, 8000);          // free the first reservation
    const r2 = await r2p;
    ok(r2.admitted && r2.waited && !r2.timedOut, 'acquire: held call admits after release (waited=true, not a timeout)');
  }

  // ---- acquire: never deadlocks — admits after timeout even if budget never frees ----
  {
    const a = createAdmission({ freeBudget: () => ({ inFree: Infinity, outFree: 1000 }), sleep: fastSleep });
    const r = await a.acquire('m', 0, 50000, { timeoutMs: 30 });
    ok(r.admitted && r.timedOut, 'acquire: budget never fits → timeout-admit (no deadlock; 429 backoff absorbs)');
  }

  // ---- release: floors at zero (no negative reservation) ----
  {
    const a = createAdmission({ freeBudget: () => ({ inFree: Infinity, outFree: 10000 }), sleep: fastSleep });
    a.release('m', 0, 5000);          // release without acquire
    ok(a.snapshot().m.out === 0, 'release: clamps reservations at 0 (no negative drift)');
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
