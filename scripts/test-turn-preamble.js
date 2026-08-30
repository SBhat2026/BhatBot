#!/usr/bin/env node
'use strict';
// THE TURN PREAMBLE — the stretch between "Siddhant hit enter" and "the first model call".
//
// Two properties are asserted here, both of which were silently violated and neither of which any
// existing test could see, because both are about the SHAPE of agentLoop rather than its output:
//
//   1. Everything keys off the REQUEST, not the mission anchor. `lastUserText(history)` after the
//      anchor is appended returns the anchor — a block about goals, plans and budgets — so mode
//      classification, all three recalls, tool retrieval, the planner, the action-verify judge and
//      the procedural trigger key were all reading mission bookkeeping instead of the ask.
//   2. The independent stages OVERLAP. Recall, retrieval and planning depend only on the request and
//      on nothing each other produces; awaited one at a time, the wait before the first token is
//      their sum instead of their max.
//
// Checked against the PARSED SOURCE, not with grep. A regex here would match the comments that
// describe the bug — which has happened twice in this repo — and structure is exactly what a future
// edit would break without changing any behaviour a normal test observes.
//
// Run: node scripts/test-turn-preamble.js   (wired into npm run verify)
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('❌ ' + m); } };

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// The TypeScript compiler API ships with the repo and parses plain JS happily; using it beats
// adding a parser dependency for one test.
let ts;
try { ts = require('typescript'); }
catch { console.log('⏭  preamble structure skipped — no parser available'); process.exit(0); }

const sf = ts.createSourceFile('main.js', SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}
/** The `async function <name>(...)` declaration node. */
function findFn(name) {
  let found = null;
  walk(sf, (n) => {
    if (!found && ts.isFunctionDeclaration(n) && n.name && n.name.text === name) found = n;
  });
  return found;
}
function nodes(root, pred) {
  const out = [];
  walk(root, (n) => { if (pred(n)) out.push(n); });
  return out;
}
const src = (n) => SRC.slice(n.getStart(sf), n.end);
const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

// Shorthands over the TS node shapes used below.
const isCallTo = (n, name) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name;
const declNamed = (root, name) => nodes(root, (n) => ts.isVariableDeclaration(n)
  && ts.isIdentifier(n.name) && n.name.text === name)[0];

const loop = findFn('agentLoop');
ok(!!loop, 'agentLoop is a top-level function declaration');
if (!loop) { console.log(`\n❌ preamble: ${pass} passed, ${fail} failed`); process.exit(1); }

// ── 1. the request is captured, and captured EARLY ──────────────────────────────────────────────
const askDecl = declNamed(loop, '_ask');
ok(!!askDecl, '_ask is declared inside agentLoop');

// The anchor append: the call `_mission.anchor(...)`.
const anchorNode = nodes(loop, (n) => ts.isCallExpression(n)
  && ts.isPropertyAccessExpression(n.expression)
  && n.expression.name.text === 'anchor')[0];
ok(!!anchorNode, 'the mission anchor is still appended (the hazard this guards against still exists)');
if (askDecl && anchorNode) {
  ok(askDecl.getStart(sf) < anchorNode.getStart(sf),
    '_ask is captured BEFORE the mission anchor is appended — after it, lastUserText returns the anchor');
}

// ── 2. nothing in the preamble re-derives the text from history ─────────────────────────────────
// Every lastUserText(history) call after the anchor is a re-read of a history that now ends in the
// anchor. One is allowed: the `_ask` declaration itself, which happens before.
const reReads = nodes(loop, (n) => isCallTo(n, 'lastUserText')
  && n.arguments.length === 1 && ts.isIdentifier(n.arguments[0]) && n.arguments[0].text === 'history')
  .filter((n) => anchorNode && n.getStart(sf) > anchorNode.getStart(sf));
ok(reReads.length === 0,
  `no lastUserText(history) re-read after the anchor append (found ${reReads.length}: `
  + reReads.map((n) => 'line ' + line(n)).join(', ') + ')');

// ── 3. the three stages are STARTED before any is AWAITED ───────────────────────────────────────
const decl = (name) => declNamed(loop, name);
const recallP = decl('recallP'), toolsP = decl('toolsP'), planP = decl('planP');
ok(!!recallP, 'recallP is created as a promise, not awaited inline');
ok(!!toolsP, 'toolsP is created as a promise, not awaited inline');
ok(!!planP, 'planP is created as a promise, not awaited inline');

if (recallP && toolsP && planP) {
  // None of the three declarations may itself contain a top-level await — that would serialize it.
  for (const [name, d] of [['recallP', recallP], ['toolsP', toolsP], ['planP', planP]]) {
    const awaits = nodes(d.initializer, (n) => ts.isAwaitExpression(n));
    ok(awaits.length === 0, `${name} is not awaited at the point it is created (that would restore the serial chain)`);
  }
  // The FIRST await of any of them must come after ALL THREE exist.
  const lastDecl = Math.max(recallP.end, toolsP.end, planP.end);
  const firstAwait = nodes(loop, (n) => ts.isAwaitExpression(n)
    && ts.isIdentifier(n.expression) && ['recallP', 'toolsP', 'planP'].includes(n.expression.text))
    .sort((a, b) => a.getStart(sf) - b.getStart(sf))[0];
  ok(!!firstAwait, 'the preamble promises are awaited somewhere');
  if (firstAwait) {
    ok(firstAwait.getStart(sf) > lastDecl,
      'all three preamble stages are in flight before the first one is awaited — the critical path is max(), not sum()');
  }
}

// ── 4. the planner is chained on retrieval, deliberately ────────────────────────────────────────
// It is the one stage that is NOT raced: it is told which tools this turn actually has, which costs
// ~50ms and stops the plan describing capabilities BhatBot does not have this turn.
if (planP) {
  ok(/toolsP\s*\.then\(/.test(src(planP)),
    'the planner runs after retrieval so it can be told the real tool list');
}

// ── 5. the post-turn judges read the request too ────────────────────────────────────────────────
const userText0 = decl('userText0');
ok(!!userText0 && /=\s*_ask\b/.test(src(userText0)),
  'userText0 (action-verify judge + procedural trigger key) is the request, not a re-read of history');

// ── 6. the latency clock starts on every surface ────────────────────────────────────────────────
// It used to start only in the desktop `chat` IPC, so every latMark and latStage was a no-op on the
// headless/ctl/phone paths — i.e. exactly the surface you would measure a turn from.
const inner = findFn('_dispatchTurnInner');
ok(!!inner && nodes(inner, (n) => isCallTo(n, 'latStart')).length > 0,
  'the latency clock is started in _dispatchTurnInner, which every surface routes through');

console.log(`\n${fail ? '❌' : '✅'} turn preamble: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
