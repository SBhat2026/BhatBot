'use strict';
// lib/reasoning.js tests — the model-capability matrix that decides what modern agentic fields go on
// the wire. Every assertion here maps to a HARD API error if it regresses: sending effort to Haiku,
// 'xhigh' to Sonnet, an explicit thinking config to Fable 5, or a thinking block to a keep-alive
// max_tokens:1 ping are all 400s, not soft degrades. Pure module → runs headless, no app boot.
const assert = require('assert');
const r = require('../lib/reasoning');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// --- per-model thinking surface -------------------------------------------------------------
{
  const s = r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, { depth: 'deep' });
  ok(s.body.thinking.type === 'adaptive', 'opus 4.8 gets adaptive thinking');
  ok(s.body.thinking.display === 'summarized', 'reasoning is summarized (BhatBot streams a thinking line)');
  ok(s.body.output_config.effort === 'xhigh', 'deep tier → xhigh on a model that supports it');
}
{
  // Fable 5 has thinking permanently on and REJECTS an explicit config other than adaptive.
  const s = r.shapeRequest({ model: 'claude-fable-5', max_tokens: 8000 }, { depth: 'deep' });
  ok(s.body.thinking === undefined, 'fable 5 sends no thinking field at all');
  ok(s.body.output_config.effort === 'xhigh', 'fable 5 still takes effort');
}
{
  const s = r.shapeRequest({ model: 'claude-haiku-4-5', max_tokens: 8000 }, { depth: 'deep' });
  ok(s.body.thinking === undefined, 'haiku 4.5 has no thinking surface');
  ok(s.body.output_config === undefined, 'haiku 4.5 ERRORS on effort — the key must be absent');
}

// --- effort ladder degrades, never drops ----------------------------------------------------
{
  const s = r.shapeRequest({ model: 'claude-sonnet-4-6', max_tokens: 8000 }, { depth: 'deep' });
  ok(s.body.output_config.effort === 'high', 'sonnet 4.6 has no xhigh → degrades to high, not absent');
  ok(r.clampEffort('claude-sonnet-4-6', 'xhigh') === 'high', 'clampEffort walks the real ladder');
  ok(r.clampEffort('claude-haiku-4-5', 'high') === null, 'clampEffort returns null for a model with no effort');
}
{
  ok(r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, { depth: 'ack' }).body.output_config.effort === 'low',
    'ack tier → low (stop burning Opus reasoning on "yes")');
  ok(r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, { heavy: true }).body.output_config.effort === 'max',
    'heavy tier → max');
  ok(r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, { subagent: true }).body.output_config.effort === 'low',
    'subagents → low (a wide fleet at xhigh would dwarf the call that planned it)');
  ok(r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, { depth: 'deep', effort: 'medium' }).body.output_config.effort === 'medium',
    'explicit effort overrides the depth tier');
}

// --- task budgets ---------------------------------------------------------------------------
{
  const s = r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, { taskBudget: 98304 });
  ok(s.body.output_config.task_budget.total === 98304, 'task budget passes through');
  ok(s.betas.includes(r.BETA_TASK_BUDGET), 'task budget carries its beta header');
  ok(r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, { taskBudget: 5000 }).body.output_config.task_budget.total === r.TASK_BUDGET_MIN,
    'below-floor budget clamps to the 20k API minimum instead of 400ing');
  const sn = r.shapeRequest({ model: 'claude-sonnet-4-6', max_tokens: 8000 }, { taskBudget: 98304 });
  ok(!sn.body.output_config, 'sonnet has no task-budget surface → nothing emitted');
  ok(sn.betas.length === 0, 'and no stray beta header');
}

// --- compaction is opt-in -------------------------------------------------------------------
{
  const s = r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, { compact: true });
  ok(s.body.context_management.edits[0].type === 'compact_20260112', 'compaction edit emitted');
  ok(s.betas.includes(r.BETA_COMPACT), 'compaction carries its beta header');
  ok(!r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, {}).body.context_management,
    'compaction is OFF by default — a one-off judge call must not pay the beta surface');
  ok(!r.shapeRequest({ model: 'claude-haiku-4-5', max_tokens: 8000 }, { compact: true }).body.context_management,
    'compaction skipped on a model that lacks it');
}

// --- degenerate + unknown inputs must fail OPEN ----------------------------------------------
{
  // The cache keep-alive pings with max_tokens:1, and the prewarm path uses max_tokens:0 — which
  // explicitly rejects a thinking config. Shaping must leave both completely alone.
  const s = r.shapeRequest({ model: 'claude-sonnet-4-6', max_tokens: 1 }, { depth: 'deep', compact: true });
  ok(s.body.thinking === undefined && s.body.output_config === undefined, 'max_tokens:1 keep-alive untouched');
  ok(r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 0 }, { depth: 'deep' }).body.thinking === undefined,
    'max_tokens:0 prewarm untouched');
}
{
  const s = r.shapeRequest({ model: 'claude-does-not-exist-9', max_tokens: 8000 }, { depth: 'deep', compact: true, taskBudget: 1e6 });
  ok(Object.keys(s.body).length === 2, 'unknown model → body passes through completely unshaped');
  ok(s.betas.length === 0, 'unknown model → no beta headers');
}
{
  const orig = { model: 'claude-opus-4-8', max_tokens: 8000 };
  r.shapeRequest(orig, { depth: 'deep', compact: true });
  ok(orig.thinking === undefined && orig.output_config === undefined && orig.context_management === undefined,
    'shapeRequest is pure — the caller\'s body is never mutated');
}
{
  const s = r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000, thinking: { type: 'adaptive', display: 'omitted' } }, { depth: 'deep' });
  ok(s.body.thinking.display === 'omitted', 'an explicit caller thinking config wins over the default');
}

// --- capability probes ----------------------------------------------------------------------
{
  ok(r.supportsMidSystem('claude-opus-4-8') === true, 'opus 4.8 takes mid-conversation system messages');
  ok(r.supportsMidSystem('claude-sonnet-4-6') === false, 'sonnet 4.6 does not');
  ok(r.thinksOutLoud('claude-haiku-4-5') === false, 'haiku has no thinking surface');
  ok(r.thinksOutLoud('claude-fable-5') === true, 'fable 5 does (always on)');
}

console.log(`✅ reasoning: ${pass} assertions passed`);
