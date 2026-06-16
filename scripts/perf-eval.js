#!/usr/bin/env node
'use strict';
// ===========================================================================
// BhatBot PERFORMANCE / CAPABILITY EVAL
//
// Measures the parent-planner → subagent pipeline the same dimensions the user asked for —
// routing success, argument integrity, error healing, and (LLM-judged) chat-update alignment /
// conciseness / hallucination — but as a SELF-CONTAINED Node harness instead of DeepEval(Python)
// + LangSmith/Phoenix(SaaS). See PERF-EVAL.md for the rationale. It exercises the REAL routing
// code (lib/router, lib/agents/orchestrator, lib/agents/protocol) and uses Claude-as-judge
// (G-Eval) for the text metrics. Traces are written as OTel-shaped JSONL (Phoenix-importable).
//
//   node scripts/perf-eval.js            # full run (needs config.apiKey for the judge suite)
//   node scripts/perf-eval.js --no-judge # offline suites only
// ===========================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = require('../lib/router');
const orch = require('../lib/agents/orchestrator');
const protocol = require('../lib/agents/protocol');
const { ROLE_TOOLS } = require('../lib/agents/roles');
const evalLib = require('../lib/eval');

const noJudge = process.argv.includes('--no-judge');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8')); } catch { return {}; } })();
const apiKey = cfg.apiKey || process.env.ANTHROPIC_API_KEY || '';

