'use strict';
// Base agent runner (Phase 3). Stateless: assemble minimal context → build role prompt →
// route to cheapest viable model → parse result envelope → escalate if needed. The agent
// never sees chat history. See ARCHITECTURE.md §3.
const ctx = require('../context');
const router = require('../router');
const protocol = require('./protocol');
const { ROLES } = require('./roles');

// adapters: { ollamaChat, anthropic, ollamaUp, tools, memFn, trellis, image, replicate }
async function runAgent(task, { wsDir, config = {}, adapters = {} } = {}) {
  const role = ROLES[task.agent];
  if (!role) return protocol.buildResult({ task_id: task.id, agent: task.agent, status: 'failed', summary: 'unknown role' });

  const assembled = await ctx.assemble({ wsDir, task, k: 4, memFn: adapters.memFn });
  const userMsg = JSON.stringify({ goal: task.goal, state: assembled.state, memory: assembled.memory, files: assembled.files, constraints: assembled.constraints, expects: task.expects });

  let attempt = 0, result = null, last = null;
  while (attempt <= (config.local_retry_limit ?? 2)) {
    const choice = await router.pick({ ...task, class: role.class }, { config: { ...config, __metrics: config.__metrics }, adapters, attempt });
    if (choice.provider === 'anthropic' || choice.provider === 'ollama') {
      const messages = [{ role: 'user', content: userMsg }];
      let out;
      try { out = await router.run(choice, { messages, system: role.system, task }, adapters); }
      catch (e) { last = { error: e.message }; attempt++; continue; }
      result = protocol.parseResult(out.text, { task_id: task.id, agent: task.agent });
      result.cost = result.cost || {};
      result.cost.model = choice.model;
      if (choice.provider === 'anthropic' && out.usd === null) {
        result.cost.usd = router.estimateUsd(choice.model, router_estimate(userMsg), (result.summary || '').length);
      }
    } else {
      // creative/3d/image providers return artifacts directly
      const out = await router.run(choice, { task }, adapters);
      result = out.error
        ? protocol.buildResult({ task_id: task.id, agent: task.agent, status: 'failed', summary: out.error })
        : protocol.buildResult({ task_id: task.id, agent: task.agent, status: 'ok', summary: 'artifact generated', artifacts: out.artifacts || [] });
    }
    if (!router.shouldEscalate({ result, attempt, config })) break;
    attempt++;
  }
  if (!result) result = protocol.buildResult({ task_id: task.id, agent: task.agent, status: 'failed', summary: (last && last.error) || 'no result' });
  result.task_id = task.id; result.agent = task.agent;
  return result;
}

function router_estimate(s) { return Math.ceil((s || '').length / 4); }

module.exports = { runAgent };
