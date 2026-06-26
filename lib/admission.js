'use strict';
// Budget-aware fleet admission controller (Phase 1, Deliverable #2).
//
// THE CONVOY BUG it fixes: the three fleet systems (ensemble, persistent sub-agents, project DAG)
// all fired the injected anthropicRequest DIRECTLY with no pacing. N suits launched together each
// drained the per-model OTPM/ITPM rolling window at the same instant, so they all tripped the rate
// limit together and stalled — a convoy. The main turn paced via callModel.waitForBudget; the fleet
// never did.
//
// This is a shared RESERVATION LEDGER over the SAME rolling windows the main preflight uses. Every
// sub-agent API call ACQUIRES an estimated in/out reservation before it fires and RELEASES on
// completion. So concurrent suits see each other's outstanding reservations and self-throttle to
// whatever the live budget allows — fleet width becomes a function of budget, not a hardcoded number.
//
// Pure logic. main.js injects:
//   freeBudget(model) → { inFree, outFree }   (= rateBudget(model); Infinity outFree = untracked)
//   sleep(ms)                                  (await-able delay)
//   log(text)                                  (optional; surfaces a pacing notice)

function createAdmission({ freeBudget, sleep, log } = {}) {
  const reserved = {};                                  // model → { in, out, agents }
  const slot = (m) => (reserved[m] = reserved[m] || { in: 0, out: 0, agents: 0 });

  // Wait until (live window − outstanding reservations) can fit this call, then reserve it.
  // Never deadlocks: after timeoutMs it admits anyway — a single stuck reservation must never
  // freeze the whole fleet (worst case it briefly oversubscribes and anthropicRequest's own
  // 429 backoff absorbs it).
  async function acquire(model, needIn, needOut, { timeoutMs = 120000, label: lbl } = {}) {
    const start = Date.now();
    let waited = false;
    while (true) {
      const f = freeBudget(model) || { inFree: Infinity, outFree: Infinity };
      const r = slot(model);
      const inOk = !isFinite(f.inFree) || (f.inFree - r.in) >= needIn;
      const outOk = !isFinite(f.outFree) || (f.outFree - r.out) >= needOut;
      if (inOk && outOk) { r.in += needIn; r.out += needOut; r.agents++; return { admitted: true, waited }; }
      if (Date.now() - start >= timeoutMs) { r.in += needIn; r.out += needOut; r.agents++; return { admitted: true, waited, timedOut: true }; }
      if (!waited && log) { try { log(`⏳ VANGUARD admission: holding ${lbl || model} for budget (~${Math.round(needOut / 1000)}k out)`); } catch {} }
      waited = true;
      await sleep(2000);
    }
  }

  function release(model, needIn, needOut) {
    const r = slot(model);
    r.in = Math.max(0, r.in - needIn);
    r.out = Math.max(0, r.out - needOut);
    r.agents = Math.max(0, r.agents - 1);
  }

  // Live fleet width: how many agents of ~perAgentOut output tokens the budget can carry RIGHT NOW
  // (after subtracting outstanding reservations), clamped to [min, max]. Untracked OTPM → max.
  function width(model, perAgentOut = 4096, { min = 2, max = 12 } = {}) {
    const f = freeBudget(model) || { outFree: Infinity };
    if (!isFinite(f.outFree)) return max;
    const r = slot(model);
    const free = Math.max(0, f.outFree - r.out);
    const n = Math.floor(free / Math.max(perAgentOut, 1));
    return Math.max(min, Math.min(max, n || min));
  }

  function snapshot() { return JSON.parse(JSON.stringify(reserved)); }

  return { acquire, release, width, snapshot };
}

module.exports = { createAdmission };
