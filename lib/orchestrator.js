'use strict';
// Cluster C — multi-agent on ONE task (parallel, for planning depth + speed). Two modes:
//
//  • ensemble(task): fan the SAME task out to N agents that take DIFFERENT roles (implementer /
//    skeptic / synthesizer by default, or caller-supplied), run them ALL IN PARALLEL (Promise.all,
//    real wall-clock speedup), then a lead pass synthesizes their takes into one decisive answer.
//    Different angles catch what a single linear pass misses.
//
//  • testApp(target, goal): an INDEPENDENT QA agent that drives a site/app like a skeptical real
//    user (same browser + vision capabilities as the main agent, acting alone) — clicks real flows,
//    tries edge cases, verifies by LOOKING, reports concrete findings + a verdict.
//
// Pure logic. main.js injects deps (reuses subagentDeps()):
//   { anthropicRequest, executeTool, toolDefs, apiKey, models:{sonnet,haiku}, onStep? }

// Default ensemble roles — generic problem-from-multiple-angles. Override per call for specialized
// teams (e.g. three architects debating a design, or N writers drafting variants).
const DEFAULT_ROLES = [
  { name: 'implementer', persona: 'You are the IMPLEMENTER. Solve the task directly and concretely — produce the actual answer/solution/code, not a discussion about it. Be decisive and complete.' },
  { name: 'skeptic',     persona: 'You are the SKEPTIC / RED-TEAM. Attack the task through its failure modes: what breaks, what is wrong, risky, or overlooked. Surface edge cases, hidden assumptions, and counter-arguments an eager answer would miss.' },
  { name: 'synthesizer', persona: 'You are the SYNTHESIZER. Take the broad view: weigh trade-offs and lay out the soundest overall approach with explicit reasoning about why it beats the alternatives.' },
];

// Independent app/site tester role — full real-user capabilities, scoped to inspection/navigation.
const TESTER = {
  name: 'tester', model: 'sonnet',
  tools: ['browser', 'open_in_browser', 'screen_parse', 'vision_click', 'vision_local', 'ui_inspect', 'fetch_url', 'read_file', 'notify_user', 'save_memory'],
  persona: `You are an INDEPENDENT QA TESTER. You exercise a site or app exactly like a skeptical real user — click through real flows, try edge inputs, check empty/error/loading states, broken links, layout, readability, and whether things ACTUALLY work end to end. You navigate yourself with the browser + vision tools and you VERIFY by looking at the result, never assuming. Report concrete findings as a list, each {severity: blocker|major|minor|nit, where, issue, repro}. Finish with a one-line verdict: ship / fix-first / broken.`,
};

// ── AGENT GUARDRAILS ─────────────────────────────────────────────────────────────────────────
// Keep delegated agents ON-TASK, prevent runaway fan-out / rabbit holes, and keep BhatBot in
// control (it orchestrates; agents do the legwork but can't go rogue).
// 1. Agents can NEVER spawn MORE agents (no nested teams / recursion bombs) or trip autonomy loops.
const NO_RECURSION = new Set(['fleet', 'agent_team', 'subagent', 'delegate_project', 'self_heal', 'self_fix', 'self_improve', 'manage_jobs']);
// 2. An agent with no explicit toolset gets this conservative WORKING set (not the full ~50-tool
//    catalog) so it can't wander into unrelated capabilities.
const DEFAULT_SUIT_TOOLS = ['read_file', 'write_file', 'list_directory', 'run_shell', 'fetch_url', 'web_search', 'browser', 'screen_parse', 'vision_click', 'ui_inspect', 'ask_ai', 'save_memory', 'notify_user'];
// 3. Step ceiling for a delegated agent is LOWER than a top-level turn — past this it's almost
//    certainly down a rabbit hole and should report back instead of grinding.
const SUIT_STEP_CEILING = 12;
const GUARDRAIL = `\n\nOPERATING RULES (strict): Stay STRICTLY within your assigned task. Do NOT expand scope, start unrelated work, or chase tangents. You CANNOT spawn other agents. If you hit something outside your task, a blocker, or an irreversible/risky action, STOP and report it back rather than improvising. Finish efficiently with a concise result — you are one member of a coordinated team under BhatBot, not a solo operator.`;

