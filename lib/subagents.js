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

// VANGUARD codenames (Phase 1): shared roster — ORACLE=research, FORGE=coding, WARDEN=life-admin.
const AGENTS = {
  research: {
    codename: 'ORACLE',
    model: 'sonnet',
    tools: ['fetch_url', 'ask_ai', 'browser', 'open_in_browser', 'read_file', 'notion_search', 'notion_write', 'save_memory', 'math_reason', 'simulate'],
    persona: `You are BhatBot's RESEARCH sub-agent — a meticulous analyst for Siddhant (a computational-biology researcher). You dig into questions, cross-check sources, and synthesize. Prefer primary sources; cite what you used. Save durable findings with save_memory/notion_write so they persist. Be rigorous and concise.`,
  },
  coding: {
    codename: 'FORGE',
    model: 'sonnet',
    tools: ['read_file', 'write_file', 'edit_file', 'list_directory', 'run_shell', 'claude_code', 'ui_inspect', 'fetch_url', 'save_memory'],
    persona: `You are BhatBot's CODING sub-agent. You make the smallest correct change to satisfy the goal, verify by running/inspecting when possible, and report exactly what you changed. Touch only what's necessary. For large/interactive builds, delegate to claude_code. Never invent file paths — read first.`,
  },
  lifeadmin: {
    codename: 'WARDEN',
    model: 'haiku',
    tools: ['manage_schedule', 'notify_user', 'open_in_browser', 'notion_write', 'notion_search', 'media_control', 'system_control', 'save_memory'],
    persona: `You are BhatBot's LIFE-ADMIN sub-agent — Siddhant's scheduling/logistics assistant. You handle reminders, schedules, light errands, and keeping things organized. Be proactive but never destructive; confirm anything irreversible via notify_user. Keep him informed succinctly.`,
  },
};

function histPath(name) { return path.join(DIR, name + '.json'); }
function loadHist(name) { try { return JSON.parse(fs.readFileSync(histPath(name), 'utf8')); } catch { return []; } }
function saveHist(name, h) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(histPath(name), JSON.stringify(h.slice(-40), null, 2)); } catch {} }

function list() { return Object.entries(AGENTS).map(([name, a]) => ({ name, codename: a.codename || name.toUpperCase(), model: a.model, tools: a.tools, turns: loadHist(name).length })); }
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

  // LAND THE PLANE. Running out of steps mid-tool-loop used to end the run with whatever text
  // happened to exist — usually none, because an agent deep in a tool loop is emitting tool_use
  // blocks, not prose. The caller then got the literal string "(completed, no text output)" and a
  // success flag. Observed live: a backlog item ran 3m20s, cost $0.13, reported ok, and banked an
  // EMPTY finding into the knowledge graph. All of the work, none of the answer.
  //
  // So when the budget is exhausted with nothing written, make ONE more call with NO tools. Without
  // tools the model cannot continue working and must answer with what it has, which is exactly the
  // summary the caller asked for. One extra call is far cheaper than discarding the whole run.
  const exhausted = steps > maxSteps;
  if (!finalText && exhausted) {
    try {
      const resp = await deps.anthropicRequest({
        model, max_tokens: 2048, system,
        messages: hist.slice(-32).concat([{ role: 'user', content: 'You have run out of tool budget. Do not call any more tools. Summarize now: what you found, what you did, and what remains — grounded only in what you actually saw.' }]),
      }, deps.apiKey);
      finalText = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    } catch { /* the wrap-up is best-effort; the honest failure below is better than a fake success */ }
  }

  saveHist(name, hist);
  // A run that produced no text is a FAILURE, not a success with a placeholder string. Reporting it
  // as success is what let an empty node reach the graph and the daily counter tick for nothing.
  if (!finalText) {
    return { success: false, agent: name, error: exhausted ? `ran out of tool budget (${maxSteps} steps) without producing an answer` : 'produced no output', result: '', steps: steps - 1 };
  }
  return { success: true, agent: name, result: finalText, steps: steps - 1 };
}

module.exports = { AGENTS, list, history, reset, run, DIR };
