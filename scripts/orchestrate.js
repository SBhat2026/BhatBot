#!/usr/bin/env node
'use strict';
// Run the multi-agent orchestrator on a goal, end-to-end, from the CLI (no Electron).
// Uses the active workspace (or --ws <slug>), local-first routing, structured state.
//   node scripts/orchestrate.js "Goal text here" [--ws <slug>] [--max 10]
const ws = require('../lib/workspace');
const adapters = require('../lib/adapters');
const orchestrator = require('../lib/agents/orchestrator');
const State = require('../lib/state');

(async () => {
  const argv = process.argv.slice(2);
  const wsi = argv.indexOf('--ws'); let slug = wsi >= 0 ? argv[wsi + 1] : ws.getActive();
  const maxi = argv.indexOf('--max'); const maxTasks = maxi >= 0 ? +argv[maxi + 1] : 12;
  const goal = argv.filter((a, i) => a !== '--ws' && a !== '--max' && argv[i - 1] !== '--ws' && argv[i - 1] !== '--max').join(' ').trim();
  if (!goal) { console.error('usage: orchestrate "<goal>" [--ws slug] [--max n]'); process.exit(1); }
  if (!slug) { const w = ws.create(goal.slice(0, 40)); slug = w.slug; ws.setActive(slug); console.log('created workspace:', slug); }

  const w = ws.load(slug);
  const config = { ...ws.readJSON(require('path').join(require('os').homedir(), '.bhatbot', 'config.json'), {}), __metrics: State.open(w.dir).snapshot().components ? (State.open(w.dir), {}) : {} };
  config.__metrics = { cost_month_usd: (State.open(w.dir).all() && 0) || 0 };

  console.log(`\n▶ ${slug}: ${goal}\n`);
  const res = await orchestrator.run(goal, {
    wsDir: w.dir, config, adapters: adapters.build(w.dir), maxTasks,
    onStep: ({ task, result }) => console.log(`  • ${task.id} [${task.agent}] ${result.status}: ${result.summary}`),
  });
  console.log(`\n✓ completed ${res.completed}, open ${res.open}${res.blocked ? ' (BLOCKED — needs input)' : ''}`);
  console.log('state:', State.open(w.dir).digest() || '(empty)');
})();
