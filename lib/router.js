'use strict';
// ⚠️ DEPRECATED (Phase 1, 2026-06-26) — NOT used by live routing. The single live routing path is
// main.js: chooseModel (regex + telemetry nudge from router.jsonl + OTPM-aware model choice) and the
// callModel preflight (per-model ITPM/OTPM budgeting + the OpenAI/Gemini/Ollama offload rungs, which
// were ported OUT of this file into the live path). This module is retained ONLY because the offline
// eval/perf harnesses (scripts/perf-eval.js, scripts/test-pass39.js) still import classOf /
// shouldEscalate / pick for deterministic tests. Do not wire it back into the live agent path; once
// those scripts migrate, delete this file. See PHASE1_NOTES.md.
//
// Local-first model router (Phase 5 routing; stub usable from Phase 3). Picks the cheapest
// model that can plausibly do the task, escalates on failure/complexity, falls back when a
// provider is down, and enforces the monthly $ cap (cost governor). Wraps existing
// main.js callables via injected adapters so we don't re-implement HTTP. See §5.

const DEFAULT_MODELS = {
  local_simple: 'qwen3:latest',          // installed; fast general/planning; TOOL-CAPABLE
  local_code: 'qwen3:latest',            // qwen2.5-coder:7b can't emit ollama tool_calls →
                                          // use qwen3 (tool-capable) for autonomous coding
  local_vision: 'gemma3:12b',             // installed; vision for dev-loop inspect (no tools)
  claude_code: 'claude-sonnet-4-6',
  claude_hard: 'claude-opus-4-8',
  claude_cheap: 'claude-haiku-4-5-20251001',
  openai_cheap: 'gpt-4o-mini',            // cross-provider offload (text-only path, no tools)
  gemini_fast: 'gemini-2.0-flash',        // cross-provider offload (text-only path, no tools)
};

// task class → ordered escalation chain of {provider, modelKey}.
// OpenAI/Gemini rungs offload mid-tier TEXT work from the Anthropic per-minute token cap
// (3 parallel agents triple the pressure); tool-loop work stays anthropic/ollama because
// only those have tool-capable callers (base.js falls back to plain text for the others).
const CHAINS = {
  simple:   [['ollama', 'local_simple'], ['openai', 'openai_cheap'], ['anthropic', 'claude_cheap']],
  memory:   [['ollama', 'local_simple'], ['openai', 'openai_cheap']],
  browser:  [['ollama', 'local_simple'], ['anthropic', 'claude_cheap']],
  // openai before gemini: tested 2026-06-12 — openai key live (~2s), gemini prepaid credits
  // depleted (instant 429). Gemini rung self-revives if the key is topped up.
  research: [['ollama', 'local_simple'], ['openai', 'openai_cheap'], ['gemini', 'gemini_fast'], ['anthropic', 'claude_code']],
  coding:   [['ollama', 'local_code'], ['anthropic', 'claude_code'], ['anthropic', 'claude_hard']],
  planning: [['ollama', 'local_simple'], ['openai', 'openai_cheap'], ['gemini', 'gemini_fast'], ['anthropic', 'claude_code']],
  vision:   [['ollama', 'local_vision'], ['anthropic', 'claude_code']],
  image:    [['local_image', null], ['replicate', null]],
  '3d':     [['trellis', null]],
};

const CODE_HARD = /\b(refactor|architect|design|migrate|concurrency|race condition|rewrite|optimi[sz]e)\b/i;

function scoreComplexity(task) {
  let s = 0;
  const files = (task.context && task.context.files) || [];
  s += Math.min(files.length, 5) * 0.15;          // multi-file = harder
  s += Math.min((task.goal || '').length / 400, 1) * 0.3;
  if (CODE_HARD.test(task.goal || '')) s += 0.4;
  if ((task.context && task.context.components || []).length > 2) s += 0.2;
  return Math.min(s, 1);
}

function classOf(task) {
  if (task.class) return task.class;
  if (task.agent === 'coding') return 'coding';
  if (task.agent === 'memory') return 'memory';
  if (task.agent === 'browser') return 'browser';
  if (task.agent === 'research') return 'research';
  if (task.agent === 'orchestrator') return 'planning';
  if (task.agent === 'creative') return task.expects === 'artifact' ? '3d' : 'image';
  return 'simple';
}

