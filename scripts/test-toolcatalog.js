'use strict';
// Tests for lib/toolcatalog.js — the two-level tool catalog that replaces flat top-k retrieval.
//
// The token numbers here are MEASURED against the live lib/tools-schema.js, not asserted from the
// plan. If a tool's description grows, these move, and that is the point: the claim "a typical turn
// costs half what it used to" should fail loudly when it stops being true rather than living on in
// a markdown file.
//
// The routing fixtures are the ten recorded misses from BENCH_APP.md (2026-08-13), where the
// embedding retrieval returned nothing and the full catalog went on the wire. They are the closest
// thing to labelled ground truth this repo has.

const assert = require('assert');
const tc = require('../lib/toolcatalog');
const buildSchema = require('../lib/tools-schema.js');

const TOOLS = buildSchema({ MEMORY_SECTIONS: ['about', 'prefs', 'projects'] });
const est = (o) => Math.ceil(JSON.stringify(o).length / 4);
const FULL = est(TOOLS);

let pass = 0;
const ok = (m) => { console.log('✅ ' + m); pass++; };

// ── every tool is placed, and placed once ─────────────────────────────────────────────────────────
{
  const seen = new Map();
  for (const [key, c] of Object.entries(tc.CATEGORIES)) {
    for (const t of c.tools) {
      assert.ok(!seen.has(t), `${t} is in two categories: ${seen.get(t)} and ${key}`);
      seen.set(t, key);
    }
  }
  ok(`no tool is in two categories (${seen.size} placed across ${Object.keys(tc.CATEGORIES).length} categories)`);

  // A category naming a tool that no longer exists is dead weight that reads as coverage.
  const live = new Set(TOOLS.map((t) => t.name));
  const ghosts = [...seen.keys()].filter((n) => !live.has(n));
  assert.deepStrictEqual(ghosts, [], `categories name tools that are not in the catalog: ${ghosts.join(', ')}`);
  ok('no category names a tool that no longer exists');

  // The reverse: anything in the catalog with no category. Allowed, but it must be VISIBLE, because
  // an uncategorized tool is one that never gets resolved to — only ever reached via toolbox.
  const { unsorted } = tc.groupTools(TOOLS);
  if (unsorted.length) console.log(`   ℹ uncategorized (always on the wire): ${unsorted.join(', ')}`);
  assert.ok(unsorted.length <= 3, `too many uncategorized tools (${unsorted.length}) — categorize them: ${unsorted.join(', ')}`);
  ok(`every catalog tool is categorized or explicitly unsorted (${unsorted.length} unsorted)`);
}

// ── the recorded misses from BENCH_APP.md now resolve ─────────────────────────────────────────────
{
  const FIXTURES = [
    ['resize these screenshots to 800px', 'file_tools'],
    ['merge these three PDFs', 'file_tools'],
    ['undo what you archived this morning', 'triage_mail'],
    ['what did you do to my inbox today', 'triage_mail'],
    ['search my gmail for the adaptyv thread', 'gmail'],
    ['put an event on my calendar for tuesday', 'calendar'],
    ['take a screenshot of the screen', 'screen_parse'],
    ['run a python simulation of the pendulum', 'simulate'],
    ['what is on my calendar tomorrow', 'calendar'],
    ['render this molecule', 'molecule'],
  ];
  const missed = [];
  for (const [q, want] of FIXTURES) {
    const r = tc.select(q, TOOLS);
    if (!r.names.includes(want)) missed.push(`${q} → wanted ${want}, got [${r.categories.join(',')}]`);
  }
  assert.deepStrictEqual(missed, [], 'BENCH_APP misses still missing:\n  ' + missed.join('\n  '));
  ok(`all 10 recorded retrieval misses now reach their tool (was 0/10)`);
}

// ── everyday queries land somewhere sensible ──────────────────────────────────────────────────────
{
  const CASES = [
    ['play some music', 'media_control'],
    ['what is the weather', 'maps'],
    ['commit this and push', 'run_shell'],
    ['build me a 3d model of a lamp in blender', 'make_model'],
    ['log into github for me', 'smart_login'],
    ['remember that I prefer terse answers', 'save_memory'],
    ['what are you running right now', 'ops_status'],
    ['read ~/notes/todo.md', 'read_file'],
    ['how did I sleep last night', 'health'],
    ['search the web for adaptyv results', 'web_search'],
    ['who is winning the world cup', 'world_cup'],
    ['run three agents on this in parallel', 'agent_team'],
  ];
  const missed = [];
  for (const [q, want] of CASES) {
    const r = tc.select(q, TOOLS);
    if (!r.names.includes(want)) missed.push(`${q} → wanted ${want}, got [${r.categories.join(',')}]`);
  }
  assert.deepStrictEqual(missed, [], 'everyday routing misses:\n  ' + missed.join('\n  '));
  ok(`${CASES.length} everyday queries reach the right tool`);
}