// One autonomous agent loop for a single role. Mirrors lib/subagents.run but takes an INLINE role
// (dynamic persona + optional scoped toolset) instead of a fixed catalog entry — and is stateless
// (no persisted history) since these roles are ephemeral.
async function runRole(role, task, deps, opts = {}) {
  // Bound the toolset: explicit role.tools → that; else a delegated suit → conservative default;
  // else (ensemble reasoning role) → full catalog. ALWAYS strip the agent-spawning tools.
  const requested = role.tools || (opts.suit ? DEFAULT_SUIT_TOOLS : (deps.toolDefs || []).map((t) => t.name));
  const allowed = requested.filter((n) => !NO_RECURSION.has(n));
  const tools = (deps.toolDefs || []).filter((t) => allowed.includes(t.name));
  const model = role.model === 'haiku' ? deps.models.haiku : deps.models.sonnet;
  const system = `${role.persona}\n\nWork autonomously to completion, then give a focused, plain result. You may ONLY use the tools provided.${GUARDRAIL}`;
  const hist = [{ role: 'user', content: task }];
  const ceiling = opts.suit ? SUIT_STEP_CEILING : 16;
  const maxSteps = Math.max(1, Math.min(ceiling, opts.maxSteps || 8));
  const update = (p) => { if (opts.onUpdate) try { opts.onUpdate(p); } catch {} };
  let steps = 0, finalText = '';
  while (steps++ < maxSteps) {
    // BhatBot stays in control: if it (or Siddhant) signalled stop, halt this agent cleanly.
    if (opts.shouldStop && opts.shouldStop()) { update({ status: 'stopped', step: 'stopped by BhatBot' }); finalText = finalText || '(stopped)'; break; }
    // Live relay → real-time feedback: fold any guidance the user typed for THIS agent into its
    // next turn, so the team can be steered mid-flight without restarting the agent.
    if (opts.getFeedback) { const fb = opts.getFeedback() || []; if (fb.length) { hist.push({ role: 'user', content: '[Live feedback from Siddhant — adjust accordingly]: ' + fb.join(' | ') }); update({ status: 'working', step: 'applying feedback', feedback: fb.join(' | ') }); } }
    const resp = await deps.anthropicRequest({ model, max_tokens: 4096, system, tools, messages: hist.slice(-32) }, deps.apiKey);
    const content = resp.content || [];
    hist.push({ role: 'assistant', content });
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) { finalText = text; update({ status: 'working', text }); }
    const tus = content.filter((b) => b.type === 'tool_use');
    if (!tus.length || resp.stop_reason === 'end_turn') break;
    const results = [];
    for (const tu of tus) {
      if (deps.onStep) try { deps.onStep(role.name, tu.name); } catch {}
      update({ status: 'working', step: tu.name });
      // Hard scope enforcement (incl. the no-agent-spawning rule) even if the model asks anyway.
      const r = allowed.includes(tu.name) ? await deps.executeTool(tu.name, tu.input)
        : { success: false, error: `tool "${tu.name}" is not permitted for the ${role.name} agent (out of scope)` };
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(r).slice(0, 16 * 1024), is_error: r && r.success === false });
    }
    hist.push({ role: 'user', content: results });
  }
  return { role: role.name, result: finalText || '(completed, no text output)', steps: steps - 1 };
}

