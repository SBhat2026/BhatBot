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
// VANGUARD codenames (Phase 1): FORGE=implementer, ECHO=skeptic, OVERMIND=synthesizer/lead.
const DEFAULT_ROLES = [
  { name: 'implementer', codename: 'FORGE',    persona: 'You are the IMPLEMENTER. Solve the task directly and concretely — produce the actual answer/solution/code, not a discussion about it. Be decisive and complete.' },
  { name: 'skeptic',     codename: 'ECHO',     persona: 'You are the SKEPTIC / RED-TEAM. Attack the task through its failure modes: what breaks, what is wrong, risky, or overlooked. Surface edge cases, hidden assumptions, and counter-arguments an eager answer would miss.' },
  { name: 'synthesizer', codename: 'OVERMIND', persona: 'You are the SYNTHESIZER. Take the broad view: weigh trade-offs and lay out the soundest overall approach with explicit reasoning about why it beats the alternatives.' },
];

// Independent app/site tester role — full real-user capabilities, scoped to inspection/navigation.
const TESTER = {
  name: 'tester', codename: 'SENTINEL', model: 'sonnet',
  tools: ['browser', 'open_in_browser', 'screen_parse', 'vision_click', 'vision_local', 'ui_inspect', 'fetch_url', 'read_file', 'notify_user', 'save_memory'],
  persona: `You are an INDEPENDENT QA TESTER. You exercise a site or app exactly like a skeptical real user — click through real flows, try edge inputs, check empty/error/loading states, broken links, layout, readability, and whether things ACTUALLY work end to end. You navigate yourself with the browser + vision tools and you VERIFY by looking at the result, never assuming. Report concrete findings as a list, each {severity: blocker|major|minor|nit, where, issue, repro}. Finish with a one-line verdict: ship / fix-first / broken.`,
};

