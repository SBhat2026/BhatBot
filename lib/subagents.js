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

// ⚠ LOAD-BEARING — see windowMessages() below. The store directory is INJECTABLE (deps.dir) so a
// test can never write into the live sub-agents' persistent memory. It used to be a module constant,
// and scripts/test-subagent-wrapup.js therefore appended its mock tool-loop into the REAL
// research.json and coding.json on every `npm run verify` — which is how they reached the 40-turn cap
// full of fixture messages and started failing for real. A test that corrupts production state is
// worse than no test.
function histPath(name, dir) { return path.join(dir || DIR, name + '.json'); }
function loadHist(name, dir) { try { return repairHistory(JSON.parse(fs.readFileSync(histPath(name, dir), 'utf8'))); } catch { return []; } }
function saveHist(name, h, dir) {
  try {
    fs.mkdirSync(dir || DIR, { recursive: true });
    // Trim to a VALID boundary, not to a raw count — see windowMessages().
    fs.writeFileSync(histPath(name, dir), JSON.stringify(windowMessages(h, HIST_CAP), null, 2));
  } catch {}
}

const HIST_CAP = 40;      // messages kept on disk
const SEND_CAP = 32;      // messages sent to the API

/**
 * ⚠ LOAD-BEARING — do not replace with a plain `slice(-n)`.
 *
 * Take the last ~`cap` messages, trimmed to a boundary the Messages API will actually accept.
 *
 * THE BUG THIS EXISTS TO PREVENT (observed live, and it took two specialists down permanently):
 * a tool loop spans TWO messages — an assistant turn carrying `tool_use` blocks, then a user turn
 * carrying the matching `tool_result` blocks. `hist.slice(-32)` counts messages, so it can land
 * between those two. The window then opens on a `tool_result` whose `tool_use` was cut away, and the
 * API rejects the whole request with a 400 in ~250ms.
 *
 * That is not a transient failure. `saveHist` writes the history straight back at the same length,
 * so the orphan is still there next time: every subsequent delegation to that sub-agent 400s
 * forever. Live, `research` and `coding` were both in this state (40 turns, window[0] a
 * `tool_result` whose id sat at index -33) while `lifeadmin` — 22 turns, no orphan — still worked.
 * The backlog worker read those instant failures as "attempted" and burned through its whole queue.
 *
 * Two rules, both necessary:
 *   • never OPEN on an orphaned tool_result — walk forward past any user turn whose tool_result
 *     blocks have no tool_use in the window;
 *   • never OPEN on an assistant turn — the API requires the first message to be from the user, and
 *     an assistant turn carrying tool_use would itself be orphaned from its results.
 */
function windowMessages(hist, cap) {
  const all = Array.isArray(hist) ? hist : [];
  // The head is validated even when the history is SHORTER than the cap. An under-cap history is not
  // automatically well-formed: a run that was interrupted (or a store edited by hand) can leave a
  // history whose first message is an assistant turn, which the API rejects just as hard as an
  // orphaned tool_result. Short-circuiting on length was hiding exactly that case.
  let start = Math.max(0, all.length - cap);
  const blocks = (m) => (Array.isArray(m && m.content) ? m.content : []);
  // Ids of tool_use blocks issued at or after `start` — the only ones whose results are answerable.
  const issued = () => {
    const s = new Set();
    for (let i = start; i < all.length; i++) {
      if (all[i] && all[i].role === 'assistant') for (const b of blocks(all[i])) if (b && b.type === 'tool_use' && b.id) s.add(b.id);
    }
    return s;
  };
  let ids = issued();
  while (start < all.length) {
    const m = all[start];
    const isAssistant = m && m.role === 'assistant';
    const orphaned = m && m.role === 'user' && blocks(m).some((b) => b && b.type === 'tool_result' && !ids.has(b.tool_use_id));
    if (!isAssistant && !orphaned) break;
    start++;
    ids = issued();
  }
  return all.slice(start);
}