// ── THE COST CLAIM, measured ──────────────────────────────────────────────────────────────────────
{
  const OLD_CORE = ['save_memory', 'read_file', 'write_file', 'run_shell', 'notify_user', 'ask_options',
    'show_visuals', 'build_project', 'ask_ai', 'request_permissions', 'self_reflect', 'mission_plan'];
  const oldCoreTok = est(TOOLS.filter((t) => OLD_CORE.includes(t.name)));

  const toolbox = tc.toolboxSchema();
  const newCore = est([toolbox, ...TOOLS.filter((t) => tc.CORE.includes(t.name))]);

  console.log(`   full catalog ........ ${FULL}`);
  console.log(`   old CORE (12) ....... ${oldCoreTok}`);
  console.log(`   new CORE + toolbox .. ${newCore}`);

  assert.ok(newCore < oldCoreTok / 2, `new CORE (${newCore}) must be less than half the old (${oldCoreTok})`);
  ok(`CORE shrinks ${oldCoreTok} → ${newCore} tokens (−${Math.round((1 - newCore / oldCoreTok) * 100)}%)`);

  // A representative spread of real turns, costed end to end.
  const TURNS = [
    'resize these screenshots to 800px',
    'what is on my calendar tomorrow',
    'build me a 3d model of a lamp in blender',
    'run a python simulation of the pendulum',
    'commit this and push',
    'play some music',
    'search my gmail for the adaptyv thread',
    'log into github for me',
  ];
  let total = 0;
  const rows = TURNS.map((q) => {
    const r = tc.select(q, TOOLS);
    const cost = est([toolbox, ...r.tools]);
    total += cost;
    return { q, cost, n: r.names.length, cats: r.categories.join(',') };
  });
  const mean = Math.round(total / TURNS.length);
  for (const r of rows) console.log(`   ${String(r.cost).padStart(5)} tok · ${String(r.n).padStart(2)} tools · ${r.cats.padEnd(22)} ${r.q}`);
  console.log(`   mean ................ ${mean}`);

  // The old selected mode was CORE(12) + top-12 ≈ 4,778 tokens on every turn.
  const OLD_TYPICAL = 4778;
  assert.ok(mean < OLD_TYPICAL, `mean turn (${mean}) must beat the old selected mode (${OLD_TYPICAL})`);
  ok(`mean turn ${OLD_TYPICAL} → ${mean} tokens (−${Math.round((1 - mean / OLD_TYPICAL) * 100)}%), full catalog is ${FULL}`);

  // And the headline: the fallback is gone.
  const nonsense = tc.select('asdkjfh qwerty zzz', TOOLS);
  const worst = est([toolbox, ...nonsense.tools]);
  assert.ok(worst < FULL / 10, `the no-match case (${worst}) must not approach the full catalog (${FULL})`);
  ok(`a query that matches NOTHING costs ${worst} tokens, not ${FULL} — the silent full-catalog fallback is gone`);
}

// ── select() never returns null, and never returns everything ─────────────────────────────────────
{
  for (const q of ['', null, undefined, '   ', 'zzzz', '🙂', 'a'.repeat(5000)]) {
    const r = tc.select(q, TOOLS);
    assert.ok(r && Array.isArray(r.tools), `select(${JSON.stringify(String(q).slice(0, 12))}) must return a result`);
    assert.ok(r.tools.length < TOOLS.length, 'select must never return the entire catalog');
  }
  ok('every degenerate query returns a small, well-formed subset — never null, never everything');
}

// ── the invariant: an unknown tool is never dropped ───────────────────────────────────────────────
{
  const withConnector = [...TOOLS,
    { name: 'acme_crm_lookup', description: 'A tool that arrived from a connector at runtime.', input_schema: { type: 'object', properties: {} } }];
  const r = tc.select('what is on my calendar tomorrow', withConnector);
  assert.ok(r.names.includes('acme_crm_lookup'), 'an uncategorized runtime tool must stay on the wire');
  assert.ok(r.unsorted.includes('acme_crm_lookup'), 'and must be reported as unsorted, not silently absorbed');
  ok('a connector tool with no category is always offered and reported, never silently dropped');
}

