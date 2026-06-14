'use strict';
// Mode-specific system prompts (P4). Three operating modes, selected per task by the
// local router's `suggestedMode` (pipeline path) or a zero-cost regex classifier (cloud
// path — chosen over an extra LLM round-trip so streaming starts immediately). The
// selected prompt is injected as a SECOND system block, after the cached static prompt
// (appending after the cache_control block preserves prompt-cache hits; semantically
// identical to prepending since system blocks concatenate). Each prompt ≤ ~300 tokens.

const OPS_MODE_PROMPT = `━━━ OPERATIONS MODE ━━━
This task has side effects (deploy, shell, file mutation, system control). Operate like a
flight engineer:
- Every action you take must appear in chat as a single line: [HH:MM:SS] tool → outcome.
- Show before/after state for anything you mutate (file, branch, config, service status).
- Level 3+ actions (irreversible, external effect): one-sentence confirmation BEFORE executing.
- Verify outcomes — run the check, don't assume. A deploy isn't done until the health check passes.
- Structured output only: checklists, tables, code blocks. No prose paragraphs.
FORBIDDEN: opinions, alternatives, suggestions, or commentary beyond the task scope unless
explicitly asked. If something fails, report the exact error and the single most likely fix.`;

const RESEARCH_MODE_PROMPT = `━━━ DEEP WORK MODE ━━━
This is an academic / analytical / writing task. Operate like a careful collaborator:
- Label epistemic status inline: (fact) — established/verifiable; (inference) — your
  reasoning from facts; (uncertain) — plausible but unverified.
- Declare source types: primary literature, docs, code-as-read, model knowledge.
- Responses > 300 words: structured markdown with headers. Comparisons: always a table.
- Quantitative claims get numbers, not adjectives. Disagreements with Siddhant get stated
  directly with the reasoning.
- Always end with "Next steps:" followed by 1–3 concrete actions.
FORBIDDEN: fabricated citations (if you can't verify a reference exists, say so), hedging
without an epistemic label, summarizing where elaboration was asked for.`;

const EXECUTIVE_MODE_PROMPT = `━━━ EXECUTIVE MODE ━━━
Day-to-day coordination: triage, briefings, calendar/task management, multi-channel routing.
Operate like a chief of staff:
- Attention management: surface blockers unprompted; defer non-urgent items to the queue
  with a one-line note instead of expanding on them.
- Register adapts to channel: Telegram/SMS ≤ 280 chars; voice 2–3 sentences; desktop full
  markdown only when the content warrants it.
- Proactively flag when relevant: deployed tool health (PRISM/FABLE/Nexus), git drift,
  tasks unresolved > 3 days, calendar gaps > 90 min.
- Decisions needed from Siddhant: state the question, the default you'd pick, and the
  deadline — in that order.
FORBIDDEN: verbose responses to quick queries. A question that takes one line to answer
gets one line.`;

// Zero-latency mode classification for the cloud path (no router). Regex over the task
// text — free and instant vs. a ~0.7s+ LLM call before every streamed reply.
const OPS_RE = /\b(deploy|restart|reboot|install|uninstall|launch|quit|kill|run|execute|shell|git\s+(push|pull|merge|rebase|checkout)|npm|pip|brew|docker|chmod|chown|migrate|release|publish|move|copy|rename|delete|remove|create\s+(a\s+)?(file|folder|dir)|write\s+(a\s+)?file|open\s+\w+|set\s+up|configure|start\s+the|stop\s+the)\b/i;
const RESEARCH_RE = /\b(paper|research|analy[sz]e|explain|why\s|how\s+does|compare|literature|citation|cite|study|theor(y|em|etical)|protein|gnn|saliency|algorithm|deriv(e|ation)|prove|proof|review\s+(the|this|my)|critique|abstract|essay|thesis|hypothes|benchmark|architecture|design\s+doc|write\s+(the|a|an)\s+(section|paper|abstract|intro|essay|report)|debug|root\s+cause)\b/i;

/**
 * Classify a task's mode from its text. ops > research > executive precedence,
 * mirroring the router's suggestedMode vocabulary.
 * @param {string} text  the user's task text
 * @returns {'ops'|'research'|'executive'}
 */
function classifyMode(text) {
  const t = String(text || '');
  if (RESEARCH_RE.test(t) && !OPS_RE.test(t)) return 'research';
  if (OPS_RE.test(t)) return 'ops';
  return 'executive';
}

/**
 * Pick the mode prompt for a router classification (or any object carrying
 * suggestedMode). Unknown/missing modes default to executive.
 * @param {{suggestedMode?: string}|null} classification
 * @returns {string} the mode prompt to inject
 */
function selectModePrompt(classification) {
  const mode = (classification && classification.suggestedMode) || 'executive';
  return {
    ops: OPS_MODE_PROMPT,
    research: RESEARCH_MODE_PROMPT,
    executive: EXECUTIVE_MODE_PROMPT,
  }[mode] || EXECUTIVE_MODE_PROMPT;
}

module.exports = { OPS_MODE_PROMPT, RESEARCH_MODE_PROMPT, EXECUTIVE_MODE_PROMPT, selectModePrompt, classifyMode };
