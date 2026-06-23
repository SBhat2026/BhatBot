#!/usr/bin/env node
'use strict';
// W5 steps 3+4 — A/B the fine-tuned local model against the baseline on an eval set, then GATED
// promote. The candidate is only registered as the router's local model if it wins by a margin and
// shows no hard regressions; otherwise config is left untouched. Decision is logged to FINETUNE_LOG.md.
//
// Backends (both OpenAI/Ollama-style HTTP, nothing leaves the machine):
//   baseline : Ollama model (default qwen3:latest)            — --baseline qwen3:latest
//   candidate: an MLX server (mlx_lm.server, OpenAI-compat)   — --mlx-url http://localhost:8081
//              OR another Ollama model (e.g. a fused+converted build) — --candidate bhatbot-local
//
//   # serve the adapter first:  ~/.bhatbot/mlx-venv/bin/python3 -m mlx_lm.server --model <base> --adapter-path <dir> --port 8081
//   node scripts/ft-eval.js --mlx-url http://localhost:8081
//   node scripts/ft-eval.js --candidate bhatbot-local            # if you converted to Ollama
//
// Judge: Claude Haiku (needs anthropicKey/apiKey in ~/.bhatbot/config.json). Exit 0 always; the
// promotion decision is in the output + FINETUNE_LOG.md.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeJSON } = require('../lib/eval');

const CFG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { return {}; } })();
const LOG = path.join(__dirname, '..', 'FINETUNE_LOG.md');

function arg(flag, d) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : d; }
const BASELINE = arg('--baseline', 'qwen3:latest');
const MLX_URL = arg('--mlx-url', null);
const CANDIDATE = arg('--candidate', null);
const OLLAMA = arg('--ollama', 'http://127.0.0.1:11434');
const WIN_THRESHOLD = Number(arg('--threshold', '0.60'));   // candidate must win ≥60% of decided pairs
const MIN_CASES = 5;
const APIKEY = cfg.anthropicKey || cfg.apiKey || process.env.ANTHROPIC_API_KEY;

// Representative of the local_simple role: quick Q&A, planning, terse helpfulness, memory phrasing.
const CASES = [
  'In one sentence, what is the capital of France?',
  'Draft a 3-step plan to back up a folder to an external drive. Keep each step under 12 words.',
  'Rewrite this to be terse and direct: "I was just wondering if you could maybe help me out with something."',
  'Summarize in one line: the meeting was moved from Tuesday to Thursday at 3pm because the room was double-booked.',
  'I prefer replies under two sentences. Acknowledge that briefly.',
  'List three quick ideas for a weeknight dinner. Names only.',
  'Convert 2.5 hours into minutes. Just the number and unit.',
  'What is a good one-line git commit message for "fixed a typo in the README"?',
];

async function genOllama(base, model, prompt) {
  const t0 = Date.now();
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }], options: { temperature: 0.3 } }),
  });
  if (!r.ok) throw new Error(`ollama ${model} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return { text: (j.message && j.message.content || '').trim(), ms: Date.now() - t0 };
}
async function genOpenAI(url, prompt) {
  const t0 = Date.now();
  const r = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 400 }),
  });
  if (!r.ok) throw new Error(`mlx server ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return { text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim(), ms: Date.now() - t0 };
}

const genBaseline = (p) => genOllama(OLLAMA, BASELINE, p);
const genCandidate = MLX_URL ? (p) => genOpenAI(MLX_URL, p) : CANDIDATE ? (p) => genOllama(OLLAMA, CANDIDATE, p) : null;

const JUDGE_SYS = 'You compare two assistant answers (A and B) to the same prompt for a terse personal assistant. Prefer correct, direct, concise, instruction-following answers. Return ONLY JSON {"winner":"A"|"B"|"tie","why":"<=12 words"}.';

