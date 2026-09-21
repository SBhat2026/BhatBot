'use strict';
// A HEADLESS `agentRun` for lib/drone.js.
//
// lib/fleet.js and lib/drone.js are already pure and dependency-injected — they take an `agentRun`
// and know nothing about how a turn is executed. main.js supplies `droneAgentRun`, which needs
// Electron. This is the same contract satisfied outside Electron, so a fleet can be run, measured
// and scored from a plain node process.
//
// It honours the drone contract exactly: the scoped `tools` list, the persona `system` block, and
// `onStep` after every model call — onStep is what charges the budget AND writes the heartbeat the
// fleet supervisor reaps against, so skipping it would make every drone look stalled.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const llm = require(path.join(ROOT, 'lib', 'llm'));
const pricing = require(path.join(ROOT, 'lib', 'pricing'));
const miniagent = require(path.join(ROOT, 'lib', 'miniagent'));

// The drone tool names that this headless runner can actually honour. A drone must never be handed a
// tool whose implementation is missing — it would call it, get an error, and burn its budget
// discovering that. So the fleet spec is intersected with this list before the drone is built.
const SUPPORTED = new Set(['read_file', 'list_directory', 'web_search', 'fetch_url']);
const SCHEMA = miniagent.TOOLS.filter((t) => SUPPORTED.has(t.name));

function priceOf(model, u) {
  const [i, o] = pricing.tuple(model);
  return (u.input_tokens || 0) / 1e6 * i + (u.output_tokens || 0) / 1e6 * o
       + (u.cache_read_input_tokens || 0) / 1e6 * i * pricing.CACHE_READ
       + (u.cache_creation_input_tokens || 0) / 1e6 * i * pricing.CACHE_WRITE_5M;
}

/**
 * makeAgentRun({ apiKey, model, onTrace }) → agentRun(ctx, task)
 * onTrace({ drone, kind, text, tool, usd }) is the live tap the office reads.
 */
function makeAgentRun({ apiKey, model = llm.DEFAULT_MODEL, onTrace = () => {} } = {}) {
  return async function agentRun(ctx, task) {
    const allowed = SCHEMA.filter((t) => ctx.tools.includes(t.name));
    const goal = String((task && task.goal) || task || '');
    const messages = [{ role: 'user', content: goal }];
    const used = [];
    let spend = 0, text = '';

    for (let step = 0; step < ctx.budget.maxTurns; step++) {
      onTrace({ drone: ctx.persona.name, kind: 'thinking', text: step === 0 ? 'reading the brief' : 'deciding what to read next' });
      let resp;
      try {
        resp = await llm.anthropicRequest({
          model, max_tokens: 1500, system: ctx.system, tools: allowed, messages,
        }, { apiKey });
      } catch (e) {
        return { status: 'failed', summary: 'model error: ' + String(e && e.message || e).slice(0, 200) };
      }
      const usd = priceOf(model, resp.usage || {});
      spend += usd;

      const content = resp.content || [];
      const uses = content.filter((b) => b.type === 'tool_use');
      const said = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (said) { text = said; onTrace({ drone: ctx.persona.name, kind: 'say', text: said.slice(0, 400) }); }

      // onStep AFTER the call and BEFORE the tools: this is the heartbeat, and a drone that only
      // beats when it finishes is a drone the supervisor reaps halfway through.
      const gate = ctx.onStep({ usd, note: uses.length ? 'calling ' + uses.map((u) => u.name).join(', ') : 'writing up' });

      if (!uses.length) return { status: 'ok', summary: text, spend: { usd: spend }, toolsUsed: used };
      if (!gate.budgetLeft || gate.terminated) {
        return { status: 'partial', summary: (text || '(out of budget before reporting)').slice(0, 1200), spend: { usd: spend }, toolsUsed: used };
      }

      messages.push({ role: 'assistant', content });
      const results = [];
      for (const u of uses) {
        used.push(u.name);
        onTrace({ drone: ctx.persona.name, kind: 'tool', tool: u.name, text: String(u.input.path || u.input.query || u.input.url || '').slice(0, 120), usd });
        const out = await miniagent.runTool(u.name, u.input, {});
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) });
      }
      messages.push({ role: 'user', content: results });
    }
    return { status: 'partial', summary: text || '(turn cap reached)', spend: { usd: spend }, toolsUsed: used };
  };
}

module.exports = { makeAgentRun, SUPPORTED, priceOf };
