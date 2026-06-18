'use strict';
// Anthropic client (plain fetch, no SDK) with tool-use support, backoff, and a real
// token→USD cost ledger written to SQLite. Mirrors the desktop's pricing/backoff so the
// cloud and Mac account costs the same way.
const db = require('./db');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL_SONNET = process.env.ANTHROPIC_MODEL_SONNET || 'claude-sonnet-4-6';
const MODEL_HAIKU = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODEL_PRICES = {                              // USD / 1M tokens: [input, output, cacheWrite, cacheRead]
  'claude-opus-4-8':   [15, 75, 18.75, 1.50],
  'claude-sonnet-4-6': [3, 15, 3.75, 0.30],
  'claude-haiku-4-5':  [1, 5, 1.25, 0.10],
};
function priceFor(model) {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const bare = (model || '').replace(/^claude-/, '');
  const k = Object.keys(MODEL_PRICES).find((m) => m.replace(/^claude-/, '') === bare || (model || '').includes(m.replace(/^claude-/, '')));
  return MODEL_PRICES[k] || MODEL_PRICES[MODEL_HAIKU];
}
function costOf(model, u) {
  if (!u) return 0;
  const [pin, pout, pcw, pcr] = priceFor(model);
  return ((u.input_tokens || 0) * pin + (u.output_tokens || 0) * pout
    + (u.cache_creation_input_tokens || 0) * pcw + (u.cache_read_input_tokens || 0) * pcr) / 1e6;
}

// One Claude call. `tools` optional. Returns the FULL message (content blocks + stop_reason)
// so the agent loop can act on tool_use. Records cost.
async function callClaude({ system, messages, tools, model = MODEL_HAIKU, maxTokens = 2048, retries = 4 }) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const body = { model, max_tokens: maxTokens, system, messages };
  if (tools && tools.length) body.tools = tools;
  let attempt = 0;
  while (true) {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      });
    } catch (e) { if (attempt++ >= retries) throw e; await sleep(Math.min(800 * 2 ** attempt, 8000)); continue; }
    if (r.status === 429 || r.status === 529 || r.status >= 500) {
      if (attempt++ >= retries) throw new Error('anthropic ' + r.status);
      const ra = parseFloat(r.headers.get('retry-after'));
      await sleep(isFinite(ra) ? Math.min(ra * 1000, 20000) : Math.min(1000 * 2 ** attempt, 12000));
      continue;
    }
    if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    try { db.recordCost(model, costOf(model, j.usage || {})); } catch {}
    return j;
  }
}

module.exports = { callClaude, MODEL_SONNET, MODEL_HAIKU };
