'use strict';
// ── TOOL FORGE — when no tool fits, build one ──────────────────────────────────────────────────────
//
// The gap this closes: BhatBot has 87 tools, and the 88th thing you ask for is answered by improvising
// with `run_shell` or by saying it cannot. Neither is what you want. A task that needs a capability
// nobody anticipated should produce the capability — and then the capability should still be there
// tomorrow.
//
// THE RULE THAT MAKES THIS SAFE RATHER THAN RECKLESS: a forged tool is not a tool until it has been
// observed producing a correct answer. Not "the code looks right", not "it ran without throwing" —
// observed, against declared cases, in the sandbox, before it is registered. A tool that has never
// been right is a guess with a name.
//
// FOUR WALLS, in the order they catch things:
//
//  1. EXECUTION — lib/sandbox.js. worker_threads, an allowlisted require, a wall-clock kill, and a
//     JSON-only boundary. Generated code never touches the Electron main process, the vault, or the
//     filesystem unless something explicitly grants it.
//
//  2. PRIVILEGE — `allow` beyond pure compute needs Siddhant's say-so, and `child_process` /
//     `worker_threads` / `vm` are refused outright at any privilege level. Those three are not
//     capabilities, they are ways out of the sandbox, and a tool that needs one is a tool that should
//     be written into the repo by hand and reviewed.
//
//  3. CORRECTNESS — declared test cases, all of which must pass.
//
//  4. THE TEST'S OWN HONESTY — and this is the wall the other three would be worthless without.
//     Expectations are DECLARATIVE ({equals}, {contains}, {keys}, …) and evaluated by this module, so
//     a forged tool cannot ship its own passing verdict. Then every case is re-run against a stub that
//     returns null: any case that still "passes" asserted nothing, and the forge refuses. This repo has
//     been bitten five separate times by a check that tested the wrong thing and therefore produced a
//     wrong answer rather than a smaller one — a dead-code scan that skipped preload*.js, a relevance
//     assertion that accepted an unrelated paper, a speech harness that skipped the normalizer, a
//     benchmark that scored silence as fabrication, and a voice preflight that spent three rounds
//     testing a loopback. A tool factory that let the tool grade itself would be the sixth.
//
// Pure + fs-backed + DI (no Electron), same contract as lib/mission.js / lib/blackboard.js.
// See scripts/test-toolforge.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(os.homedir(), '.bhatbot', 'forged');

// Never allowed, at any privilege level: each is a door out of the sandbox rather than a capability.
const FORBIDDEN = ['child_process', 'worker_threads', 'vm', 'module', 'repl', 'inspector', 'v8', 'process'];
// Allowed without asking: pure compute, no ambient authority. Matches lib/sandbox.js SAFE_DEFAULT.
const FREE = ['crypto', 'path', 'url', 'querystring', 'util', 'buffer', 'string_decoder', 'zlib', 'assert', 'punycode'];
// Allowed only with explicit approval — each one reaches something outside the worker.
const GATED = ['fs', 'net', 'http', 'https', 'dns', 'tls', 'os', 'dgram'];

const NAME_RE = /^[a-z][a-z0-9_]{2,39}$/;
const MAX_CODE = 20000;

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ── declarative expectations ──────────────────────────────────────────────────────────────────────
// Deliberately small. Every operator here can FAIL on a null result, which is what makes the
// null-stub check below meaningful — an operator that passes on anything (a bare `truthy`, a
// `noThrow`) would silently defeat it, so there isn't one.
const OPS = {
  equals: (got, want) => JSON.stringify(got) === JSON.stringify(want),
  contains: (got, want) => typeof got === 'string' ? got.includes(String(want))
    : Array.isArray(got) ? got.some((x) => JSON.stringify(x) === JSON.stringify(want))
    : false,
  keys: (got, want) => !!got && typeof got === 'object' && (want || []).every((k) => Object.prototype.hasOwnProperty.call(got, k)),
  type: (got, want) => (want === 'array' ? Array.isArray(got) : want === 'null' ? got === null : typeof got === want),
  gt: (got, want) => typeof got === 'number' && got > Number(want),
  lt: (got, want) => typeof got === 'number' && got < Number(want),
  length: (got, want) => (typeof got === 'string' || Array.isArray(got)) && got.length === Number(want),
  matches: (got, want) => typeof got === 'string' && new RegExp(String(want)).test(got),
  // `throws` is judged in forge(), where the throw is visible; here it can only mean the tool
  // RETURNED, which is precisely the failure the case was asserting against. A tool that returns null
  // does not throw, so a {throws:true} case can never be vacuous.
  throws: () => false,
};
const OP_NAMES = Object.keys(OPS);

