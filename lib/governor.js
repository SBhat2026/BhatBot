'use strict';
// ── THERMAL / MEMORY GOVERNOR (Pass B4) ───────────────────────────────────────────────────────────
// The existing gate is `shouldSpareWatts() = powerSaver && onBattery` — one bit, and the wrong bit.
// It says nothing about the constraint that actually ends long runs on this machine.
//
// TARGET HARDWARE (measured on the box): **M5 Pro, 15-core, 24GB** — `sysctl hw.memsize` says
// 25769803776, and the chassis is actively cooled. This file used to describe a fanless MacBook Air
// M4 with 16GB, which is a machine that no longer exists; the thresholds below were set for it and
// were therefore ~50% too conservative in absolute terms. They are retuned per M5_TUNING_PLAN.md §7
// to hold the same ABSOLUTE headroom: 25% of 16GB ≈ 18% of 24GB.
//
// That the description was stale is not a cosmetic problem. ARCHITECTURE.md-class documents in this
// repo are read by self-drive and reflection, so a hardware claim in a module they consult is closer
// to an instruction than to a comment.
//
// Sustained local inference no longer throttles the way it did on the fanless box, but the stated
// goal is still *hours*. So the governor's job is not to make peak throughput high — it is to keep the
// machine in a state where work continues at reduced quality instead of stalling or overheating.
//
// SIGNALS (all injected — this module never spawns anything itself):
//   thermal — Electron `powerMonitor.getCurrentThermalState()`: nominal|fair|serious|critical.
//             Falls back to `pmset -g therm` ProcessorSpeedLimit. NOTE: on an idle Mac `pmset -g
//             therm` prints "No thermal warning level has been recorded" — absence is NOT nominal,
//             it's unknown, and unknown must never be treated as pressure (that would shed forever
//             on a healthy machine).
//   memFreePct — `memory_pressure -Q` "System-wide memory free percentage". Do NOT use
//             `os.freemem()` on macOS: it reported 0.4GB free on a 16GB machine that
//             `memory_pressure` called 48% free. Unified memory + compression make the raw page
//             count meaningless, and a governor driven by it would shed permanently.
//   battery — the existing onBattery/powerSaver pair, folded in as one more pressure input.
//
// SHED LADDER (order fixed by B4; each level is cumulative):
//   nominal  → everything allowed
//   warm     → shed the LOCAL MODEL SLOT first (fall back to the hosted judge slot). Local inference
//              is both the largest heat source and the most substitutable — the hosted slot does the
//              same job for money instead of watts.
//   hot      → also halve vision cadence + drop the heavy caption/semantics pass.
//   critical → also defer all background ticks (ambient/patrol/synapse/health). Scheduler and
//              foreground turns still run.
//
// FOREGROUND IS NEVER SHED. At every level `allowForeground()` is true. A governor that can block
// the user is a governor that gets turned off.
//
// HYSTERESIS. Escalation is immediate (heat is real, react now); de-escalation requires the lower
// reading to hold for `dwellMs` (default 90s). Without this the governor flaps at a boundary and
// thrashes the model slot every sample — measurably worse than no governor at all.
//
// Pure + DI. No Electron, no child_process. See scripts/test-governor.js.

const LEVELS = ['nominal', 'warm', 'hot', 'critical'];
const RANK = { nominal: 0, warm: 1, hot: 2, critical: 3 };

const DEFAULTS = {
  dwellMs: 90 * 1000,        // how long a cooler reading must hold before we relax
  // Retuned for 24GB (M5_TUNING_PLAN.md §7). The ABSOLUTE headroom is what matters — ~4.3GB free is
  // the same amount of room whether it is 27% of 16GB or 18% of 24GB — and the old percentages on the
  // bigger machine were reserving half again as much as they were written to.
  memWarnPct: 18,            // free% below this → warm   (24GB: ~4.3GB free)
  memHotPct: 11,             // free% below this → hot    (~2.6GB free)
  memCriticalPct: 6,         // free% below this → critical (~1.4GB free)
  sampleEveryMs: 20 * 1000,  // minimum spacing between probe calls
};

// thermal string → level. `unknown`/null → nominal (absence of evidence, not evidence of pressure).
function thermalLevel(t) {
  switch (String(t || '').toLowerCase()) {
    case 'critical': return 'critical';
    case 'serious': return 'hot';
    case 'fair': return 'warm';
    case 'nominal': return 'nominal';
    default: return 'nominal';
  }
}

