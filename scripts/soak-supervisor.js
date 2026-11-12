#!/usr/bin/env node
'use strict';
// ── THE HOUR, ACTUALLY RUN ────────────────────────────────────────────────────────────────────────
//
// Siddhant asked for agents that can work for an hour without him checking in. Unit tests prove the
// supervisor's LOGIC — walls, stalls, escalation, resume — in milliseconds with a fake worker. They
// cannot prove the thing he actually asked about, which is whether it is still healthy sixty minutes
// in, against a real model, with real latency and real variance.
//
// The Anthropic budget is spent, so this runs against OLLAMA — a local qwen3, free, on this machine.
// That is a genuine substitution rather than a cheaper fake: it is a real model emitting real tool
// calls with real jitter, and what is under test is the SUPERVISOR, not Claude. The one thing it
// cannot tell us is whether Claude's answers get worse over an hour; it tells us whether the loop
// around them survives one, which is the part that had never been run.
//
// ── THE TASK MIX IS THE EXPERIMENT ────────────────────────────────────────────────────────────────
//
// Every item is VERIFIABLE by this script independently of what the agent claims, because "the agent
// said done" is exactly the signal an endurance test must not trust. Three kinds, deliberately:
//
//   • ~70% doable with the tools provided → measures whether it keeps getting things RIGHT. Accuracy
//     is compared between the first quarter of completed items and the last, which is the only way to
//     answer "does it degrade" rather than "did it survive".
//   • ~15% needing a computation no tool provides → it must FORGE one. An hour-long run that cannot
//     extend itself is an hour of hitting the same wall.
//   • ~15% needing a fact only Siddhant knows → it must ESCALATE, and the run must keep working
//     meanwhile. Half of those get answered a minute later (he is at his desk); half never get
//     answered at all (he is asleep, which is the case this whole lane exists for).
//
// NOTHING HERE CAN PHONE HIM. `notify` is a recorder. A soak that woke Siddhant at 3am to ask a
// synthetic question would be a bug with a very short feedback loop.
//
//   node scripts/soak-supervisor.js --minutes 60 [--model qwen3:latest] [--width 3] [--items 120]
//
// Exits non-zero if the run did not survive, if memory ran away, if the loop spun hot, or if accuracy
// collapsed in the back half.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMissions } = require('../lib/mission');
const { createSupervisor } = require('../lib/supervisor');
const { createEscalations } = require('../lib/escalate');
const { createForge } = require('../lib/toolforge');
const sandbox = require('../lib/sandbox');
const designation = require('../lib/designation');
const power = require('./bench-power');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MINUTES = Number(arg('minutes', 60));
const MODEL = arg('model', 'qwen3:latest');
const WIDTH = Number(arg('width', 3));
const ITEMS = Number(arg('items', 120));
// ── two-lane mode ────────────────────────────────────────────────────────────────────────────────
//
// `--lanes` exercises the two-lane scheduler end to end instead of with fakes. The LOCAL lane is the
// real thing: the same Ollama worker every other mode uses. The CLOUD lane is SIMULATED — it does the
// same verification work but sleeps for a sampled latency instead of calling Anthropic, because the
// point here is the scheduler's lane mechanics (one local slot, N cloud slots, no borrowing, correct
// release on failure) and those are timing behaviour, not model behaviour. Spending real money to
// re-measure a sleep would tell us nothing we do not already know.
//
// Said plainly because a simulated lane reported as a real one is worse than no measurement: this
// proves the SCHEDULER under realistic timing. It does not prove the Claude worker, which is still
// unproven end to end and needs its own live run.
const LANES = process.argv.includes('--lanes');
const CLOUD_MS = Number(arg('cloud-ms', 2500));      // a plausible Sonnet item: a few turns of tools
const OLLAMA = 'http://localhost:11434';
const ROOT = path.join(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-'));
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK, { recursive: true });

const log = (s) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`; console.log(line); try { fs.appendFileSync(path.join(TMP, 'soak.log'), line + '\n'); } catch {} };

// ── the work ──────────────────────────────────────────────────────────────────────────────────────
// Real files, real answers, computed HERE so the check is independent of the agent.
const CORPUS = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^test-.*\.js$/.test(f)).sort();

function makeItems(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = CORPUS[i % CORPUS.length];
    const kind = i % 7 === 3 ? 'forge' : i % 7 === 6 ? 'ask' : 'count';
    if (kind === 'count') {
      const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
      const truth = src.split('\n').length;
      out.push({
        kind, id: 'i' + i,
        text: `Count the lines in the file scripts/${f} and write ONLY that number into ${path.join(WORK, 'i' + i + '.txt')}`,
        check: () => { try { return String(parseInt(fs.readFileSync(path.join(WORK, 'i' + i + '.txt'), 'utf8').trim(), 10)) === String(truth); } catch { return false; } },
        truth,
      });
    } else if (kind === 'forge') {
      const n2 = 1000 + (i * 137) % 2900;
      out.push({
        kind, id: 'i' + i,
        // No tool converts to Roman numerals, and no tool here will. The only way to be RIGHT is to
        // build one — which is the point.
        text: `Write the Roman numeral for ${n2} into ${path.join(WORK, 'i' + i + '.txt')}. There is no tool for this; forge one with forge_tool and use it.`,
        check: () => { try { return fs.readFileSync(path.join(WORK, 'i' + i + '.txt'), 'utf8').trim().toUpperCase() === roman(n2); } catch { return false; } },
        truth: roman(n2),
      });
    } else {
      out.push({
        kind, id: 'i' + i,
        text: `Write Siddhant's preferred citation style into ${path.join(WORK, 'i' + i + '.txt')}. Only he knows it — ask him (need.kind="human") rather than guessing, and say you would assume "APA" meanwhile.`,
        check: () => { try { return /apa|chicago/i.test(fs.readFileSync(path.join(WORK, 'i' + i + '.txt'), 'utf8')); } catch { return false; } },
        truth: '(needs Siddhant)',
      });
    }
  }
  return out;
}
function roman(n) {
  const M = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of M) while (n >= v) { out += s; n -= v; }
  return out;
}

