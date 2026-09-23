#!/usr/bin/env node
'use strict';
// ── CAN IT KEEP WORKING? ──────────────────────────────────────────────────────────────────────────
// Not "is one answer correct" — agent-bench measures that. This measures whether BhatBot stays
// healthy across a SUSTAINED run: many turns, increasing in length, with the app's own vitals read
// between each one.
//
// It exists because the risk to unattended work is not a wrong answer, it is a slow rot nobody is
// watching: memory climbing, latency drifting, a turn that quietly answers with nothing. That last
// one has been seen three times, always on a long turn, never reproducibly — and a background job
// cannot notice it answered nobody.
//
// WHAT IS MEASURED, per turn: wall time, whether any text came back at all, and the process's heap
// and uptime. WHAT IS REPORTED: the trend, because a single slow turn is noise and a rising line is
// a leak.
//
//   npm run endurance:bench                  # dry — prints the plan, spends nothing
//   npm run endurance:bench -- --go [n]      # run n rounds (default 6). Costs money.
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

// Ordered shortest → longest, because the failure correlates with LENGTH and a rising ramp shows
// where it starts rather than only that it happened.
const TURNS = [
  { id: 'trivial', tools: 0, ask: 'Say ready in one word.' },
  { id: 'one-tool', tools: 1, ask: 'How many Google accounts are connected? Just the number.' },
  { id: 'two-tool', tools: 2, ask: 'Check my unread mail and tell me the count, then say what time it is. Two short sentences.' },
  { id: 'research', tools: 3, ask: 'Search the web for AlphaFold 3 release date, check arXiv for one recent protein design paper, and summarise both in two sentences.' },
  { id: 'long-chain', tools: 4, ask: 'Find a recent arXiv paper on enzyme design, search the web for a benchmark of it, check my calendar for the next 3 days, and give me a combined three-sentence summary.' },
];

const vitals = (url, token) => {
  try {
    const out = execFileSync('curl', ['-s', '-m', '8', '-H', `Authorization: Bearer ${token}`, `${url}/health`], { encoding: 'utf8' });
    return JSON.parse(out);
  } catch { return null; }
};

(async () => {
  const go = process.argv.includes('--go');
  const rounds = Number(process.argv.find((a) => /^\d+$/.test(a))) || 6;
  const token = process.env.BHATBOT_MCP_TOKEN;
  const url = 'http://127.0.0.1:8788';

  console.log(`\n── endurance bench ── ${TURNS.length} turn shapes × ${rounds} round(s) = ${TURNS.length * rounds} turns\n`);
  for (const t of TURNS) console.log(`  · ${t.id.padEnd(11)} ~${t.tools} tool(s)  ${t.ask.slice(0, 68)}`);
  if (!go) { console.log(`\n  Dry run. Re-run with --go to execute (this spends money — roughly $0.03–0.06 per turn).\n`); process.exit(0); }
  if (!token) { console.error('\n✗ set BHATBOT_MCP_TOKEN\n'); process.exit(2); }

  const rows = [];
  for (let round = 1; round <= rounds; round++) {
    for (const t of TURNS) {
      const t0 = Date.now();
      let text = '', err = null;
      try {
        text = execFileSync('node', [path.join(ROOT, 'scripts', 'bhatctl.js'), '-q', '-r', t.ask],
          { env: process.env, timeout: 240000, encoding: 'utf8' })
          .replace(/\x1b\[[0-9;]*m/g, '').replace(/^.*?BHATBOT\s*/s, '').trim();
      } catch (e) { err = String(e.message || e).slice(0, 60); }
      const ms = Date.now() - t0;
      const h = vitals(url, token) || {};
      // The property that matters for unattended work: did anything come back at all?
      const answered = !!text && !/^✗|no text/i.test(text);
      rows.push({ round, id: t.id, ms, answered, err, heapMb: h.heapMb || h.heap || null });
      process.stdout.write(`  ${answered ? '✓' : '✗'} r${round} ${t.id.padEnd(11)} ${(ms / 1000).toFixed(1)}s${err ? '  ' + err : answered ? '' : '  ← NO TEXT'}\n`);
    }
  }

  // Trend, not a single number: a slow turn is noise, a rising line is a leak.
  const byShape = {};
  for (const r of rows) (byShape[r.id] = byShape[r.id] || []).push(r);
  console.log('\n── per turn shape ' + '─'.repeat(52));
  for (const [id, rs] of Object.entries(byShape)) {
    const ok = rs.filter((r) => r.answered).length;
    const times = rs.map((r) => r.ms).sort((a, b) => a - b);
    // A TREND NEEDS SAMPLES. The first version printed first→last as a percentage at n=2 and
    // reported "+287% drift" on a turn that went from 1.7s to 6.5s — which is ordinary variance
    // dressed up as a finding. Below four rounds the honest output is the spread, not a direction.
    const lo = times[0], hi = times[times.length - 1];
    const trend = rs.length >= 4
      ? (() => {
          const half = Math.floor(rs.length / 2);
          const early = rs.slice(0, half).reduce((n, r) => n + r.ms, 0) / half;
          const late = rs.slice(-half).reduce((n, r) => n + r.ms, 0) / half;
          const d = ((late - early) / early) * 100;
          return ` · first half ${(early / 1000).toFixed(1)}s → last half ${(late / 1000).toFixed(1)}s (${d >= 0 ? '+' : ''}${d.toFixed(0)}%)`;
        })()
      : ` · spread ${(lo / 1000).toFixed(1)}–${(hi / 1000).toFixed(1)}s (too few rounds to call a trend)`;
    console.log(`  ${id.padEnd(11)} ${ok}/${rs.length} answered · median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s${trend}`);
  }
  const silent = rows.filter((r) => !r.answered);
  console.log('\n── overall ' + '─'.repeat(59));
  console.log(`  ${rows.length - silent.length}/${rows.length} turns answered`);
  if (silent.length) {
    console.log(`  ⚠ ${silent.length} silent turn(s) — check the app log for [no-text], which records duration, stop_reason and prompt:`);
    for (const s of silent) console.log(`      r${s.round} ${s.id} after ${(s.ms / 1000).toFixed(1)}s${s.err ? ' — ' + s.err : ''}`);
  } else {
    console.log('  no silent turns — the failure that breaks unattended work did not occur in this run');
  }
  console.log('');
  process.exit(silent.length ? 1 : 0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