/** Evaluate one declared case against a result. Returns { pass, why }. */
function judge(expect, got) {
  const ops = Object.entries(expect || {}).filter(([k]) => OPS[k]);
  if (!ops.length) return { pass: false, why: 'the case declares no expectation this module knows how to check' };
  for (const [op, want] of ops) {
    if (!OPS[op](got, want)) {
      return { pass: false, why: `${op}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got) || String(got)}`.slice(0, 300) };
    }
  }
  return { pass: true, why: '' };
}

// ── meeting the caller where they are ─────────────────────────────────────────────────────────────
// Observed, not imagined: in scripts/soak-supervisor.js a local qwen3 tried to forge a tool SEVENTEEN
// times in three minutes and was refused every time, for two reasons that have nothing to do with
// whether its tool was any good.
//
//   1. It wrote `{ input: 1994, expected: "MCMXCIV" }`. That is the obvious way to write a test case.
//      The forge wanted `{ input: ..., expect: { equals: ... } }`, which is the obvious way to write a
//      test case if you already know about the operator vocabulary.
//   2. It wrote `code` as a complete `function (input) { … }` rather than as the function BODY. The
//      sandbox wraps the body, so a whole function expression evaluates to a function nobody calls and
//      the tool returns undefined — a correct implementation failing for a packaging reason.
//
// Neither is a correctness problem and neither is worth a refusal, so both are absorbed. What is NOT
// absorbed is the vacuous-test check below: normalising `expected: "MCMXCIV"` into `{equals:...}`
// gives a case that a broken tool still fails, which is the whole standard. A factory that is strict
// about the wrong things trains callers to give up on it.
const EXPECT_ALIASES = ['expect', 'expected', 'output', 'result', 'returns'];

/** `function (input) {…}` / `(input) => …` / `async input => …` → a body that calls it. */
function normalizeCode(code) {
  const src = String(code || '').trim();
  if (!src) return src;
  // Only when the WHOLE string is one function — a body that merely mentions `function` is left alone.
  const whole = /^(?:async\s+)?function\s*\w*\s*\([\s\S]*\}$/.test(src)
    || /^(?:async\s+)?\(?[\w\s,{}[\]]*\)?\s*=>/.test(src);
  if (!whole) return src;
  // A body that already returns cannot be a bare function expression, so this cannot double-wrap.
  if (/^\s*(return|const|let|var|if|for|while|throw)\b/.test(src)) return src;
  return `return await (${src})(input);`;
}

/** `{ expected: 5 }` → `{ expect: { equals: 5 } }`, and friends. Leaves a well-formed case untouched. */
function normalizeTest(t) {
  if (!t || typeof t !== 'object') return t;
  const out = { ...t };
  // A JSON STRING INPUT IS AN OBJECT IN DISGUISE. The API's structured-output schema subset cannot
  // express "any object" — an empty node, a type union containing 'object', and
  // `additionalProperties: true` are all rejected — so a tool's argument has to travel as a JSON
  // string. Parse it back here, where the rest of the shape-forgiveness already lives.
  //
  // Only when it PARSES. A tool that genuinely takes the string "hello" must keep getting "hello",
  // and JSON.parse throws on it, which is exactly the signal that it was never JSON.
  if (typeof out.input === 'string') {
    try { out.input = JSON.parse(out.input); } catch { /* it was a plain string; leave it */ }
  }
  let exp = null, found = false;
  for (const k of EXPECT_ALIASES) {
    if (Object.prototype.hasOwnProperty.call(out, k)) { exp = out[k]; found = true; if (k !== 'expect') delete out[k]; break; }
  }
  // PRESENCE, not truthiness. `expected: null` is a real expectation — "it should return null" — and
  // treating it as absent sent it to the validator instead of to the vacuous check, which is where it
  // belongs: a case that passes when the tool returns null is the exact thing that check exists for.
  if (!found) return out;
  // An object whose keys are ALL known operators is already an expectation. Anything else — a scalar,
  // an array, or an object of plain data — is the value the tool should return.
  const isOps = exp && typeof exp === 'object' && !Array.isArray(exp)
    && Object.keys(exp).length > 0 && Object.keys(exp).every((k) => OPS[k]);
  out.expect = isOps ? exp : { equals: exp };
  return out;
}

