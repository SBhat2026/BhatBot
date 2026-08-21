'use strict';
// MODEL PRICING (lib/pricing.js) — one table, and the parts that can drift are computed.
//
// Two hardcoded tables drifted in OPPOSITE directions before this existed: Opus billed at the
// retired 4.1 rate of $15/$75 when it costs $5/$25 (3× over), Fable at $5/$25 when it costs $10/$50
// (2× under). Because lib/agents/select.js used its copy to enforce the DAG agents' monthly cost
// CAP, the overstatement did not merely misreport — it starved the fan-out.
//
// Rates verified against platform.claude.com/docs/en/about-claude/pricing on 2026-08-21.
const assert = require('assert');
const p = require('../lib/pricing');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const near = (a, b, m) => ok(Math.abs(a - b) < 1e-6, `${m} (got ${a}, want ${b})`);

// ── the published rates ───────────────────────────────────────────────────────────────────────
{
  const want = {
    'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25],
    'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
    'claude-haiku-4-5': [1, 5], 'claude-fable-5': [10, 50],
  };
  for (const [id, [i, o]] of Object.entries(want)) {
    const b = p.base(id);
    ok(b.input === i && b.output === o, `${id} = $${i}/$${o}`);
    ok(b.exact, `${id} is priced exactly, not by family guess`);
  }
  ok(p.base('claude-sonnet-5').input < p.base('claude-sonnet-4-6').input,
    'Sonnet 5 is CHEAPER than Sonnet 4.6 — moving the workhorse tier forward saves money as well as being newer');
}

// ── cache tiers are DERIVED, so they cannot drift ─────────────────────────────────────────────
{
  const r = p.rates('claude-opus-5');
  near(r.cacheWrite, 5 * 1.25, 'Opus 5 5-minute cache write is 1.25x input');
  near(r.cacheRead, 5 * 0.1, 'Opus 5 cache read is 0.1x input');
  near(r.cacheWrite1h, 5 * 2, 'Opus 5 1-hour cache write is 2x input');
  const f = p.rates('claude-fable-5');
  near(f.cacheWrite, 12.5, 'Fable 5 cache write follows the same multiplier');
  near(f.cacheRead, 1.0, 'Fable 5 cache read follows the same multiplier');
  // The whole point: two thirds of the old table was arithmetic someone typed by hand.
  for (const id of p.known()) {
    const x = p.rates(id);
    near(x.cacheWrite, +(x.input * 1.25).toFixed(4), `${id}: cache write is computed`);
    near(x.cacheRead, +(x.input * 0.1).toFixed(4), `${id}: cache read is computed`);
  }
}

// ── an unknown model is NEVER free ────────────────────────────────────────────────────────────
{
  // Booking an unpriced model at $0 is the worst failure available: spend goes invisible and every
  // budget gate silently stops working. A future point release must cost something sane on day one.
  const future = p.base('claude-opus-6');
  ok(future.input === 5 && future.output === 25, 'an unseen Opus resolves to the Opus family rate, not $0');
  ok(future.family === true && future.exact === false, 'and reports that it was a family fallback, not a known price');
  ok(p.base('claude-sonnet-7').input === 2, 'an unseen Sonnet 5+ resolves to the Sonnet-5 rate');
  ok(p.base('claude-haiku-9').input === 1, 'an unseen Haiku resolves to the Haiku rate');
  ok(p.base('claude-haiku-4-5-20251001').exact, 'a date-suffixed id still resolves EXACTLY (this one used to price at zero)');
  ok(p.base('gpt-4o-mini').input === 0.15, 'cross-provider offload models are priced too');
  ok(p.base('llama-local').input === 0, 'a genuinely unknown non-Claude model is free, which is correct for a local model');
}

// ── config override wins, so a rate change needs no code edit ─────────────────────────────────
{
  p.setOverrides(() => ({ 'claude-opus-5': [4, 20] }));
  const b = p.base('claude-opus-5');
  ok(b.input === 4 && b.output === 20 && b.source === 'config', 'config.modelPrices overrides the table');
  near(p.rates('claude-opus-5').cacheWrite, 5, 'derived tiers follow the override');
  p.setOverrides(() => ({}));
  ok(p.base('claude-opus-5').input === 5, 'clearing the override restores the table');
}

// ── usd() bills the real Anthropic usage shape ────────────────────────────────────────────────
{
  // Worked example from the pricing docs: 50k in + 15k out on Opus 5 = $0.25 + $0.375.
  near(p.usd('claude-opus-5', { input_tokens: 50000, output_tokens: 15000 }), 0.625, 'the documented worked example matches');
  // …and with 40k of the input served from cache: $0.05 + $0.02 + $0.375.
  near(p.usd('claude-opus-5', { input_tokens: 10000, output_tokens: 15000, cache_read_input_tokens: 40000 }), 0.445,
    'cache reads are billed at 0.1x, matching the docs worked example');
  ok(p.usd('claude-opus-5', {}) === 0, 'no usage → no cost');
  ok(p.usd('claude-opus-5', { input_tokens: 1e6, output_tokens: 1e6 }) === 30, '1M in + 1M out on Opus 5 = $30');
  near(p.usd('claude-opus-5', { input_tokens: 1e6, output_tokens: 1e6 }, { batch: true }), 15, 'the Batch API halves it');
  near(p.usd('claude-opus-5', { input_tokens: 1e6, output_tokens: 0 }, { fast: true }), 10, 'fast mode bills the flat premium, not a multiplier');
  ok(p.usd('claude-sonnet-5', { tin: 1e6, tout: 1e6 }) === 12, 'the short usage spelling (tin/tout) works — the audit log uses it');
}

// ── the two former call sites agree, because there is only one table now ──────────────────────
{
  const select = require('../lib/agents/select');
  for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5']) {
    const b = p.base(id);
    assert.deepStrictEqual(select.PRICES[id], [b.input, b.output]);
    pass++;
  }
  ok(true, 'lib/agents/select.js prices through lib/pricing.js — the rival table is gone');
  near(select.estimateUsd('claude-opus-5', 1e6, 1e6), 30, 'and its estimateUsd agrees');
  // Every model its chains can select must have a price.
  for (const chain of Object.values(select.CHAINS)) {
    for (const [, key] of chain) {
      const id = select.DEFAULT_MODELS[key];
      if (!id || !/^claude-/.test(id)) continue;
      ok(p.base(id).input > 0, `${id} (a live chain rung) is priced`);
    }
  }
}

console.log(`✅ pricing: ${pass} assertions passed`);
