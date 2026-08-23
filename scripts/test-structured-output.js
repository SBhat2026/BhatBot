'use strict';
// STRUCTURED OUTPUTS — stop fishing JSON out of prose.
//
// Three paths asked the model for JSON and then dug it out with a regex
// (`txt.match(/\[[\s\S]*\]/)`). When the model adds a preamble or a ```json fence the match fails,
// and the caller degrades to "found nothing" — indistinguishable from a legitimately empty answer.
// output_config.format makes the API enforce the shape, so a malformed reply becomes impossible
// rather than invisible. Verified supported on Opus 5 / Sonnet 5 via GET /v1/models.
//
// The end-to-end WIRING is what these mostly test, because that is where this kind of change dies:
// a schema built by the planner, passed down two layers, and silently dropped by an adapter that
// never accepted the argument looks enforced and does nothing.
const assert = require('assert');
const reasoning = require('../lib/reasoning');
const select = require('../lib/agents/select');
const synapse = require('../lib/synapse');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── the shaping layer emits output_config.format ──────────────────────────────────────────────
{
  const schema = { type: 'object', properties: { tasks: { type: 'array' } }, required: ['tasks'] };
  const { body } = reasoning.shapeRequest({ model: 'claude-opus-5', max_tokens: 900, messages: [] }, { schema, schemaName: 'plan' });
  ok(body.output_config && body.output_config.format, 'a schema produces output_config.format');
  ok(body.output_config.format.type === 'json_schema', 'as a json_schema');
  assert.deepStrictEqual(body.output_config.format.schema, schema); pass++;
  ok(body.output_config.format.name === undefined,
    'and carries NO name field — the API rejects it: 400 "output_config.format.name: Extra inputs are not permitted"');
  assert.deepStrictEqual(Object.keys(body.output_config.format).sort(), ['schema', 'type']); pass++;

  // It must COMPOSE with the rest of output_config, not clobber it.
  const both = reasoning.shapeRequest({ model: 'claude-opus-5', max_tokens: 900, messages: [] }, { schema, depth: 'deep', taskBudget: 50000 }).body.output_config;
  ok(both.format && both.effort, 'format coexists with effort');
  ok(both.task_budget, 'and with task_budget');

  ok(!reasoning.shapeRequest({ model: 'claude-opus-5', max_tokens: 900, messages: [] }, {}).body.output_config?.format,
    'no schema → no format (never send an empty constraint)');
  // Haiku has structured_outputs.supported === false; sending it would be a 400.
  const h = reasoning.shapeRequest({ model: 'claude-haiku-4-5', max_tokens: 900, messages: [] }, { schema });
  ok(!(h.body.output_config && h.body.output_config.format), 'a model without structured outputs gets none — an unsupported field is a hard error');
  ok(reasoning.CAPS['claude-opus-5'].structured === true && reasoning.CAPS['claude-haiku-4-5'].structured === false,
    'the capability is recorded per model, read from GET /v1/models');
}

// ── the schema actually REACHES the wire ──────────────────────────────────────────────────────
{
  let seen = null;
  const adapters = { anthropic: async (m, s, model, opts) => { seen = opts; return '{"tasks":[]}'; } };
  return select.run({ provider: 'anthropic', model: 'claude-opus-5' }, { messages: [], system: 'x', schema: { type: 'object' }, schemaName: 'plan' }, adapters)
    .then(() => {
      ok(seen && seen.schema, 'router.run forwards the schema to the anthropic adapter');
      ok(seen.schemaName === 'plan', 'including its name');
      const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
      ok(/anthropic: async \(m, s, model, opts = \{\}\)/.test(main), 'and the live adapter in main.js ACCEPTS it (it used to take three arguments and drop the fourth)');
      ok(/_reason: \{ schema: opts\.schema/.test(main), 'and passes it into the shaping layer');
      rest();
    });
}

function rest() {
  // ── the planner: the site where a failed parse does the most damage ─────────────────────────
  {
    const orch = require('../lib/agents/orchestrator');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'agents', 'orchestrator.js'), 'utf8');
    ok(/PLAN_SCHEMA/.test(src), 'the planner declares a schema');
    ok(/schema: PLAN_SCHEMA/.test(src), 'and passes it to router.run');
    ok(/JSON\.parse\(text\)/.test(src), 'it parses a schema-constrained reply DIRECTLY');
    ok(/text\.match\(/.test(src), 'and keeps the regex as a fallback — local Ollama rungs have no structured-output surface');
    ok(/silently becomes one\s*\n\/\/ agent doing everything/.test(src) || /fan-out silently becomes/.test(src),
      'and the comment records why this site matters most: a failed parse collapses the whole fan-out to one task');
    void orch;
  }

  // ── synapse.suggest ─────────────────────────────────────────────────────────────────────────
  {
    ok(synapse.SUGGEST_SCHEMA, 'synapse exports its suggestion schema');
    const s = synapse.SUGGEST_SCHEMA;
    ok(s.required.includes('suggestions'), 'which requires the suggestions array');
    const item = s.properties.suggestions.items;
    for (const f of ['project', 'why', 'next']) ok(item.required.includes(f), `each suggestion must carry "${f}"`);
    ok(item.additionalProperties === false, 'and nothing else — a loose schema is barely a schema');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'synapse.js'), 'utf8');
    ok(/schema: SUGGEST_SCHEMA/.test(src), 'suggest() passes it through the injected llm');
    ok(/JSON\.parse\(txt\)/.test(src), 'and parses the constrained reply directly');
    const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
    ok(/llm: async \(\{ system, content, maxTokens, schema, schemaName \}\)/.test(main), 'and the live llm adapter accepts a schema');
  }

  console.log(`✅ structured output: ${pass} assertions passed`);
}
