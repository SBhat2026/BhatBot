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

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MINUTES = Number(arg('minutes', 60));
const MODEL = arg('model', 'qwen3:latest');
const WIDTH = Number(arg('width', 3));
const ITEMS = Number(arg('items', 120));
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
const stats = { toolCalls: 0, toolErrors: 0, modelCalls: 0, modelErrors: 0, forgeAttempts: 0, forgeOk: 0 };
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
  return j.message || {};
}

/** Some local builds put the call in `tool_calls`, some emit it as JSON in the content. Accept both. */
function toolCallsOf(msg) {
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    return msg.tool_calls.map((c) => ({ name: c.function && c.function.name, args: (c.function && c.function.arguments) || {} }));
  }
  const txt = String(msg.content || '').trim();
  const m = txt.match(/\{[\s\S]*"name"\s*:\s*"(\w+)"[\s\S]*\}/);
  if (!m) return [];
  try { const j = JSON.parse(m[0]); if (j.name) return [{ name: j.name, args: j.arguments || j.parameters || {} }]; } catch {}
  return [];
}

async function worker(spec) {
  const sys = `You are ${spec.name}, working one item of a plan. Designation: ${designation.get(spec.designation).label}.
Do the work with the tools. When the item asks you to WRITE something to a path, you must actually call write_file — saying you did is not doing it.
If no tool can do what is needed, forge one with forge_tool, then call it with call_forged.
Be brief. Do not explain. /no_think`;
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: spec.goal }];
  let last = '';
  for (let i = 0; i < 8; i++) {
    let m;
    try { m = await ollama(msgs, TOOLS); } catch (e) { stats.modelErrors++; return { status: 'failed', summary: 'model error: ' + e.message, turns: i }; }
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
  if (item && item.kind === 'ask') {
    return { status: 'blocked', summary: 'needs Siddhant', turns: 8,
      need: { kind: 'human', question: `What citation style do you want for item ${item.id}?`, assumption: 'APA' } };
  }
  const ok = item ? item.check() : false;
  return { status: ok ? 'done' : 'partial', summary: (ok ? 'verified: ' : 'not verified yet: ') + last.slice(0, 120), turns: 8 };
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
  const sup = createSupervisor({
    missions, escalations, forge,
    runAgent: worker,
    decompose: async () => items.map((i) => i.text),
    onEvent: (e) => { events[e.type] = (events[e.type] || 0) + 1; },
    log: () => {},
  }, { width: WIDTH, itemBudgetUsd: 999, maxItemAttempts: 2, stallTicks: 400, idleWaitMs: 90000 });

  const startedAt = Date.now();
  const startRss = process.memoryUsage().rss;
  log(`soak: ${MINUTES}min · ${MODEL} · width ${WIDTH} · ${items.length} items (${items.filter((i) => i.kind === 'count').length} verifiable / ${items.filter((i) => i.kind === 'forge').length} need a forged tool / ${items.filter((i) => i.kind === 'ask').length} need Siddhant)`);
  log(`workspace: ${TMP}`);

  // The heartbeat is the instrument. A soak whose only output is the final verdict cannot tell you
  // WHEN it went wrong, and "it degraded somewhere in the middle" is not a finding.
  const completionTimes = [];
  const beat = setInterval(() => {
    const mins = (Date.now() - startedAt) / 60000;
    const r = process.memoryUsage().rss;
    rss.push({ mins: +mins.toFixed(1), mb: Math.round(r / 1048576) });
    const verified = items.filter((i) => i.check()).length;
    while (completionTimes.length < verified) completionTimes.push(mins);
    log(`  ${mins.toFixed(1)}min · verified ${verified}/${items.length} · rss ${Math.round(r / 1048576)}MB · model ${stats.modelCalls} calls (${stats.modelErrors} err) · tools ${stats.toolCalls} · forged ${stats.forgeOk}/${stats.forgeAttempts} · asked ${asked.length}`);
  }, 60000);
  beat.unref?.();

  const report = await sup.run({ goal: 'Work through the audit checklist', plan: items.map((i) => i.text), budgetUsd: 999, wallClockMs: MINUTES * 60000, width: WIDTH });
  clearInterval(beat);

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
  if (report.stoppedBecause === 'crashed') fails.push('the run crashed');
  // Running out of WORK is not running out of stamina. 'complete' and 'blocked' both mean there was
  // nothing left to do; only a wall or a stall before the time is up is a real early stop.
  const RAN_OUT = report.stoppedBecause === 'complete' || report.stoppedBecause === 'blocked';
  if (elapsedMin < MINUTES * 0.95 && !RAN_OUT) fails.push(`stopped early at ${elapsedMin.toFixed(1)}min (${report.stoppedBecause}) — it was asked for ${MINUTES}`);
  if (RAN_OUT && elapsedMin < MINUTES * 0.95) log(`NOTE: it ran out of work at ${elapsedMin.toFixed(1)}min rather than running out of stamina — give it more --items to test the full window.`);
  if (verified.length === 0) fails.push('nothing was independently verified — the run did no real work');
  if (falseDone.length > verified.length * 0.25) fails.push(`${falseDone.length} items were claimed done without being done — a false done is a hole in the report`);
  const growthMb = (endRss - startRss) / 1048576;
  if (growthMb > 400) fails.push(`memory grew ${growthMb.toFixed(0)}MB over the run`);
  // A hot loop is the failure a wall-clock test is uniquely able to catch: correct, productive, and
  // burning a core doing nothing. Ticks are bounded by real work, so tens of thousands means spinning.
  if (report.ticks / Math.max(1, elapsedMin) > 4000) fails.push(`${Math.round(report.ticks / elapsedMin)} scheduling passes a minute — the loop is spinning rather than waiting`);
  if (hadWorkLate && early >= 4 && late < early * 0.4) fails.push(`throughput collapsed: ${early} verified in the first half, ${late} in the second — and there was still work to do`);
  if (stats.modelErrors > stats.modelCalls * 0.3) fails.push(`${stats.modelErrors}/${stats.modelCalls} model calls failed`);
  if (escalations.pending().length === 0 && asked.length === 0) fails.push('nothing ever escalated — the escalation path was not exercised at all');

  fs.writeFileSync(path.join(TMP, 'report.json'), JSON.stringify({ report, stats, events, rss, completionTimes, verified: verified.length, falseDone, elapsedMin }, null, 2));
  console.log('─'.repeat(78));
  if (fails.length) { console.log(`\n❌ soak FAILED (${fails.length}):`); fails.forEach((f) => console.log('   ✗ ' + f)); console.log(`\nfull report: ${path.join(TMP, 'report.json')}`); process.exit(1); }
  console.log(`\n✅ the supervisor ran ${elapsedMin.toFixed(1)} minutes unattended: ${verified.length} items independently verified, ${forge.list().length} tool(s) forged, ${asked.length} question(s) escalated without blocking, ${Math.round(growthMb)}MB memory growth.`);
  console.log(`   full report: ${path.join(TMP, 'report.json')}`);
})();
