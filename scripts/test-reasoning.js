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
  // Narrowed from "no betas at all": context editing is now on by default for every model that
  // supports it, so Sonnet legitimately carries the context-management beta here. The thing this
  // assertion was actually protecting is that a model WITHOUT task-budget support never sends the
  // TASK-BUDGET beta — claiming a capability the model does not have is the 400 we care about.
  ok(!sn.betas.includes(r.BETA_TASK_BUDGET), 'and no stray TASK-BUDGET beta for a model that has no task-budget surface');
}

// --- compaction is opt-in, and no longer the ONLY context tool ------------------------------
// Rewritten when clear_tool_uses/clear_thinking were added. These used to assert that
// context_management was absent unless compaction was requested; context editing is now on by
// default for every model that supports it, because it is the cheap half — no model round-trip and
// no lossy rewrite. Compaction itself stays opt-in, which is what these still pin.
{
  const s = r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, { compact: true });
  const types = s.body.context_management.edits.map((e) => e.type);
  ok(types.includes('compact_20260112'), 'compaction edit emitted when asked for');
  ok(types[types.length - 1] === 'compact_20260112', 'and comes LAST — the cheap clears get first crack at the context');
  ok(s.betas.includes(r.BETA_COMPACT), 'compaction carries its beta header');

  const dflt = r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, {});
  ok(!dflt.body.context_management.edits.some((e) => e.type === 'compact_20260112'),
    'compaction is OFF by default — it costs a model round-trip and rewrites context lossily');
  ok(!dflt.betas.includes(r.BETA_COMPACT), 'and its beta is not sent when it is not used');

  // A caller can still opt out of the whole surface (one-off judges, prewarms).
  const none = r.shapeRequest({ model: 'claude-opus-4-8', max_tokens: 8000 }, { clearToolUses: false, clearThinking: false });
  ok(!none.body.context_management, 'the entire context surface can be declined');

  ok(!r.shapeRequest({ model: 'claude-haiku-4-5', max_tokens: 8000 }, { compact: true }).body.context_management,
    'skipped entirely on a model that lacks context management — an unsupported field is a 400');
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


// ── every ROUTED model must be in the capability matrix ───────────────────────────────────────
// shapeRequest() bails out entirely for an unknown id — no thinking, no effort, no compaction, no
// task budget — and does it silently, because bailing out is also the correct behaviour for a model
// we genuinely do not know. So pointing the router at a new model without adding it here turns the
// whole agentic surface off with no error anywhere. That is exactly what moving to Opus 5 would
// have done. This reads the router's own constants out of main.js so it cannot drift from them.
{
  const fs = require('fs'), path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const routed = [...main.matchAll(/^const MODEL_(SONNET|OPUS|FABLE) = '([^']+)'/gm)].map((m) => [m[1], m[2]]);
  ok(routed.length >= 3, 'found the router model constants in main.js');
  for (const [name, id] of routed) {
    ok(r.CAPS[id], `MODEL_${name} (${id}) is in the capability matrix — otherwise its agentic surface is silently off`);
  }
  // And the shaping must actually engage for each of them.
  for (const [name, id] of routed) {
    const { body } = r.shapeRequest({ model: id, max_tokens: 8000, messages: [] }, { depth: 'deep' });
    const shaped = !!(body.thinking || (body.output_config && body.output_config.effort));
    ok(shaped, `MODEL_${name} (${id}) actually gets shaped (thinking and/or effort present)`);
  }
  // Sonnet 5 gained xhigh over Sonnet 4.6 — verified against GET /v1/models on 2026-08-21.
  ok(r.CAPS['claude-sonnet-5'].effort.includes('xhigh'), 'Sonnet 5 supports xhigh');
  ok(!r.CAPS['claude-sonnet-4-6'].effort.includes('xhigh'), 'Sonnet 4.6 still does NOT — the clamp is still needed for it');
  ok(r.CAPS['claude-opus-5'].effort.includes('xhigh') && r.CAPS['claude-opus-5'].compact, 'Opus 5 has the full effort ladder + compaction');
}
// ── context editing: three tools exist, we used to send one ───────────────────────────────────
// Verified against /v1/messages/count_tokens on 2026-08-22: a realistic 6-tool-call read loop went
// from 240,770 to 120,809 input tokens — a 50% cut, with no summarization round-trip and without
// touching the transcript the human reads.
{
  const cm = (opts) => (r.shapeRequest({ model: 'claude-opus-5', max_tokens: 8000, messages: [] }, opts).body.context_management || {}).edits || [];
  const types = (opts) => cm(opts).map((e) => e.type);

  ok(types({}).includes('clear_tool_uses_20250919'), 'tool-result clearing is ON by default — it is the cheap one, and this agent is tool-heavy');
  ok(types({}).includes('clear_thinking_20251015'), 'thinking clearing is on too, now that adaptive thinking is always enabled');
  ok(!types({}).includes('compact_20260112'), 'compaction stays OPT-IN — it costs a model round-trip and rewrites context lossily');
  ok(types({ compact: true }).includes('compact_20260112'), 'and is added when the caller asks');

  // API requirement, and a silent 400 if violated.
  const both = types({ compact: true });
  ok(both.indexOf('clear_thinking_20251015') < both.indexOf('clear_tool_uses_20250919'), 'clear_thinking is listed FIRST, as the API requires');

  const ct = cm({}).find((e) => e.type === 'clear_tool_uses_20250919');
  ok(ct.trigger.value >= 20000, 'the trigger is high enough that short conversations are untouched');
  ok(ct.keep.value >= 3, 'recent tool results are kept — the model still sees what it just did');
  ok(ct.clear_at_least.value > 0, 'clear_at_least is set, so a clear is worth the cache invalidation it costs');
  for (const t of ['save_memory', 'ask_options']) {
    ok(ct.exclude_tools.includes(t), `${t} is excluded — clearing it would erase the ANSWER, not save context`);
  }

  // The beta header is the part that fails silently when wrong. Confirmed live: sending only
  // compact-2026-01-12 with a clear_* edit returns 400 "Input tag 'clear_thinking_20251015' ...
  // does not match any of the expected tags".
  const betas = r.shapeRequest({ model: 'claude-opus-5', max_tokens: 8000, messages: [] }, {}).betas;
  ok(betas.includes('context-management-2025-06-27'), 'context editing sends ITS OWN beta, not the compaction one');
  ok(!betas.includes('compact-2026-01-12'), 'and does not send the compaction beta unless compaction was asked for');
  ok(r.shapeRequest({ model: 'claude-opus-5', max_tokens: 8000, messages: [] }, { compact: true }).betas.includes('compact-2026-01-12'), 'compaction adds its beta when enabled');

  ok(cm({ clearToolUses: false, clearThinking: false, compact: false }).length === 0, 'a one-off judge call can opt out of the whole surface');
  ok((r.shapeRequest({ model: 'claude-haiku-4-5', max_tokens: 8000, messages: [] }, {}).body.context_management) === undefined,
    'a model without context_management support gets none of it — an unsupported field here is a 400');

  // And the response must be READ BACK, or none of this is observable.
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  ok(/applied_edits/.test(main), 'main.js reads applied_edits from the response');
  ok(/\[context\]/.test(main), 'and logs what was actually freed — a feature you cannot observe is one you cannot trust');
}

console.log(`✅ reasoning: ${pass} assertions passed`);