// pick: returns {provider, model, modelKey, reason}. attempt index walks the chain.
async function pick(task, { config = {}, adapters = {}, attempt = 0 } = {}) {
  const models = { ...DEFAULT_MODELS, ...(config.models || {}) };
  const cls = classOf(task);
  let chain = CHAINS[cls] || CHAINS.simple;

  // Explicit override
  if (task.budget && task.budget.model && task.budget.model !== 'auto') {
    return { provider: 'anthropic', model: task.budget.model, modelKey: 'override', reason: 'explicit budget.model' };
  }
  if (/\[claude\]/i.test(task.goal || '')) attempt = Math.max(attempt, 1);

  // Cost governor: at >= cap%, force local-only unless [claude]-tagged
  const cap = (config.budget && config.budget.month_usd_cap) || 10;
  const at = (config.budget && config.budget.local_only_at_pct) || 0.8;
  const spent = (config.__metrics && config.__metrics.cost_month_usd) || 0;
  const localOnly = spent >= cap * at && !/\[claude\]/i.test(task.goal || '');
  if (localOnly) chain = chain.filter(([p]) => p !== 'anthropic') ;

  // Complexity can jump the starting attempt forward for coding/planning
  if ((cls === 'coding' || cls === 'planning') && scoreComplexity(task) >= 0.6) attempt = Math.max(attempt, 1);

  // Provider availability fallback (cross-provider rungs need their key configured)
  const ollamaUp = adapters.ollamaUp ? await adapters.ollamaUp().catch(() => false) : true;
  let idx = Math.min(attempt, chain.length - 1);
  while (idx < chain.length) {
    const [provider, key] = chain[idx];
    if (provider === 'ollama' && !ollamaUp) { idx++; continue; }
    if (provider === 'openai' && !(config.openaiKey && adapters.openaiChat)) { idx++; continue; }
    if (provider === 'gemini' && !(config.geminiKey && adapters.geminiChat)) { idx++; continue; }
    return { provider, model: key ? models[key] : null, modelKey: key, reason: `class=${cls} attempt=${attempt} idx=${idx}${localOnly ? ' local-only(budget)' : ''}` };
  }
  // Nothing local available → cheapest claude
  return { provider: 'anthropic', model: models.claude_cheap, modelKey: 'claude_cheap', reason: 'all-local-down fallback' };
}

// Unified call surface. adapters: {ollamaChat(messages,system,model), anthropic(messages,system,model), trellis(task), image(task)}
async function run(choice, { messages, system, task }, adapters = {}) {
  switch (choice.provider) {
    case 'ollama': return { text: await adapters.ollamaChat(messages, system, choice.model), model: choice.model, usd: 0 };
    case 'anthropic': return { text: await adapters.anthropic(messages, system, choice.model), model: choice.model, usd: null /* caller records via recordCost */ };
    case 'openai': return { text: await adapters.openaiChat(messages, system, choice.model), model: choice.model, usd: null };
    case 'gemini': return { text: await adapters.geminiChat(messages, system, choice.model), model: choice.model, usd: null };
    case 'trellis': return adapters.trellis ? adapters.trellis(task) : { error: 'trellis adapter missing' };
    case 'local_image': return adapters.image ? adapters.image(task) : { error: 'image adapter missing' };
    case 'replicate': return adapters.replicate ? adapters.replicate(task) : { error: 'replicate adapter missing' };
    default: return { error: 'unknown provider ' + choice.provider };
  }
}

// Escalate when any criterion fires (§5). Returns true → caller re-pick with attempt+1.
function shouldEscalate({ result, attempt, config = {} }) {
  const limit = config.local_retry_limit ?? 2;
  if (!result) return attempt < limit;
  if (result.status && result.status !== 'ok' && attempt < limit) return true;
  if (typeof result.confidence === 'number' && result.confidence < 0.55 && attempt < limit) return true;
  if (result.verifier_failed) return true;
  return false;
}

// $ estimate per provider model ([$/M in, $/M out]). Unknown models → 0.
const PRICES = { 'claude-sonnet-4-6': [3, 15], 'claude-opus-4-8': [15, 75], 'claude-haiku-4-5-20251001': [0.8, 4],
  'gpt-4o-mini': [0.15, 0.6], 'gemini-2.0-flash': [0.1, 0.4] };
function estimateUsd(model, inTok, outTok) {
  const p = PRICES[model]; if (!p) return 0;
  return +(((inTok / 1e6) * p[0] + (outTok / 1e6) * p[1]).toFixed(5));
}

module.exports = { DEFAULT_MODELS, CHAINS, pick, run, shouldEscalate, scoreComplexity, classOf, estimateUsd };
