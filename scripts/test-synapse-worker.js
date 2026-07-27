#!/usr/bin/env node
'use strict';
// Tests for scripts/synapse-worker.js — the headless process that makes "always-on" true.
//
// The load-bearing assertion is the boring one: NO ELECTRON IN THE REQUIRE GRAPH. If electron ever
// creeps in (directly, or transitively through a lib someone edits later), the worker stops booting
// under launchd and the second brain silently goes dark again — which is exactly the failure that
// left ~/.bhatbot/brain/ empty for weeks while a "worker" was supposedly running. A unit test cannot
// prove this by requiring the module, so we SPAWN it for real, under a temp $HOME, and check that it
// produced a graph.
//
// Also asserts the generated LaunchAgent avoids the two mistakes that killed the previous agents:
// invoking `npm` (launchd's PATH has no node → exit 127) and omitting HOME/PATH.
// Wired into `npm run verify`.
//   node scripts/test-synapse-worker.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-worker-'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// A self-contained fake $HOME: a config, one project, one git repo. No real data, no network.
fs.mkdirSync(path.join(TMP, '.bhatbot', 'projects'), { recursive: true });
fs.writeFileSync(path.join(TMP, '.bhatbot', 'config.json'), JSON.stringify({
  synapseBudgetUsd: 1,
  synapse: { worker: true, hydrateMin: 5, connectHours: 6, paid: true },
  apiKey: 'CRED_REF_APIKEY_FAKE',        // a vault handle — exactly what a real install has
  openaiKey: 'CRED_REF_OPENAIKEY_FAKE',
}));
fs.mkdirSync(path.join(TMP, 'demorepo', '.git'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'demorepo', 'README.md'), '# demorepo\nA fake repo for the worker test.');

// Scrub inherited keys so the run genuinely exercises the no-credentials path.
const ENV = { ...process.env, HOME: TMP, PATH: process.env.PATH };
delete ENV.ANTHROPIC_API_KEY; delete ENV.OPENAI_API_KEY; delete ENV.BHATBOT_ANTHROPIC_KEY;

const run = (args, extraEnv = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'synapse-worker.js'), ...args],
  { encoding: 'utf8', env: { ...ENV, ...extraEnv }, timeout: 120000, cwd: ROOT });

// ---- one real cycle, with NO credentials at all ----
const r = run(['--once']);
const out = (r.stdout || '') + (r.stderr || '');
ok(r.status === 0, `--once exits 0 (got ${r.status})${r.status !== 0 ? '\n' + out.slice(0, 1200) : ''}`);
ok(/synapse worker up/.test(out), 'worker: announces startup');

const graphPath = path.join(TMP, '.bhatbot', 'brain', 'graph.json');
ok(fs.existsSync(graphPath), 'worker: PRODUCED A GRAPH with no API key (the free pass is the point)');
let graph = null; try { graph = JSON.parse(fs.readFileSync(graphPath, 'utf8')); } catch {}
ok(graph && Object.keys(graph.nodes || {}).length > 0, 'worker: the graph has nodes');
ok(Object.values(graph.nodes).some((n) => n.type === 'project' && /demorepo/i.test(n.label + n.ref)), 'worker: indexed the git repo under the fake $HOME');
ok(Number((graph.meta || {}).spendUsd || 0) === 0, 'worker: spent nothing without keys');

// Degradation must be LOUD. A worker that quietly does half its job is the original bug.
ok(/paid pass degraded/.test(out), 'worker: says clearly that the paid pass is degraded');
ok(/add-generic-password/.test(out), 'worker: tells you exactly how to enable it (Keychain, not plaintext)');
ok(/cycle done/.test(out), 'worker: reports the cycle result');

// A CRED_REF handle must never be treated as a usable key.
ok(!/CRED_REF/.test(out) || /vault|handle|degraded/i.test(out), 'worker: never tries to use a vault handle as a key');

// ---- the pidfile is released so the next run is not locked out ----
ok(!fs.existsSync(path.join(TMP, '.bhatbot', 'synapse-worker.pid')), 'worker: releases its pidfile on exit');
const r2 = run(['--once']);
ok(r2.status === 0 && /cycle done/.test((r2.stdout || '') + (r2.stderr || '')), 'worker: a second run is not locked out');

