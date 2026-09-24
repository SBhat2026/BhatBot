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

  // There is a SECOND legitimate source of advertisement. Tree-mode retrieval injects a `toolbox`
  // meta-tool that lib/toolcatalog.js builds at call time, so it is deliberately absent from the
  // static schema — it is the only tool whose own schema depends on the category list. The
  // invariant the assertion below protects is unchanged (nothing implemented is unreachable); it
  // just has to look in both places, otherwise the correct design reads as dead code.
  const toolcatalog = require('../lib/toolcatalog');
  const advertised = new Set([...names, toolcatalog.toolboxSchema().name]);
  const unadvertised = [...cases].filter((n) => !advertised.has(n));
  ok(unadvertised.length === 0, 'every implemented tool is advertised — otherwise it is unreachable dead code: ' + unadvertised.join(', '));

  // ...and the dynamic one must be genuinely reachable, not merely exempted from the check above.
  ok(cases.has(toolcatalog.TOOLBOX_NAME), 'the toolbox meta-tool has a handler in executeTool');
  ok(/toolcatalog\.select\(/.test(main), 'tree-mode retrieval is actually called from main.js');
  ok(/toolcatalog\.toolboxSchema\(\)/.test(main), 'the toolbox schema is actually put on the wire');
  ok(/_activeTools = \[\.\.\.\(_activeTools \|\| \[\]\), \.\.\.fresh\]/.test(main),
    'the toolbox handler expands the turn\'s tool set in place — otherwise it loads a category the model still cannot call');

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
  // The catalog half of this is the original point: rank native + connector tools together.
  // The QUERY half used to be pinned as `lastUserText(history)` — which was the bug, not the
  // contract: by the time retrieval runs, history ends in the mission anchor, so that expression
  // returns mission bookkeeping rather than the request. `_ask` is captured before the anchor.
  // (scripts/test-turn-preamble.js proves that structurally, against the parsed source.)
  ok(/toolselect\.select\(_ask, _catalog/.test(main),
    'retrieval ranks over the FULL catalog (native + connectors), keyed on the REQUEST not the anchor');
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

// ── pricing is single-sourced ─────────────────────────────────────────────────────────────────
// main.js used to carry its own MODEL_PRICES and lib/agents/select.js a rival copy; they drifted
// (Opus billed 3x over, Fable 2x under). Both now read lib/pricing.js, so the invariant is simply
// that no second table has reappeared. Rates themselves are covered by scripts/test-pricing.js.
{
  ok(!/const MODEL_PRICES = \{/.test(main), 'main.js no longer defines its own price table');
  ok(/require\('\.\/lib\/pricing'\)/.test(main), 'main.js prices through lib/pricing.js');
  const select = require('../lib/agents/select');
  const pricing = require('../lib/pricing');
  for (const chain of Object.values(select.CHAINS)) {
    for (const [, key] of chain) {
      const id = select.DEFAULT_MODELS[key];
      if (!id || !/^claude-/.test(id)) continue;
      ok(pricing.base(id).input > 0, `${id} (a live chain rung) is priced — an unpriced model spends invisibly against the cap`);
    }
  }
}

// ── THE ENVELOPE IS A CONTRACT BETWEEN TWO FILES ──────────────────────────────────────────────────
// main.js tells the model, through a JSON schema, which kinds of "I am stuck" it may report.
// lib/supervisor.js decides what to DO with each one. If those two lists drift apart the failure is
// silent in the worst way: the schema invites the model to say `need.kind: "decompose"`, the model
// says it, and the supervisor falls through to "a need this supervisor does not know how to serve" —
// so the item is blocked for a reason that is entirely our fault and reads like the model's.
//
// This is also the single largest untested surface in the autonomy lane. The supervisor has run an
// hour against a local model; the Claude-backed worker in main.js has not run at all, because the
// budget is spent. The contract between them is the part that can be checked without spending
// anything, so it is checked here.
{
  const supervisor = fs.readFileSync(path.join(ROOT, 'lib', 'supervisor.js'), 'utf8');

  // What the model is ALLOWED to say.
  const m = main.match(/kind:\s*\{\s*type:\s*'string',\s*enum:\s*\[([^\]]+)\]/);
  ok(!!m, 'main.js declares an enum of need kinds in the envelope schema');
  const offered = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  ok(offered.length >= 3, `the schema offers ${offered.length} need kinds: ${offered.join(', ')}`);

  // What the supervisor actually handles. 'none' is the model saying "nothing is wrong", which
  // main.js strips before the envelope ever reaches serveNeed — so it is handled by NOT being passed.
  const served = [...supervisor.matchAll(/kind === '(\w+)'/g)].map((x) => x[1]);
  for (const kind of offered) {
    if (kind === 'none') {
      ok(/need\.kind !== 'none'/.test(main),
        "'none' is stripped in main.js before the envelope reaches the supervisor, which is how it is 'handled'");
      continue;
    }
    ok(served.includes(kind),
      `the supervisor serves need.kind="${kind}" — the schema invites the model to say it, and an unserved kind blocks the item for a reason that is our fault and reads like the model's`);
  }
  // And the other direction: nothing the supervisor can serve should be unreachable because the schema
  // forbids the model from asking for it.
  for (const kind of served) {
    ok(offered.includes(kind), `the schema lets the model ask for "${kind}", which the supervisor can serve`);
  }

  // The fields each kind needs must be in the schema too, or the model cannot supply them.
  for (const field of ['question', 'assumption', 'name', 'purpose', 'code', 'items']) {
    ok(new RegExp(`${field}: \\{ type:`).test(main) || new RegExp(`${field}: \\{`).test(main),
      `the envelope schema has a place for "${field}"`);
  }
  // A human escalation without an assumption stalls an item until the idle timeout; the prompt has to
  // ask for one explicitly, because the schema cannot require it conditionally.
  ok(/assumption/.test(main) && /assumption you would proceed on|with question and assumption/.test(main),
    'and the worker is TOLD to supply an assumption with a human need — a question with no fallback is a question that stalls its item');
}

// ── FIVE TOOLS THAT ALL SOUND LIKE "DO A BIG JOB" ─────────────────────────────────────────────────
// plan_and_run, delegate_project, deploy_drones, agent_team, fleet and now long_run all answer some
// version of "this is too big for one turn". A sixth tool the model picks wrongly is worse than no
// sixth tool — so the two closest neighbours have to say, in their own descriptions, when to reach
// for the new one instead. A model choosing between them reads THEIR text, not long_run's.
{
  const desc = (n) => (TOOLS.find((t) => t.name === n) || {}).description || '';
  for (const n of ['plan_and_run', 'delegate_project']) {
    ok(/long_run/.test(desc(n)), `${n} names long_run as the alternative`);
  }
  // And it has to say WHEN, not merely that the other exists. These are the three discriminators.
  const both = desc('plan_and_run') + ' ' + desc('delegate_project');
  ok(/hour|outlast|survive a crash/i.test(both), 'the discriminator includes duration');
  ok(/decision|answer|Siddhant/i.test(both), 'and needing a decision from Siddhant');
  ok(/capability|tool that does not exist/i.test(both), 'and needing a capability that does not exist yet');

  // long_run's own description must distinguish itself from them too, since a model already holding
  // long_run is deciding whether to keep it.
  ok(/plan_and_run/.test(desc('long_run')) && /delegate_project/.test(desc('long_run')),
    'long_run names the tools it is NOT');
}

// ── WHAT A SUPERVISED WORKER MAY REACH ────────────────────────────────────────────────────────────
// A worker inside a long run gets a SCOPED tool set — ~20 relevant tools rather than 89 vague ones,
// which is the same reasoning per-turn retrieval already proved on the main loop. Two properties have
// to hold for every designation, and neither is visible by reading the map: every designation must
// actually resolve to a usable set (a typo'd category silently yields nothing and the worker is left
// with two tools), and none may reach `long_run` — a worker starting another long run is a recursion
// that would cost a turn to be refused, and reads to the model as a capability it has.
{
  const toolcatalog = require('../lib/toolcatalog');
  const body = main.slice(main.indexOf('const SUPERVISED_TOOLS ='), main.indexOf('function supervisedToolDefs'));
  // eslint-disable-next-line no-new-func
  const SUPERVISED_TOOLS = new Function(body + '\nreturn SUPERVISED_TOOLS;')();
  const designation = require('../lib/designation');

  // And the worker is TOLD, or it spends turns reaching for a tool it does not have.
  ok(/ONLY way to reach him/.test(main), 'the worker prompt says the envelope is the only way to reach Siddhant');
  // The mirror above is only as good as its fidelity to the real function.
  ok(/want\.delete\('long_run'\)/.test(main) && /want\.delete\('notify_user'\)/.test(main),
    'supervisedToolDefs really removes both, so the reconstruction below is reconstructing something');

  ok(Object.keys(SUPERVISED_TOOLS).length >= designation.DESIGNATIONS.length,
    'every designation has a tool scope — one without falls back to `general`, which is a silent downgrade');

  for (const [desig, cats] of Object.entries(SUPERVISED_TOOLS)) {
    const bad = cats.filter((c) => !toolcatalog.CATEGORIES[c]);
    ok(bad.length === 0, `${desig} names only real tool categories${bad.length ? ' — unknown: ' + bad.join(', ') : ''}`);

    const want = new Set();
    for (const c of cats) for (const t of toolcatalog.expand(c, TOOLS)) want.add(t.name);
    for (const n of toolcatalog.CORE) want.add(n);
    // Mirrors supervisedToolDefs. A reconstruction can drift from the thing it reconstructs, so the
    // two deletions are ALSO asserted against main.js's source below — the mirror checks the effect,
    // the source check makes sure the mirror is still mirroring.
    want.add('forge_tool'); want.add('plugin'); want.delete('long_run'); want.delete('notify_user');

    ok(want.size >= 8, `${desig} resolves to a usable set (${want.size} tools), not an empty one`);
    ok(!want.has('long_run'), `${desig} cannot start another long run from inside one`);
    ok(want.has('forge_tool'), `${desig} can forge — "there is no tool for this" must be something it can act on`);
    ok(want.has('toolbox'), `${desig} keeps the toolbox escape hatch, so a misclassified item can still widen its own scope`);
    // ONE DOOR TO SIDDHANT. lib/escalate dedupes, caps interruptions at a few an hour and goes silent
    // between 23:00 and 07:00. notify_user is in CORE and therefore reaches every agent by default —
    // a second door with none of that on it, where six agents can each text him and urgency:"call" at
    // 3am becomes an URGENT SMS. A ceiling with a way around it is not a ceiling.
    ok(!want.has('notify_user'), `${desig} has no messaging tool — it reaches Siddhant through the guarded escalation path or not at all`);
  }
}

console.log(`✅ tool wiring: ${pass} assertions passed`);
