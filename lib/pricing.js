'use strict';
// ── MODEL PRICING — one table, and it maintains itself ───────────────────────────────────────────
//
// There used to be two hardcoded tables (main.js MODEL_PRICES, lib/agents/select.js PRICES) and they
// drifted in opposite directions: Opus was still on the retired Opus-4.1 rate of $15/$75 when Opus
// 4.8 bills $5/$25 (3× over), while Fable 5 sat at $5/$25 when it bills $10/$50 (2× under). That is
// not just a reporting error — select.js PRICES enforces the DAG agents' monthly cost CAP, so an
// overstated price starves the fan-out, and an understated one lets it overrun.
//
// Three things stop that recurring, none of which need a network call:
//
//   1. CACHE TIERS ARE DERIVED, NOT TYPED. Anthropic's multipliers are fixed and public:
//      5-minute cache write = 1.25× input, 1-hour write = 2× input, cache read = 0.1× input. So the
//      table only carries [input, output] and the other four numbers cannot drift by construction.
//      Two thirds of the old table's surface area was hand-copied numbers that are pure arithmetic.
//
//   2. FAMILY FALLBACK. An unknown model id resolves to its family's rate instead of $0. Point
//      releases within a tier have held their price for years (every Opus 4.5→5 is $5/$25; every
//      Sonnet 4.x is $3/$15), so `claude-opus-6` will be priced correctly on the day it ships
//      without an edit here. Booking an unpriced model at zero is the worst failure mode available:
//      spend becomes invisible and every budget gate silently stops working.
//
//   3. CONFIG OVERRIDE. `config.modelPrices = { "claude-opus-5": [4, 20] }` wins over everything,
//      so a price change can be corrected in seconds without a code edit or a release.
//
// Rates verified against platform.claude.com/docs/en/about-claude/pricing on 2026-08-21.

// [input, output] USD per 1M tokens. Everything else is computed.
const BASE = {
  'claude-fable-5':    [10, 50],
  'claude-mythos-5':   [10, 50],
  'claude-opus-5':     [5, 25],
  'claude-opus-4-8':   [5, 25],
  'claude-opus-4-7':   [5, 25],
  'claude-opus-4-6':   [5, 25],
  'claude-sonnet-5':   [2, 10],     // cheaper than Sonnet 4.6 — the introductory rate is now standard
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5':  [1, 5],
  // Cross-provider offload models (no cache tiers; the multipliers below are meaningless for them
  // but harmless, since the offload path only ever reports input/output).
  'gpt-4o-mini':       [0.15, 0.60],
  'gemini-2.0-flash':  [0.10, 0.40],
};

// Fixed, published multipliers on the BASE INPUT price.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;
// Fast mode (Opus 5 / Opus 4.8, research preview) is a flat premium, not a multiplier: $10/$50.
const FAST_MODE = { 'claude-opus-5': [10, 50], 'claude-opus-4-8': [10, 50] };
const BATCH_DISCOUNT = 0.5;

// Family patterns, most specific first. Used only when an exact id is unknown.
const FAMILIES = [
  ['Mythos',   /^claude-mythos/,        [10, 50]],
  ['Fable',    /^claude-fable/,         [10, 50]],
  ['Opus',     /^claude-opus/,          [5, 25]],
  ['Sonnet 5+', /^claude-sonnet-[5-9]/, [2, 10]],
  ['Sonnet',   /^claude-sonnet/,        [3, 15]],
  ['Haiku',    /^claude-haiku/,         [1, 5]],
];

let _warned = new Set();
let _overrides = () => ({});

/** Register a source of user overrides, e.g. () => loadConfig().modelPrices. */
function setOverrides(fn) { _overrides = typeof fn === 'function' ? fn : () => ({}); }

/**
 * base(model) → { input, output, exact, family } USD per 1M tokens.
 * Never returns zero for a Claude model: an unknown id falls back to its family rate and says so
 * once, so new releases are costed correctly rather than invisibly.
 */
function base(model) {
  const id = String(model || '').trim();
  let over;
  try { over = (_overrides() || {})[id]; } catch { over = null; }
  if (Array.isArray(over) && over.length >= 2) return { input: +over[0], output: +over[1], exact: true, source: 'config' };
  if (BASE[id]) return { input: BASE[id][0], output: BASE[id][1], exact: true, source: 'table' };
  // Strip a date suffix (`claude-haiku-4-5-20251001`) before giving up on an exact match.
  const undated = id.replace(/-\d{8}$/, '');
  if (BASE[undated]) return { input: BASE[undated][0], output: BASE[undated][1], exact: true, source: 'table' };
  for (const [label, re, [i, o]] of FAMILIES) {
    if (re.test(id)) {
      if (!_warned.has(id)) { _warned.add(id); try { console.warn(`[pricing] "${id}" is not in the table — billing it at the ${label} family rate $${i}/$${o} so its spend is never invisible. Set config.modelPrices["${id}"] = [in, out] if that is wrong.`); } catch {} }
      return { input: i, output: o, exact: false, family: true, source: 'family' };
    }
  }
  return { input: 0, output: 0, exact: false, source: 'unknown' };
}

/**
 * rates(model, {fast}) → every tier, derived. [input, output, cacheWrite5m, cacheRead, cacheWrite1h]
 * The 4-tuple prefix matches the shape main.js's MODEL_PRICES used, so callers are unchanged.
 */
function rates(model, { fast = false } = {}) {
  const b = base(model);
  const f = fast && FAST_MODE[model] ? { input: FAST_MODE[model][0], output: FAST_MODE[model][1] } : b;
  return {
    input: f.input,
    output: f.output,
    cacheWrite: +(f.input * CACHE_WRITE_5M).toFixed(4),
    cacheRead: +(f.input * CACHE_READ).toFixed(4),
    cacheWrite1h: +(f.input * CACHE_WRITE_1H).toFixed(4),
    exact: b.exact,
    source: b.source,
  };
}

/** The legacy [in, out, cacheWrite, cacheRead] tuple, for call sites that index positionally. */
function tuple(model, opts) { const r = rates(model, opts); return [r.input, r.output, r.cacheWrite, r.cacheRead]; }

/**
 * usd(model, usage) → cost in USD for one call.
 * `usage` accepts the Anthropic shape directly: { input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens } — and the short spellings.
 */
function usd(model, usage = {}, { fast = false, batch = false } = {}) {
  const r = rates(model, { fast });
  const inTok = Number(usage.input_tokens ?? usage.tin ?? usage.in ?? 0) || 0;
  const outTok = Number(usage.output_tokens ?? usage.tout ?? usage.out ?? 0) || 0;
  const cw = Number(usage.cache_creation_input_tokens ?? usage.cacheWrite ?? 0) || 0;
  const cr = Number(usage.cache_read_input_tokens ?? usage.cacheRead ?? 0) || 0;
  const total = (inTok / 1e6) * r.input + (outTok / 1e6) * r.output
    + (cw / 1e6) * r.cacheWrite + (cr / 1e6) * r.cacheRead;
  return +((batch ? total * BATCH_DISCOUNT : total)).toFixed(6);
}

/** Every id we price exactly — for tests and for a "what do you know" report. */
function known() { return Object.keys(BASE); }

module.exports = {
  base, rates, tuple, usd, known, setOverrides,
  BASE, FAMILIES, CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_READ, FAST_MODE, BATCH_DISCOUNT,
};