// ── SHARED-BOARD TOOLS ───────────────────────────────────────────────────────────────────────
// When a fan-out shares a blackboard, each agent gets these tools so it can ACTIVELY coordinate —
// not just passively read the injected status block. They're handled INSIDE runRole against the
// batch's board (never through the global executeTool), so the board stays batch-local.
const BOARD_TOOL_DEFS = [
  { name: 'board_post', description: 'Post a short note to the shared TEAM BOARD so your sibling agents see it live. kind: "finding" (something you learned or produced), "need" (something you need a teammate to do/provide), or "status" (what you are doing now). Keep text under ~280 chars. Post your key results so the team can build on them.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['finding', 'need', 'status'] }, text: { type: 'string' } }, required: ['kind', 'text'] } },
  { name: 'board_read', description: 'Read the shared TEAM BOARD — what your sibling agents are doing right now and what they have found or claimed. Call this before starting work that might overlap a teammate, and to build on their findings.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'board_claim', description: 'Claim a shared resource (a file, a section, a subtask) so teammates avoid double-working it. Read the board first; if someone already claimed it, coordinate or take a different part.',
    input_schema: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'] } },
];
const BOARD_TOOL_NAMES = BOARD_TOOL_DEFS.map((t) => t.name);
function handleBoardTool(board, agentId, name, input = {}) {
  if (!board) return { success: false, error: 'no shared board on this run' };
  try {
    if (name === 'board_post') { const e = board.post({ agent: agentId, kind: input.kind, text: input.text }); return { success: true, posted: { kind: e.kind, text: e.text } }; }
    if (name === 'board_read') { const rows = board.read({ limit: 20 }); return { success: true, board: board.fleetStatusBlock({ maxFindings: 10 }) || '(board empty)', entries: rows.map((r) => ({ agent: r.agent, kind: r.kind, text: r.text })) }; }
    if (name === 'board_claim') { const conflict = board.isClaimed(input.resource, { byOther: agentId }); board.claim(input.resource, agentId); return { success: true, claimed: input.resource, alreadyClaimedByTeammate: conflict }; }
  } catch (e) { return { success: false, error: String(e && e.message || e) }; }
  return { success: false, error: 'unknown board tool: ' + name };
}

// Lead INTEGRATOR — merge a parallel fleet's separate outputs into ONE coherent deliverable
// (fleet used to just concatenate). Reconciles overlaps/conflicts and flags gaps. One model call.
async function integrateFleet(list, agents, board, deps) {
  try {
    const parts = agents.map((a) => {
      const t = list.find((x) => (x.id || '') === a.id || x.role === a.role) || {};
      return `### ${a.role}${a.error ? ' (FAILED)' : ''} — assigned: ${t.task || ''}\n${a.result}`;
    }).join('\n\n');
    const boardTxt = board ? (board.fleetStatusBlock({ maxFindings: 12 }) || '') : '';
    const sys = `You are the LEAD who INTEGRATES a parallel team's work into ONE coherent deliverable. Each suit handled a PART of a larger job at the same time. Combine their outputs into a single unified result: reconcile overlaps and conflicts, keep what is done, and CLEARLY flag any gaps, contradictions, failed parts, or unfinished work that still needs attention. Be decisive and concrete — do NOT just concatenate their reports.`;
    const usr = `The suits and their results:\n\n${parts}\n\n${boardTxt ? 'Shared team board (their live findings/claims):\n' + boardTxt + '\n\n' : ''}Produce the integrated deliverable now.`;
    const resp = await deps.anthropicRequest({ model: deps.models.sonnet, max_tokens: 4096, system: sys, messages: [{ role: 'user', content: usr }] }, deps.apiKey);
    return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
  } catch { return null; }
}

// ── AGENT GUARDRAILS ─────────────────────────────────────────────────────────────────────────
// Keep delegated agents ON-TASK, prevent runaway fan-out / rabbit holes, and keep BhatBot in
// control (it orchestrates; agents do the legwork but can't go rogue).
// 1. Agents can NEVER spawn MORE agents (no nested teams / recursion bombs) or trip autonomy loops.
const NO_RECURSION = new Set(['fleet', 'agent_team', 'subagent', 'delegate_project', 'self_heal', 'self_fix', 'self_improve', 'manage_jobs']);
// 2. An agent with no explicit toolset gets this conservative WORKING set (not the full ~50-tool
//    catalog) so it can't wander into unrelated capabilities.
const DEFAULT_SUIT_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_directory', 'run_shell', 'fetch_url', 'web_search', 'browser', 'screen_parse', 'vision_click', 'ui_inspect', 'ask_ai', 'save_memory', 'notify_user', 'generate_image', 'make_figure'];
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
  let tools = (deps.toolDefs || []).filter((t) => allowed.includes(t.name));
  // T7 — if this run shares a board, hand the agent the coordination tools too (handled locally below).
  const hasBoard = !!opts.board;
  if (hasBoard) tools = [...tools, ...BOARD_TOOL_DEFS];
  let model = role.model === 'haiku' ? deps.models.haiku : deps.models.sonnet;
  // Task 4 — cross-model overflow spill. A downgrade-safe role (verification/critique, per
  // deps.canDowngrade) routes to Haiku when Sonnet is pinned at its admission floor and Haiku has
  // real headroom — using idle Haiku OTPM instead of convoying onto the saturated Sonnet queue.
  // Guarded on deps presence so ensemble/test paths without the injected budget probes are unaffected.
  if (model === deps.models.sonnet && typeof deps.fleetWidth === 'function' && deps.canDowngrade && deps.canDowngrade(role)) {
    try {
      const sw = deps.fleetWidth(deps.models.sonnet);
      const hw = deps.fleetWidth(deps.models.haiku);
      if (sw <= (deps.fleetFloor || 3) && hw > sw) { model = deps.models.haiku; if (deps.logDowngrade) deps.logDowngrade(role.name || role.role, sw, hw); }
    } catch { /* budget probe failed → keep Sonnet */ }
  }
  const system = `${role.persona}\n\nWork autonomously to completion, then give a focused, plain result. You may ONLY use the tools provided.${GUARDRAIL}`;
  const hist = [{ role: 'user', content: task }];
  const ceiling = opts.suit ? SUIT_STEP_CEILING : 16;
  const maxSteps = Math.max(1, Math.min(ceiling, opts.maxSteps || 8));
  const update = (p) => { if (opts.onUpdate) try { opts.onUpdate(p); } catch {} };
  // T7 — shared blackboard: read siblings' live state each turn, and post this agent's own status/
  // findings so the batch coordinates DURING the run (not only at synthesis time). Soft + bounded.
  const board = opts.board || null;
  const agentId = role.name || role.role || 'agent';
  if (board) try { board.post({ agent: agentId, kind: 'status', text: 'starting: ' + String(task).slice(0, 100) }); } catch {}
  let steps = 0, finalText = '';
  while (steps++ < maxSteps) {
    // BhatBot stays in control: if it (or Siddhant) signalled stop, halt this agent cleanly.
    if (opts.shouldStop && opts.shouldStop()) { update({ status: 'stopped', step: 'stopped by BhatBot' }); finalText = finalText || '(stopped)'; break; }
    // Live relay → real-time feedback: fold any guidance the user typed for THIS agent into its
    // next turn, so the team can be steered mid-flight without restarting the agent.
    if (opts.getFeedback) { const fb = opts.getFeedback() || []; if (fb.length) { hist.push({ role: 'user', content: '[Live feedback from Siddhant — adjust accordingly]: ' + fb.join(' | ') }); update({ status: 'working', step: 'applying feedback', feedback: fb.join(' | ') }); } }
    // Fold the live team board into this turn's system context so the agent can react to siblings.
    const sysNow = board ? (system + '\n\n' + (board.fleetStatusBlock() || '')).trim() : system;
    const resp = await deps.anthropicRequest({ model, max_tokens: 4096, system: sysNow, tools, messages: hist.slice(-32) }, deps.apiKey);
    const content = resp.content || [];
    hist.push({ role: 'assistant', content });
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) { finalText = text; update({ status: 'working', text }); }
    const tus = content.filter((b) => b.type === 'tool_use');
    if (board && tus.length) try { board.post({ agent: agentId, kind: 'status', text: 'running ' + tus.map((t) => t.name).join(', ') }); } catch {}
    if (!tus.length || resp.stop_reason === 'end_turn') break;
    // Execute ONE tool_use → its tool_result block. Kept as a fn so a burst of INDEPENDENT read-only
    // tools can run concurrently below instead of one at a time (per-suit throughput inside the fleet).
    const runOne = async (tu) => {
      if (deps.onStep) try { deps.onStep(role.name, tu.name); } catch {}
      update({ status: 'working', step: tu.name });
      // Hard scope enforcement (incl. the no-agent-spawning rule) even if the model asks anyway.
      // Board tools are handled locally against the batch's shared board, never the global executor.
      const r = BOARD_TOOL_NAMES.includes(tu.name)
        ? (hasBoard ? handleBoardTool(board, agentId, tu.name, tu.input) : { success: false, error: 'no shared board on this run' })
        : (allowed.includes(tu.name) ? await deps.executeTool(tu.name, tu.input)
          : { success: false, error: `tool "${tu.name}" is not permitted for the ${role.name} agent (out of scope)` });
      // Stream this agent's "screen": if a tool returned an image (browser/screen/vision/figure),
      // forward it so the per-agent monitor window can show what the agent is looking at.
      if (r && r._image) update({ status: 'working', step: tu.name, shot: r._image, shotMime: r._imageMime || 'image/jpeg' });
      const { _image, _imageMime, ...rClean } = (r && typeof r === 'object') ? r : { v: r };
      return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(rClean).slice(0, 16 * 1024), is_error: r && r.success === false };
    };
    // Throughput: if the suit fired several INDEPENDENT read-only tools this turn, run them
    // concurrently (order preserved so pairing/validation holds). Board tools always stay sequential —
    // they mutate the shared team board and must not race. Falls back to sequential when no predicate.
    let results;
    if (tus.length > 1 && typeof deps.parallelSafe === 'function'
        && tus.every((t) => deps.parallelSafe(t.name) && !BOARD_TOOL_NAMES.includes(t.name))) {
      results = await Promise.all(tus.map(runOne));
    } else {
      results = [];
      for (const tu of tus) results.push(await runOne(tu));
    }
    hist.push({ role: 'user', content: results });
  }
  if (board) try { board.post({ agent: agentId, kind: 'finding', text: (finalText || 'done').slice(0, 260) }); } catch {}
  return { role: role.name, result: finalText || '(completed, no text output)', steps: steps - 1 };
}