// ── the local-model worker ────────────────────────────────────────────────────────────────────────
const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file and return its contents.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'count_lines', description: 'Count the lines in a text file. Returns { lines }.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write text to a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'forge_tool', description: 'Build a new tool when none of the others can do the job. It runs sandboxed and must pass the cases you declare.', parameters: { type: 'object', properties: { name: { type: 'string' }, purpose: { type: 'string' }, code: { type: 'string', description: 'A JS function body taking `input` and returning a value.' }, tests: { type: 'array', items: { type: 'object' } } }, required: ['name', 'purpose', 'code', 'tests'] } } },
  { type: 'function', function: { name: 'call_forged', description: 'Call a tool you forged earlier.', parameters: { type: 'object', properties: { name: { type: 'string' }, input: { type: 'object' } }, required: ['name'] } } },
];

// Reads are confined to the repo and writes to the scratch workspace. The point is a soak, not an
// exercise in what a 7B model does with an unguarded write primitive.
const inRepo = (p) => path.resolve(String(p)).startsWith(ROOT);
const inWork = (p) => path.resolve(String(p)).startsWith(WORK);

let forge = null;   // set in main, injected here
const stats = { toolCalls: 0, toolErrors: 0, modelCalls: 0, modelErrors: 0, forgeAttempts: 0, forgeOk: 0, tokensIn: 0, tokensOut: 0 };
// WHY a forge failed is the interesting number, not how many did. If a small model cannot drive the
// forge, the question is whether its refusals TEACH — an error a model cannot act on is a dead end
// dressed as feedback.
const forgeFails = new Map();

async function runTool(name, a = {}) {
  stats.toolCalls++;
  try {
    if (name === 'read_file') {
      if (!inRepo(a.path)) return { error: 'reads are confined to the repo' };
      return { content: fs.readFileSync(a.path, 'utf8').slice(0, 4000) };
    }
    if (name === 'count_lines') {
      if (!inRepo(a.path)) return { error: 'reads are confined to the repo' };
      return { lines: fs.readFileSync(a.path, 'utf8').split('\n').length };
    }
    if (name === 'write_file') {
      if (!inWork(a.path)) return { error: 'writes are confined to the workspace' };
      fs.mkdirSync(path.dirname(a.path), { recursive: true });
      fs.writeFileSync(a.path, String(a.content == null ? '' : a.content));
      return { written: a.path };
    }
    if (name === 'forge_tool') {
      stats.forgeAttempts++;
      const r = await forge.forge({ name: a.name, purpose: a.purpose, code: a.code, tests: a.tests });
      if (r.ok) stats.forgeOk++;
      else { const k = r.stage + ': ' + String((r.errors || [])[0] || '').slice(0, 90); forgeFails.set(k, (forgeFails.get(k) || 0) + 1); }
      return r.ok ? { forged: r.tool.name, call_with: r.callWith } : { failed: true, stage: r.stage, errors: r.errors };
    }
    if (name === 'call_forged') {
      const r = await forge.run(a.name, a.input || {});
      return r.success ? { result: r.result } : { error: r.error };
    }
    return { error: 'no such tool: ' + name };
  } catch (e) { stats.toolErrors++; return { error: String(e && e.message || e).slice(0, 200) }; }
}

async function ollama(messages, tools, timeoutMs = 90000) {
  stats.modelCalls++;
  const body = { model: MODEL, stream: false, think: false, messages, ...(tools ? { tools } : {}) };
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error('ollama ' + r.status);
  const j = await r.json();
  // Ollama reports its own token counts and they were being dropped on the floor. The whole point of
  // running the soak locally is that tokens/item can be measured for free — a benchmark that cannot
  // see its own token cost cannot tell you whether an optimisation worked.
  stats.tokensIn += j.prompt_eval_count || 0;
  stats.tokensOut += j.eval_count || 0;
  return j.message || {};
}

/**
 * Some local builds put the call in `tool_calls`, some emit it as JSON in the content. Accept both —
 * but COUNT THEM SEPARATELY. A parser this permissive cannot otherwise answer the one question the
 * local lane depends on: does this model actually emit ollama `tool_calls`? A single "tools: 116"
 * counter reads as proof of native tool-calling while being satisfied entirely by the text fallback.
 * That is the same shape of mistake as a test that asserts fidelity to the caller instead of fitness
 * for the wire, and it has cost this project a whole evening before.
 */
function toolCallsOf(msg) {
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    stats.toolsNative = (stats.toolsNative || 0) + msg.tool_calls.length;
    return msg.tool_calls.map((c) => ({ name: c.function && c.function.name, args: (c.function && c.function.arguments) || {} }));
  }
  const txt = String(msg.content || '').trim();
  const m = txt.match(/\{[\s\S]*"name"\s*:\s*"(\w+)"[\s\S]*\}/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]);
    if (j.name) { stats.toolsScraped = (stats.toolsScraped || 0) + 1; return [{ name: j.name, args: j.arguments || j.parameters || {} }]; }
  } catch {}
  return [];
}

/**
 * Does one item the way a reliable agent would, with no model in the loop. The harness already holds
 * the ground truth for every item, so this writes the artifact the item asks for and nothing is
 * assumed: the caller still verifies by reading the file back.
 */
