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

// One autonomous agent loop for a single role. Mirrors lib/subagents.run but takes an INLINE role
// (dynamic persona + optional scoped toolset) instead of a fixed catalog entry — and is stateless
// (no persisted history) since ensemble roles are ephemeral.
async function runRole(role, task, deps, opts = {}) {
  const tools = role.tools ? (deps.toolDefs || []).filter((t) => role.tools.includes(t.name)) : (deps.toolDefs || []);
  const model = role.model === 'haiku' ? deps.models.haiku : deps.models.sonnet;
  const system = `${role.persona}\n\nWork autonomously to completion, then give a focused, plain result.${role.tools ? ' You may ONLY use the tools provided.' : ''}`;
  const hist = [{ role: 'user', content: task }];
  const maxSteps = Math.max(1, Math.min(16, opts.maxSteps || 8));
  let steps = 0, finalText = '';
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
      if (deps.onStep) try { deps.onStep(role.name, tu.name); } catch {}
      const allowed = !role.tools || role.tools.includes(tu.name);
      const r = allowed ? await deps.executeTool(tu.name, tu.input)
        : { success: false, error: `tool "${tu.name}" is not permitted for the ${role.name} agent` };
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(r).slice(0, 16 * 1024), is_error: r && r.success === false });
    }
    hist.push({ role: 'user', content: results });
  }
  return { role: role.name, result: finalText || '(completed, no text output)', steps: steps - 1 };
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

module.exports = { ensemble, testApp, runRole, DEFAULT_ROLES, TESTER };
