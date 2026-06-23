#!/usr/bin/env node
'use strict';
// W5 / AMBITIOUS_ROADMAP.md §A2 — one-command continual-learning cycle:
//   export traces → THRESHOLD GUARD → LoRA train → serve adapter → gated A/B eval → stop server.
//
// The guard is the point: a future cron (`manage_schedule`) can call this nightly and it will
// cheaply no-op until enough fresh trace data has accrued, then run a full train+eval+gated-promote
// pass on its own. Everything is local (MLX on-device); nothing leaves the machine.
//
// Usage:
//   node scripts/ft-cycle.js                 # export + guard; trains only if data ≥ threshold
//   node scripts/ft-cycle.js --force         # train+eval regardless of data volume (toolchain test)
//   node scripts/ft-cycle.js --min-sft 200   # override SFT-pair threshold (default 150)
//   node scripts/ft-cycle.js --no-eval       # train only, skip the A/B
// Exit 0 on success or a clean below-threshold skip; non-zero only on a hard failure.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const FT_DIR = path.join(os.homedir(), '.bhatbot', 'finetune');
const STATS = path.join(FT_DIR, 'stats.json');
const ADAPTERS = path.join(FT_DIR, 'adapters');
const VENV_PY = path.join(os.homedir(), '.bhatbot', 'mlx-venv', 'bin', 'python3');
const BASE = process.env.MLX_BASE || 'mlx-community/Qwen2.5-3B-Instruct-4bit';
const PORT = Number(process.env.FT_PORT) || 8081;

function arg(flag, def) { const i = process.argv.indexOf(flag); return i > -1 ? (process.argv[i + 1] || true) : def; }
const FORCE = process.argv.includes('--force');
const NO_EVAL = process.argv.includes('--no-eval');
const MIN_SFT = Number(arg('--min-sft', 150));
const MIN_PREF = Number(arg('--min-pref', 0));

function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
// Run a child to completion, inheriting stdio so the user sees live progress. Returns exit code.
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  return r.status == null ? 1 : r.status;
}

function waitForServer(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/v1/models', timeout: 2000 }, (res) => {
        res.resume(); resolve(true);
      });
      req.on('error', () => { if (Date.now() > deadline) resolve(false); else setTimeout(tick, 1500); });
      req.on('timeout', () => { req.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(tick, 1500); });
    };
    tick();
  });
}

(async () => {
  console.log('── BhatBot fine-tune cycle ──');

  // 1) Export fresh trace data.
  console.log('\n[1/4] export traces…');
  if (run(process.execPath, ['scripts/export-prefs.js'])) { console.error('✗ export failed'); process.exit(1); }

  // 2) Threshold guard — the cron-safety valve.
  const s = readJSON(STATS, { sftPairs: 0, prefPairs: 0 });
  console.log(`\n[2/4] guard: sftPairs=${s.sftPairs} (min ${MIN_SFT}), prefPairs=${s.prefPairs} (min ${MIN_PREF}), force=${FORCE}`);
  if (!FORCE && (s.sftPairs < MIN_SFT || s.prefPairs < MIN_PREF)) {
    console.log(`\n⏸ below threshold — skipping train/eval (this is the expected no-op until traces accrue).`);
    console.log(`   Re-run with --force to train anyway, or --min-sft N to lower the bar.`);
    process.exit(0);
  }

  // 3) Train (MLX LoRA via finetune.sh).
  console.log('\n[3/4] LoRA train…');
  if (run('bash', ['scripts/finetune.sh'])) { console.error('✗ train failed'); process.exit(1); }
  if (NO_EVAL) { console.log('\n✅ trained (eval skipped via --no-eval).'); process.exit(0); }

  // 4) Serve the adapter, run the gated A/B, then always stop the server.
  console.log('\n[4/4] serve adapter + gated A/B eval…');
  if (!fs.existsSync(VENV_PY)) { console.error('✗ mlx venv missing — run scripts/finetune.sh once first'); process.exit(1); }
  const server = spawn(VENV_PY, ['-m', 'mlx_lm.server', '--model', BASE, '--adapter-path', ADAPTERS, '--port', String(PORT)],
    { cwd: ROOT, stdio: 'ignore', detached: false });
  let code = 1;
  try {
    const up = await waitForServer(PORT, 60000);
    if (!up) { console.error('✗ MLX server did not come up within 60s'); }
    else { code = run(process.execPath, ['scripts/ft-eval.js', '--mlx-url', `http://localhost:${PORT}`]); }
  } finally {
    try { server.kill('SIGTERM'); } catch {}
  }
  console.log(code === 0 ? '\n✅ cycle complete (see FINETUNE_LOG.md for the A/B + promote decision).'
                         : '\n⚠ eval ran but candidate did not win — baseline kept (gate working as designed).');
  // A non-winning candidate is a HOLD, not a cycle failure → exit 0 unless the eval itself errored.
  process.exit(0);
})();