// ── static validation ─────────────────────────────────────────────────────────────────────────────
/**
 * validate(spec, { existingToolNames }) → { ok, errors, needsApproval }
 *
 * Everything that can be decided without running anything. Called before the sandbox so a malformed
 * proposal costs no execution and gets one clear list of what is wrong rather than a first failure.
 */
function validate(spec = {}, opts = {}) {
  const errors = [];
  const name = String(spec.name || '').toLowerCase().trim();
  if (!NAME_RE.test(name)) errors.push(`name must match ${NAME_RE} (lowercase, 3–40 chars) — got ${JSON.stringify(spec.name)}`);
  // A forged tool that shadows a built-in would make the built-in unreachable and the failure would
  // look like the built-in breaking.
  if ((opts.existingToolNames || []).includes(name)) errors.push(`"${name}" is already a built-in tool — pick another name`);
  if (!String(spec.purpose || '').trim()) errors.push('purpose is required: one line on what this does and when to reach for it');
  const code = String(spec.code || '');
  if (!code.trim()) errors.push('code is required (a function body that receives `input` and returns a value)');
  if (code.length > MAX_CODE) errors.push(`code is ${code.length} bytes; the cap is ${MAX_CODE}`);

  const allow = [...new Set((spec.allow || []).map((x) => String(x).replace(/^node:/, '')))];
  const forbidden = allow.filter((m) => FORBIDDEN.includes(m));
  if (forbidden.length) errors.push(`refused modules: ${forbidden.join(', ')} — these are ways out of the sandbox, not capabilities. A tool that needs one belongs in the repo, written by hand and reviewed.`);
  const unknown = allow.filter((m) => !FREE.includes(m) && !GATED.includes(m) && !FORBIDDEN.includes(m));
  if (unknown.length) errors.push(`unknown modules: ${unknown.join(', ')}`);
  const gated = allow.filter((m) => GATED.includes(m));

  const tests = (Array.isArray(spec.tests) ? spec.tests : []).map(normalizeTest);
  if (!tests.length) errors.push('at least one test case is required — a tool that has never been observed being right is a guess with a name');
  tests.forEach((t, i) => {
    if (!t || typeof t !== 'object') { errors.push(`test ${i}: must be an object, e.g. { input: { n: 1994 }, expect: { equals: "MCMXCIV" } }`); return; }
    const declared = Object.keys(t.expect || {}).filter((k) => OPS[k]);
    if (!declared.length) {
      errors.push(`test ${i}: no expectation. Write either { input: {...}, expected: <the value it should return> } `
        + `or { input: {...}, expect: { <one of ${OP_NAMES.join('|')}>: ... } }. Pick one a BROKEN tool would fail.`);
    }
  });

  return { ok: errors.length === 0, errors, needsApproval: gated, name, allow, tests, code: normalizeCode(code) };
}

// ── the forge ─────────────────────────────────────────────────────────────────────────────────────
/**
 * createForge(deps) → the forge.
 *
 * deps:
 *   sandbox        — { runSandboxed(code, input, opts) } (lib/sandbox.js)
 *   dir            — where forged tools live (default ~/.bhatbot/forged)
 *   existingTools  — () => [tool names] so a forged tool cannot shadow a built-in
 *   approve        — async ({ name, purpose, modules }) => bool. Asked ONLY for gated modules.
 *                    Absent means refuse: silence is not consent for filesystem or network access.
 *   onForged       — (tool) => void. main.js uses this to register the tool where `plugin` can find it.
 *   now, log
 */
