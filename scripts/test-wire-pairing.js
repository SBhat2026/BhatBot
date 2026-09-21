'use strict';
// THE PAIRING GUARANTEE — every Anthropic call must leave this process with each `tool_use`
// answered by tool_results in the immediately following message.
//
// The API rejects anything else with `tool_use ids were found without tool_result blocks`, and that
// 400 has now surfaced three times through three different doors. The repair itself
// (lib/history.validateHistory) was never the problem — it handles every adversarial shape below.
// The problem was WHERE it was applied: capTokens, which only protects callers that route through
// capTokens. Two do not, and one of them broke the morning brief on 2026-09-21 at messages.4.
//
// So this suite asserts two separate things:
//   1. validateHistory repairs every shape we can construct (unit level);
//   2. the repair sits on the ACTUAL chokepoint, anthropicRequest, so a new caller cannot
//      reintroduce the bug by assembling messages in a way nobody anticipated (structural level).
// The second half is the one that would have caught this.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateHistory } = require('../lib/history');

let pass = 0;
const ok = (m) => { console.log('✅ ' + m); pass++; };

const tu = (id, name) => ({ type: 'tool_use', id, name: name || 'read_file', input: {} });
const tr = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });
const A = (...b) => ({ role: 'assistant', content: b });
const U = (...b) => ({ role: 'user', content: b });
const T = (t) => ({ type: 'text', text: t });

/** The API's own rule, restated as an assertion we can run locally. */
function unpaired(msgs) {
  const bad = [];
  msgs.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (!ids.length) return;
    const n = msgs[i + 1];
    const answered = (n && n.role === 'user' && Array.isArray(n.content))
      ? new Set(n.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)) : new Set();
    for (const id of ids) if (!answered.has(id)) bad.push(`msg ${i}: ${id}`);
  });
  // The other half of the rule: a tool_result with no tool_use before it is equally rejected.
  msgs.forEach((m, i) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return;
    const results = m.content.filter((b) => b.type === 'tool_result');
    if (!results.length) return;
    const prev = msgs[i - 1];
    const ids = new Set((prev && prev.role === 'assistant' && Array.isArray(prev.content))
      ? prev.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : []);
    for (const r of results) if (!ids.has(r.tool_use_id)) bad.push(`msg ${i}: orphan result ${r.tool_use_id}`);
  });
  return bad;
}

// ── 1. the repair itself ──────────────────────────────────────────────────────────────────────────
{
  const CASES = [
    ['a trailing tool_use nobody answered', [U(T('hi')), A(tu('t1'))]],
    ['a mid-history tool_use interrupted by a new user turn', [U(T('a')), A(tu('t1')), U(T('interrupt')), A(T('b'))]],
    ['parallel tool_use where only one result came back', [U(T('a')), A(tu('t1'), tu('t2')), U(tr('t1')), A(T('done'))]],
    ['a lost result between two tool turns', [U(T('a')), A(tu('t1')), U(tr('t1')), A(tu('t2')), U(T('oops')), A(T('end'))]],
    ['an assistant turn following an unanswered tool_use', [U(T('a')), A(tu('t1')), A(T('b'))]],
    ['a result that arrives two messages late', [U(T('a')), A(tu('t1')), U(T('noise')), U(tr('t1'))]],
    ['a plain-string user message after a tool_use', [U(T('a')), A(tu('t1')), { role: 'user', content: 'plain' }]],
    ['an orphan result with no tool_use at all', [U(T('a')), U(tr('ghost')), A(T('b'))]],
    ['the shape that failed live — unanswered at index 4', [U(T('a')), A(T('b')), U(T('c')), A(tu('t1'), tu('t2')), U(tr('t1')), A(T('z'))]],
  ];
  for (const [name, h] of CASES) {
    const out = validateHistory(h);
    assert.deepStrictEqual(unpaired(out), [], `${name} — still unpaired after repair`);
  }
  ok(`validateHistory repairs all ${CASES.length} adversarial shapes`);
}

// ── 2. a RAW WINDOW, which is how the drone path broke it ─────────────────────────────────────────
{
  // A long tool conversation, then sliced to the last N — exactly `hist.slice(-24)`. A slice can cut
  // either side of a pair, so both boundaries have to survive.
  const long = [U(T('start'))];
  for (let i = 0; i < 20; i++) { long.push(A(tu('t' + i))); long.push(U(tr('t' + i))); }
  let worst = 0;
  for (let n = 1; n <= 30; n++) {
    const raw = long.slice(-n);
    worst = Math.max(worst, unpaired(raw).length);
    assert.deepStrictEqual(unpaired(validateHistory(raw)), [], `slice(-${n}) still unpaired after repair`);
  }
  assert.ok(worst > 0, 'the test is worthless unless some raw slice was genuinely broken');
  ok(`every slice(-1..-30) of a tool conversation is repaired (raw slices broke ${worst ? 'as expected' : 'never'})`);
}

// ── 3. THE STRUCTURAL ONE — the repair is on the real chokepoint ──────────────────────────────────
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf('async function anthropicRequest(');
  assert.ok(start > 0, 'located anthropicRequest');
  const head = main.slice(start, start + 2600);
  assert.ok(/validateHistory\(body\.messages\)/.test(head),
    'anthropicRequest MUST validate body.messages itself — every Anthropic call in the process ' +
    'passes through it, which is what makes "every path is safe" a fact rather than a claim');

  // ...and it must happen before the body is handed onward, not after some other mutation.
  const vIdx = head.indexOf('validateHistory(body.messages)');
  const cIdx = head.indexOf('tagLastBlockForCache');
  assert.ok(vIdx > 0 && cIdx > vIdx, 'validation must run before the cache breakpoint is tagged');
  ok('anthropicRequest validates its own messages, before anything else touches them');
}

// ── 4. the two callers that bypassed capTokens ────────────────────────────────────────────────────
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/messages: hist\.slice\(-24\),/.test(main),
    'the drone window must not go to the wire unvalidated — it was the live failure');
  assert.ok(/validateHistory\(hist\.slice\(-24\)\)/.test(main),
    'the drone window validates at the source too, so the intent is visible where the slice is taken');
  ok('the drone window is validated where it is sliced, not only downstream');
}

// ── 5. idempotence, because it now runs on paths that already validated ───────────────────────────
{
  const h = [U(T('a')), A(tu('t1'), tu('t2')), U(tr('t1')), A(T('z'))];
  const once = validateHistory(h);
  const twice = validateHistory(once.map((m) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content })));
  assert.strictEqual(JSON.stringify(twice), JSON.stringify(once),
    'a second pass must change nothing — it now runs on every call, including already-clean ones');
  ok('validation is idempotent, so double-validated paths pay nothing and change nothing');
}

// ── 6. it must not eat a legitimate conversation ──────────────────────────────────────────────────
{
  const good = [U(T('what is in the file')), A(tu('t1')), U(tr('t1')), A(T('it defines the scheduler'))];
  assert.strictEqual(JSON.stringify(validateHistory(good)), JSON.stringify(good),
    'a well-formed conversation must survive byte-identical');
  const plain = [U(T('hello')), A(T('sir')), U(T('what time is it'))];
  assert.strictEqual(JSON.stringify(validateHistory(plain)), JSON.stringify(plain));
  ok('well-formed histories pass through untouched — the repair only repairs');
}

console.log(`\n✅ wire pairing: ${pass} groups passed`);
