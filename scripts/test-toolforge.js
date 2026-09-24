#!/usr/bin/env node
'use strict';
// Tests for lib/toolforge.js — the thing that lets BhatBot build the 88th tool.
//
// The tests that carry weight are the ones about REFUSAL, because a tool factory is only as good as
// what it declines to make:
//   • a tool whose cases fail is not registered;
//   • a tool whose cases would pass even if it returned null is not registered either — that is the
//     "check that tests the wrong thing" failure this repo has now made five times, and a factory
//     that let the tool grade itself would make it permanently;
//   • fs/net need Siddhant's word, and silence is not consent;
//   • child_process is refused outright, approval or no approval.
//
//   node scripts/test-toolforge.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const forgeMod = require('../lib/toolforge');
const realSandbox = require('../lib/sandbox');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
const mk = (over = {}) => forgeMod.createForge({ dir: TMP, sandbox: realSandbox, now: () => 1758600000000, ...over });

// A genuinely useful little tool, of exactly the kind that has no built-in: parse a duration string.
const DURATION_CODE = `
  const m = /^(\\d+(?:\\.\\d+)?)\\s*(ms|s|m|h|d)$/i.exec(String(input.text || '').trim());
  if (!m) throw new Error('not a duration: ' + input.text);
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
  return { ms: Math.round(parseFloat(m[1]) * mult), unit: m[2].toLowerCase() };
`;
const DURATION_TESTS = [
  { input: { text: '90s' }, expect: { equals: { ms: 90000, unit: 's' } } },
  { input: { text: '2.5h' }, expect: { keys: ['ms', 'unit'] } },
  { input: { text: 'banana' }, expect: { throws: true } },
];

