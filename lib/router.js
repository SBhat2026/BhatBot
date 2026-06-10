'use strict';
// Local-first model router (Phase 5 routing; stub usable from Phase 3). Picks the cheapest
// model that can plausibly do the task, escalates on failure/complexity, falls back when a
// provider is down, and enforces the monthly $ cap (cost governor). Wraps existing
// main.js callables via injected adapters so we don't re-implement HTTP. See §5.

const DEFAULT_MODELS = {
  local_simple: 'qwen3:latest',          // installed; fast general/planning
  local_code: 'qwen2.5-coder:7b',         // installed; coding first-pass
  local_vision: 'gemma3:12b',             // installed; vision-capable for dev-loop inspect
  claude_code: 'claude-sonnet-4-6',
  claude_hard: 'claude-opus-4-8',
  claude_cheap: 'claude-haiku-4-5-20251001',
};

// task class → ordered escalation chain of {provider, modelKey}
const CHAINS = {
  simple:   [['ollama', 'local_simple'], ['anthropic', 'claude_cheap']],
  memory:   [['ollama', 'local_simple']],
  browser:  [['ollama', 'local_simple'], ['anthropic', 'claude_cheap']],
  research: [['ollama', 'local_simple'], ['anthropic', 'claude_code']],
  coding:   [['ollama', 'local_code'], ['anthropic', 'claude_code'], ['anthropic', 'claude_hard']],
  planning: [['ollama', 'local_simple'], ['anthropic', 'claude_code']],
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

  // Provider availability fallback
  const ollamaUp = adapters.ollamaUp ? await adapters.ollamaUp().catch(() => false) : true;
  let idx = Math.min(attempt, chain.length - 1);
  while (idx < chain.length) {
    const [provider, key] = chain[idx];
    if (provider === 'ollama' && !ollamaUp) { idx++; continue; }
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

// Anthropic $ estimate (sonnet ~ $3/M in, $15/M out; haiku ~ $0.8/$4; opus ~ $15/$75).
const PRICES = { 'claude-sonnet-4-6': [3, 15], 'claude-opus-4-8': [15, 75], 'claude-haiku-4-5-20251001': [0.8, 4] };
function estimateUsd(model, inTok, outTok) {
  const p = PRICES[model]; if (!p) return 0;
  return +(((inTok / 1e6) * p[0] + (outTok / 1e6) * p[1]).toFixed(5));
}

module.exports = { DEFAULT_MODELS, CHAINS, pick, run, shouldEscalate, scoreComplexity, classOf, estimateUsd };