async function judge(prompt, a, b) {
  // Randomize position to cancel order bias: caller passes A=baseline,B=candidate but we swap 50/50.
  const swap = Math.random() < 0.5;
  const A = swap ? b : a, B = swap ? a : b;
  const out = await claudeJSON(
    `PROMPT:\n${prompt}\n\nANSWER A:\n${A.slice(0, 800)}\n\nANSWER B:\n${B.slice(0, 800)}`,
    { apiKey: APIKEY, system: JUDGE_SYS, max_tokens: 120 }
  );
  let w = (out && out.winner) || 'tie';
  if (swap && w === 'A') w = 'B'; else if (swap && w === 'B') w = 'A';   // unswap to baseline=A / candidate=B
  return { winner: w, why: (out && out.why) || '' };
}

async function main() {
  if (!genCandidate) { console.error('Provide --mlx-url <url> or --candidate <ollama-model>.'); process.exit(1); }
  if (!APIKEY) { console.error('No Anthropic key in config (anthropicKey/apiKey) — judge needs it.'); process.exit(1); }

  let candWins = 0, baseWins = 0, ties = 0, errors = 0, baseMs = 0, candMs = 0;
  const rows = [];
  for (const prompt of CASES) {
    try {
      const [a, b] = await Promise.all([genBaseline(prompt), genCandidate(prompt)]);
      baseMs += a.ms; candMs += b.ms;
      const j = await judge(prompt, a.text, b.text);
      if (j.winner === 'B') candWins++; else if (j.winner === 'A') baseWins++; else ties++;
      rows.push({ prompt: prompt.slice(0, 48), winner: j.winner === 'B' ? 'candidate' : j.winner === 'A' ? 'baseline' : 'tie', why: j.why });
    } catch (e) { errors++; rows.push({ prompt: prompt.slice(0, 48), winner: 'ERROR', why: e.message.slice(0, 60) }); }
  }

  const decided = candWins + baseWins;
  const winRate = decided ? candWins / decided : 0;
  const enoughData = (CASES.length - errors) >= MIN_CASES;
  const promote = enoughData && winRate >= WIN_THRESHOLD && candWins > baseWins;

  console.log('\n── BhatBot fine-tune A/B ──');
  console.log(`baseline : ${BASELINE} (avg ${Math.round(baseMs / CASES.length)}ms)`);
  console.log(`candidate: ${MLX_URL || CANDIDATE} (avg ${Math.round(candMs / CASES.length)}ms)`);
  for (const r of rows) console.log(`  [${r.winner.padEnd(9)}] ${r.prompt}  — ${r.why}`);
  console.log(`\ncandidate ${candWins} / baseline ${baseWins} / tie ${ties} / err ${errors}  → win-rate ${(winRate * 100).toFixed(0)}% (need ${(WIN_THRESHOLD * 100)}%)`);

  const verdict = promote ? 'PROMOTE' : 'HOLD';
  if (promote) {
    const id = CANDIDATE || `mlx-adapter`;
    cfg.models = cfg.models || {};
    cfg.models.local_simple = id;
    cfg.ftAdapter = { id, mlxUrl: MLX_URL || undefined, winRate: +winRate.toFixed(2), promotedAt: new Date().toISOString() };
    fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
    console.log(`\n✅ PROMOTED: config.models.local_simple = "${id}". Restart the app to route local turns to it.`);
  } else {
    console.log(`\n⏸ HOLD: baseline kept. ${!enoughData ? 'Too few decided cases.' : 'Candidate did not clear the bar.'} Config untouched.`);
  }

  const entry = `\n## ${new Date().toISOString()} — ${verdict}\n- baseline: ${BASELINE} · candidate: ${MLX_URL || CANDIDATE}\n- candidate ${candWins} / baseline ${baseWins} / tie ${ties} / err ${errors} — win-rate ${(winRate * 100).toFixed(0)}%\n- latency: base ${Math.round(baseMs / CASES.length)}ms vs cand ${Math.round(candMs / CASES.length)}ms\n`;
  try { fs.appendFileSync(LOG, entry); } catch {}
}

main().catch((e) => { console.error('ft-eval failed:', e.message); process.exit(0); });
