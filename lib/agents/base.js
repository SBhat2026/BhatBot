'use strict';
// Base agent runner (full autonomy). Stateless: assemble minimal context → build role
// prompt → route to cheapest viable model → run a real tool-use loop (agent actually
// executes tools) → parse result envelope → escalate if needed. The agent never sees chat
// history; only the assembled task context. See ARCHITECTURE.md §3.
const ctx = require('../context');
const router = require('./select');
const protocol = require('./protocol');
const { runToolLoop } = require('./exec');
const { ROLES, ROLE_TOOLS } = require('./roles');

// adapters: { ollamaUp, ollamaChat, anthropic, anthropicTools?, ollamaTools?, toolExec?,
//             toolDefs?, memFn, memWrite, trellis?, image?, onEvent? }
async function runAgent(task, { wsDir, config = {}, adapters = {} } = {}) {
  const role = ROLES[task.agent];
  if (!role) return protocol.buildResult({ task_id: task.id, agent: task.agent, status: 'failed', summary: 'unknown role' });

  const assembled = await ctx.assemble({ wsDir, task, k: 4, memFn: adapters.memFn });
  // peer_findings = what sibling agents on this same goal have already reported. The agent should
  // BUILD ON these (don't redo work, resolve/flag contradictions) — this is the cross-agent relay.
  // fleet = the LIVE blackboard (T5): what siblings are doing RIGHT NOW (statuses + latest findings),
  // injected fresh at call time. Optional — absent board → field omitted, behavior unchanged.
  const fleet = adapters.board ? adapters.board.fleetStatusBlock() : '';
  const userMsg = JSON.stringify({ goal: task.goal, state: assembled.state, memory: assembled.memory, files: assembled.files, constraints: assembled.constraints, peer_findings: assembled.peers, fleet: fleet || undefined, expects: task.expects });

  const wantTools = (ROLE_TOOLS[task.agent] || []).length > 0 && adapters.toolExec && Array.isArray(adapters.toolDefs);
  const toolSubset = wantTools ? adapters.toolDefs.filter((t) => ROLE_TOOLS[task.agent].includes(t.name)) : [];

  let attempt = 0, result = null, last = null;
  while (attempt <= (config.local_retry_limit ?? 2)) {
    const choice = await router.pick({ ...task, class: role.class }, { config: { ...config, __metrics: config.__metrics }, adapters, attempt });

    if (wantTools && (choice.provider === 'anthropic' || choice.provider === 'ollama')) {
      // ---- Autonomous tool-execution path ----
      const caller = choice.provider === 'anthropic'
        ? (m, s, tools) => adapters.anthropicTools(m, s, tools, choice.model)
        : (m, s, tools) => adapters.ollamaTools(m, s, tools, choice.model);
      if ((choice.provider === 'anthropic' && !adapters.anthropicTools) || (choice.provider === 'ollama' && !adapters.ollamaTools)) {
        // no tool-capable caller for this provider → fall through to plain text below
      } else {
        let loop;
        try {
          loop = await runToolLoop({ caller, toolExec: adapters.toolExec, system: role.system, tools: toolSubset, userContent: userMsg, maxSteps: config.agentMaxSteps || 8, onEvent: adapters.onEvent });
        } catch (e) { last = { error: e.message }; attempt++; continue; }
        result = protocol.parseResult(loop.text, { task_id: task.id, agent: task.agent });
        result.cost = result.cost || {}; result.cost.model = choice.model;
        if (choice.provider === 'anthropic') result.cost.usd = router.estimateUsd(choice.model, est(userMsg) + loop.toolCalls * 300, (result.summary || '').length);
        if (!result.summary && loop.text) result.summary = loop.text.slice(0, 200);
        if (loop.maxed && result.status === 'ok') result.status = 'partial';
        if (!router.shouldEscalate({ result, attempt, config })) break;
        attempt++; continue;
      }
    }

    // ---- Plain text path (no-tool roles, or provider lacks tool support — openai/gemini
    // offload rungs land here even for tool roles: they trade tools for zero Anthropic quota) ----
    if (['anthropic', 'ollama', 'openai', 'gemini'].includes(choice.provider)) {
      const messages = [{ role: 'user', content: userMsg }];
      let out;
      try { out = await router.run(choice, { messages, system: role.system, task }, adapters); }
      catch (e) { last = { error: e.message }; attempt++; continue; }
      result = protocol.parseResult(out.text, { task_id: task.id, agent: task.agent });
      result.cost = result.cost || {}; result.cost.model = choice.model;
      if (out.usd === null) result.cost.usd = router.estimateUsd(choice.model, est(userMsg), (result.summary || '').length);
    } else {
      const out = await router.run(choice, { task }, adapters);
      result = out.error
        ? protocol.buildResult({ task_id: task.id, agent: task.agent, status: 'failed', summary: out.error })
        : protocol.buildResult({ task_id: task.id, agent: task.agent, status: 'ok', summary: 'artifact generated', artifacts: out.artifacts || [], state_updates: out.facts ? Object.entries(out.facts).map(([k, v]) => ({ path: `${task.agent}.facts.${k}`, value: v })) : [] });
    }
    if (!router.shouldEscalate({ result, attempt, config })) break;
    attempt++;
  }
  if (!result) result = protocol.buildResult({ task_id: task.id, agent: task.agent, status: 'failed', summary: (last && last.error) || 'no result' });
  result.task_id = task.id; result.agent = task.agent;
  // Relay the finding onto the blackboard so siblings still running see it live (T5).
  if (adapters.board) { try { adapters.board.post({ agent: task.agent, taskId: task.id, kind: result.status === 'ok' ? 'finding' : 'status', text: `[${result.status}] ${result.summary || ''}` }); } catch {} }
  return result;
}

function est(s) { return Math.ceil((s || '').length / 4); }

module.exports = { runAgent };