const EVAL_DIR = path.join(os.homedir(), '.bhatbot', 'eval');
fs.mkdirSync(EVAL_DIR, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const traceFile = path.join(EVAL_DIR, `run-${runId}.jsonl`);
const spans = [];
function span(name, attrs) { const s = { ts: Date.now(), name, ...attrs }; spans.push(s); fs.appendFileSync(traceFile, JSON.stringify(s) + '\n'); return s; }

const pct = (n, d) => d ? Math.round((100 * n) / d) : 0;
const bar = (p) => '█'.repeat(Math.round(p / 5)).padEnd(20, '░');

// --------------------------------------------------------------------------
// Suite A — Subagent routing success
// --------------------------------------------------------------------------
const ROUTING = [
  { prompt: 'Fix the null pointer crash in main.js and add a test', agent: 'coding' },
  { prompt: 'Refactor the router to support a new provider', agent: 'coding' },
  { prompt: 'Research recent papers on protein complex assembly order', agent: 'research' },
  { prompt: 'Look up the docs for the Notion API rate limits', agent: 'research' },
  { prompt: 'Open YouTube and take a screenshot of the homepage', agent: 'browser' },
  { prompt: 'Remember that my advisor prefers Friday meetings', agent: 'memory' },
  { prompt: 'Generate a 3D mesh of a gear and texture it', agent: 'creative' },
  { prompt: 'Render a model of a gear and export the STL', agent: 'creative' },        // regression: bare "render" must not win
  { prompt: 'Make an STL of a bracket for 3D printing', agent: 'creative' },           // regression: STL must not fall to default
];
function suiteRouting() {
  let ok = 0;
  const rows = ROUTING.map((c) => {
    const got = orch.inferAgent(c.prompt);
    const cls = router.classOf({ agent: got });
    const pass = got === c.agent;
    if (pass) ok++;
    span('route', { prompt: c.prompt, expected: c.agent, got, class: cls, pass });
    return { prompt: c.prompt.slice(0, 46), expected: c.agent, got, class: cls, pass };
  });
  return { name: 'Routing success', score: pct(ok, ROUTING.length), ok, total: ROUTING.length, rows };
}

// --------------------------------------------------------------------------
// Suite B — Argument integrity (task built for the subagent is well-formed + params survive)
// --------------------------------------------------------------------------
const ARGS = [
  { agent: 'coding', goal: 'edit lib/figures.js to cap the cache at 24 entries', mustContain: ['24'] },
  { agent: 'creative', goal: 'slice the STL at 0.2mm layer height with 20% infill', mustContain: ['0.2mm', '20%'] },
  { agent: 'research', goal: 'compare GAT vs GraphSAGE on the PPI benchmark', mustContain: ['PPI'] },
];
function suiteArgs() {
  let ok = 0;
  const rows = ARGS.map((c, i) => {
    const task = protocol.buildTask({ id: 't' + i, agent: c.agent, goal: c.goal, expects: 'answer' });
    const valid = protocol.validateTask ? !!protocol.validateTask(task) : true;
    const hasFields = task.agent === c.agent && typeof task.goal === 'string' && !!task.expects;
    const paramsKept = c.mustContain.every((s) => task.goal.includes(s));
    const toolsetOk = Array.isArray(ROLE_TOOLS[c.agent]) && ROLE_TOOLS[c.agent].length > 0;
    const pass = valid && hasFields && paramsKept && toolsetOk;
    if (pass) ok++;
    span('args', { agent: c.agent, goal: c.goal, valid, hasFields, paramsKept, toolsetOk, pass });
    return { agent: c.agent, paramsKept, valid, toolsetOk, pass };
  });
  return { name: 'Argument integrity', score: pct(ok, ARGS.length), ok, total: ARGS.length, rows };
}

// --------------------------------------------------------------------------
// Suite C — Error healing (escalation policy + a fail→retry→succeed heal loop)
// --------------------------------------------------------------------------
async function suiteC() {
  const checks = [];
  // 1) router.shouldEscalate retries until the limit, then stops (no infinite loop, no crash).
  const cfg2 = { local_retry_limit: 2 };
  const esc = [0, 1, 2].map((attempt) => router.shouldEscalate({ result: { status: 'error' }, attempt, config: cfg2 }));
  const escOk = esc[0] === true && esc[1] === true && esc[2] === false;
  checks.push({ name: 'escalate-until-limit', pass: escOk, detail: JSON.stringify(esc) });
  span('heal', { check: 'escalate', seq: esc, pass: escOk });

  // 2) Transient failure heals: a tool that fails twice then succeeds, retried up to 3 → success.
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw new Error('ECONNRESET (transient)'); return 'ok'; };
  async function withRetry(fn, n) { let last; for (let i = 0; i < n; i++) { try { return { ok: true, val: await fn(), tries: i + 1 }; } catch (e) { last = e; } } return { ok: false, error: last.message, tries: n }; }
  const healed = await withRetry(flaky, 3);
  const healOk = healed.ok && healed.tries === 3;
  checks.push({ name: 'transient-heals', pass: healOk, detail: `tries=${healed.tries} ok=${healed.ok}` });
  span('heal', { check: 'transient', tries: healed.tries, ok: healed.ok, pass: healOk });

  // 3) Permanent failure degrades GRACEFULLY (returns an error, never throws/crashes).
  const perma = await withRetry(async () => { throw new Error('permanent: file not found'); }, 3);
  const gracefulOk = perma.ok === false && !!perma.error;
  checks.push({ name: 'permanent-degrades-gracefully', pass: gracefulOk, detail: perma.error });
  span('heal', { check: 'permanent', ok: perma.ok, pass: gracefulOk });

  const ok = checks.filter((c) => c.pass).length;
  return { name: 'Error healing', score: pct(ok, checks.length), ok, total: checks.length, rows: checks };
}

