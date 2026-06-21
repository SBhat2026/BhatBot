#!/usr/bin/env node
'use strict';
// Test-run + self-iteration harness for the World Cup engine. Runs the full pipeline
// (fetch → groups → Elo → Monte-Carlo → report), and on EITHER a thrown error OR a sanity-check
// failure, appends a structured entry to WORLDCUP_ITERATION_LOG.md. That log is the seed the
// self-improvement loop (BhatBot's claude_code) reads to draft the next fix.
//
//   node scripts/worldcup-iterate.js            # one run, logs result
//   WC_SIMS=2000 node scripts/worldcup-iterate.js
const fs = require('fs');
const path = require('path');
const wc = require('../lib/worldcup');

const LOG = path.join(__dirname, '..', 'WORLDCUP_ITERATION_LOG.md');
function log(status, title, body) {
  const stamp = new Date().toISOString();
  const entry = `\n## [${status}] ${stamp} — ${title}\n${body}\n`;
  fs.appendFileSync(LOG, entry);
  console.log(`${status}: ${title}`);
}

// Sanity checks a correct snapshot must satisfy — each failure is an iteration target.
function checks(s) {
  const fail = [];
  if (s.groups.length !== 12) fail.push(`expected 12 groups, got ${s.groups.length}`);
  for (const g of s.groups) if (g.teams.length !== 4) fail.push(`group ${g.label} has ${g.teams.length} teams (expected 4)`);
  if (!s.matches.length) fail.push('0 matches parsed');
  const totW = Object.values(s.odds).reduce((a, o) => a + o.W, 0);
  if (Math.abs(totW - 1) > 0.02) fail.push(`title odds sum to ${totW.toFixed(3)} (expected ~1.0)`);
  const champ = Object.entries(s.odds).sort((a, b) => b[1].W - a[1].W)[0];
  if (!champ || champ[1].W <= 0) fail.push('no champion favourite emerged');
  // monotonicity: reaching the final implies reaching the semi
  for (const [ab, o] of Object.entries(s.odds)) if (o.F - o.SF > 0.01) fail.push(`${ab}: P(final) > P(semi)`);
  return fail;
}

(async () => {
  const t0 = Date.now();
  let s;
  try {
    s = await wc.snapshot({ ttlMs: 0, sims: Number(process.env.WC_SIMS) || 4000 });
  } catch (e) {
    log('FAIL', 'snapshot threw', '```\n' + (e.stack || e.message) + '\n```');
    process.exit(1);
  }
  const fails = checks(s);
  if (fails.length) {
    log('FAIL', `${fails.length} sanity check(s) failed`,
      fails.map((f) => `- ${f}`).join('\n') +
      `\n\nContext: groups=${s.groups.length}, matches=${s.matches.length}, stages=${s.stages.join('/')}.`);
    process.exit(2);
  }
  const champ = Object.entries(s.odds).sort((a, b) => b[1].W - a[1].W)[0];
  const top5 = Object.entries(s.odds).sort((a, b) => b[1].W - a[1].W).slice(0, 5)
    .map(([ab, o]) => `${ab} ${(o.W * 100).toFixed(1)}%`).join(', ');
  log('PASS', `pipeline OK in ${Date.now() - t0}ms`,
    `- groups: ${s.groups.length}, matches: ${s.matches.length}, stages: ${s.stages.join('/')}\n` +
    `- live now: ${s.live.length}, upcoming: ${s.upcoming.length}\n` +
    `- title favourite: **${champ[0]}** (${(champ[1].W * 100).toFixed(1)}%)\n- top 5: ${top5}`);
  process.exit(0);
})();
