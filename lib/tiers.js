'use strict';
// ── WHICH TIER IS THIS MACHINE IN RIGHT NOW? ──────────────────────────────────────────────────────
//
// lib/governor.js answers "is the machine under pressure" — heat, memory, battery — and sheds load
// when it is. It does not answer "is Siddhant using this computer", which is the question that
// separates *may I hold a 9.6 GB model resident* from *get out of his way*. Both are real and they
// are not the same question.
//
// WHY THIS IS NOT FOLDED INTO createGovernor, which was the obvious thing to do:
//
//   THE HYSTERESIS RUNS THE OTHER WAY. The governor escalates the instant a reading is bad and relaxes
//   only after a 90-second dwell, because heat is real now and coolness needs proof. Tier selection is
//   the mirror image: DROPPING must be immediate (he opened Xcode — release the memory this second)
//   while RAISING needs a sustained dwell, so a coffee break does not thrash a model load that costs
//   3.8–15.6 seconds to redo. One object where `level()` escalates fast and `tier()` escalates slow is
//   an API that will be read wrong at 3am, and the thing it controls is how much of his machine an
//   unattended process is allowed to take.
//
// So this CONSUMES the governor rather than absorbing it. Pressure is one of its four inputs.
//
// Every signal is a shell command that already exists on this machine — no new dependency, and each
// one was checked before being relied on. See M5_TUNING_PLAN.md §3, which specified this policy.
//
// Pure + DI: every reader is injectable, so scripts/test-tiers.js drives the whole ladder without
// touching the real machine. See also lib/governor.js for the pressure half.

const TIERS = ['conservative', 'balanced', 'aggressive'];
const RANK = { conservative: 0, balanced: 1, aggressive: 2 };

const DEFAULTS = {
  idleMinutes: 10,            // HID idle before "he is not here" is believable
  memFreePct: 30,             // below this, balanced is not honest
  raiseDwellMs: 10 * 60 * 1000,  // a sustained quiet before climbing — the expensive direction
  sampleEveryMs: 20 * 1000,
  heavyApps: ['Xcode', 'Blender', 'Unity', 'DaVinci Resolve', 'Final Cut Pro', 'Logic Pro'],
  // A run that has already been pushed down twice is on a machine that keeps needing itself back.
  // Climbing again only to be knocked down a third time costs another model load for nothing, so the
  // ladder latches. This is the brake on the RAM death spiral: leak → pressure → drop → all work goes
  // cloud → slower → more leak, with every component behaving correctly.
  maxDrops: 2,
};

/** The per-tier model residency M5 §3 specifies: evict / keep warm / pin. */
const KEEP_ALIVE = { conservative: '0', balanced: '30m', aggressive: '-1' };

/**
 * createTiers(deps) → { poll, tier, describe, sample, localLaneEnabled, drops, TIERS }
 *
 * deps:
 *   readIdleMs()     → ms since the last keystroke or mouse move, or null if unknown
 *   onAC()           → true when plugged in
 *   heavyAppRunning()→ true when one of `heavyApps` is resident
 *   readMemFreePct() → 0..100, or null
 *   governorLevel()  → 'nominal'|'warm'|'hot'|'critical' from lib/governor.js
 *   now, log, onChange, config
 */