async function cloudDoItem(item) {
  const out = path.join(WORK, item.id + '.txt');
  if (item.kind === 'count') {
    const m = /scripts\/(\S+?)\s/.exec(item.text + ' ');
    const src = fs.readFileSync(path.join(ROOT, 'scripts', m[1]), 'utf8');
    fs.writeFileSync(out, String(src.split('\n').length));
    return;
  }
  if (item.kind === 'forge') { fs.writeFileSync(out, item.truth); return; }
  fs.writeFileSync(out, 'APA');                       // the assumption an unanswered ask proceeds on
}

// The lane-aware wrapper. It records what each lane did so the report can say whether the second lane
// actually bought throughput — which is the only question two lanes exist to answer.
const laneStats = { cloud: { started: 0, done: 0, ms: 0, peak: 0, live: 0 }, local: { started: 0, done: 0, ms: 0, peak: 0, live: 0 } };
async function laneAwareWorker(spec) {
  const lane = spec.lane === 'local' ? 'local' : 'cloud';
  const L = laneStats[lane];
  L.started++; L.live++; L.peak = Math.max(L.peak, L.live);
  const t0 = Date.now();
  try {
    if (lane === 'local') return await worker(spec);

    // ── the simulated cloud lane ──────────────────────────────────────────────────────────────────
    //
    // ONLY THE LATENCY IS SIMULATED. NEVER THE OUTCOME. The first version of this slept and then
    // returned `status: 'done'` without doing anything, which produced 112 false "done"s in a 12-minute
    // run — every single cloud item a fabricated success. The harness's own false-done detector caught
    // it, which is the one good thing about that afternoon, but it is exactly the failure this project
    // keeps rediscovering: a benchmark that scores an absence as a success. A simulated lane may stand
    // in for an agent's SPEED. It may never stand in for its RESULT.
    //
    // So this does the item for real — the harness knows the truth, so it writes the correct artifact
    // and check() then passes on the actual file, verified independently like everything else — and
    // sleeps for a plausible Sonnet latency instead of thinking. Jittered, because a constant latency
    // lets the scheduler settle into a lockstep no real network produces and would hide a refill bug.
    //
    // What that buys is a RELIABLE stand-in, which is the point: it measures the SCHEDULER (one local
    // slot, N cloud slots, no borrowing, correct release) without model quality as a confound. It
    // therefore says nothing about how good Sonnet is at these items, and the report says so.
    await new Promise((r) => setTimeout(r, Math.round(CLOUD_MS * (0.6 + Math.random() * 0.8))));
    const item = ITEM_BY_TEXT.get(spec.goal);
    if (!item) return { status: 'partial', summary: 'no such item', spendUsd: 0, tokensIn: 0, tokensOut: 0 };
    // An `ask` item still escalates exactly once, in either lane: needing a human is not a lane
    // property, and dropping it here would remove escalation from half the run's coverage.
    if (item.kind === 'ask' && !item.askedOnce) {
      item.askedOnce = true;
      return { status: 'blocked', summary: 'needs Siddhant', spendUsd: 0, tokensIn: 0, tokensOut: 0,
        need: { kind: 'human', question: `What citation style do you want for item ${item.id}?`, assumption: 'APA' } };
    }
    try { await cloudDoItem(item); } catch (e) { return { status: 'partial', summary: 'cloud stand-in failed: ' + e.message, spendUsd: 0, tokensIn: 0, tokensOut: 0 }; }
    // Verified the same way as every other item: by checking the artifact, never by taking a word for it.
    const ok = item.check();
    if (ok) L.done++;
    return { status: ok ? 'done' : 'partial', summary: (ok ? 'verified: ' : 'not verified: ') + 'cloud stand-in', spendUsd: 0, tokensIn: 0, tokensOut: 0 };
  } finally { L.live--; L.ms += Date.now() - t0; }
}

async function worker(spec) {
  const t0in = stats.tokensIn, t0out = stats.tokensOut;
  const used = () => ({ tokensIn: stats.tokensIn - t0in, tokensOut: stats.tokensOut - t0out });
  const sys = `You are ${spec.name}, working one item of a plan. Designation: ${designation.get(spec.designation).label}.
Do the work with the tools. When the item asks you to WRITE something to a path, you must actually call write_file — saying you did is not doing it.
If no tool can do what is needed, forge one with forge_tool, then call it with call_forged.
Be brief. Do not explain. /no_think`;
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: spec.goal }];
  let last = '';
  for (let i = 0; i < 8; i++) {
    let m;
    try { m = await ollama(msgs, TOOLS); } catch (e) { stats.modelErrors++; return { status: 'failed', summary: 'model error: ' + e.message, turns: i, ...used() }; }
    const calls = toolCallsOf(m);
    last = String(m.content || '').slice(0, 300) || last;
    if (!calls.length) break;
    msgs.push({ role: 'assistant', content: m.content || '', ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) });
    for (const c of calls) {
      const out = await runTool(c.name, c.args);
      if (spec.onStep) try { spec.onStep(`${c.name} ${JSON.stringify(c.args).slice(0, 60)}`); } catch {}
      msgs.push({ role: 'tool', content: JSON.stringify(out).slice(0, 2000) });
    }
  }

  // The envelope. A 7B model will not reliably produce clean JSON with a schema it has not seen, so
  // this asks for the narrowest thing that can be parsed and falls back rather than failing the item —
  // the supervisor is what is under test, not the local model's JSON discipline.
  const item = ITEM_BY_TEXT.get(spec.goal);
  // ASK ONCE, THEN BE HONEST. This used to return `blocked` for an `ask` item on EVERY attempt — after
  // the tool loop above had already written the file, and without ever calling check(). That produced
  // 114 phantom under-claims in the baseline (628 verified against 514 claimed), which reads as "the
  // agent cannot tell when it succeeded" and is really just this early return never looking. A
  // harness that manufactures a defect and then reports it is worse than one that measures nothing,
  // because the number looks real.
  //
  // But "check before asking" alone would be the wrong fix, and it was the first one I wrote: this
  // item's check is `/apa|chicago/` and its own text says to assume "APA" meanwhile, so the model can
  // satisfy it on the first attempt and the soak would quietly stop exercising escalation at all —
  // which is one of the things under test. Asking exactly ONCE per item keeps both properties: every
  // ask item still escalates, and once it has an answer or an assumption it reports what it actually
  // did rather than asking again forever.
  if (item && item.kind === 'ask' && !item.askedOnce) {
    item.askedOnce = true;
    return { status: 'blocked', summary: 'needs Siddhant', turns: 8, ...used(),
      need: { kind: 'human', question: `What citation style do you want for item ${item.id}?`, assumption: 'APA' } };
  }
  const ok = item ? item.check() : false;
  return { status: ok ? 'done' : 'partial', summary: (ok ? 'verified: ' : 'not verified yet: ') + last.slice(0, 120), turns: 8, ...used() };
}

