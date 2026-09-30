#!/usr/bin/env node
'use strict';
// ── IS THE MACHINERY STRANGLING THE WORK? ────────────────────────────────────────────────────────
//
// `npm run verify` answers "is it correct". This answers "is it still fast", which is a different
// question and was going unasked. The supervisor now carries six individually-correct brakes — the
// width arbiter, the one-agent-per-role cap, the single local slot, admission, the tier ladder and
// the cost pilot — and a stack of correct brakes is exactly how a system degrades monotonically while
// every test still passes. A run arbitrated to width 5 that averages 1.4 agents in flight is a bug,
// and no pass/fail suite will ever say so.
//
// It reads the durable soak records in ~/.bhatbot/bench/ and compares the most recent run against the
// ones before it. It deliberately does NOT run anything: measuring costs an hour and contends for the
// same CPU and Ollama that the thing being measured needs, which has already invalidated one baseline
// tonight. This is the cheap check you run often; the soak is the expensive one you run occasionally.
//
//   node scripts/efficiency-check.js            # the last run against its predecessors
//   node scripts/efficiency-check.js --all      # every run, oldest first
//   node scripts/efficiency-check.js --json     # machine-readable, for a future gate
//
// Exit code is 0 unless --strict is passed AND a regression threshold is crossed, because "slower
// than last time" is a conversation and not automatically a failure: a run against a different plan,
// a narrower dependency frontier or a busier machine is legitimately slower. The numbers are here to
// be explained, not to be enforced.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.bhatbot', 'bench');
const ALL = process.argv.includes('--all');
const JSON_OUT = process.argv.includes('--json');
const STRICT = process.argv.includes('--strict');

