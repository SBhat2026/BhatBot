'use strict';
// Adapter bridge (Phase 3 wiring). Builds the `adapters` object the orchestrator/base/
// router need, from standalone implementations (direct fetch + config) so the multi-agent
// stack runs BOTH inside Electron (main.js passes its own fns) and from a plain CLI
// (scripts/orchestrate.js). Keeps the agent stack decoupled from main.js internals.
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('./memory');

const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const CONFIG = path.join(os.homedir(), '.bhatbot', 'config.json');
function cfg() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } }

async function ollamaUp() { try { const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }

async function ollamaChat(messages, system, model) {
  const msgs = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
  if (system) msgs.unshift({ role: 'system', content: system });
  const r = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: msgs, stream: false, options: { temperature: 0.4 } }) });
  if (!r.ok) throw new Error('ollama ' + r.status);
  const j = await r.json();
  return (j.message && j.message.content) || '';
}

async function anthropic(messages, system, model) {
  const c = cfg();
  const key = process.env.ANTHROPIC_API_KEY || c.anthropicKey || c.apiKey;
  if (!key) throw new Error('no anthropic key');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 2048, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages }),
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// Build the adapters object for a given workspace dir.
function build(wsDir) {
  const c = cfg();
  const embedModel = (c.models && c.models.embed) || c.embedModel || 'nomic-embed-text';
  return {
    ollamaUp, ollamaChat, anthropic,
    memFn: (q, k) => memory.search(wsDir, q, k, { embedModel }),
    memWrite: (w) => memory.write(wsDir, w, { embedModel }),
    // creative/3d/image adapters are attached lazily by their integrations when configured
    trellis: null, image: null, replicate: null,
  };
}

module.exports = { build, ollamaUp, ollamaChat, anthropic };