// FLEET (VANGUARD) — run N DISTINCT tasks in parallel, each its own autonomous suit, with live
// per-agent relay (opts.onUpdate) and mid-flight steering (opts.drainFeedback(id) → strings). Unlike
// ensemble (same task, many angles) this is many tasks at once. tasks: [{id?, role?, persona?, tools?, task}].
async function fleet(tasks, deps, opts = {}) {
  // Width is budget-driven now (Phase 1): main.js passes opts.maxParallel = live fleetWidth(). The
  // per-request admission ledger does the fine pacing, so this is just the upper bound on suits.
  const cap = Math.max(1, opts.maxParallel || 12);   // Phase 5: default fleet width 6→12 (admission paces the real ceiling)
  const list = (tasks || []).filter((t) => t && t.task).slice(0, cap);
  if (!list.length) return { success: false, error: 'tasks (array of {role, task}) required' };
  const t0 = Date.now();
  const board = deps.makeBoard ? deps.makeBoard() : null;   // T7 — one shared board for the whole fleet
  // Team roster: every suit is told WHO its teammates are + WHAT they're doing, so it can coordinate
  // (via the board tools) instead of working blind — the "actually work together" fix.
  const roster = list.map((t, i) => `${t.id || ('suit-' + (i + 1))} (${String(t.task).slice(0, 60)})`).join(' · ');
  const run = (t, i) => {
    const id = t.id || ('suit-' + (i + 1));
    const role = t.role || id;
    const teammates = list.filter((_, j) => j !== i).map((x, j) => x.id || ('suit-' + (list.indexOf(x) + 1))).join(', ');
    const coord = board ? `\n\nYOUR TEAM (all working in parallel RIGHT NOW): ${roster}. You are building ONE combined deliverable together. Use board_read to see teammates' live progress before you start something that may overlap; board_claim a shared file/section before editing it so you don't collide; board_post your key findings and anything a teammate needs. Build on what they post — don't redo it.` : '';
    const persona = (t.persona || `You are "${role}", ONE suit in BhatBot's agent Vanguard. You work AUTONOMOUSLY on your OWN assigned task, in parallel with other suits. Stay focused on your task only, complete it, and report a concise result. Siddhant may send live feedback mid-task — honor it.`) + coord;
    const emit = (p) => { if (opts.onUpdate) try { opts.onUpdate({ id, role, task: t.task, ...p }); } catch {} };
    emit({ status: 'working', step: 'starting' });
    return runRole({ name: id, persona, tools: t.tools }, t.task, deps, {
      suit: true,                                   // → conservative default toolset + lower step ceiling + guardrails
      board,                                        // T7 — shared live state across the fleet
      maxSteps: opts.maxSteps,
      onUpdate: (p) => emit(p),
      getFeedback: () => (opts.drainFeedback ? opts.drainFeedback(id) : []),
      shouldStop: () => (opts.shouldStop ? opts.shouldStop(id) : false),
    }).then((r) => { emit({ status: 'done', text: r.result }); return { id, role, task: t.task, result: r.result, steps: r.steps }; })
      .catch((e) => { emit({ status: 'failed', text: String(e && e.message || e) }); return { id, role, task: t.task, error: true, result: String(e && e.message || e) }; });
  };
  const agents = await Promise.all(list.map(run));
  // Lead INTEGRATOR — merge the suits' separate outputs (+ their shared board) into ONE deliverable,
  // reconciling overlaps and flagging gaps. This is what makes the fleet a TEAM, not N loose workers.
  let integrated = null;
  if (opts.integrate !== false && agents.length > 1) {
    if (opts.onUpdate) try { opts.onUpdate({ id: 'lead', role: 'integrator', status: 'working', step: 'integrating team output' }); } catch {}
    integrated = await integrateFleet(list, agents, board, deps);
    if (opts.onUpdate) try { opts.onUpdate({ id: 'lead', role: 'integrator', status: 'done', text: integrated || '' }); } catch {}
  }
  const result = integrated || agents.map((a) => `### ${a.role}\n${a.result}`).join('\n\n');
  return { success: true, mode: 'fleet', ms: Date.now() - t0, agents, result };
}

