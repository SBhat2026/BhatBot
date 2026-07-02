'use strict';
// Adaptive utterance endpointing — decides when the user has actually FINISHED speaking. Two goals:
//   1. WAIT OUT thinking-pauses instead of cutting the user off. It LEARNS the user's personal pause
//      habits (the gaps they leave mid-sentence and recover from) and holds the mic open a safe margin
//      past their 90th-percentile mid-utterance pause — so a deliberate pause never sends early, but a
//      real end-of-turn still closes promptly.
//   2. COCKTAIL-PARTY gate: the "still talking" signal is keyed to the USER'S OWN voice (energy +,
//      when available, a speaker-ID match), so background chatter can neither hold the mic open nor
//      trip a false endpoint. shouldEnd() only cares whether the ENROLLED user is currently speaking.
//
// PURE + persistable (no audio, DOM, or fs) so the identical logic drives the desktop renderer and the
// phone VAD loop, and is unit-testable in node. Persist with toJSON() and restore via createEndpointer.
const DEFAULTS = {
  floorMs: 1200,     // never end sooner than this after the user's last speech (a genuine pause)
  ceilMs: 6000,      // never wait longer than this (avoid dead air on a true end-of-turn)
  defaultMs: 1800,   // used until we've learned enough of the user's pauses
  marginMs: 500,     // safety headroom added over the learned p90 pause
  sampleCap: 80,     // rolling window of learned mid-utterance pauses
  quantile: 0.9,     // wait past the 90th-percentile mid-utterance pause
  minLearn: 6,       // need this many samples before trusting the learned threshold
};

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
// Linear-interpolated percentile over an already-sorted ascending array.
function percentile(sorted, q) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function createEndpointer(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let pauses = Array.isArray(opts.pauses) ? opts.pauses.slice(-cfg.sampleCap) : [];

  // Observe a gap between two consecutive USER speech events. `resumed` = the user kept talking after
  // this gap → it was a mid-utterance thinking-pause we must learn to wait past. A gap that ENDED the
  // utterance is NOT learned (that's the thing we're trying to detect, not tolerate). Out-of-range
  // gaps (sub-blip jitter, or longer than we'd ever wait) are ignored so noise can't skew the model.
  function observePause(ms, resumed) {
    ms = Number(ms) || 0;
    if (resumed && ms >= 150 && ms <= cfg.ceilMs) {
      pauses.push(ms);
      while (pauses.length > cfg.sampleCap) pauses.shift();
    }
  }

  // Current end-of-utterance silence threshold (ms of USER-silence that means "done"). Adaptive once
  // we've learned enough; a clamped default before that.
  function threshold() {
    if (pauses.length < cfg.minLearn) return clamp(cfg.defaultMs, cfg.floorMs, cfg.ceilMs);
    const s = pauses.slice().sort((a, b) => a - b);
    return clamp(Math.round(percentile(s, cfg.quantile) + cfg.marginMs), cfg.floorMs, cfg.ceilMs);
  }

  // Decide whether to finalize the utterance.
  //   userSilentMs — ms since the ENROLLED USER last produced speech (energy/voiceid, NOT background).
  //   userSpeaking — the enrolled user is producing speech RIGHT NOW → never end.
  // Background-only voice keeps userSpeaking=false and does NOT advance userSilentMs (the caller feeds
  // user-attributed silence), so a noisy room neither holds the mic open nor ends the turn early.
  function shouldEnd({ userSilentMs = 0, userSpeaking = false } = {}) {
    if (userSpeaking) return false;
    return Number(userSilentMs) >= threshold();
  }

  function toJSON() { return { pauses: pauses.slice(), learned: pauses.length, threshold: threshold() }; }
  function stats() {
    const s = pauses.slice().sort((a, b) => a - b);
    return { count: pauses.length, threshold: threshold(),
      p50: Math.round(percentile(s, 0.5)), p90: Math.round(percentile(s, 0.9)),
      max: s.length ? s[s.length - 1] : 0, learned: pauses.length >= cfg.minLearn };
  }
  return { observePause, threshold, shouldEnd, toJSON, stats, cfg,
    get pauses() { return pauses.slice(); } };
}

module.exports = { createEndpointer, percentile, DEFAULTS };
