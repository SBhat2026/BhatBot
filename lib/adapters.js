'use strict';
// Adapter bridge (Phase 3 wiring). Builds the `adapters` object the orchestrator/base/
// router need, from standalone implementations (direct fetch + config) so the multi-agent
// stack runs BOTH inside Electron (main.js passes its own fns) and from a plain CLI
// (scripts/orchestrate.js). Keeps the agent stack decoupled from main.js internals.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
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

// Ollama tool-calling → Anthropic-shaped content (mirrors main.js ollamaToolChat) so the
// CLI path can drive tools with local models for free.
async function ollamaTools(messages, system, tools, model) {
  const msgs = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((b) => b.type === 'text' ? b.text : b.type === 'tool_result' ? '[tool result] ' + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 6000) : b.type === 'tool_use' ? '[calling ' + b.name + ' ' + JSON.stringify(b.input) + ']' : '').filter(Boolean).join('\n') : '',
  })).filter((m) => m.content);
  if (system) msgs.unshift({ role: 'system', content: system });
  const otools = (tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const r = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: msgs, tools: otools, stream: false, options: { temperature: 0.3 } }) });
  if (!r.ok) throw new Error('ollama ' + r.status);
  const j = await r.json();
  const content = [];
  if (j.message && j.message.content) content.push({ type: 'text', text: j.message.content });
  for (const tc of (j.message && j.message.tool_calls) || []) {
    let input = tc.function && tc.function.arguments;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
    content.push({ type: 'tool_use', id: 'ot_' + crypto.randomBytes(4).toString('hex'), name: tc.function.name, input: input || {} });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  return { content: content.length ? content : [{ type: 'text', text: '' }], stop_reason: hasTools ? 'tool_use' : 'end_turn' };
}
async function anthropicTools(messages, system, tools, model) {
  const c = cfg();
  const key = process.env.ANTHROPIC_API_KEY || c.anthropicKey || c.apiKey;
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: 4096, system, tools, messages }) });
  if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

// Minimal real tool executor for the CLI path (subset of main.js executeTool). Honors the
// same HARD_BLOCKED floor; autonomous-mode auto-approves the rest.
const HARD_BLOCKED = [/rm\s+-rf\s+\/(?:\s|$)/, /:\(\)\{.*\}/, /mkfs\./, /dd\s+if=.*of=\/dev\/(sd|disk)/];
const CLI_TOOLS = [
  { name: 'read_file', description: 'Read a UTF-8 text file. Absolute paths. Large files: pass offset (1-based line) + limit (line count) to page through.', input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write a UTF-8 file, mkdir -p parent.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'list_directory', description: 'List directory entries.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_shell', description: 'Run a shell command (60s).', input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } },
];
function cliToolExec(name, input) {
  return new Promise((resolve) => {
    try {
      if (name === 'read_file') {
        const raw = fs.readFileSync(input.path, 'utf8');
        const CAP = 90 * 1024;
        if (input.offset != null || input.limit != null) {
          const lines = raw.split('\n'); const start = Math.max(1, Number(input.offset) || 1); const count = Math.max(1, Number(input.limit) || 400);
          return resolve({ success: true, content: lines.slice(start - 1, start - 1 + count).join('\n').slice(0, CAP), offset: start, total_lines: lines.length, truncated: start - 1 + count < lines.length });
        }
        if (raw.length > CAP) { const lines = raw.split('\n'); const head = raw.slice(0, CAP); return resolve({ success: true, content: head, offset: 1, total_lines: lines.length, truncated: true, note: `paged head; re-read with offset/limit to continue (${lines.length} lines total)` }); }
        return resolve({ success: true, content: raw });
      }
      if (name === 'write_file') { fs.mkdirSync(path.dirname(input.path), { recursive: true }); fs.writeFileSync(input.path, input.content); return resolve({ success: true, path: input.path }); }
      if (name === 'list_directory') return resolve({ success: true, entries: fs.readdirSync(input.path, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) });
      if (name === 'run_shell') {
        if (HARD_BLOCKED.some((re) => re.test(input.command))) return resolve({ success: false, error: 'Blocked: destructive command' });
        return exec(input.command, { cwd: input.cwd || os.homedir(), timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => resolve({ success: !err, stdout: so || '', stderr: se || '', exitCode: err ? err.code : 0 }));
      }
      resolve({ success: false, error: 'unknown tool ' + name });
    } catch (e) { resolve({ success: false, error: String(e && e.message || e) }); }
  });
}

// Build the adapters object for a given workspace dir.
function build(wsDir) {
  const c = cfg();
  const embedModel = (c.models && c.models.embed) || c.embedModel || 'nomic-embed-text';
  return {
    ollamaUp, ollamaChat, anthropic,
    anthropicTools, ollamaTools, toolExec: cliToolExec, toolDefs: CLI_TOOLS,
    onEvent: (ev) => { if (ev.type === 'tool') console.log(`    ↳ ${ev.name}(${JSON.stringify(ev.input).slice(0, 80)})`); },
    memFn: (q, k) => memory.search(wsDir, q, k, { embedModel }),
    memWrite: (w) => memory.write(wsDir, w, { embedModel }),
    trellis: null, image: null, replicate: null,
  };
}

module.exports = { build, ollamaUp, ollamaChat, anthropic, ollamaTools, anthropicTools };
