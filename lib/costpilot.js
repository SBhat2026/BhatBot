'use strict';
// ── WHAT THIS RUN WILL COST, SAID BEFORE IT COSTS IT ──────────────────────────────────────────────
//
// The supervisor already has a hard spend wall. A wall tells you where the edge is and nothing about
// how fast you are approaching it, so a run can spend its whole envelope in ten minutes and stop —
// which is not what "keep going for several hours" means. Siddhant asked for a predicted cost up
// front, an update every fifteen or twenty minutes, and continuous monitoring "independent of the
// actual workflow". So this is a separate module that WATCHES; it does not schedule anything.
//
// READER ONLY. lib/costledger.js is already written to by recordCost() inside anthropicRequest, on
// every call the app makes. A second writer would double the daily total, so this one never records.
//
// AND IT DOES NOT READ THE LEDGER FOR RUN SPEND. The ledger is keyed by calendar day: a run that
// starts at 22:00 would watch its own cumulative spend drop to zero at midnight and compute a
// NEGATIVE burn rate, then "optimise" in the wrong direction on the strength of it. Run-scoped spend
// comes from mission.json, which is monotonic for the life of the run; the ledger is only for the
// cross-run "what am I spending per day" view.
//
// THE LEVERS ARE RANKED BY WHAT ACTUALLY SAVES MONEY, which is not the order they suggest themselves
// in. If the binding constraint is the account's output-tokens-per-minute — and M5_TUNING_PLAN.md §10
// says it is — then NARROWING WIDTH SAVES NOTHING: the same tokens flow through fewer slots at the
// same rate, and it takes longer. The levers that genuinely move the number are the ones that reduce
// tokens per item or move work off the meter entirely.
//
// Pure + DI, no Electron, no network. See scripts/test-costpilot.js.

const DEFAULTS = {
  targetUsdPerHour: 3.5,        // Siddhant's ceiling: "maximum $3-4"
  reportEveryMs: 15 * 60 * 1000,
  warnAtFraction: 0.8,          // of the target rate, before anything is recommended
  // With no history at all, an item is assumed to cost this. Stated as a guess wherever it is used —
  // a prediction whose basis is invented should say so rather than borrow the authority of one that
  // was measured.
  assumedUsdPerItem: 0.02,
  minSamplesForBasis: 3,
};

const LEVERS = [
  { id: 'local', why: 'move eligible items to the local lane — the only lever that removes cost rather than reshaping it' },
  { id: 'max_tokens', why: 'lower the per-turn output ceiling — fewer tokens per turn, same number of turns' },
  { id: 'max_turns', why: 'lower the turn ceiling per item — the tail turns are the ones that rarely change the answer' },
  { id: 'width', why: 'narrow the fan-out — last, because if OTPM is binding this saves nothing and only takes longer' },
  { id: 'stop', why: 'park the run and report — the envelope is the envelope' },
];

const fmt = (n) => `$${Number(n || 0).toFixed(2)}`;

/**
 * createCostPilot(deps) → the watcher.
 *
 * deps:
 *   missionMeta()  → { spendUsd, budgetUsd }  — run-scoped and monotonic
 *   journal()      → [{ tokensIn, tokensOut, name, ... }]  — for the measured basis
 *   planDigest()   → { total, done }
 *   priceOf(tin,tout) → usd   (lib/pricing.usd, injected so this module holds no rate table)
 *   now, log, onReport, config
 */