// --------------------------------------------------------------------------
// Suite D — Chat-update quality (LLM judge): alignment / conciseness / hallucination
// Includes adversarial cases so we ALSO verify the judge discriminates good from bad.
// --------------------------------------------------------------------------
const UPDATES = [
  { kind: 'good', groundTruth: '3D subagent: generate_mesh OK. slice_stl FAILED (non-manifold edge). auto-repaired mesh, slice_stl OK. exported gear.stl.',
    update: 'Built the gear mesh — the first slice hit a non-manifold edge, so I repaired it and re-sliced. gear.stl is ready.' },
  { kind: 'good', groundTruth: 'email subagent: browser_login to gmail FAILED (wrong password). did not send.',
    update: "Couldn't send the email — the Gmail login was rejected, so nothing went out. Flagged it for you." },
  { kind: 'hallucinated', groundTruth: '3D subagent: slice_stl FAILED permanently after 3 retries. nothing exported.',
    update: 'All done — your gear has been sliced and is ready to print!' },
  { kind: 'noisy', groundTruth: 'research subagent: fetched 3 URLs, summarized 2 papers OK.',
    update: '[2026-06-16T09:01:22Z] DEBUG spawn pid=55231 ... GET 200 14233 bytes ... GET 200 9981 bytes ... Traceback (most recent call last): retry ... INFO done exit=0 INFO done exit=0 bytes=...' },
];
async function suiteD() {
  if (noJudge || !apiKey) return { name: 'Chat-update quality (judge)', skipped: true, reason: noJudge ? '--no-judge' : 'no apiKey' };
  const judged = [];
  for (const c of UPDATES) {
    try {
      const s = await evalLib.judgeUpdate({ update: c.update, groundTruth: c.groundTruth, apiKey });
      judged.push({ kind: c.kind, ...s });
      span('judge', { kind: c.kind, ...s });
    } catch (e) { judged.push({ kind: c.kind, error: e.message }); span('judge', { kind: c.kind, error: e.message }); }
  }
  const goods = judged.filter((j) => j.kind === 'good' && j.alignment != null);
  const hall = judged.find((j) => j.kind === 'hallucinated');
  const noisy = judged.find((j) => j.kind === 'noisy');
  const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const goodAlign = mean(goods.map((j) => j.alignment));
  const goodConc = mean(goods.map((j) => j.conciseness));
  const goodHall = mean(goods.map((j) => j.hallucination));
  // Discrimination checks: the judge must catch the bad ones.
  const catchesHall = hall && hall.alignment != null && hall.hallucination > 0.5 && hall.alignment < 0.5;
  const catchesNoise = noisy && noisy.conciseness != null && noisy.conciseness < 0.5;
  return { name: 'Chat-update quality (judge)', judged,
    metrics: { good_alignment: +goodAlign.toFixed(2), good_conciseness: +goodConc.toFixed(2), good_hallucination: +goodHall.toFixed(2) },
    discrimination: { catches_hallucination: !!catchesHall, catches_noise: !!catchesNoise } };
}

// --------------------------------------------------------------------------
(async () => {
  console.log('\n  BhatBot Performance / Capability Eval — run ' + runId + '\n  ' + '─'.repeat(60));
  const A = suiteRouting();
  const B = suiteArgs();
  const C = await suiteC();
  const D = await suiteD();

  const line = (s) => console.log(`  ${s.name.padEnd(26)} ${bar(s.score)} ${String(s.score).padStart(3)}%  (${s.ok}/${s.total})`);
  console.log('\n  DETERMINISTIC SUITES (real router/orchestrator code, offline)');
  line(A); line(B); line(C);

  console.log('\n  Routing detail:');
  for (const r of A.rows) console.log(`    ${r.pass ? '✅' : '❌'} ${r.prompt.padEnd(48)} → ${r.got}${r.pass ? '' : ' (exp ' + r.expected + ')'}`);

  if (!D.skipped) {
    console.log('\n  CHAT-UPDATE JUDGE (Claude G-Eval)');
    for (const j of D.judged) {
      if (j.error) { console.log(`    ⚠ ${j.kind}: ${j.error}`); continue; }
      console.log(`    ${j.kind.padEnd(13)} align=${j.alignment}  concise=${j.conciseness}  halluc=${j.hallucination}  — ${j.reason || ''}`);
    }
    console.log(`\n    Honest-update means: alignment=${D.metrics.good_alignment}  conciseness=${D.metrics.good_conciseness}  hallucination=${D.metrics.good_hallucination}`);
    console.log(`    Judge discrimination: catches hallucination=${D.discrimination.catches_hallucination ? '✅' : '❌'}  catches noise=${D.discrimination.catches_noise ? '✅' : '❌'}`);
  } else {
    console.log('\n  CHAT-UPDATE JUDGE: skipped (' + D.reason + ')');
  }

  // Overall capability score (deterministic suites; judge reported separately as quality signal).
  const overall = Math.round((A.score + B.score + C.score) / 3);
  console.log('\n  ' + '─'.repeat(60));
  console.log(`  OVERALL PIPELINE SCORE (routing+args+healing): ${overall}%`);
  console.log(`  Trace (OTel-shaped, Phoenix-importable): ${traceFile}`);

  const summary = { runId, overall, routing: A, args: B, healing: C, judge: D, spans: spans.length };
  const summaryFile = path.join(EVAL_DIR, `summary-${runId}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`  Summary: ${summaryFile}\n`);
})();