// Fan the SAME task to N roles in parallel, then synthesize.
async function ensemble(task, deps, opts = {}) {
  if (!task) return { success: false, error: 'task required' };
  const roles = (opts.roles && opts.roles.length ? opts.roles : DEFAULT_ROLES).slice(0, 8);   // Phase 5: ensemble cap 4→8
  const t0 = Date.now();
  const board = deps.makeBoard ? deps.makeBoard() : null;   // T7 — one shared board for this fan-out
  const takes = await Promise.all(roles.map((r) => {
    if (opts.onUpdate) try { opts.onUpdate({ id: r.name, role: r.name, task, status: 'working', step: 'starting' }); } catch {}
    return runRole(r, task, deps, { ...opts, board, onUpdate: (p) => { if (opts.onUpdate) try { opts.onUpdate({ id: r.name, role: r.name, ...p }); } catch {} } })
      .then((res) => { if (opts.onUpdate) try { opts.onUpdate({ id: r.name, role: r.name, status: 'done', text: res.result }); } catch {} return res; })
      .catch((e) => { if (opts.onUpdate) try { opts.onUpdate({ id: r.name, role: r.name, status: 'failed', text: String(e && e.message || e) }); } catch {} return { role: r.name, result: '(failed: ' + (e && e.message || e) + ')', error: true }; });
  }));
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
  const out = await runRole(TESTER, task, deps, { maxSteps: opts.maxSteps || 12,
    onUpdate: (p) => { if (opts.onUpdate) try { opts.onUpdate({ id: 'tester', role: 'tester', ...p }); } catch {} } });
  if (opts.onUpdate) try { opts.onUpdate({ id: 'tester', role: 'tester', status: out.error ? 'failed' : 'done', text: out.result }); } catch {}
  return { success: true, mode: 'test_app', target, ...out };
}

module.exports = { ensemble, testApp, fleet, runRole, DEFAULT_ROLES, TESTER };