(async () => {
  // ── the happy path, end to end through the real sandbox ─────────────────────────────────────────
  {
    let registered = null;
    const f = mk({ onForged: (t) => { registered = t; } });
    const r = await f.forge({ name: 'parse_duration', purpose: 'Turn "90s"/"2.5h" into milliseconds.', code: DURATION_CODE, tests: DURATION_TESTS, forgedFor: 'scheduling a follow-up' });
    ok(r.ok, 'a correct pure-compute tool forges' + (r.ok ? '' : ' — ' + JSON.stringify(r.errors)));
    ok(r.ok && r.cases.length === 3 && r.cases.every((c) => c.pass), 'all three declared cases were actually run and passed');
    ok(!!registered && registered.name === 'parse_duration', 'onForged fired so main.js can register it where `plugin` finds it');
    ok(fs.existsSync(path.join(TMP, 'parse_duration.json')), 'it is persisted, so it is still there tomorrow');
    ok(r.callWith && r.callWith.includes('parse_duration') && r.callWith.includes('text'),
      'the result states the exact call shape, including the input keys mined from the cases');

    // And it actually works when called.
    const call = await f.run('parse_duration', { text: '15m' });
    ok(call.success && call.result.ms === 900000, 'the forged tool runs and is right on an input it was never tested on');
    const missing = await f.run('nope', {});
    ok(!missing.success && /no forged tool/.test(missing.error), 'calling a tool that was never forged says so');

    ok(f.list().length === 1 && f.get('parse_duration').purpose.length > 0, 'list/get see it');
    ok(f.promptBlock().includes('parse_duration'), 'the prompt block tells the agent the tool exists — a tool it cannot see is a tool it does not have');
    ok(f.get('parse_duration').calls === 1, 'usage is counted, so a forged tool nobody calls is visible as dead weight');
  }

  // ── a tool that is simply wrong ──────────────────────────────────────────────────────────────────
  {
    let registered = null;
    const f = mk({ onForged: () => { registered = true; } });
    const r = await f.forge({ name: 'adder', purpose: 'Add two numbers.', code: 'return input.a - input.b;', tests: [{ input: { a: 5, b: 2 }, expect: { equals: 7 } }] });
    ok(!r.ok && r.stage === 'tests', 'a tool whose case fails is refused at the tests stage');
    ok(!registered && !fs.existsSync(path.join(TMP, 'adder.json')), 'nothing is registered and nothing is written when a case fails');
    ok(r.errors[0].includes('expected 7') && r.errors[0].includes('3'), 'the failure says what was expected and what came back');
  }

  // ── THE VACUOUS-TEST WALL ────────────────────────────────────────────────────────────────────────
  {
    const f = mk();
    // `{type:'object'}` on a tool that returns an object looks like a real assertion and is not one:
    // typeof null is 'object', so a totally broken tool passes it. This is the exact shape of the
    // bugs this repo keeps finding, and the point is that it is caught at forge time, for free.
    const r = await f.forge({ name: 'shape_only', purpose: 'Return a config object.', code: 'return { a: 1 };', tests: [{ input: {}, expect: { type: 'object' } }] });
    ok(!r.ok && r.stage === 'vacuous', 'a case that passes on a null result is refused — {type:"object"} passes for null');
    ok(r.errors[0].includes('returns null'), 'the refusal explains WHY the case asserts nothing');
    ok(!fs.existsSync(path.join(TMP, 'shape_only.json')), 'a vacuously-tested tool is not written');

    // The same tool with a real assertion forges fine, which is what makes the wall a nudge rather
    // than a blockade.
    const r2 = await f.forge({ name: 'shape_only', purpose: 'Return a config object.', code: 'return { a: 1 };', tests: [{ input: {}, expect: { equals: { a: 1 } } }] });
    ok(r2.ok, 'the same tool with an assertion that could fail forges');
  }

  // ── privilege ────────────────────────────────────────────────────────────────────────────────────
  {
    const noApprover = mk();
    const spec = { name: 'read_csv', purpose: 'Read a CSV off disk.', allow: ['fs'], code: 'return require("fs").existsSync(input.path);', tests: [{ input: { path: '/etc/hosts' }, expect: { equals: true } }] };
    const r = await noApprover.forge(spec);
    ok(!r.ok && r.stage === 'privilege' && r.refused.includes('fs'),
      'fs is refused when there is nobody to ask — silence is not consent for filesystem access');

    const denied = mk({ approve: async () => false });
    ok(!(await denied.forge(spec)).ok, 'fs is refused when Siddhant says no');

    let asked = null;
    const granted = mk({ approve: async (q) => { asked = q; return true; } });
    const r3 = await granted.forge(spec);
    ok(r3.ok, 'fs is granted when Siddhant says yes' + (r3.ok ? '' : ' — ' + JSON.stringify(r3.errors)));
    ok(asked && asked.modules.join() === 'fs' && asked.name === 'read_csv' && asked.purpose && asked.code,
      'the approval request names the tool, the purpose, the exact modules and shows the code — a prompt saying "allow modules?" is unanswerable');

    // Pure compute is never asked about, which is what keeps the gate from becoming noise.
    let askedAgain = false;
    const pure = mk({ approve: async () => { askedAgain = true; return true; } });
    await pure.forge({ name: 'upper', purpose: 'Uppercase a string.', code: 'return String(input.s).toUpperCase();', tests: [{ input: { s: 'hi' }, expect: { equals: 'HI' } }] });
    ok(!askedAgain, 'a pure-compute tool is forged without asking anything');
  }

  // ── refused outright ─────────────────────────────────────────────────────────────────────────────
  {
    const yesToEverything = mk({ approve: async () => true });
    for (const mod of ['child_process', 'worker_threads', 'vm', 'process']) {
      const r = await yesToEverything.forge({ name: 'escape_' + mod.replace(/[^a-z]/g, ''), purpose: 'x', allow: [mod], code: 'return 1;', tests: [{ input: {}, expect: { equals: 1 } }] });
      ok(!r.ok && r.stage === 'validate' && r.errors.join(' ').includes(mod),
        `${mod} is refused even with approval — it is a way out of the sandbox, not a capability`);
    }
  }

  // ── validation ───────────────────────────────────────────────────────────────────────────────────
  {
    const f = mk({ existingTools: () => ['web_search', 'gmail'] });
    const shadow = await f.forge({ name: 'gmail', purpose: 'x', code: 'return 1;', tests: [{ input: {}, expect: { equals: 1 } }] });
    ok(!shadow.ok && shadow.errors.join(' ').includes('built-in'),
      'a forged tool may not shadow a built-in — the built-in would go unreachable and read as broken');

    const noTests = await f.forge({ name: 'untested', purpose: 'x', code: 'return 1;' });
    ok(!noTests.ok && noTests.errors.join(' ').includes('at least one test'), 'a tool with no cases is refused');

    const badName = await f.forge({ name: 'X', purpose: 'x', code: 'return 1;', tests: [{ input: {}, expect: { equals: 1 } }] });
    ok(!badName.ok, 'a malformed name is refused');

    const noPurpose = await f.forge({ name: 'nameless', code: 'return 1;', tests: [{ input: {}, expect: { equals: 1 } }] });
    ok(!noPurpose.ok && noPurpose.errors.join(' ').includes('purpose'), 'a tool with no stated purpose is refused — nobody can decide when to reach for it');

    // Every problem at once, reported at once: a factory that stops at the first error makes you
    // iterate for information it already had.
    const many = f.validate({ name: 'Z!', allow: ['child_process', 'bogus'], tests: [] });
    ok(!many.ok && many.errors.length >= 4, `validate reports every problem at once (${many.errors.length} here), not just the first`);
  }

  // ── timeouts and hostile code ────────────────────────────────────────────────────────────────────
  {
    const f = mk();
    const spin = await f.forge({ name: 'spinner', purpose: 'Hang forever.', timeoutMs: 400, code: 'while (true) {}', tests: [{ input: {}, expect: { equals: 1 } }] });
    ok(!spin.ok && spin.stage === 'tests', 'an infinite loop is killed by the sandbox timeout and reported as a failed case, not a hung forge');

    const escape = await f.forge({ name: 'escaper', purpose: 'Try to read the vault.', code: 'return require("fs").readFileSync("/etc/hosts","utf8").length;', tests: [{ input: {}, expect: { gt: 0 } }] });
    ok(!escape.ok, 'code that requires fs WITHOUT declaring it cannot get it — the sandbox refuses the module, so the case fails');
  }

  // ── MEETING THE CALLER WHERE THEY ARE ────────────────────────────────────────────────────────────
  // Not hypothetical. In scripts/soak-supervisor.js a local qwen3 tried to forge a tool seventeen
  // times in three minutes and was refused every single time, for two packaging reasons that say
  // nothing about whether its tool was any good. A factory strict about the wrong things teaches
  // callers to stop using it.
  {
    const { normalizeTest, normalizeCode } = forgeMod;

    // 1. The obvious way to write a test case.
    const t = normalizeTest({ input: 1994, expected: 'MCMXCIV' });
    ok(t.expect && t.expect.equals === 'MCMXCIV' && t.expected === undefined,
      "`expected: <value>` becomes `expect: { equals: <value> }` — the shape everyone writes first");
    for (const alias of ['output', 'result', 'returns']) {
      ok(normalizeTest({ input: {}, [alias]: 7 }).expect.equals === 7, `\`${alias}\` works the same way`);
    }
    ok(normalizeTest({ input: {}, expect: { equals: 3 } }).expect.equals === 3, 'an already-correct case is untouched');
    // An object of PLAIN DATA is a value, not an expectation — only an object whose keys are all
    // operators is read as one, or a tool returning { equals: 1 } could never be tested.
    ok(JSON.stringify(normalizeTest({ input: {}, expect: { a: 1 } }).expect) === '{"equals":{"a":1}}',
      'an object of plain data is the VALUE it should return, not a set of operators');

    // 2. Code handed over as a whole function rather than as a body.
    ok(/return await \(function/.test(normalizeCode('function (input) { return input * 2; }')),
      'a whole `function (input) {…}` is unwrapped into a call — the sandbox wraps a BODY, so a bare function expression returns nothing');
    ok(/return await \(\(input\)/.test(normalizeCode('(input) => input * 3')), 'an arrow function too');
    ok(normalizeCode('return input * 2;') === 'return input * 2;', 'an actual body is left exactly as it was');
    ok(normalizeCode('const x = 1; return x;') === 'const x = 1; return x;', 'and so is a multi-statement body — no double wrapping');

    // End to end: the exact call that local model made, which the forge refused seventeen times.
    const f = mk();
    const r = await f.forge({
      name: 'roman_numeral_converter',
      purpose: 'Convert an integer to its Roman numeral equivalent.',
      code: "function(input) { const R = [['M',1000],['CM',900],['D',500],['CD',400],['C',100],['XC',90],['L',50],['XL',40],['X',10],['IX',9],['V',5],['IV',4],['I',1]]; let n = input, out = ''; for (const [s, v] of R) { while (n >= v) { out += s; n -= v; } } return out; }",
      tests: [{ input: 1994, expected: 'MCMXCIV' }],
    });
    ok(r.ok, 'the exact shape a small model produces now forges' + (r.ok ? '' : ' — ' + JSON.stringify(r.errors)));
    const call = await f.run('roman_numeral_converter', 2026);
    ok(call.success && call.result === 'MMXXVI', 'and the result is a working tool, called with a bare scalar');

    // The wall is UNCHANGED. Absorbing the shape must not absorb the standard.
    const vac = await f.forge({ name: 'vac2', purpose: 'p', code: 'return { a: 1 };', tests: [{ input: {}, expected: null }] });
    ok(!vac.ok && vac.stage === 'vacuous',
      '`expected: null` still normalises to a case that passes on null, and is still refused — the shape got friendlier, the standard did not move');

    const wrong = await f.forge({ name: 'wrong2', purpose: 'p', code: 'return 3;', tests: [{ input: {}, expected: 4 }] });
    ok(!wrong.ok && wrong.stage === 'tests', 'and a tool that is simply wrong still fails its case');

    // The refusal has to TEACH. An error a model cannot act on is a dead end dressed as feedback.
    const noExp = mk().validate({ name: 'x_tool', purpose: 'p', code: 'return 1;', tests: [{ input: {} }] });
    ok(noExp.errors.join(' ').includes('expected') && noExp.errors.join(' ').includes('BROKEN'),
      'a case with no expectation is told BOTH accepted shapes and reminded the case must be able to fail');
  }

  // ── remove ───────────────────────────────────────────────────────────────────────────────────────
  {
    const f = mk();
    ok(f.remove('parse_duration') === true, 'remove() forgets a forged tool');
    ok(f.remove('parse_duration') === false, 'removing it twice says there was nothing to remove');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail === 0 ? '✅' : '❌'} toolforge: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
