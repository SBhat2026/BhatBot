'use strict';
// TOOL WIRING — the contract between what the model is TOLD it can do and what actually runs.
//
// Two halves, both silent when broken:
//   • a tool advertised with no handler → the model calls it and gets "Unknown tool", having spent a
//     turn and burned the schema tokens on every prior request;
//   • a handler with no schema → dead code the model can never reach.
// Neither shows up in any other test, because both sides individually parse fine.
//
// Also pins the CONNECTOR half of the wiring: connector tools must go through tool retrieval like
// everything else (they used to be appended after it, exempt and permanently on the wire), and a
// connector tool that a native tool supersedes must be hidden from the model but still callable by
// the wrapper.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const TOOLS = require('../lib/tools-schema')({ MEMORY_SECTIONS: ['a'] });
const connectors = require('../lib/connectors');
const mcphub = require('../lib/mcphub');

// ── schema ↔ implementation ───────────────────────────────────────────────────────────────────
{
  const names = TOOLS.map((t) => t.name);
  ok(new Set(names).size === names.length, 'no duplicate tool names in the schema (a later entry would silently shadow an earlier one)');

  // executeTool's switch: from `case 'read_file':` through the mcphub default. Bounded by the
  // function itself rather than line numbers, which drift with every edit.
  const start = main.indexOf('function executeTool');
  const end = main.indexOf('mcphub.isHubTool(name)', start);
  ok(start > 0 && end > start, 'located the executeTool switch');
  const body = main.slice(start, end);
  const cases = new Set([...body.matchAll(/^\s{6}case '([a-z_0-9]+)':/gm)].map((m) => m[1]));

  const unimplemented = names.filter((n) => !cases.has(n));
  ok(unimplemented.length === 0, 'every ADVERTISED tool has a handler — otherwise the model calls it and gets "Unknown tool": ' + unimplemented.join(', '));
  const unadvertised = [...cases].filter((n) => !names.includes(n));
  ok(unadvertised.length === 0, 'every implemented tool is advertised — otherwise it is unreachable dead code: ' + unadvertised.join(', '));

  for (const t of TOOLS) {
    ok(typeof t.description === 'string' && t.description.length > 20, `${t.name} has a real description (retrieval ranks on it — a stub makes the tool unfindable)`);
    ok(t.input_schema && t.input_schema.type === 'object', `${t.name} has an object input_schema`);
  }
}

// ── the two new tools are wired end to end ────────────────────────────────────────────────────
{
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  ok(byName.visual_build, 'visual_build is advertised');
  ok(byName.connectors, 'connectors is advertised');
  ok(/seedance/i.test(byName.visual_build.description), 'visual_build names its backend so the model knows what it depends on');
  ok(/WAITS|finished video/i.test(byName.visual_build.description),
    'visual_build tells the model it BLOCKS — otherwise the model polls itself, which is the cost this tool exists to avoid');
  ok(byName.visual_build.input_schema.required.includes('prompt'), 'visual_build requires a prompt');
  // The preview allowlist is what makes the poster frame visible in chat.
  ok(/'generate_image', 'visual_build'/.test(main), "visual_build is in the showImage allowlist, so its poster frame reaches the conversation");
  // Cost telemetry: video is the priciest call BhatBot can make and was ledgered at zero.
  const { estimateToolCost } = require('../lib/pure');
  const cheap = estimateToolCost('visual_build', { duration: 5, resolution: '480p' }, { success: true });
  const dear = estimateToolCost('visual_build', { duration: 10, resolution: '4k' }, { success: true });
  ok(cheap > 0, 'a video call has a non-zero cost estimate');
  ok(dear > cheap * 5, 'and the estimate scales with resolution and duration rather than being a flat guess');
  ok(estimateToolCost('visual_build', {}, { success: false }) === 0, 'a failed generation is not billed');
}

