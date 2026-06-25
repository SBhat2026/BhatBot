#!/usr/bin/env node
'use strict';
// Quick parallelism benchmark — measures sequential vs Promise.all wall-clock for N real Sonnet
// calls (the same shape lib/orchestrator.ensemble fires), and reports throttling (429s). Shows the
// concurrency win that Cluster C unlocks + whether the current account tier serves it without backoff.
//   node scripts/parallel-bench.js [N]
const fs = require('fs'), os = require('os');
const cfg = JSON.parse(fs.readFileSync(os.homedir() + '/.bhatbot/config.json', 'utf8'));
const KEY = cfg.apiKey;
const MODEL = 'claude-sonnet-4-6';
const N = Math.max(2, Math.min(8, parseInt(process.argv[2] || '4', 10)));

const PROMPTS = [
  'In 4 sentences, argue the strongest case FOR using a knowledge graph for an AI assistant memory.',
  'In 4 sentences, argue the strongest case AGAINST a knowledge graph for AI memory — what breaks.',
  'In 4 sentences, propose the best hybrid memory design for a personal AI assistant.',
  'In 4 sentences, list the top failure modes of multi-agent orchestration and how to avoid them.',
  'In 4 sentences, explain when parallel agents help vs hurt answer quality.',
  'In 4 sentences, describe how to evaluate whether an agent ensemble beat a single agent.',
  'In 4 sentences, give the cheapest way to cut token cost in a tool-using agent loop.',
  'In 4 sentences, explain prompt caching and when it stops helping.',
];

async function call(prompt) {
  const t0 = Date.now();
  let status = 0, out = 0, err = null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    status = r.status;
    const j = await r.json();
    if (j.error) err = j.error.type + ': ' + (j.error.message || '').slice(0, 80);
    out = (j.usage || {}).output_tokens || 0;
  } catch (e) { err = e.message; }
  return { ms: Date.now() - t0, status, out, err };
}

(async () => {
  if (!KEY) { console.error('no apiKey in config'); process.exit(1); }
  const prompts = PROMPTS.slice(0, N);
  console.log(`\nBenchmark: ${N} Sonnet calls (max_tokens 500 each)\n`);

  // Sequential
  let t = Date.now(); const seq = [];
  for (const p of prompts) seq.push(await call(p));
  const seqMs = Date.now() - t;
  const seq429 = seq.filter((r) => r.status === 429).length;

  // brief cooldown so the two runs don't share a rate window
  await new Promise((r) => setTimeout(r, 3000));

  // Parallel
  t = Date.now();
  const par = await Promise.all(prompts.map(call));
  const parMs = Date.now() - t;
  const par429 = par.filter((r) => r.status === 429).length;

  const fmt = (rs) => rs.map((r) => (r.err ? `ERR(${r.status})` : `${(r.ms / 1000).toFixed(1)}s`)).join('  ');
  console.log('SEQUENTIAL', (seqMs / 1000).toFixed(1) + 's', `(429s: ${seq429})`, '\n  ', fmt(seq));
  console.log('PARALLEL  ', (parMs / 1000).toFixed(1) + 's', `(429s: ${par429})`, '\n  ', fmt(par));
  const speedup = seqMs / parMs;
  console.log(`\n→ Parallel speedup: ${speedup.toFixed(2)}× faster wall-clock`);
  console.log(`→ Throttling (429): sequential ${seq429}, parallel ${par429} ${par429 === 0 ? '(tier serves the burst cleanly)' : '(still hitting the cap)'}`);
  const errs = [...seq, ...par].filter((r) => r.err);
  if (errs.length) console.log('errors:', errs.map((e) => e.err).slice(0, 4));
})();