function createForge(deps = {}) {
  const dir = deps.dir || DIR;
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const sandbox = deps.sandbox || require('./sandbox');
  const existingTools = deps.existingTools || (() => []);
  const onForged = deps.onForged || (() => {});
  const approve = deps.approve || null;

  const file = (name) => path.join(dir, name + '.json');

  function list() {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter(Boolean);
    } catch { return []; }
  }
  function get(name) { return readJson(file(String(name || '').toLowerCase()), null); }

  /** The one-line summary the agent's system prompt carries, so it knows these exist. */
  function promptBlock() {
    const t = list();
    if (!t.length) return '';
    return 'TOOLS YOU FORGED EARLIER (call with plugin{action:"call", name, input}):\n'
      + t.map((x) => `  • ${x.name}(${(x.inputKeys || []).join(', ')}) — ${x.purpose}`).join('\n');
  }

  /**
   * run(name, input) → { success, result } | { success:false, error }
   * Re-reads the stored code every call: a tool edited on disk takes effect without a restart, and
   * nothing keeps a stale copy of code in memory that the file no longer says.
   */
  async function run(name, input = {}) {
    const t = get(name);
    if (!t) return { success: false, error: `no forged tool named "${name}" — list them with plugin{action:"list"}` };
    const r = await sandbox.runSandboxed(t.code, input, { allow: t.allow, timeoutMs: t.timeoutMs || 5000 });
    // Usage is recorded on the tool itself, so a tool that is never called is visible as dead weight
    // rather than accumulating silently. Best-effort: a failed write must not fail the call.
    try { writeAtomic(file(t.name), JSON.stringify({ ...t, calls: (t.calls || 0) + 1, lastCallAt: new Date(now()).toISOString(), lastCallOk: !!r.success }, null, 2)); } catch {}
    return r;
  }

  /**
   * forge(spec) → { ok, tool?, errors?, cases?, refused? }
   *
   * The whole gate, in order: validate → privilege → run the cases → prove the cases could fail →
   * persist. Nothing is written and nothing is registered unless every stage passes.
   */
  async function forge(spec = {}) {
    const v = validate(spec, { existingToolNames: existingTools() });
    if (!v.ok) return { ok: false, stage: 'validate', errors: v.errors };

    // PRIVILEGE. Asked once, for the whole set, naming exactly what is being granted — an approval
    // prompt that says "allow modules?" is one nobody can answer.
    if (v.needsApproval.length) {
      if (!approve) return { ok: false, stage: 'privilege', refused: v.needsApproval,
        errors: [`${v.name} wants ${v.needsApproval.join(', ')}, which reach outside the sandbox. Nothing here can ask Siddhant, so this is refused — re-forge it as pure compute, or have the capability added to the repo by hand.`] };
      let granted = false;
      try { granted = await approve({ name: v.name, purpose: String(spec.purpose), modules: v.needsApproval, code: String(spec.code).slice(0, 2000) }); } catch { granted = false; }
      if (!granted) return { ok: false, stage: 'privilege', refused: v.needsApproval, errors: [`Siddhant did not grant ${v.needsApproval.join(', ')} to ${v.name}.`] };
    }

    const code = v.code;         // unwrapped if the caller handed over a whole function
    const timeoutMs = Math.max(200, Math.min(30000, Number(spec.timeoutMs) || 5000));
    const tests = v.tests;       // `expected: x` already canonicalised to `expect: { equals: x }`

    // THE TEST'S OWN HONESTY, FIRST. Judge every case against a null result. Any case that passes
    // was not checking the tool — it was checking nothing, and would have gone on passing after the
    // tool broke. This is the check the other three need, and it runs BEFORE them for two reasons: it
    // executes nothing at all, and when a case is both vacuous AND failing, "this case asserts
    // nothing" is a far more useful thing to be told than "expected null, got {a:1}".
    const vacuous = tests.map((t, i) => ({ i, ...judge(t.expect, null) })).filter((x) => x.pass).map((x) => x.i);
    if (vacuous.length) {
      return { ok: false, stage: 'vacuous', vacuousCases: vacuous,
        errors: [`case${vacuous.length > 1 ? 's' : ''} ${vacuous.join(', ')} pass${vacuous.length > 1 ? '' : 'es'} even when the tool returns null, so ${vacuous.length > 1 ? 'they assert' : 'it asserts'} nothing. Declare an expectation that a broken tool would fail — {equals}, {contains}, {keys}, {length}, {matches}, {gt}/{lt}.`],
        note: 'Nothing was registered.' };
    }

    // CORRECTNESS.
    const cases = [];
    for (let i = 0; i < tests.length; i++) {
      const t = tests[i];
      const r = await sandbox.runSandboxed(code, t.input || {}, { allow: v.allow, timeoutMs });
      if (!r.success) {
        // A case may legitimately expect a throw; anything else that throws is a failure.
        const wantThrow = t.expect && t.expect.throws;
        cases.push({ i, pass: !!wantThrow, why: wantThrow ? '' : `threw: ${String(r.error).slice(0, 200)}`, threw: true, error: r.error });
        continue;
      }
      const j = judge(t.expect, r.result);
      // The INPUT goes in the failure, not just expected-vs-got. The commonest real mistake is a shape
      // mismatch between the case and the code — `input: 1994` against a body that reads `input.n` —
      // and "expected MCMXCIV, got null" does not point at it, while "for input 1994" does immediately.
      cases.push({ i, pass: j.pass, why: j.why ? `${j.why}  (for input ${JSON.stringify(t.input === undefined ? {} : t.input).slice(0, 120)})` : '', got: r.result });
    }
    const failed = cases.filter((c) => !c.pass);
    if (failed.length) {
      return { ok: false, stage: 'tests', cases,
        errors: failed.map((c) => `case ${c.i}: ${c.why}`),
        note: 'Nothing was registered. Fix the code or the expectation and forge again — a tool is not a tool until it has been seen being right.' };
    }

    // PERSIST. Provenance is recorded because in six months the only question that matters about a
    // forged tool is who asked for it and why.
    const inputKeys = [...new Set(tests.flatMap((t) => Object.keys(t.input || {})))];
    const tool = {
      name: v.name, purpose: String(spec.purpose).trim(), code, allow: v.allow, timeoutMs,
      inputKeys, tests, sha: sha(code),
      forgedAt: new Date(now()).toISOString(),
      forgedFor: spec.forgedFor ? String(spec.forgedFor).slice(0, 300) : '',   // the task that needed it
      missionId: spec.missionId || null,
      casesPassed: cases.length, calls: 0,
    };
    writeAtomic(file(tool.name), JSON.stringify(tool, null, 2));
    try { onForged(tool); } catch (e) { log('[forge] onForged failed: ' + (e && e.message)); }
    log(`[forge] ${tool.name} — ${cases.length} case(s) passed, ${v.allow.length ? 'allow: ' + v.allow.join(', ') : 'pure compute'}`);
    return { ok: true, tool, cases,
      callWith: `plugin{action:"call", name:"${tool.name}", input:{${inputKeys.join(', ')}}}` };
  }

  /** remove(name) — forget a forged tool. Returns whether there was one. */
  function remove(name) {
    const f = file(String(name || '').toLowerCase());
    if (!fs.existsSync(f)) return false;
    fs.unlinkSync(f);
    return true;
  }

  return { forge, run, list, get, remove, promptBlock, validate: (s) => validate(s, { existingToolNames: existingTools() }) };
}

module.exports = { createForge, validate, judge, normalizeTest, normalizeCode, OPS, OP_NAMES, EXPECT_ALIASES, FREE, GATED, FORBIDDEN, DIR, NAME_RE, MAX_CODE };
