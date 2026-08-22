'use strict';
// lib/reasoning.js — the REQUEST-SHAPING layer for the modern Claude agentic surface.
//
// Until now every BhatBot call to /v1/messages sent { model, max_tokens, system, tools, messages }
// and nothing else. That left four capabilities completely unused, including on Opus 4.8 — which is
// an adaptive-thinking-only model, so we were paying the deepest-reasoning tier and never letting it
// reason:
//
//   • adaptive thinking     — Claude decides when/how deep to think, and interleaves thinking
//                             BETWEEN tool calls. This is the single biggest agentic-quality lever
//                             and it costs nothing to ask for.
//   • output_config.effort  — the intelligence ↔ latency ↔ cost dial. We already classify every turn
//                             into a depth tier (lib/depth.js); that classification now drives effort
//                             instead of only sizing max_tokens.
//   • compaction            — server-side summarization of old context. Replaces the LOSSY hand-rolled
//                             capTokens() head-trim for long runs: capTokens throws the oldest turns
//                             in the bin, compaction folds them into a summary the model keeps using.
//                             This is the endurance fix (an 8-hour run stops amnesia-ing its own start).
//   • task_budget           — the fleet already has a wallet (fleet.js envelopeUsd) but it was purely
//                             supervisor-side: the model could not see it, so it could not pace itself
//                             and just got reaped mid-thought. task_budget shows the model a running
//                             countdown so it prioritizes and lands the plane.
//
// DESIGN — a pure capability matrix + one shaping function, applied at the two wire chokepoints
// (anthropicRequest / anthropicStream in main.js). Pure and DI-free so it unit-tests headless, and
// FAIL-OPEN by construction: an unknown model gets an unshaped body (exactly today's behaviour)
// rather than a 400. That matters because sending an unsupported field here is a hard error, not a
// soft degrade — Opus 4.8 rejects budget_tokens/temperature, Sonnet 4.6 rejects effort:'xhigh',
// Haiku 4.5 rejects effort entirely.

// Per-model capabilities. Deliberately keyed on EXACT ids (no prefix matching) — a wrong guess here
// is a 400 on every request, so an id we don't know about must fall through to "shape nothing".
//   thinking : 'adaptive' → send { type:'adaptive' }; 'always-on' → send NOTHING (Fable 5 rejects an
//              explicit {type:'disabled'} and has thinking permanently on); null → model has no
//              thinking surface at all.
//   effort   : the levels this model actually accepts. Sonnet 4.6 supports max but NOT xhigh;
//              Sonnet 5 DOES support xhigh; Haiku 4.5 errors on the parameter itself.
//
// Verified against GET /v1/models/{id} on 2026-08-21 — the `capabilities` object reports effort
// levels and context_management support per model, so these are read values, not inferences.
// A MODEL MISSING FROM THIS MAP IS NOT A NO-OP: shapeRequest() bails out entirely for an unknown id,
// which silently disables thinking, effort, compaction and task budgets for every request on that
// model. Adding a model to the router without adding it here turns the whole agentic surface off
// without a single error — scripts/test-reasoning.js now asserts the routed models are present.
const CAPS = {
  'claude-opus-5':     { thinking: 'adaptive',  effort: ['low', 'medium', 'high', 'xhigh', 'max'], compact: true,  taskBudget: true,  midSystem: true },
  'claude-sonnet-5':   { thinking: 'adaptive',  effort: ['low', 'medium', 'high', 'xhigh', 'max'], compact: true,  taskBudget: false, midSystem: false },
  'claude-opus-4-8':   { thinking: 'adaptive',  effort: ['low', 'medium', 'high', 'xhigh', 'max'], compact: true,  taskBudget: true,  midSystem: true },
  'claude-opus-4-7':   { thinking: 'adaptive',  effort: ['low', 'medium', 'high', 'xhigh', 'max'], compact: true,  taskBudget: true,  midSystem: true },
  'claude-opus-4-6':   { thinking: 'adaptive',  effort: ['low', 'medium', 'high', 'max'],          compact: true,  taskBudget: false, midSystem: false },
  'claude-fable-5':    { thinking: 'always-on', effort: ['low', 'medium', 'high', 'xhigh', 'max'], compact: true,  taskBudget: true,  midSystem: false },
  'claude-sonnet-4-6': { thinking: 'adaptive',  effort: ['low', 'medium', 'high', 'max'],          compact: true,  taskBudget: false, midSystem: false },
  'claude-haiku-4-5':  { thinking: null,        effort: null,                                     compact: false, taskBudget: false, midSystem: false },
};