// Re-hydrating must not duplicate — this runs every 30 minutes, forever.
const graph2 = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
ok(Object.keys(graph2.nodes).length === Object.keys(graph.nodes).length, 'worker: a second cycle updates, never duplicates');

// ---- a live lock is respected ----
fs.writeFileSync(path.join(TMP, '.bhatbot', 'synapse-worker.pid'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
const r3 = run(['--once']);
ok(/already holds the lock/.test((r3.stdout || '') + (r3.stderr || '')), 'worker: refuses to double-run against a LIVE lock');
ok(r3.status === 0, 'worker: standing down is a clean exit, not an error (launchd must not retry-storm)');
fs.unlinkSync(path.join(TMP, '.bhatbot', 'synapse-worker.pid'));

// ---- --status reports without running a cycle ----
const r4 = run(['--status']);
const s4 = (r4.stdout || '') + (r4.stderr || '');
ok(/worker:\s+not running/.test(s4), '--status: reports the worker is not running');
ok(/graph:\s+\d+ nodes/.test(s4), '--status: reports graph size');
ok(/NOT resolvable/.test(s4), '--status: reports unusable credentials honestly');
ok(!/cycle done/.test(s4), '--status: does NOT run a cycle');

// ---- THE ONE THAT MATTERS: no electron anywhere in the require graph ----
{
  const probe = `
    const Module = require('module');
    const orig = Module._load;
    Module._load = function (req, ...rest) {
      if (req === 'electron' || /^electron[\\\\/]/.test(req)) { console.error('ELECTRON_LEAKED:' + req); process.exit(42); }
      return orig.call(this, req, ...rest);
    };
    process.argv.push('--status');
    require(${JSON.stringify(path.join(ROOT, 'scripts', 'synapse-worker.js'))});
  `;
  const rp = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: ENV, timeout: 60000, cwd: ROOT });
  ok(rp.status !== 42, 'worker: NO electron in the require graph' + (rp.status === 42 ? ' — leaked via ' + (rp.stderr || '').trim() : ''));
}

// ---- the generated LaunchAgent avoids the mistakes that killed the previous two ----
{
  const installer = fs.readFileSync(path.join(ROOT, 'scripts', 'install-daemon.js'), 'utf8');
  // Slice from the WORKER_LABEL constant (not the function) so the label + plist are both in scope.
  const wblock = installer.slice(installer.indexOf("const WORKER_LABEL"));
  ok(/process\.execPath/.test(wblock), 'plist: uses an absolute node path (com.siddhant.bhatbot died on `npm` + launchd PATH → exit 127)');
  ok(!/'npm'|"npm"/.test(wblock.slice(0, wblock.indexOf('console.log'))), 'plist: never invokes npm');
  ok(/<key>HOME<\/key>/.test(wblock), 'plist: sets HOME (without it os.homedir() resolves elsewhere and the graph goes nowhere)');
  ok(/<key>PATH<\/key>/.test(wblock), 'plist: sets PATH (the Keychain `security` CLI must be reachable)');
  ok(/ThrottleInterval/.test(wblock), 'plist: throttles a crash-loop instead of hammering the machine');
  ok(/SuccessfulExit<\/key><false\/>/.test(wblock.replace(/\s+/g, '')) || /SuccessfulExit/.test(wblock), 'plist: KeepAlive is crash-only');
  ok(/com\.bhatbot\.synapse/.test(wblock), 'plist: uses the com.bhatbot.synapse label');
  ok(/electron/i.test(wblock) && /Run this with plain node/.test(wblock), 'installer: refuses to install itself under electron');
}

// ---- the app stands down when the daemon holds the lock (one graph, one budget) ----
{
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  ok(/headlessWorkerAlive\(\)/.test(main), 'app: checks whether the headless worker is alive');
  const tick = main.slice(main.indexOf('async function synapseWorkerTick()'), main.indexOf('function startSynapseWorker()'));
  ok(/if \(headlessWorkerAlive\(\)\) return;/.test(tick), 'app: the in-app timer stands down while the daemon owns the cycle');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