// FLEET (Iron Legion) — run N DISTINCT tasks in parallel, each its own autonomous suit, with live
// per-agent relay (opts.onUpdate) and mid-flight steering (opts.drainFeedback(id) → strings). Unlike
// ensemble (same task, many angles) this is many tasks at once. tasks: [{id?, role?, persona?, tools?, task}].
async function fleet(tasks, deps, opts = {}) {
  const list = (tasks || []).filter((t) => t && t.task).slice(0, 6);
  if (!list.length) return { success: false, error: 'tasks (array of {role, task}) required' };
  const t0 = Date.now();
  const run = (t, i) => {
    const id = t.id || ('suit-' + (i + 1));
    const role = t.role || id;
    const persona = t.persona || `You are "${role}", ONE suit in BhatBot's agent legion. You work AUTONOMOUSLY on your OWN assigned task, in parallel with other suits. Stay focused on your task only, complete it, and report a concise result. Siddhant may send live feedback mid-task — honor it.`;
    const emit = (p) => { if (opts.onUpdate) try { opts.onUpdate({ id, role, task: t.task, ...p }); } catch {} };
    emit({ status: 'working', step: 'starting' });
    return runRole({ name: id, persona, tools: t.tools }, t.task, deps, {
      suit: true,                                   // → conservative default toolset + lower step ceiling + guardrails
      maxSteps: opts.maxSteps,
      onUpdate: (p) => emit(p),
      getFeedback: () => (opts.drainFeedback ? opts.drainFeedback(id) : []),
      shouldStop: () => (opts.shouldStop ? opts.shouldStop(id) : false),
    }).then((r) => { emit({ status: 'done', text: r.result }); return { id, role, task: t.task, result: r.result, steps: r.steps }; })
      .catch((e) => { emit({ status: 'failed', text: String(e && e.message || e) }); return { id, role, task: t.task, error: true, result: String(e && e.message || e) }; });
  };
  const agents = await Promise.all(list.map(run));
  return { success: true, mode: 'fleet', ms: Date.now() - t0, agents };
}

// Fan the SAME task to N roles in parallel, then synthesize.
async function ensemble(task, deps, opts = {}) {
  if (!task) return { success: false, error: 'task required' };
  const roles = (opts.roles && opts.roles.length ? opts.roles : DEFAULT_ROLES).slice(0, 4);
  const t0 = Date.now();
  const takes = await Promise.all(roles.map((r) =>
    runRole(r, task, deps, opts).catch((e) => ({ role: r.name, result: '(failed: ' + (e && e.message || e) + ')', error: true }))));
  const merged = takes.map((t) => `### ${t.role}\n${t.result}`).join('\n\n');
  // Lead synthesis: one model call resolves disagreements into a single answer for the user.
  const sys = `You are the LEAD agent. ${roles.length} specialists tackled the SAME task in parallel from different angles. Synthesize their takes into ONE clear, decisive answer for the user — resolve disagreements explicitly, keep what is strongest, drop what is wrong. Do not just concatenate; produce the best single answer. Don't mention the agents unless it genuinely helps.`;
  let synthesis = merged;
  try {
    const resp = await deps.anthropicRequest({ model: deps.models.sonnet, max_tokens: 4096, system: sys,
      messages: [{ role: 'user', content: `Task:\n${task}\n\nThe specialists' takes:\n\n${merged}` }] }, deps.apiKey);
    synthesis = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || merged;
  } catch (e) { /* fall back to the concatenated takes */ }
  return { success: true, mode: 'ensemble', roles: roles.map((r) => r.name), ms: Date.now() - t0, takes, result: synthesis };
}

// Independent QA agent drives a site/app and reports.
async function testApp(target, goal, deps, opts = {}) {
  if (!target) return { success: false, error: 'target (url or app name) required' };
  const isUrl = /^https?:\/\//i.test(target) || (/\.[a-z]{2,}($|\/)/i.test(target) && !/\s/.test(target));
  const nav = isUrl
    ? `Start by navigating the BhatBot browser to ${/^https?:/i.test(target) ? target : 'https://' + target} (browser action "navigate").`
    : `Bring the app "${target}" into focus, then use screen_parse / vision_click to drive it.`;
  const task = `Independently test this ${isUrl ? 'website' : 'app'}: ${target}\n\nGoal / what to verify: ${goal || 'general quality — does it work, is it usable, is anything broken?'}\n\n${nav}\nExplore real user flows, verify by LOOKING at the results, and report concrete findings with severity + a final verdict.`;
  const out = await runRole(TESTER, task, deps, { maxSteps: opts.maxSteps || 12 });
  return { success: true, mode: 'test_app', target, ...out };
}

module.exports = { ensemble, testApp, fleet, runRole, DEFAULT_ROLES, TESTER };