const ITEM_BY_TEXT = new Map();

// ── the run ───────────────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const t = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!t.ok) throw new Error('not ok');
  } catch { console.error('✗ ollama is not running (http://localhost:11434). `ollama serve`, then retry.'); process.exit(2); }

  const items = makeItems(ITEMS);
  for (const it of items) ITEM_BY_TEXT.set(it.text, it);

  const missions = createMissions({ dir: path.join(TMP, 'missions') });
  forge = createForge({ dir: path.join(TMP, 'forged'), sandbox });

  // NOTHING HERE CAN PHONE HIM. Half the questions get answered a minute later (he is at his desk);
  // half never do (he is asleep) — and the run has to be fine either way.
  const asked = [];
  const escalations = createEscalations({
    dir: path.join(TMP, 'escalations'),
    opts: { maxPerHour: 6 },
    notify: async (msg, urgency, o) => {
      asked.push({ at: Date.now(), msg: String(msg).slice(0, 120), urgency, id: o && o.taskId });
      if (asked.length % 2 === 1) {
        setTimeout(() => { try { escalations.answer('Use Chicago style', { id: o && o.taskId }); } catch {} }, 60000);
      }
      return { sent: true, via: 'telegram' };
    },
  });

  const events = {};
  const rss = [];
  const watts = [];
  // The custodian runs with no judge here (no API key in this harness), so it does only its
  // deterministic checks — which is exactly the degraded mode a real unattended run falls into when
  // the budget is gone, and therefore the mode worth soaking.
  const custodian = require('../lib/custodian').createCustodian({});
  let stopRequested = false;
  const sup = createSupervisor({
    missions, escalations, forge,
    shouldStop: () => stopRequested,
    review: async ({ goal, deliverable, trace }) => custodian.review({ prompt: goal, deliverable, trace, autonomous: true }),
    // In two-lane mode every SECOND item goes local, so both lanes stay busy and the scheduler is
    // actually under contention rather than nominally two-laned with one lane idle.
    laneFor: LANES ? ((item) => (/\blocal\b/i.test(item.text || '') || (item.text || '').length % 2 === 0 ? 'local' : 'cloud')) : undefined,
    runAgent: LANES ? laneAwareWorker : worker,
    decompose: async () => items.map((i) => i.text),
    onEvent: (e) => {
      events[e.type] = (events[e.type] || 0) + 1;
      // A capped plan invalidates the whole measurement, so it is a loud failure and not a counter.
      if (e.type === 'plan-capped') log(`⚠️  PLAN CAPPED: ${e.given} items given, ${e.kept} kept — this run measures nothing about endurance.`);
    },
    log: () => {},
    // planMax MUST match the harness's own item count. The cap is right in production — it is what
    // stops a runaway decomposition — but it also guards the direct-plan path now, and a soak handed
    // 800 items against the default 40 does not soak: it exhausts a 40-item plan in six minutes and
    // reports "blocked", which reads exactly like a stamina failure and is nothing of the kind. That
    // is how the first attempt at this baseline died.
  }, { width: WIDTH, itemBudgetUsd: 999, maxItemAttempts: 2, stallTicks: 400, idleWaitMs: 90000, planMax: items.length + 50 });

  const startedAt = Date.now();
  const startRss = process.memoryUsage().rss;
  log(`soak: ${MINUTES}min · ${MODEL} · width ${WIDTH} · ${items.length} items (${items.filter((i) => i.kind === 'count').length} verifiable / ${items.filter((i) => i.kind === 'forge').length} need a forged tool / ${items.filter((i) => i.kind === 'ask').length} need Siddhant)`);
  log(`workspace: ${TMP}`);

  // The heartbeat is the instrument. A soak whose only output is the final verdict cannot tell you
  // WHEN it went wrong, and "it degraded somewhere in the middle" is not a finding.
  const completionTimes = [];
  // A BUSY RUN THAT PRODUCES NOTHING IS THE FAILURE THIS HARNESS EXISTS TO CATCH, and the first
  // version of it took thirty minutes to make that visible — three items had seized all three worker
  // slots and were cycling between blocked and todo forever, while the heartbeat cheerfully reported
  // rising model and tool counts. Model calls are ACTIVITY. Verified items are WORK. When the second
  // climbs and the first does not, stop and say so rather than spending the remaining half hour
  // confirming it.
  let lastVerified = 0, flatFor = 0;
  let deadlocked = null;

  // ── THE EFFICIENCY INSTRUMENT ───────────────────────────────────────────────────────────────────
  //
  // Correctness and throughput are different questions and this harness only answered the first. The
  // run now carries a width arbiter, a one-agent-per-role cap, a single local slot, admission, a tier
  // ladder and a cost pilot — six individually-correct brakes — and a stack of correct brakes is
  // exactly how a system degrades monotonically while every test still passes. A run arbitrated to
  // width 5 that averages 1.4 agents in flight is a bug, and nothing in a pass/fail suite says so.
  //
  // Sampled at 2s rather than on the progress event, because progress only fires when an item lands:
  // sampling on completions is sampling the busy moments and would report near-perfect utilisation for
  // a run that spends most of its time idle. The point is to catch the idle.
  const util = { n: 0, inFlight: 0, width: 0, held: 0, saturated: 0, idle: 0, binding: {}, lanes: { cloud: 0, local: 0 },
    // IDLE HAS TWO MEANINGS and only one is a fault. Agents idle while work is ready to start is a
    // brake that is too tight. Agents idle because everything left is waiting on a dependency or on
    // an answer from him is the system behaving correctly — and a run that ends with a minute of
    // waiting for answers would otherwise read as "43% idle" and be blamed on the scheduler.
    busyN: 0, busyInFlight: 0, busyWidth: 0, idleWithBacklog: 0, idleWaiting: 0 };
  const utilBeat = setInterval(() => {
    let st = null;
    try { st = sup.stats(); } catch { return; }
    if (!st || !st.width) return;                      // before the first arbitration there is nothing to say
    util.n++;
    // The fleet is the cloud width PLUS the local slot when two lanes are on. Measured against the
    // cloud width alone, a full house read as 117%.
    st.width += LANES ? 1 : 0;
    util.inFlight += st.inFlight; util.width += st.width; util.held += st.heldForRole || 0;
    util.lanes.cloud += (st.lanes && st.lanes.cloud) || 0;
    util.lanes.local += (st.lanes && st.lanes.local) || 0;
    if (st.inFlight >= st.width) util.saturated++;      // asking for more width would actually help
    if (st.inFlight === 0) util.idle++;                 // nobody working at all
    const backlog = (st.ready || 0) + (st.heldForRole || 0);
    if (st.inFlight > 0 || backlog > 0) { util.busyN++; util.busyInFlight += st.inFlight; util.busyWidth += st.width; }
    if (st.inFlight === 0 && backlog > 0) util.idleWithBacklog++;       // THE FAULT: work was ready and nobody took it
    if (st.inFlight === 0 && backlog === 0) util.idleWaiting++;         // not a fault: nothing could start
    const b = st.bindingConstraint || 'spec';
    util.binding[b] = (util.binding[b] || 0) + 1;
  }, 2000);
  if (utilBeat.unref) utilBeat.unref();
  const beat = setInterval(() => {
    const mins = (Date.now() - startedAt) / 60000;
    const r = process.memoryUsage().rss;
    rss.push({ mins: +mins.toFixed(1), mb: Math.round(r / 1048576) });
    // Whole-system draw, and only on battery — on AC the field reports charge current rather than
    // consumption, so it reads null and the report says "not measured" instead of inventing a number.
    const pw = power.read();
    if (pw.ok) watts.push({ mins: +mins.toFixed(1), w: +pw.watts.toFixed(1) });
    const verified = items.filter((i) => i.check()).length;
    while (completionTimes.length < verified) completionTimes.push(mins);
    log(`  ${mins.toFixed(1)}min · verified ${verified}/${items.length} · rss ${Math.round(r / 1048576)}MB · model ${stats.modelCalls} calls (${stats.modelErrors} err) · tools ${stats.toolCalls} (${stats.toolsNative || 0} native/${stats.toolsScraped || 0} scraped) · forged ${stats.forgeOk}/${stats.forgeAttempts} · asked ${asked.length}`);

    if (verified > lastVerified) { lastVerified = verified; flatFor = 0; return; }
    if (verified >= items.length) return;                    // nothing left to verify is not a stall
    flatFor++;
    if (flatFor === 5) log('  ⚠ five minutes with no new verified item — watching for a livelock');
    if (flatFor >= 8 && !deadlocked) {
      deadlocked = `${flatFor} minutes with no new verified item while ${items.length - verified} remain, `
        + `and the agents were not idle: ${stats.modelCalls} model calls and ${stats.toolCalls} tool calls so far. `
        + 'Busy and producing nothing is a livelock, not slowness.';
      log('  ✗ ' + deadlocked);
      // Stopping cooperatively rather than killing: the report below is the interesting part, and the
      // plan file it leaves behind is what names the items that seized the slots.
      stopRequested = true;
    }
  }, 60000);
  beat.unref?.();

  const report = await sup.run({ goal: 'Work through the audit checklist', plan: items.map((i) => i.text), budgetUsd: 999, wallClockMs: MINUTES * 60000, width: WIDTH });
  clearInterval(beat);
  clearInterval(utilBeat);

  const elapsedMin = (Date.now() - startedAt) / 60000;
  const endRss = process.memoryUsage().rss;
  const verified = items.filter((i) => i.check());
  const verifiedIds = new Set(verified.map((i) => i.id));

  // ── the verdict ────────────────────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(78));
  log(`stopped: ${report.stoppedBecause} after ${elapsedMin.toFixed(1)}min · ${report.ticks} scheduling passes`);
  log(`agent CLAIMED done: ${report.done.length} · INDEPENDENTLY VERIFIED: ${verified.length}`);
  const claimedIds = new Set(report.done.map((txt) => (ITEM_BY_TEXT.get(txt) || {}).id).filter(Boolean));
  const falseDone = [...claimedIds].filter((id) => !verifiedIds.has(id));
  log(`false "done": ${falseDone.length}${falseDone.length ? ' — ' + falseDone.slice(0, 6).join(', ') : ''}`);
  log(`rss ${Math.round(startRss / 1048576)}MB → ${Math.round(endRss / 1048576)}MB`);
  log(`events: ${Object.entries(events).map(([k, v]) => k + '=' + v).join(' ')}`);
  log(`escalations: ${asked.length} asked, ${escalations.all().filter((e) => e.status === 'answered').length} answered, ${escalations.pending().length} still open`);
  log(`forged tools: ${forge.list().map((t) => `${t.name}(${t.calls} calls)`).join(', ') || '(none)'}`);
  if (report.doubts && report.doubts.length) {
    log(`doubts raised mid-run (${report.doubts.length}) — these are the ones there was still time to act on:`);
    for (const d of report.doubts.slice(0, 5)) log(`      [${d.verdict}] after ${d.afterDone} done${d.raised > 1 ? `, still true after ${d.raised} checks` : ''}: ${d.reason}`);
  }
  // ── the efficiency verdict ──────────────────────────────────────────────────────────────────────
  //
  // Reported whether or not anything is wrong, because a number you only print when it looks bad is a
  // number nobody trusts when it looks fine.
  //
  // THIS BLOCK WAS MISSING FOR SIX WEEKS. The sampler above and the `efficiency: U` field in the
  // record below were both committed in September; the code between them — this — was in an edit
  // that failed partway and saved nothing, and only its last line was re-applied. So every soak ran
  // to the end, printed its report, and then died on `U is not defined` BEFORE writing its record.
  // The instrument that was meant to catch a silently idle fleet silently never produced a number,
  // and the on-demand efficiency check had no new record to read. `U` is declared at function scope
  // so the record cannot reference something that does not exist.
  const U = (() => {
    if (!util.n) return null;
    const meanIn = util.inFlight / util.n, meanW = util.width / util.n;
    return {
      samples: util.n,
      meanInFlight: +meanIn.toFixed(2),
      meanWidth: +meanW.toFixed(2),
      utilisationPct: Math.round((meanIn / Math.max(0.01, meanW)) * 100),
      idlePct: Math.round((util.idle / util.n) * 100),
      saturatedPct: Math.round((util.saturated / util.n) * 100),
      meanHeld: +(util.held / util.n).toFixed(2),
      binding: Object.entries(util.binding).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((v / util.n) * 100)}%`).join(', '),
      meanCloud: +(util.lanes.cloud / util.n).toFixed(2),
      meanLocal: +(util.lanes.local / util.n).toFixed(2),
      // The number that matters: how full the fleet was WHILE there was something to do.
      utilisationWhileWorkPct: util.busyN ? Math.round((util.busyInFlight / Math.max(0.01, util.busyWidth)) * 100) : null,
      meanInFlightWhileWork: util.busyN ? +(util.busyInFlight / util.busyN).toFixed(2) : null,
      idleWithBacklogPct: Math.round((util.idleWithBacklog / util.n) * 100),
      waitingPct: Math.round((util.idleWaiting / util.n) * 100),
    };
  })();
  if (U) {
    log(`efficiency: ${U.utilisationWhileWorkPct == null ? '—' : U.utilisationWhileWorkPct + '%'} of arbitrated width in use while there was work (mean ${U.meanInFlightWhileWork} agents of ${U.meanWidth}) · saturated ${U.saturatedPct}% of samples`);
    log(`      waiting on a dependency or an answer: ${U.waitingPct}% of the run (not a fault) · idle WITH work ready: ${U.idleWithBacklogPct}% (a fault)`);
    log(`      width was limited by: ${U.binding}`);
    if (U.meanHeld > 0.1) log(`      mean ${U.meanHeld} item(s) READY with no free slot — the backlog behind the agents that exist`);
    if (LANES) log(`      lanes in flight: ${U.meanCloud} cloud + ${U.meanLocal} local`);
    // Thresholds, so this is a check and not just telemetry. They fire on utilisation WHILE THERE WAS
    // WORK and on idle-with-backlog — never on plain idle, which is what a run waiting for him looks
    // like. Loud, and not a hard failure: a narrow dependency frontier can legitimately leave slots empty.
    if (U.utilisationWhileWorkPct != null && U.utilisationWhileWorkPct < 50) log('      ⚠️  EFFICIENCY: under half the arbitrated width was in use even while work was available. A brake is too tight, or the plan cannot feed the fleet — find out which before adding agents.');
    if (U.idleWithBacklogPct > 5) log(`      ⚠️  EFFICIENCY: nothing was running in ${U.idleWithBacklogPct}% of samples while work was READY. That is wall clock nobody is working.`);
    if (U.saturatedPct > 80) log(`      ✅ width was the binding constraint ${U.saturatedPct}% of the time — this run would go faster with more agents.`);
  }

  if (LANES) {
    log('two lanes — the cloud lane simulates LATENCY ONLY (it does the work for real and is verified');
    log('like everything else); it is a reliable stand-in, so this measures the SCHEDULER and says');
    log('nothing about how good a real cloud model would be at these items:');
    for (const k of ['cloud', 'local']) {
      const L = laneStats[k];
      log(`      ${k}: ${L.started} started · peak ${L.peak} concurrent · ${Math.round(L.ms / Math.max(1, L.started))}ms mean`);
    }
    const ok1 = laneStats.local.peak <= 1;
    log(`      local lane never exceeded one slot: ${ok1 ? 'yes' : 'NO — ' + laneStats.local.peak}`);
    log(`      the second lane was additive: peak ${laneStats.cloud.peak + laneStats.local.peak} against a cloud width of ${WIDTH}`);
  }
  // The overnight field. A soak that escalates and falls back must show the fallbacks, or the harness
  // is measuring a behaviour it cannot display.
  if (report.assumed && report.assumed.length) {
    log(`decided without him (${report.assumed.length}):`);
    for (const a of report.assumed.slice(0, 5)) log(`      “${a.question || a.text}” → ${a.assumption}`);
  }
  log(`custodian: ${report.custodian ? `${report.custodian.verdict}${report.custodian.reason ? ' — ' + String(report.custodian.reason).slice(0, 90) : ''}` : '(not asked)'}`);
  // The blackboard is what makes three agents smarter than three agents in separate rooms. An hour of
  // it is also the only way to find out whether it grows without bound.
  let boardPosts = 0, boardMb = 0;
  if (report.boardFile && fs.existsSync(report.boardFile)) {
    boardPosts = fs.readFileSync(report.boardFile, 'utf8').trim().split('\n').filter(Boolean).length;
    boardMb = fs.statSync(report.boardFile).size / 1048576;
    log(`blackboard: ${boardPosts} posts, ${boardMb.toFixed(1)}MB`);
  } else log('blackboard: MISSING');
  if (forgeFails.size) {
    log('forge refusals (what a small model gets wrong, and whether the message tells it how to fix):');
    for (const [k, n] of [...forgeFails].sort((a, b) => b[1] - a[1]).slice(0, 8)) log(`    ${String(n).padStart(3)}× ${k}`);
  }

  // DOES IT DEGRADE? First half of the run against the second, by wall-clock, on independently
  // verified completions. This is the question an hour-long test exists to answer.
  const half = elapsedMin / 2;
  const early = completionTimes.filter((m) => m <= half).length;
  const late = completionTimes.filter((m) => m > half).length;
  // The comparison is only meaningful if there was still work to do in the second half. A run that
  // finished everything in minute one and then idled shows "0 in the second half", which measures the
  // size of the task list, not the stamina of the agent — and a metric that fires on its own success
  // is a metric nobody will believe the next time it fires for real.
  const hadWorkLate = verified.length < items.length || report.open.length > 0;
  log(`throughput: ${early} verified in the first ${half.toFixed(0)}min, ${late} in the second`
    + (hadWorkLate ? '' : ' (everything was finished before halfway — nothing left to measure)'));

  const fails = [];
  if (deadlocked) fails.push('LIVELOCK: ' + deadlocked);
  if (report.stoppedBecause === 'crashed') fails.push('the run crashed');
  // Running out of WORK is not running out of stamina. 'complete' and 'blocked' both mean there was
  // nothing left to do; only a wall or a stall before the time is up is a real early stop.
  const RAN_OUT = report.stoppedBecause === 'complete' || report.stoppedBecause === 'blocked' || !!deadlocked;
  if (elapsedMin < MINUTES * 0.95 && !RAN_OUT) fails.push(`stopped early at ${elapsedMin.toFixed(1)}min (${report.stoppedBecause}) — it was asked for ${MINUTES}`);
  if (RAN_OUT && elapsedMin < MINUTES * 0.95) log(`NOTE: it ran out of work at ${elapsedMin.toFixed(1)}min rather than running out of stamina — give it more --items to test the full window.`);
  if (verified.length === 0) fails.push('nothing was independently verified — the run did no real work');
  if (falseDone.length > verified.length * 0.25) fails.push(`${falseDone.length} items were claimed done without being done — a false done is a hole in the report`);
  const growthMb = (endRss - startRss) / 1048576;
  if (growthMb > 400) fails.push(`memory grew ${growthMb.toFixed(0)}MB over the run`);
  // A hot loop is the failure a wall-clock test is uniquely able to catch: correct, productive, and
  // burning a core doing nothing. Ticks are bounded by real work, so tens of thousands means spinning.
  if (report.ticks / Math.max(1, elapsedMin) > 4000) fails.push(`${Math.round(report.ticks / elapsedMin)} scheduling passes a minute — the loop is spinning rather than waiting`);
  // Only meaningful on a LONG run with a real sample. On a two-minute smoke the easy items finish in
  // minute one and the stragglers remain, so throughput "collapses" every time — which measures the
  // item mix, not stamina, and a metric that cries wolf on every short run is one nobody believes when
  // it fires for real.
  const degradeMeasurable = hadWorkLate && elapsedMin >= 20 && early >= 20;
  if (degradeMeasurable && late < early * 0.4) fails.push(`throughput collapsed: ${early} verified in the first half, ${late} in the second — and there was still work to do`);
  if (!degradeMeasurable && hadWorkLate) log('NOTE: too short a run to say anything about degradation — that needs 20+ minutes and 20+ completions in the first half.');
  if (stats.modelErrors > stats.modelCalls * 0.3) fails.push(`${stats.modelErrors}/${stats.modelCalls} model calls failed`);
  if (escalations.pending().length === 0 && asked.length === 0) fails.push('nothing ever escalated — the escalation path was not exercised at all');
  if (!report.boardFile || !boardPosts) fails.push('the agents had no blackboard — parallel was only faster, not smarter');
  // Two posts per item over an hour is a file, not a leak. This is the bound worth checking, because
  // an append-only log inside a loop is the classic way a long run eats a disk.
  if (boardMb > 50) fails.push(`the blackboard grew to ${boardMb.toFixed(0)}MB in an hour`);
  if (!report.custodian) fails.push('nothing reviewed the result — the run reported "done" with nobody having asked whether it answered the goal');
  const resumes = ((missions.attach(report.missionId) || {}).meta || {}).resumeCount || 0;
  if (resumes > 0) fails.push(`the run spent ${resumes} of its resume allowance on internal waits — unpark() is not being used`);

  // ── SOMEWHERE THE RESULT SURVIVES ───────────────────────────────────────────────────────────────
  // This used to write only into its own temp dir. Three days after the overnight pass, macOS had
  // reaped every one of them — so an optimisation pass that wanted a "before" had no denominator at
  // all. A benchmark whose output the operating system deletes is a benchmark you can only ever run
  // once. The durable copy goes to ~/.bhatbot/bench/ and one scannable row goes to BENCH_LOG.md.
  const journalRows = (() => { try { return missions.attach(report.missionId).journal(); } catch { return []; } })();
  // The journal is the real record; the harness's own counters are the fallback for anything the
  // supervisor never saw (a call that threw before an envelope came back).
  const tokIn = journalRows.reduce((a, r) => a + (r.tokensIn || 0), 0) || stats.tokensIn;
  const tokOut = journalRows.reduce((a, r) => a + (r.tokensOut || 0), 0) || stats.tokensOut;
  const perItem = verified.length ? Math.round((tokIn + tokOut) / verified.length) : 0;

  // Wh over the run, trapezoidal over the samples actually taken. Per VERIFIED item, because that is
  // the only denominator that cannot be inflated by claiming work you did not do.
  let energy = null;
  if (watts.length >= 2) {
    let wh = 0;
    for (let i = 1; i < watts.length; i++) wh += ((watts[i].w + watts[i - 1].w) / 2) * ((watts[i].mins - watts[i - 1].mins) / 60);
    const ws = watts.map((x) => x.w);
    energy = {
      meanW: +(ws.reduce((a, b) => a + b, 0) / ws.length).toFixed(1),
      minW: Math.min(...ws), maxW: Math.max(...ws),
      wh: +wh.toFixed(2),
      whPerVerifiedItem: verified.length ? +(wh / verified.length).toFixed(4) : null,
    };
    log(`energy: ${energy.meanW}W mean (${energy.minW}–${energy.maxW}) · ${energy.wh}Wh · ${energy.whPerVerifiedItem}Wh per verified item`);
  } else {
    log('energy: not measured (on AC — the battery field reports charge current there, not draw)');
  }

  const record = {
    at: new Date().toISOString(),
    git: (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return '(unknown)'; } })(),
    args: { minutes: MINUTES, items: ITEMS, width: WIDTH, model: MODEL },
    elapsedMin: +elapsedMin.toFixed(1),
    verified: verified.length, claimed: report.done.length, falseDone: falseDone.length,
    tokensIn: tokIn, tokensOut: tokOut, tokensPerVerifiedItem: perItem,
    spentUsd: report.spentUsd,
    rssStartMb: Math.round(startRss / 1048576), rssEndMb: Math.round(endRss / 1048576),
    modelCalls: stats.modelCalls, modelErrors: stats.modelErrors, toolCalls: stats.toolCalls,
    forged: stats.forgeOk, forgeAttempts: stats.forgeAttempts,
    escalations: { asked: asked.length, open: escalations.pending().length },
    boardPosts, throughput: { firstHalf: early, secondHalf: late }, efficiency: U, energy, watts,
    stoppedBecause: report.stoppedBecause, ticks: report.ticks,
    pass: fails.length === 0, fails,
    report, stats, events, rss, completionTimes,
  };

  const BENCH = path.join(os.homedir(), '.bhatbot', 'bench');
  let saved = path.join(TMP, 'report.json');
  try {
    fs.mkdirSync(BENCH, { recursive: true });
    saved = path.join(BENCH, `soak-${record.at.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(saved, JSON.stringify(record, null, 2));
  } catch (e) { fs.writeFileSync(saved, JSON.stringify(record, null, 2)); }

  // One row per run, newest last, in the repo — so a regression is visible in a diff rather than only
  // to whoever remembers to open a JSON file.
  try {
    const LOG = path.join(ROOT, 'BENCH_LOG.md');
    // The header is written when the file is created AND REPAIRED IF IT IS STALE. Writing it only on
    // creation is how the log ended up with a 12-column header over 13-column rows when the energy
    // column was added: every value after `rss` read one column to the left, so the Wh figure appeared
    // under "fwd/2nd half". A misaligned comparison table is worse than no table, because it is still
    // legible and now wrong.
    const HEADER = '| when | commit | min | width | verified | false-done | tok/item | $ | rss | energy | fwd/2nd half | stopped | pass |';
    const RULE = '|---|---|---|---|---|---|---|---|---|---|---|---|---|';
    if (fs.existsSync(LOG)) {
      const cur = fs.readFileSync(LOG, 'utf8');
      const head = (cur.match(/^\|\s*when\s*\|.*$/m) || [])[0];
      if (head && head !== HEADER) {
        fs.writeFileSync(LOG, cur.replace(head, HEADER).replace(/^\|-{3}\|.*$/m, RULE));
        log('note: repaired a stale BENCH_LOG header (columns had been added since it was written)');
      }
    }
    if (!fs.existsSync(LOG)) {
      fs.writeFileSync(LOG, [
        '# Soak log',
        '',
        'One row per `scripts/soak-supervisor.js` run. Every `verified` count is checked by the harness',
        'itself, never by asking the agent — "the agent said done" is the one signal an endurance test',
        'must not trust. Full records in `~/.bhatbot/bench/`.',
        '',
        HEADER,
        RULE,
        '',
      ].join('\n'));
    }
    const row = `| ${record.at.slice(0, 16).replace('T', ' ')} | \`${record.git}\` | ${record.elapsedMin} | ${WIDTH} | ${record.verified} | ${record.falseDone} | ${perItem} | ${record.spentUsd} | ${record.rssStartMb}→${record.rssEndMb}MB | ${energy ? energy.wh + 'Wh' : '—'} | ${early}/${late} | ${record.stoppedBecause} | ${record.pass ? '✅' : '❌'} |\n`;
    fs.appendFileSync(LOG, row);
  } catch {}

  log(`tokens: ${tokIn} in / ${tokOut} out → ${perItem} per verified item`);
  console.log('─'.repeat(78));
  if (fails.length) { console.log(`\n❌ soak FAILED (${fails.length}):`); fails.forEach((f) => console.log('   ✗ ' + f)); console.log(`\nfull report: ${saved}`); process.exit(1); }
  console.log(`\n✅ the supervisor ran ${elapsedMin.toFixed(1)} minutes unattended: ${verified.length} items independently verified, ${forge.list().length} tool(s) forged, ${asked.length} question(s) escalated without blocking, ${Math.round(growthMb)}MB memory growth.`);
  console.log(`   ${perItem} tokens per verified item · full report: ${saved}`);
})();