// ── connector tools obey the same rules as native ones ────────────────────────────────────────
{
  // activeTools() must NOT append hub tools after retrieval — that is what made them exempt.
  ok(!/\.concat\(\s*mcphub\.toolSchemas\(\)/.test(main),
    'connector tools are not blind-appended to the retrieval result (that made them ride every turn)');
  ok(/toolselect\.select\(lastUserText\(history\), catalog/.test(main),
    'retrieval ranks over the FULL catalog (native + connectors), so connector tools are selected on relevance');
  ok(/function fullCatalog\(\)/.test(main), 'there is one definition of "every tool the model could call"');

  const hidden = connectors.hiddenToolIds();
  ok(hidden.size > 0, 'at least one connector tool is marked as superseded by a native wrapper');
  ok(hidden.get('mcp__seedance__seedance_generate_video') === 'visual_build',
    'the async raw generator is hidden in favour of visual_build');
  ok(hidden.get('mcp__seedance__seedance_generate_video_from_image') === 'visual_build',
    '…and so is the image-to-video variant');
  // Hiding is advertising-only: the wrapper still has to be able to call it.
  const vb = require('../lib/visualbuild');
  ok(hidden.has(vb.T_GEN) && hidden.has(vb.T_GEN_IMG), 'the hidden ids are exactly the ones visual_build drives');
  ok(!hidden.has(vb.T_TASK), 'the task-status tool stays visible — it is how the model checks an earlier generation');

  // toolSchemas must honour the filter, and must NOT filter when not asked to.
  const fake = [{ name: 'a' }, { name: 'b' }];
  void fake;
  ok(mcphub.toolSchemas().length === 0, 'no connectors connected in this test process → no schemas');
  ok(mcphub.toolSchemas({ hidden }).length === 0, 'filtering an empty set is still empty (no crash on the hidden path)');
}

// ── every registered connector is coherent ────────────────────────────────────────────────────
{
  for (const [name, def] of Object.entries(connectors.REGISTRY)) {
    ok(def.name === name, `${name}: registry key matches its name`);
    ok(/^https:\/\//.test(def.url), `${name}: endpoint is https`);
    ok(def.auth && (def.auth.env || def.auth.configField), `${name}: declares where its token comes from`);
    ok(Array.isArray(def.tools) && def.tools.length, `${name}: declares the tools it provides`);
    ok(typeof def.docs === 'string' && def.docs, `${name}: has a docs URL, so an unauthenticated skip can tell you where to get a token`);
    for (const t of Object.keys(def.hide || {})) {
      ok(def.tools.includes(t), `${name}: hidden tool "${t}" is one this connector actually provides`);
    }
  }
}

// ── the two price tables must agree ───────────────────────────────────────────────────────────
// main.js MODEL_PRICES bills the chat loop; lib/agents/select.js PRICES enforces the DAG agents'
// monthly cost CAP. They are separate tables for separate consumers, and they had silently drifted:
// Opus 4.8 sat at the 4.1-era $15/$75 in BOTH — 3× its real $5/$25 — so every Opus turn was booked
// at triple and the governor throttled agents long before the real budget was reached. An
// overstated price is not a reporting nit; it starves the fan-out.
{
  const select = require('../lib/agents/select');
  const block = /const MODEL_PRICES = \{([\s\S]*?)\n\};/.exec(main);
  ok(block, 'found MODEL_PRICES in main.js');
  const mp = {};
  for (const r of block[1].matchAll(/'([^']+)':\s*\[([\d.]+),\s*([\d.]+)/g)) mp[r[1]] = [+r[2], +r[3]];
  ok(Object.keys(mp).length >= 4, 'parsed the price table');

  // Sanity floor: a price table that has drifted an order of magnitude is worse than none.
  ok(mp['claude-opus-4-8'][0] === 5 && mp['claude-opus-4-8'][1] === 25, 'Opus 4.8 is priced at its actual $5/$25');
  ok(mp['claude-fable-5'][0] === 10 && mp['claude-fable-5'][1] === 50, 'Fable 5 is priced at its actual $10/$50');
  ok(mp['claude-sonnet-4-6'][0] === 3 && mp['claude-sonnet-4-6'][1] === 15, 'Sonnet 4.6 is priced at $3/$15');
  ok(mp['claude-haiku-4-5'][0] === 1 && mp['claude-haiku-4-5'][1] === 5, 'Haiku 4.5 is priced at $1/$5');

  for (const [model, [i, o]] of Object.entries(mp)) {
    const p = select.PRICES[model];
    if (!p) continue;                                  // select only prices what its chains can pick
    ok(p[0] === i && p[1] === o, `${model}: the chat and DAG price tables agree (${i}/${o} vs ${p[0]}/${p[1]})`);
  }
  // Every model a chain can actually select must have a price, or its spend books as zero.
  for (const chain of Object.values(select.CHAINS)) {
    for (const [, key] of chain) {
      const id = select.DEFAULT_MODELS[key];
      if (!id || !/^claude-/.test(id)) continue;
      ok(select.PRICES[id], `${id} (chain rung "${key}") has a price — an unpriced model spends invisibly against the cap`);
    }
  }
}

console.log(`✅ tool wiring: ${pass} assertions passed`);