function memLevel(freePct, cfg) {
  if (freePct == null || Number.isNaN(freePct)) return 'nominal';   // unknown → don't shed
  if (freePct <= cfg.memCriticalPct) return 'critical';
  if (freePct <= cfg.memHotPct) return 'hot';
  if (freePct <= cfg.memWarnPct) return 'warm';
  return 'nominal';
}

function maxLevel(...ls) { return ls.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'nominal'); }

function createGovernor({
  readThermal = () => null,        // () => 'nominal'|'fair'|'serious'|'critical'|null
  readMemFreePct = () => null,     // () => number 0..100 | null
  onBattery = () => false,
  powerSaver = () => true,
  now = () => Date.now(),
  log = () => {},
  config = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...config };
  let level = 'nominal';
  let raw = 'nominal';             // latest unsmoothed reading
  let coolSince = 0;               // when `raw` first dropped below `level`
  let lastSample = null;           // null = never sampled; the FIRST poll must always probe
  let sample = { thermal: null, memFreePct: null, battery: false, ts: 0 };
  const history = [];              // bounded transition log, for the Manage panel

  function note(from, to, why) {
    history.push({ ts: now(), from, to, why });
    while (history.length > 30) history.shift();
    log(`[governor] ${from} → ${to} (${why})`);
  }

  // Read the probes at most every sampleEveryMs, then fold into `level` with hysteresis.
  function poll({ force = false } = {}) {
    const t = now();
    if (!force && lastSample !== null && t - lastSample < cfg.sampleEveryMs) return level;
    lastSample = t;

    let thermal = null, memFreePct = null, batt = false;
    try { thermal = readThermal(); } catch {}
    try { memFreePct = readMemFreePct(); } catch {}
    try { batt = !!onBattery(); } catch {}
    sample = { thermal, memFreePct, battery: batt, ts: t };

    const tl = thermalLevel(thermal);
    const ml = memLevel(typeof memFreePct === 'number' ? memFreePct : null, cfg);
    // Battery alone is not heat — it caps at `warm`, never escalates past it on its own.
    const bl = (batt && (() => { try { return !!powerSaver(); } catch { return true; } })()) ? 'warm' : 'nominal';
    raw = maxLevel(tl, ml, bl);

    if (RANK[raw] > RANK[level]) {
      const why = raw === tl ? `thermal=${thermal}` : raw === ml ? `mem=${memFreePct}% free` : 'battery';
      note(level, raw, why);
      level = raw; coolSince = 0;
      return level;
    }
    if (RANK[raw] < RANK[level]) {
      if (!coolSince) coolSince = t;
      if (t - coolSince >= cfg.dwellMs) {           // held cool long enough → relax one step
        const next = LEVELS[RANK[level] - 1];
        note(level, next, `cooled ${Math.round((t - coolSince) / 1000)}s`);
        level = next; coolSince = RANK[raw] < RANK[level] ? t : 0;
      }
      return level;
    }
    coolSince = 0;
    return level;
  }

  const at = (l) => RANK[level] >= RANK[l];

  return {
    poll,
    level: () => level,
    sample: () => ({ ...sample, level, raw }),
    history: () => history.slice(),

    // ── the ladder, as questions the call sites ask ──────────────────────────────────────────────
    allowForeground: () => true,                       // invariant: never shed the user
    allowLocalModel: () => !at('warm'),                // warm+ → use the hosted judge slot instead
    allowHeavyVision: () => !at('hot'),                // hot+  → no caption/semantics pass
    visionCadenceMultiplier: () => (at('hot') ? 2 : 1),// hot+  → sample the screen half as often
    allowBackgroundTick: (name) => {
      if (!at('critical')) return true;
      return name === 'scheduler';                     // critical → scheduler only (it gates itself)
    },

    // One line for telemetry / the Manage panel.
    describe() {
      const s = sample;
      const bits = [
        `level=${level}`,
        s.thermal ? `thermal=${s.thermal}` : null,
        typeof s.memFreePct === 'number' ? `mem=${s.memFreePct}% free` : null,
        s.battery ? 'battery' : null,
      ].filter(Boolean);
      return bits.join(' · ');
    },
  };
}

module.exports = { createGovernor, thermalLevel, memLevel, LEVELS, RANK, DEFAULTS };