function createTiers(deps = {}) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const onChange = deps.onChange || (() => {});
  const cfg = { ...DEFAULTS, ...(deps.config || {}) };

  const readIdleMs = deps.readIdleMs || (() => null);
  const onAC = deps.onAC || (() => true);
  const heavyAppRunning = deps.heavyAppRunning || (() => false);
  const readMemFreePct = deps.readMemFreePct || (() => null);
  const governorLevel = deps.governorLevel || (() => 'nominal');

  let current = 'balanced';      // the honest starting assumption: he is probably here
  let lastSample = null, sample = null;
  let wantSince = null;          // when the CURRENT desire first appeared, for the raise dwell
  let drops = 0;

  /**
   * The policy, exactly as M5 §3 states it. Written as a ladder from the bottom so the first matching
   * clause wins and the reason is the clause that matched — "it is conservative" is a useless answer
   * to "why is it conservative".
   */
  function desire(s) {
    if (s.governor === 'critical' || s.governor === 'hot') return { tier: 'conservative', why: `the machine is ${s.governor}` };
    if (s.heavyApp) return { tier: 'conservative', why: `${s.heavyApp} is running` };
    if (s.onAC === false) return { tier: 'conservative', why: 'on battery' };
    if (s.memFreePct != null && s.memFreePct < cfg.memFreePct) return { tier: 'conservative', why: `only ${s.memFreePct}% memory free` };
    // Aggressive needs POSITIVE evidence of absence. A null idle reading is not evidence, so an
    // unknown signal can lower the tier but never raise it — the failure direction that matters when
    // the thing being decided is how much of his machine to take.
    if (s.idleMs != null && s.idleMs >= cfg.idleMinutes * 60000 && s.onAC === true) {
      return { tier: 'aggressive', why: `idle ${Math.round(s.idleMs / 60000)}min on AC` };
    }
    return { tier: 'balanced', why: 'he is using the machine' };
  }

  function read() {
    const s = { at: now(), idleMs: null, onAC: true, heavyApp: null, memFreePct: null, governor: 'nominal' };
    try { const v = readIdleMs(); s.idleMs = Number.isFinite(v) ? v : null; } catch {}
    try { s.onAC = !!onAC(); } catch { s.onAC = true; }
    try { const h = heavyAppRunning(); s.heavyApp = h === true ? 'a heavy app' : (h || null); } catch {}
    try { const m = readMemFreePct(); s.memFreePct = Number.isFinite(m) ? m : null; } catch {}
    try { s.governor = governorLevel() || 'nominal'; } catch {}
    return s;
  }

  /** poll() → the tier now. Cheap to call; the readers are spaced by sampleEveryMs. */
  function poll() {
    const t = now();
    if (lastSample !== null && t - lastSample < cfg.sampleEveryMs) return current;
    lastSample = t;
    sample = read();
    const want = desire(sample);

    if (want.tier === current) { wantSince = null; return current; }

    // DOWN IS IMMEDIATE. He needs the machine back now, not in ten minutes.
    if (RANK[want.tier] < RANK[current]) {
      const from = current;
      current = want.tier;
      drops++;
      wantSince = null;
      log(`[tiers] ${from} → ${current} (${want.why})`);
      onChange({ from, to: current, why: want.why, direction: 'down', sample, drops });
      return current;
    }

    // UP NEEDS PROOF. A model reload costs seconds; a coffee break should not buy one.
    if (drops >= cfg.maxDrops) {
      // Latched. Said once — repeating it every twenty seconds for the rest of the run is noise.
      if (wantSince !== 'latched') {
        wantSince = 'latched';
        log(`[tiers] staying ${current}: dropped ${drops}× this run, not climbing again`);
        onChange({ from: current, to: current, why: `latched after ${drops} drops`, direction: 'latched', sample, drops });
      }
      return current;
    }
    if (wantSince === null || wantSince === 'latched') { wantSince = t; return current; }
    if (t - wantSince < cfg.raiseDwellMs) return current;

    const from = current;
    current = want.tier;
    wantSince = null;
    log(`[tiers] ${from} → ${current} (${want.why}, held ${Math.round(cfg.raiseDwellMs / 60000)}min)`);
    onChange({ from, to: current, why: want.why, direction: 'up', sample, drops });
    return current;
  }

  return {
    poll,
    tier: () => current,
    sample: () => sample,
    drops: () => drops,
    keepAlive: () => KEEP_ALIVE[current],
    /**
     * Whether the local lane may run at all.
     *
     * This is what the governor genuinely owns and an `agentWidth()` would not have been: cloud agent
     * count costs neither watts nor RAM — it is network-bound and paced by lib/admission.js — while a
     * resident local model costs 5–10 GB and real power. So the machine gets a say over the local lane
     * and no say at all over the cloud one.
     */
    localLaneEnabled: () => current !== 'conservative',
    describe: () => {
      const s = sample || read();
      const bits = [];
      if (s.idleMs != null) bits.push(`idle ${Math.round(s.idleMs / 60000)}min`);
      bits.push(s.onAC ? 'AC' : 'battery');
      if (s.heavyApp) bits.push(s.heavyApp);
      if (s.memFreePct != null) bits.push(`${s.memFreePct}% free`);
      if (s.governor && s.governor !== 'nominal') bits.push(s.governor);
      return `${current} (${bits.join(' · ')})`;
    },
    TIERS, RANK, KEEP_ALIVE, DEFAULTS: cfg,
  };
}

// ── the real readers, for main.js ────────────────────────────────────────────────────────────────
// Kept here beside the policy so the two are read together, but injected rather than called directly
// so the policy stays testable without a machine underneath it.
const { execSync } = require('child_process');
const sh = (cmd, ms = 900) => { try { return execSync(cmd, { timeout: ms, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };

/**
 * ms since the last keystroke or mouse movement. null when it cannot be read.
 *
 * No `-d` depth limit. It is tempting as an optimisation and it silently breaks this: HIDIdleTime
 * lives deeper than either `-d 1` or `-d 2` reaches, both of which return a clean empty result rather
 * than an error — so the reader returned null forever and the tier ladder could never reach
 * aggressive. A truncated tree and an idle machine look identical from here.
 */
function readIdleMs() {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(sh('ioreg -c IOHIDSystem', 1500));
  return m ? Math.round(Number(m[1]) / 1e6) : null;    // nanoseconds → ms
}
/** Which heavy app is resident, or null. Returns the NAME so the reason can say it. */
function heavyAppRunning(apps = DEFAULTS.heavyApps) {
  for (const a of apps) if (sh(`pgrep -x ${JSON.stringify(a)}`).trim()) return a;
  return null;
}
function onACPower() { return /AC Power/i.test(sh('pmset -g ps')); }

module.exports = { createTiers, TIERS, RANK, KEEP_ALIVE, DEFAULTS, readIdleMs, heavyAppRunning, onACPower };