function load() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.startsWith('soak-') && f.endsWith('.json')); } catch { return []; }
  return files.map((f) => {
    try { return { file: f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Items verified per minute — the only throughput number that is independently checked. */
const rate = (r) => (r.elapsedMin > 0 ? r.verified / r.elapsedMin : 0);
const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

function row(r) {
  const e = r.efficiency || null;
  return {
    when: String(r.at || '').slice(0, 16).replace('T', ' '),
    commit: r.git || '—',
    min: +num(r.elapsedMin, 1),
    verified: r.verified,
    perMin: +num(rate(r), 1),
    tokPerItem: r.tokensPerVerifiedItem || null,
    utilPct: e ? e.utilisationPct : null,
    idlePct: e ? e.idlePct : null,
    meanAgents: e ? e.meanInFlight : null,
    width: e ? e.meanWidth : null,
    binding: e ? e.binding : null,
    falseDone: r.falseDone,
    stopped: r.stoppedBecause,
  };
}

const runs = load();
if (!runs.length) {
  console.log('no soak records in ' + DIR + ' — run `npm run bench:soak` first (it takes an hour).');
  process.exit(0);
}

if (JSON_OUT) { console.log(JSON.stringify(runs.map(row), null, 2)); process.exit(0); }

const shown = ALL ? runs : runs.slice(-6);
console.log('\nEFFICIENCY — ' + runs.length + ' soak record(s) in ' + DIR + '\n');
console.log('  when              commit    min  verified  /min  tok/item  util  idle  agents/width  stopped');
for (const r of shown) {
  const x = row(r);
  console.log('  ' + [
    x.when.padEnd(17),
    String(x.commit).padEnd(9),
    String(x.min).padStart(4),
    String(x.verified).padStart(9),
    String(x.perMin).padStart(6),
    String(x.tokPerItem || '—').padStart(9),
    (x.utilPct == null ? '—' : x.utilPct + '%').padStart(6),
    (x.idlePct == null ? '—' : x.idlePct + '%').padStart(6),
    (x.meanAgents == null ? '—' : x.meanAgents + '/' + x.width).padStart(13),
    '  ' + x.stopped + (x.falseDone > 0 ? '  ❌ ' + x.falseDone + ' false done — row invalid' : ''),
  ].join(''));
}

const last = runs[runs.length - 1];
const L = row(last);
console.log('\n  latest: ' + L.when + ' (' + L.commit + ')');
if (L.binding) console.log('  width was limited by: ' + L.binding);

// ── the findings ─────────────────────────────────────────────────────────────────────────────────
const findings = [];

// A false "done" is not an efficiency problem, but it invalidates every other number in the row, so
// it is checked first and it SHORT-CIRCUITS everything after it. A run that fabricates successes has
// no meaningful throughput, and the first version of this file happily went on to report a
// "degradation curve" derived from those fabrications — which is precisely the misattribution the
// whole exercise keeps tripping over. A number computed from invalid data is not a weaker finding
// than no number; it is a wrong one, and it is more convincing.
const INVALID = L.falseDone > 0;
if (INVALID) {
  findings.push(['FATAL', L.falseDone + ' false "done"(s) — this run fabricated successes, so its throughput, utilisation and degradation figures are all meaningless and are not reported']);
}

if (INVALID) {
  // nothing further: every downstream number depends on `verified`, which cannot be trusted here.
} else if (L.utilPct == null) {
  findings.push(['INFO', 'this run predates the efficiency instrument; utilisation is unknown for it']);
} else {
  if (L.utilPct < 50) findings.push(['WARN', 'only ' + L.utilPct + '% of arbitrated width was in use (mean ' + L.meanAgents + ' of ' + L.width + '). Either a brake is too tight or the plan frontier is too narrow to fill it — find out which BEFORE adding agents']);
  if (L.idlePct > 25) findings.push(['WARN', 'nothing was running in ' + L.idlePct + '% of samples — that is wall clock nobody is working']);
  if (L.utilPct >= 80) findings.push(['GOOD', L.utilPct + '% utilisation — the agents are the bottleneck, not the machinery']);
}

// Trend, against the mean of the previous comparable runs rather than the single previous one: one
// slow run is noise, and comparing to a neighbour turns noise into an alarm.
const prev = runs.slice(0, -1).filter((r) => r.elapsedMin >= 10 && !r.falseDone);
if (INVALID) {
  console.log('  trends: not computed — the latest run is invalid (see below)');
} else if (prev.length && last.elapsedMin >= 10) {
  const base = prev.reduce((a, r) => a + rate(r), 0) / prev.length;
  const now = rate(last);
  const delta = base > 0 ? ((now - base) / base) * 100 : 0;
  console.log('  throughput: ' + num(now, 1) + '/min against a ' + prev.length + '-run mean of ' + num(base, 1) + '/min (' + (delta >= 0 ? '+' : '') + num(delta, 0) + '%)');
  if (delta < -25) findings.push(['WARN', 'throughput is ' + num(-delta, 0) + '% below the running mean — check what was added since ' + (prev[prev.length - 1].git || 'the last run')]);

  const bt = prev.map((r) => r.tokensPerVerifiedItem).filter(Boolean);
  if (bt.length && last.tokensPerVerifiedItem) {
    const tb = bt.reduce((a, b) => a + b, 0) / bt.length;
    const td = ((last.tokensPerVerifiedItem - tb) / tb) * 100;
    console.log('  tokens/item: ' + last.tokensPerVerifiedItem + ' against a mean of ' + Math.round(tb) + ' (' + (td >= 0 ? '+' : '') + num(td, 0) + '%)');
    if (td > 25) findings.push(['WARN', 'tokens per verified item are ' + num(td, 0) + '% above the mean — something is being sent that was not before']);
  }
} else {
  console.log('  throughput: no comparable previous run (needs a clean run of 10+ minutes) — nothing to trend against yet');
}

// Degradation WITHIN the run is the thing an hours-long workflow actually cares about, and it is
// independent of how the run compares to any other.
const t = INVALID ? {} : (last.throughput || {});
if (t.firstHalf > 10) {
  const drop = ((t.firstHalf - t.secondHalf) / t.firstHalf) * 100;
  console.log('  within the run: ' + t.firstHalf + ' verified in the first half, ' + t.secondHalf + ' in the second (' + (drop > 0 ? '-' : '+') + num(Math.abs(drop), 0) + '%)');
  if (drop > 40) findings.push(['WARN', 'the second half did ' + num(drop, 0) + '% less than the first — that is a degradation curve, which is the one thing an hours-long run must not have']);
}

console.log('');
if (!findings.length) console.log('  ✅ nothing inhibiting the workflow that these numbers can see.\n');
for (const [level, msg] of findings) {
  console.log('  ' + ({ FATAL: '❌', WARN: '⚠️ ', GOOD: '✅', INFO: 'ℹ️ ' }[level] || '·') + ' ' + msg);
}
console.log('');

const bad = findings.some(([l]) => l === 'FATAL') || (STRICT && findings.some(([l]) => l === 'WARN'));
process.exit(bad && STRICT ? 1 : 0);