const BETA_COMPACT = 'compact-2026-01-12';
// Context editing (clear_tool_uses / clear_thinking) ships under its own beta, NOT the compaction
// one. Sending only `compact-2026-01-12` alongside a clear_* edit is how you get a silent no-op.
const BETA_CONTEXT = 'context-management-2025-06-27';
// Tools whose RESULT is the payload rather than a step toward one. Clearing these would not save
// context, it would erase the answer: a dropped save_memory result reads as "I never saved it", and
// a dropped ask_options result loses what the user actually chose.
const EXCLUDE_FROM_CLEARING = ['save_memory', 'ask_options', 'ask_form', 'self_reflect', 'request_permissions'];
const BETA_TASK_BUDGET = 'task-budgets-2026-03-13';
const TASK_BUDGET_MIN = 20000;          // API floor — a smaller total is rejected

// Depth tier (lib/depth.js) → effort. The tiers already encode "how much answer does this deserve";
// effort is the same question asked about REASONING, so reusing the classification keeps one source
// of truth instead of inventing a second heuristic that can drift out of sync with max_tokens sizing.
//
// 'deep' maps to xhigh rather than max on purpose: Anthropic's guidance is that xhigh is the sweet
// spot for coding/agentic work and that max shows diminishing returns and is prone to overthinking.
// max is reserved for the explicit heavy tier below.
const DEPTH_EFFORT = { ack: 'low', conversational: 'medium', detailed: 'high', deep: 'xhigh' };

/** Resolve a requested effort level to the best one this model actually accepts. */
function clampEffort(model, want) {
  const caps = CAPS[model];
  if (!caps || !caps.effort || !want) return null;
  if (caps.effort.includes(want)) return want;
  // Degrade along the real ladder rather than dropping the parameter — a Sonnet call that asked for
  // 'xhigh' should still get 'high', not silently fall back to the API default.
  const LADDER = ['max', 'xhigh', 'high', 'medium', 'low'];
  const from = LADDER.indexOf(want);
  if (from < 0) return null;
  for (let i = from; i < LADDER.length; i++) if (caps.effort.includes(LADDER[i])) return LADDER[i];
  return null;
}

/**
 * Shape an outbound /v1/messages body for the modern agentic surface.
 *
 * @param body  the request body as built today (never mutated)
 * @param opts  {
 *   depth       — lib/depth.js tier ('ack'|'conversational'|'detailed'|'deep')
 *   effort      — explicit override, wins over depth
 *   heavy       — true for sims / heavy coding: pins effort to the model's ceiling
 *   subagent    — true for drones/fleet workers: pins effort low (Anthropic's own guidance for
 *                 subagents) so a wide fleet stays affordable
 *   compact     — enable server-side compaction (long-running tool loops only)
 *   taskBudget  — total token budget for a whole agentic loop, in tokens
 *   showThinking— surface summarized reasoning (default true; BhatBot streams a thinking indicator,
 *                 and the API default of 'omitted' would render that as a long silent pause)
 * }
 * @returns { body, betas } — betas is the list for the anthropic-beta header ([] when none).
 */
