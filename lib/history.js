'use strict';
// lib/history.js — SPLIT_PLAN step 9 (the safe, pure slice). The agent-turn loop's stateless
// helpers: conversation-history integrity repair, old-image eviction, and the idempotent-retry
// classifiers. All PURE (no main-scope closure, fs, or electron) → plain functions, unit-testable
// in node, and lifted out of main.js to shrink the agent-loop region without touching the
// dispatch/control-flow that genuinely needs a live boot to verify.

// History integrity guard. Agent histories must alternate user/assistant and keep every tool_use
// paired with a following tool_result. Corruptions (a stray user message that just echoes the
// assistant's own last reply → self-hallucination loops; an orphan tool_result with no preceding
// tool_use → API 400) are logged and healed in place so a session can't get wedged. Returns a clean copy.
function validateHistory(history) {
  if (!Array.isArray(history)) return [];
  const blocks = (m) => Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
  const textOf = (m) => blocks(m).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const toolUseIds = (m) => (m.role === 'assistant' ? blocks(m).filter((b) => b.type === 'tool_use').map((b) => b.id) : []);
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (!m || !m.role) { console.warn('[history] dropped malformed message at', i); continue; }
    // 1) user message that exactly echoes the previous assistant text = the self-feedback bug.
    if (m.role === 'user' && out.length && out[out.length - 1].role === 'assistant') {
      const ut = textOf(m), at = textOf(out[out.length - 1]);
      if (ut && ut === at) { console.warn('[history] dropped user msg echoing assistant reply (self-hallucination guard) at', i); continue; }
    }
    // 2) orphan tool_result (no matching tool_use in the immediately preceding assistant msg).
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) {
      const prevIds = out.length ? toolUseIds(out[out.length - 1]) : [];
      const kept = m.content.filter((b) => b.type !== 'tool_result' || prevIds.includes(b.tool_use_id));
      if (kept.length !== m.content.length) console.warn('[history] stripped orphan tool_result(s) at', i);
      if (!kept.length) continue;
      out.push({ role: 'user', content: kept }); continue;
    }
    out.push(m);
  }
  // 3) assistant tool_use whose tool_result never arrived → drop the trailing dangling turn.
  while (out.length && out[out.length - 1].role === 'assistant' && toolUseIds(out[out.length - 1]).length) {
    console.warn('[history] dropped trailing assistant turn with unanswered tool_use');
    out.pop();
  }
  // 4) MID-history dangling tool_use (caused by concurrency/interruption — wake word firing a new
  //    turn between the assistant tool_use and its tool_results). The API rejects ANY tool_use that
  //    isn't immediately followed by matching tool_results, not just the trailing one. Repair by
  //    splicing in synthetic error results so the pairing is always intact. (#multi-step robustness)
  for (let i = 0; i < out.length; i++) {
    const ids = toolUseIds(out[i]);
    if (!ids.length) continue;
    const next = out[i + 1];
    const answered = (next && next.role === 'user' && Array.isArray(next.content))
      ? new Set(next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)) : new Set();
    const missing = ids.filter((id) => !answered.has(id));
    if (!missing.length) continue;
    const synth = missing.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '[interrupted — no result captured]', is_error: true }));
    if (next && next.role === 'user' && Array.isArray(next.content)) next.content.unshift(...synth);
    else out.splice(i + 1, 0, { role: 'user', content: synth });
    console.warn('[history] repaired', missing.length, 'dangling tool_use(s) at', i);
  }
  return out;
}

// Drop all but the most-recent `keep` screenshots from a history copy (token economy). Returns a
// deep clone — the input is never mutated.
function evictOldImages(history, keep) {
  const h = structuredClone(history);
  const refs = [];
  for (const m of h) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (let ci = 0; ci < b.content.length; ci++) {
          if (b.content[ci].type === 'image') refs.push({ arr: b.content, ci });
        }
      }
    }
  }
  for (const r of refs.slice(0, Math.max(0, refs.length - keep))) {
    r.arr[r.ci] = { type: 'text', text: '[earlier screenshot omitted to save tokens]' };
  }
  return h;
}

// Transient failure signatures worth one automatic retry (network/load races, not logic errors).
const TRANSIENT_RE = /(timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|Target closed|Execution context|navigation|detached|not attached|temporarily|overloaded|try again|\b50[234]\b|\b429\b)/i;
// Only auto-retry IDEMPOTENT reads — never an action with side effects (a double click / submit /
// write / shell could do real damage). Pure fetches and page reads are safe.
function isRetryableTool(name, input) {
  if (name === 'fetch_url' || name === 'ui_inspect' || name === 'vision_local') return true;
  if (name === 'web_search' || name === 'news') return true;
  if (name === 'read_file' || name === 'list_directory') return true;
  if (name === 'browser') return ['navigate', 'get_text', 'screenshot'].includes(input && input.action);
  return false;
}

module.exports = { validateHistory, evictOldImages, isRetryableTool, TRANSIENT_RE };