function createCostPilot(deps = {}) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const onReport = deps.onReport || (() => {});
  const cfg = { ...DEFAULTS, ...(deps.config || {}) };

  // EVERY READER IS WRAPPED. This watches a run; it must not be able to end one. A mission file that
  // vanishes mid-read, an unreadable journal, a reporter that throws — each is a reason to know less
  // about the cost, and none is a reason to stop the work. Absent data degrades the prediction to its
  // assumption, which the report already labels as a guess.
  const safe = (fn, fallback) => (...a) => { try { const v = fn(...a); return v == null ? fallback : v; } catch { return fallback; } };
  const missionMeta = safe(deps.missionMeta || (() => ({})), {});
  const journal = safe(deps.journal || (() => []), []);
  const planDigest = safe(deps.planDigest || (() => ({ total: 0, done: 0 })), { total: 0, done: 0 });
  const priceOf = safe(deps.priceOf || ((tin, tout) => (tin / 1e6) * 2 + (tout / 1e6) * 10), 0);

  const startedAt = now();
  let lastReportAt = 0;
  let capWidth = null;            // what the pilot is asking the width arbiter for, or null
  let advised = [];               // levers recommended so far, in order, never repeated

  const elapsedMs = () => Math.max(1, now() - startedAt);
  const elapsedHours = () => elapsedMs() / 3600000;
  const spent = () => Number((missionMeta() || {}).spendUsd) || 0;
  const budget = () => Number((missionMeta() || {}).budgetUsd) || 0;

  /**
   * basis() → { usdPerItem, samples, measured }
   *
   * From the journal's real token counts where there are any. `measured: false` means the number is
   * the configured assumption and every caller says so — Phase 0 started recording tokensIn/tokensOut
   * precisely so this could stop being a guess, and a run on a fresh machine still has no history.
   */
  function basis() {
    const rows = (journal() || []).filter((r) => r && (r.tokensIn || r.tokensOut));
    if (rows.length < cfg.minSamplesForBasis) {
      return { usdPerItem: cfg.assumedUsdPerItem, samples: rows.length, measured: false };
    }
    const total = rows.reduce((a, r) => a + priceOf(r.tokensIn || 0, r.tokensOut || 0), 0);
    return { usdPerItem: total / rows.length, samples: rows.length, measured: true };
  }

  /**
   * predict() → what the whole job looks like from here.
   *
   * Cost is driven by TURNS, not items, but turns are only observable through what items have already
   * cost — so the per-item figure is the honest unit as long as the remaining items resemble the
   * finished ones. It says which basis it used so a wild number can be traced rather than argued with.
   */
  function predict() {
    const d = planDigest() || { total: 0, done: 0 };
    const b = basis();
    const remaining = Math.max(0, (d.total || 0) - (d.done || 0));
    const projected = spent() + remaining * b.usdPerItem;
    const rate = spent() / elapsedHours();
    // Projected wall-clock from the observed completion rate, not from an item count alone.
    const perItemMs = (d.done || 0) > 0 ? elapsedMs() / d.done : null;
    return {
      spentUsd: +spent().toFixed(4),
      projectedUsd: +projected.toFixed(4),
      usdPerHour: +rate.toFixed(4),
      usdPerItem: +b.usdPerItem.toFixed(5),
      basis: b.measured ? `${b.samples} completed items` : 'an assumption — no items have reported tokens yet',
      measured: b.measured,
      remaining,
      etaMs: perItemMs ? Math.round(perItemMs * remaining) : null,
      budgetUsd: budget() || null,
      overBudget: budget() > 0 && projected > budget(),
      overRate: rate > cfg.targetUsdPerHour,
    };
  }

  /**
   * The next lever worth pulling, or null. Escalates one step at a time and never repeats itself, so
   * a run that is mildly over does not have every remedy thrown at it in one pass.
   */
  function nextLever(p) {
    if (!p.overRate && !p.overBudget) return null;
    for (const l of LEVERS) if (!advised.includes(l.id)) return l;
    return null;
  }

  /** widthCap() — what the pilot asks the width arbiter for. null means "no opinion". */
  function widthCap() { return capWidth; }

  /**
   * tick() → a report, or null when it is not time yet.
   *
   * Called freely from the scheduling loop; the cadence is enforced here rather than by the caller, so
   * "every fifteen minutes" is a property of the pilot and not of whoever remembered to call it.
   */
  function tick(force = false) {
    const t = now();
    if (!force && t - lastReportAt < cfg.reportEveryMs) return null;
    lastReportAt = t;

    const p = predict();
    const lever = nextLever(p);
    if (lever) {
      advised.push(lever.id);
      // Width is the only lever this module can pull by itself; the rest are recommendations the
      // supervisor or Siddhant acts on. Asking for a cap it cannot enforce would be a lie.
      if (lever.id === 'width') capWidth = Math.max(1, (capWidth || 5) - 1);
    }

    const report = {
      at: t, elapsedMin: Math.round(elapsedMs() / 60000), ...p,
      lever: lever ? lever.id : null, leverWhy: lever ? lever.why : null,
      advisedSoFar: [...advised],
      line: [
        `${fmt(p.spentUsd)} in ${Math.round(elapsedMs() / 60000)}min`,
        `${fmt(p.usdPerHour)}/h${p.overRate ? ` (over ${fmt(cfg.targetUsdPerHour)})` : ''}`,
        p.remaining ? `projected ${fmt(p.projectedUsd)}${p.measured ? '' : ' (a guess)'}` : 'nothing left to do',
        lever ? `→ ${lever.why}` : '',
      ].filter(Boolean).join(' · '),
    };
    log('[costpilot] ' + report.line);
    try { onReport(report); } catch {}
    return report;
  }

  return { tick, predict, basis, widthCap, elapsedMs, LEVERS, DEFAULTS: cfg, get advised() { return [...advised]; } };
}

module.exports = { createCostPilot, DEFAULTS, LEVERS };