// ── CORE is always present ────────────────────────────────────────────────────────────────────────
{
  const r = tc.select('run a python simulation of the pendulum', [...TOOLS, tc.toolboxSchema()]);
  assert.ok(r.names.includes('toolbox'), 'toolbox must be on the wire — it is the escape hatch');
  assert.ok(r.names.includes('notify_user'), 'notify_user must be on the wire');
  ok('CORE (toolbox + notify_user) is on every turn');
}

// ── toolbox carries the whole map, cheaply ────────────────────────────────────────────────────────
{
  const s = tc.toolboxSchema();
  const cost = est(s);
  for (const k of Object.keys(tc.CATEGORIES)) {
    assert.ok(s.description.includes(k), `toolbox description must name the "${k}" category`);
    assert.ok(s.input_schema.properties.category.enum.includes(k), `enum must include "${k}"`);
  }
  // The whole map for the price of two average tool schemas (mean tool = ~300 tokens). If a
  // category summary grows into a manifest this fails, which is the intent — the summaries exist to
  // let a model CHOOSE a category, not to document its contents.
  assert.ok(cost < 500, `the toolbox schema must stay cheap (${cost} tokens)`);
  ok(`toolbox exposes all ${Object.keys(tc.CATEGORIES).length} categories for ${cost} tokens`);
}

// ── expand / describe round-trip ──────────────────────────────────────────────────────────────────
{
  const exp = tc.expand('science', TOOLS);
  assert.ok(exp.length >= 4 && exp.every((t) => t.input_schema), 'expand returns real schemas');
  assert.ok(exp.some((t) => t.name === 'simulate'));

  const d = tc.describe('mail', TOOLS);
  assert.strictEqual(d.category, 'mail');
  assert.ok(d.tools.some((t) => t.name === 'gmail' && t.summary.length > 10));
  assert.strictEqual(tc.describe('nope', TOOLS), null, 'an unknown category is null, not a throw');

  // describe() is the cheap answer to a toolbox call; it must be far cheaper than the schemas.
  assert.ok(est(d) < est(exp) / 2, 'a category description must cost far less than its full schemas');
  ok('expand returns schemas, describe returns a cheap summary, unknown category is null');
}

// ── the reranker is optional, bounded, and cannot break a turn ────────────────────────────────────
{
  const base = tc.select('read ~/notes/todo.md', TOOLS);
  const throwing = tc.select('read ~/notes/todo.md', TOOLS, { rank: () => { throw new Error('embedder down'); } });
  assert.deepStrictEqual(throwing.names, base.names, 'a throwing reranker must cost nothing');

  const reversing = tc.select('read ~/notes/todo.md', TOOLS, { rank: (names) => [...names].reverse() });
  assert.deepStrictEqual(new Set(reversing.names), new Set(base.names), 'reordering must not change the SET');

  // A reranker may narrow a category, but it must never be able to strip CORE — the escape hatch
  // and the out-of-band channel are not the ranker's to remove.
  const withBox = [...TOOLS, tc.toolboxSchema()];
  const trimming = tc.select('read ~/notes/todo.md', withBox, { rank: (names) => names.slice(0, 1) });
  const baseBox = tc.select('read ~/notes/todo.md', withBox);
  assert.ok(trimming.names.length < baseBox.names.length, 'a trimming reranker narrows the wire');
  assert.ok(trimming.names.includes('toolbox') && trimming.names.includes('notify_user'), 'but CORE survives any reranker');
  ok('the embedding reranker is optional: it may reorder or trim, and a failure costs nothing');
}

// ── resolution is stable and explains itself ──────────────────────────────────────────────────────
{
  const a = tc.select('merge these three PDFs', TOOLS);
  const b = tc.select('merge these three PDFs', TOOLS);
  assert.deepStrictEqual(a.names, b.names, 'the same query must always resolve identically');
  assert.match(a.reason, /files/, 'the reason names the category that fired');
  assert.match(tc.select('zzz', TOOLS).reason, /no category matched/);
  ok('resolution is deterministic and reports why');
}

// ── breadth is capped ─────────────────────────────────────────────────────────────────────────────
{
  const kitchenSink = 'search the web, email it, render a 3d model, run a simulation, log in, and remember it';
  const r = tc.select(kitchenSink, TOOLS);
  assert.ok(r.categories.length <= 3, `a sprawling request loads at most 3 categories, got ${r.categories.length}`);
  assert.ok(est(r.tools) < FULL / 2, 'even a sprawling request stays well under the full catalog');
  ok('a request spanning everything still loads at most 3 categories — the rest is one toolbox call');
}

console.log(`\n✅ toolcatalog: ${pass} groups passed`);
