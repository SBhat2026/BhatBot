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
// How many tool turns keep their full output. Older ones are stubbed — see prune().
const FULL_CONTEXT_TURNS = 2;
const SCHEMA = miniagent.TOOLS.filter((t) => SUPPORTED.has(t.name));

// ── CONTEXT PRUNING ───────────────────────────────────────────────────────────────────────────────
// A tool loop re-sends its entire transcript on every call, so a drone that reads twenty 12KB files
// pays for the first file twenty times and its cost grows with the SQUARE of its turn count. That is
// what killed the first run of the fan-out experiment: every agent in both arms exhausted its dollar
// cap around turn 4–8, mid-audit, with nothing written down.
//
// Old tool results are therefore replaced with a one-line stub naming what was read. The drone is
// told this plainly in its brief, so the correct behaviour — write your conclusion about a file in
// your own words in the SAME turn you read it, because the file itself will not be there next turn —
// is something it can actually comply with rather than a trap.
function prune(messages, keep = FULL_CONTEXT_TURNS) {
  const toolTurns = messages
    .map((m, i) => (m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result') ? i : -1))
    .filter((i) => i >= 0);
  const stubBefore = toolTurns[toolTurns.length - keep];
  if (stubBefore == null) return messages;
  return messages.map((m, i) => {
    if (i >= stubBefore || m.role !== 'user' || !Array.isArray(m.content)) return m;
    if (!m.content.some((b) => b.type === 'tool_result')) return m;
    return { ...m, content: m.content.map((b) => (b.type === 'tool_result'
      ? { ...b, content: '(output dropped to save context — you recorded what mattered at the time)' }
      : b)) };
  });
}

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
          model, max_tokens: 1500, system: ctx.system, tools: allowed, messages: prune(messages),
        }, { apiKey });
      } catch (e) {
        return { status: 'failed', summary: 'model error: ' + String(e && e.message || e).slice(0, 200) };
      }
      const usd = priceOf(model, resp.usage || {});
      spend += usd;
      onTrace({ drone: ctx.persona.name, kind: 'turn', usd, step });

      const content = resp.content || [];
      const uses = content.filter((b) => b.type === 'tool_use');
      const said = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (said) { text = said; onTrace({ drone: ctx.persona.name, kind: 'say', text: said.slice(0, 400) }); }

      // onStep AFTER the call and BEFORE the tools: this is the heartbeat, and a drone that only
      // beats when it finishes is a drone the supervisor reaps halfway through.
      const gate = ctx.onStep({ usd, note: uses.length ? 'calling ' + uses.map((u) => u.name).join(', ') : 'writing up' });

      if (!uses.length) return { status: 'ok', summary: text, spend: { usd: spend }, toolsUsed: used };
      if (!gate.budgetLeft || gate.terminated) {
        // THE WRAP-UP TURN. Running out of budget mid-tool-call used to end the drone where it stood,
        // and the first fan-out run showed what that costs: four agents that had done the work and
        // reported none of it, because the last thing each of them did was ask to read another file.
        // One final call with the tools REMOVED — so the model has no option but to answer — rescues
        // the whole run for the price of a single short completion, and the API cannot leave a
        // tool_use unanswered because there is no tool_use in it.
        onTrace({ drone: ctx.persona.name, kind: 'thinking', text: 'out of budget — writing up' });
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: '(budget reached — no more tools)' })) });
        const final = await wrapUp(messages, ctx);
        spend += final.usd;
        return { status: final.text ? 'ok' : 'partial', summary: final.text || text || '(out of budget before reporting)', spend: { usd: spend }, toolsUsed: used, wrappedUp: true };
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
    // Same rescue at the turn cap, for the same reason.
    onTrace({ drone: ctx.persona.name, kind: 'thinking', text: 'turn cap — writing up' });
    const final = await wrapUp(messages, ctx);
    spend += final.usd;
    return { status: final.text ? 'ok' : 'partial', summary: final.text || text || '(turn cap reached)', spend: { usd: spend }, toolsUsed: used, wrappedUp: true };

    async function wrapUp(msgs, c) {
      try {
        const r = await llm.anthropicRequest({
          model, max_tokens: 700, system: c.system,
          messages: [...prune(msgs, 1), { role: 'user', content: 'Your budget is spent. No more tools. Report NOW, in the exact format your brief specified, using only what you have already established. An incomplete honest answer is worth more than none.' }],
        }, { apiKey });
        return {
          usd: priceOf(model, r.usage || {}),
          text: (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
        };
      } catch { return { usd: 0, text: '' }; }
    }
  };
}

module.exports = { makeAgentRun, SUPPORTED, priceOf };