function shapeRequest(body, opts = {}) {
  const out = { ...body };
  const betas = [];
  const caps = CAPS[body && body.model];
  // Unknown model, or a degenerate call (cache keep-alive pings use max_tokens:1, and max_tokens:0
  // prewarm explicitly REJECTS a thinking config) → hand back the body untouched.
  if (!caps || !(body.max_tokens > 4)) return { body: out, betas };

  // ---- thinking ------------------------------------------------------------
  // Only set it if the caller didn't already; an explicit thinking config from a specialised call
  // site (e.g. a structured-output judge that wants it off) must win.
  if (caps.thinking === 'adaptive' && out.thinking === undefined) {
    out.thinking = opts.showThinking === false
      ? { type: 'adaptive' }
      : { type: 'adaptive', display: 'summarized' };
  }
  // caps.thinking === 'always-on' (Fable 5): send nothing. It thinks regardless, and any explicit
  // config other than 'adaptive' is a 400.

  // ---- effort --------------------------------------------------------------
  let want = opts.effort || null;
  if (!want && opts.subagent) want = 'low';
  if (!want && opts.heavy) want = 'max';
  if (!want && opts.depth) want = DEPTH_EFFORT[opts.depth] || null;
  const effort = clampEffort(body.model, want);

  // ---- task budget ---------------------------------------------------------
  const tb = (caps.taskBudget && opts.taskBudget > 0)
    ? { type: 'tokens', total: Math.max(TASK_BUDGET_MIN, Math.round(opts.taskBudget)) }
    : null;
  if (tb) betas.push(BETA_TASK_BUDGET);

  if (effort || tb) {
    out.output_config = { ...(out.output_config || {}) };
    if (effort) out.output_config.effort = effort;
    if (tb) out.output_config.task_budget = tb;
  }

  // ---- context management --------------------------------------------------
  // THREE tools exist; this used to send one. GET /v1/models/{id} reports
  // clear_tool_uses_20250919, clear_thinking_20251015 and compact_20260112 on Opus 5 / Sonnet 5,
  // and only compaction was wired — the most expensive of the three, gated behind a 60K-token
  // estimate, so in practice almost nothing happened.
  //
  // TOOL-RESULT CLEARING IS THE CHEAP ONE, and it is the one that fits this agent. BhatBot is
  // tool-heavy by design: read_file returns up to 90KB, run_shell and browser return unbounded
  // text, and every byte of it sits in history until something removes it. Compaction removes it by
  // SUMMARIZING the whole conversation — a model round-trip, a full cache invalidation, and a lossy
  // rewrite of context the user can still see on screen. Clearing old tool RESULTS costs nothing:
  // no round-trip, and the transcript the human reads is untouched. Anthropic calls it the safest,
  // lightest-touch form of compaction, and for an agent whose context is mostly tool output it is
  // strictly the first thing to reach for.
  //
  // ORDER MATTERS: clear_thinking must precede clear_tool_uses in the edits array (API requirement).
  if (caps.compact && !out.context_management) {
    const edits = [];

    // Thinking blocks accumulate now that adaptive thinking is on across the fleet. Cache
    // asymmetry is why `keep` is generous rather than aggressive: KEEPING thinking preserves the
    // prompt cache, CLEARING it invalidates the prefix. Trimming thinking to save tokens can
    // therefore cost more than it saves on a cache-warm conversation, so we only trim deep history.
    if (opts.clearThinking !== false) {
      edits.push({ type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 3 } });
    }

    // Tool results: on by default for anything with a tool loop.
    if (opts.clearToolUses !== false) {
      edits.push({
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'input_tokens', value: opts.clearTrigger || 40000 },
        keep: { type: 'tool_uses', value: 3 },
        // Clearing a little invalidates the cache prefix for very little gain; this makes each
        // clear worth the cache write it costs.
        clear_at_least: { type: 'input_tokens', value: 5000 },
        // Tools whose RESULT is the point, not a means. A cleared save_memory result would make the
        // agent think it never saved; a cleared ask_options would lose the answer the user gave.
        exclude_tools: EXCLUDE_FROM_CLEARING,
      });
    }

    // Compaction stays opt-in and last: it is the heavy hammer, for conversations that are long
    // even after the cheap clearing above.
    if (opts.compact) edits.push({ type: 'compact_20260112' });

    if (edits.length) {
      out.context_management = { edits };
      betas.push(BETA_CONTEXT);
      if (opts.compact) betas.push(BETA_COMPACT);
    }
  }

  return { body: out, betas };
}

/** True when this model can take a mid-conversation {role:'system'} message (Opus 4.7+). */
function supportsMidSystem(model) { return !!(CAPS[model] && CAPS[model].midSystem); }

/** Does this model expose a thinking surface at all? (used to decide whether to render reasoning) */
function thinksOutLoud(model) { return !!(CAPS[model] && CAPS[model].thinking); }

module.exports = {
  shapeRequest, clampEffort, supportsMidSystem, thinksOutLoud,
  CAPS, DEPTH_EFFORT, TASK_BUDGET_MIN, BETA_COMPACT, BETA_CONTEXT, BETA_TASK_BUDGET, EXCLUDE_FROM_CLEARING,
};
