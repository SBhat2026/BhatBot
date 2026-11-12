#!/usr/bin/env node
'use strict';
// ── THE GATES ─────────────────────────────────────────────────────────────────────────────────────
// `npm run verify` had grown to 118 scripts and 23.7 MINUTES. I mistook it for a hang twice, and a
// gate that slow stops being a gate — it becomes something you skip, and then the thing it was
// guarding breaks.
//
// The split is MEASURED, not guessed (scripts/verify.js --time regenerates the numbers):
//
//   111 of the 118 scripts finish in 18 SECONDS combined.
//   Four account for 21.4 minutes:  connectors 561s · agentlock 307s · imagesearch 235s ·
//                                   synapse-worker 181s
//
// Those four are slow because they do real network work, or deliberately sit through lock timeouts.
// They are not less important — they are less FREQUENT. So:
//
//   quick  (~20s)   every fast unit test. For the edit/run loop.
//   verify (~2min)  quick + the syntax walk + the structural audits. The pre-commit gate.
//   full   (~24min) everything, including the four slow ones. Before a release, or in CI.
//
// A tier is defined by what it EXCLUDES, so a new test joins the fast gate automatically and nobody
// has to remember to add it. That ordering matters: the failure mode of a hand-maintained list is a
// test that exists and is never run, which is the same disease as a module nothing requires.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Measured >20s. Everything else is fast by default.
const SLOW = new Set([
  'test-connectors.js',      // 561s — live MCP connector handshakes
  'test-agentlock.js',       // 307s — deliberately waits out real lock timeouts
  'test-imagesearch.js',     // 235s — hits Openverse and Wikimedia for real
  'test-synapse-worker.js',  // 181s — spawns the worker and lets it run a cycle
  'test-parallel-tools.js',  // 29s
]);

// Structural audits: cheap, and they catch the class of bug that unit tests cannot see at all —
// a module nothing requires, a document claiming a file that is not there.
const AUDITS = ['verify-syntax.js', 'deadcode.js --strict', 'docdrift.js --strict'];

const allTests = () => fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => /^test-.*\.js$/.test(f))
  .sort();

function run(list, label) {
  const t0 = Date.now();
  let failed = [];
  for (const cmd of list) {
    const name = cmd.split(' ')[0];
    process.stdout.write(`  ${name.replace(/\.js$/, '').padEnd(34)}`);
    const s = Date.now();
    try {
      execSync(`node ${path.join(ROOT, 'scripts', cmd)}`, { cwd: ROOT, stdio: 'pipe', timeout: 900000 });
      process.stdout.write(`✓ ${((Date.now() - s) / 1000).toFixed(1)}s\n`);
    } catch (e) {
      process.stdout.write(`✗ ${((Date.now() - s) / 1000).toFixed(1)}s\n`);
      failed.push({ name, out: String((e.stdout || '') + (e.stderr || '')).slice(-700) });
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  ${label}: ${list.length - failed.length}/${list.length} passed in ${secs}s`);
  for (const f of failed) console.log(`\n── ${f.name} ${'─'.repeat(50)}\n${f.out}`);
  return failed.length;
}

const mode = (process.argv[2] || 'verify').replace(/^--/, '');

if (mode === 'time') {
  // Regenerate the measurement the split is based on, so SLOW never drifts from reality.
  const rows = [];
  for (const t of allTests()) {
    const s = Date.now();
    try { execSync(`node ${path.join(ROOT, 'scripts', t)}`, { cwd: ROOT, stdio: 'ignore', timeout: 900000 }); } catch {}
    rows.push({ t, ms: Date.now() - s });
  }
  rows.sort((a, b) => b.ms - a.ms);
  console.log('\n  slowest 10:');
  for (const r of rows.slice(0, 10)) console.log(`    ${String((r.ms / 1000).toFixed(1) + 's').padStart(8)}  ${r.t}${SLOW.has(r.t) ? '   [in SLOW]' : r.ms > 20000 ? '   ← >20s and NOT in SLOW' : ''}`);
  const drift = rows.filter((r) => r.ms > 20000 && !SLOW.has(r.t));
  console.log(`\n  total ${(rows.reduce((n, r) => n + r.ms, 0) / 60000).toFixed(1)} min across ${rows.length} scripts`);
  if (drift.length) { console.log(`  ⚠ ${drift.length} script(s) are now slow but not listed in SLOW — the fast gate is no longer fast.`); process.exit(1); }
  process.exit(0);
}

const fast = allTests().filter((t) => !SLOW.has(t));
let failures = 0;

if (mode === 'quick') {
  console.log(`\n── quick ── ${fast.length} fast tests, no audits\n`);
  failures = run(fast, 'quick');
} else if (mode === 'full') {
  console.log(`\n── full ── all ${allTests().length} tests + audits (this takes ~24 minutes)\n`);
  failures = run([...AUDITS, ...allTests()], 'full');
} else {
  console.log(`\n── verify ── ${fast.length} fast tests + ${AUDITS.length} audits (the ${SLOW.size} slow tests are in \`npm run verify:full\`)\n`);
  failures = run([...AUDITS, ...fast], 'verify');
}
// The efficiency read lived here for five passes (2026-09-30 → 2026-11-12), at Siddhant's request,
// and has moved back to on demand as agreed: `npm run bench:efficiency`. It reads the durable soak
// records and runs nothing, so run it after a soak or after adding any constraint to the supervisor.
process.exit(failures ? 1 : 0);