/**
 * ⚠ LOAD-BEARING — repair a history that is already malformed, rather than only avoiding malforming
 * it. windowMessages fixes the BOUNDARY, which is the bug that slicing causes. This handles damage
 * from any other source: a run killed mid-tool-loop, a store edited by hand, or messages removed
 * from the middle. Both directions are 400s, so both are stripped:
 *   • a tool_result whose tool_use is absent  → "unexpected tool_result"
 *   • a tool_use whose tool_result is absent  → "tool_use ids were found without tool_result blocks"
 * A message left with no blocks at all is dropped. Runs on every load, so the store heals itself on
 * the next launch instead of needing reset() — which is the only alternative today, and throws away
 * every genuine turn along with the damage.
 */
function repairHistory(hist) {
  const all = Array.isArray(hist) ? hist : [];
  const useIds = new Set(), resultIds = new Set();
  for (const m of all) {
    if (!Array.isArray(m && m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool_use' && b.id) useIds.add(b.id);
      if (b && b.type === 'tool_result' && b.tool_use_id) resultIds.add(b.tool_use_id);
    }
  }
  const out = [];
  for (const m of all) {
    if (!m) continue;
    if (!Array.isArray(m.content)) { out.push(m); continue; }   // plain-text turn: nothing to pair
    const kept = m.content.filter((b) => {
      if (!b) return false;
      if (b.type === 'tool_result') return resultIds.has(b.tool_use_id) && useIds.has(b.tool_use_id);
      if (b.type === 'tool_use') return useIds.has(b.id) && resultIds.has(b.id);
      return true;
    });
    if (kept.length) out.push({ ...m, content: kept });
  }
  return out;
}

function list(dir) { return Object.entries(AGENTS).map(([name, a]) => ({ name, codename: a.codename || name.toUpperCase(), model: a.model, tools: a.tools, turns: loadHist(name, dir).length })); }
function history(name, dir) { return loadHist(name, dir); }
function reset(name, dir) { try { const p = histPath(name, dir); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} return { success: true, reset: name }; }

// deps: { anthropicRequest, executeTool, toolDefs (full TOOLS array), apiKey, models:{sonnet,haiku}, onStep? }
async function run(name, task, deps, opts = {}) {
  const a = AGENTS[name];
  if (!a) return { success: false, error: `unknown sub-agent "${name}". Available: ${Object.keys(AGENTS).join(', ')}` };
  if (!task) return { success: false, error: 'task required' };
  const tools = (deps.toolDefs || []).filter((t) => a.tools.includes(t.name));
  const model = a.model === 'haiku' ? deps.models.haiku : deps.models.sonnet;
  const system = `${a.persona}\n\nYou are a PERSISTENT specialized sub-agent and you RETAIN memory of earlier tasks in this same thread. Work autonomously to completion, then give a short, plain summary of what you did/found. You may ONLY use the tools provided.`;

  const dir = deps.dir || DIR;
  let hist = loadHist(name, dir);
  hist.push({ role: 'user', content: task });
  const maxSteps = Math.max(1, Math.min(16, opts.maxSteps || 8));
  let steps = 0, finalText = '';
  try {
    while (steps++ < maxSteps) {
      const resp = await deps.anthropicRequest({ model, max_tokens: 4096, system, tools, messages: windowMessages(hist, SEND_CAP) }, deps.apiKey);
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
    saveHist(name, hist, dir);
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
        messages: windowMessages(hist, SEND_CAP).concat([{ role: 'user', content: 'You have run out of tool budget. Do not call any more tools. Summarize now: what you found, what you did, and what remains — grounded only in what you actually saw.' }]),
      }, deps.apiKey);
      finalText = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    } catch { /* the wrap-up is best-effort; the honest failure below is better than a fake success */ }
  }

  saveHist(name, hist, dir);
  // A run that produced no text is a FAILURE, not a success with a placeholder string. Reporting it
  // as success is what let an empty node reach the graph and the daily counter tick for nothing.
  if (!finalText) {
    return { success: false, agent: name, error: exhausted ? `ran out of tool budget (${maxSteps} steps) without producing an answer` : 'produced no output', result: '', steps: steps - 1 };
  }
  return { success: true, agent: name, result: finalText, steps: steps - 1 };
}

module.exports = { AGENTS, list, history, reset, run, DIR, windowMessages, repairHistory, HIST_CAP, SEND_CAP };
