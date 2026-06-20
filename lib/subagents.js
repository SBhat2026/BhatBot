'use strict';
// Persistent specialized sub-agents (#20). Unlike the STATELESS per-task roles in
// lib/agents/roles (used by delegate_project for one-off project runs), these are LONG-LIVED:
// each keeps its own conversation/context across delegations and has a scoped tool allowlist, so
// the main loop can hand off recurring work to a specialist that remembers prior turns —
// "research", "coding", "lifeadmin" — and run several of them at once (real parallel multitasking).
//
// Pure logic + persistence here; main.js injects the heavy deps (the model call, executeTool, the
// tool schemas, the API key) so there's no circular require and main.js stays the integration point.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.bhatbot', 'subagents');

const AGENTS = {
  research: {
    model: 'sonnet',
    tools: ['fetch_url', 'ask_ai', 'browser', 'open_in_browser', 'read_file', 'notion_search', 'notion_write', 'save_memory', 'math_reason', 'simulate'],
    persona: `You are BhatBot's RESEARCH sub-agent — a meticulous analyst for Siddhant (a computational-biology researcher). You dig into questions, cross-check sources, and synthesize. Prefer primary sources; cite what you used. Save durable findings with save_memory/notion_write so they persist. Be rigorous and concise.`,
  },
  coding: {
    model: 'sonnet',
    tools: ['read_file', 'write_file', 'list_directory', 'run_shell', 'claude_code', 'ui_inspect', 'fetch_url', 'save_memory'],
    persona: `You are BhatBot's CODING sub-agent. You make the smallest correct change to satisfy the goal, verify by running/inspecting when possible, and report exactly what you changed. Touch only what's necessary. For large/interactive builds, delegate to claude_code. Never invent file paths — read first.`,
  },
  lifeadmin: {
    model: 'haiku',
    tools: ['manage_schedule', 'notify_user', 'open_in_browser', 'notion_write', 'notion_search', 'media_control', 'system_control', 'save_memory'],
    persona: `You are BhatBot's LIFE-ADMIN sub-agent — Siddhant's scheduling/logistics assistant. You handle reminders, schedules, light errands, and keeping things organized. Be proactive but never destructive; confirm anything irreversible via notify_user. Keep him informed succinctly.`,
  },
};

function histPath(name) { return path.join(DIR, name + '.json'); }
function loadHist(name) { try { return JSON.parse(fs.readFileSync(histPath(name), 'utf8')); } catch { return []; } }
function saveHist(name, h) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(histPath(name), JSON.stringify(h.slice(-40), null, 2)); } catch {} }

function list() { return Object.entries(AGENTS).map(([name, a]) => ({ name, model: a.model, tools: a.tools, turns: loadHist(name).length })); }
function history(name) { return loadHist(name); }
function reset(name) { try { if (fs.existsSync(histPath(name))) fs.unlinkSync(histPath(name)); } catch {} return { success: true, reset: name }; }

// deps: { anthropicRequest, executeTool, toolDefs (full TOOLS array), apiKey, models:{sonnet,haiku}, onStep? }
async function run(name, task, deps, opts = {}) {
  const a = AGENTS[name];
  if (!a) return { success: false, error: `unknown sub-agent "${name}". Available: ${Object.keys(AGENTS).join(', ')}` };
  if (!task) return { success: false, error: 'task required' };
  const tools = (deps.toolDefs || []).filter((t) => a.tools.includes(t.name));
  const model = a.model === 'haiku' ? deps.models.haiku : deps.models.sonnet;
  const system = `${a.persona}\n\nYou are a PERSISTENT specialized sub-agent and you RETAIN memory of earlier tasks in this same thread. Work autonomously to completion, then give a short, plain summary of what you did/found. You may ONLY use the tools provided.`;

  let hist = loadHist(name);
  hist.push({ role: 'user', content: task });
  const maxSteps = Math.max(1, Math.min(16, opts.maxSteps || 8));
  let steps = 0, finalText = '';
  try {
    while (steps++ < maxSteps) {
      const resp = await deps.anthropicRequest({ model, max_tokens: 4096, system, tools, messages: hist.slice(-32) }, deps.apiKey);
      const content = resp.content || [];
      hist.push({ role: 'assistant', content });
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) finalText = text;
      const tus = content.filter((b) => b.type === 'tool_use');
      if (!tus.length || resp.stop_reason === 'end_turn') break;
      const results = [];
      for (const tu of tus) {
        if (deps.onStep) try { deps.onStep(name, tu.name); } catch {}
        // Hard scope enforcement: refuse any tool outside the allowlist even if the model asks.
        const r = a.tools.includes(tu.name)
          ? await deps.executeTool(tu.name, tu.input)
          : { success: false, error: `tool "${tu.name}" is not permitted for the ${name} sub-agent` };
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(r).slice(0, 16 * 1024), is_error: r && r.success === false });
      }
      hist.push({ role: 'user', content: results });
    }
  } catch (e) {
    saveHist(name, hist);
    return { success: false, agent: name, error: String(e && e.message ? e.message : e), result: finalText };
  }
  saveHist(name, hist);
  return { success: true, agent: name, result: finalText || '(completed, no text output)', steps: steps - 1 };
}

module.exports = { AGENTS, list, history, reset, run, DIR };
