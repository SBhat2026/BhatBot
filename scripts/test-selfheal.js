#!/usr/bin/env node
'use strict';
// Safety-rail tests for the autonomous self-healer (lib/selfheal.js). It auto-edits the repo and
// auto-reverts unsupervised when enabled (Feat-2 turns it on by default), so its rails are
// security-critical: verify-gate, daily cap, cooldown, clean-tree + idle gating, frozen-zone revert,
// trigger toggles, dedup, and local-commit-never-push. Pure policy (deps injected) → runs in plain
// node. Temp $HOME isolates selfheal.json. Wired into `npm run verify`.
//   node scripts/test-selfheal.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-selfheal-'));
process.env.HOME = TMP;
const sh = require('../lib/selfheal');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };
const ON = () => ({ selfHeal: { enabled: true } });
const OFF = () => ({});
const writeState = (s) => { fs.mkdirSync(path.dirname(sh.STATE_PATH), { recursive: true }); fs.writeFileSync(sh.STATE_PATH, JSON.stringify(s)); };
const clearState = () => { try { fs.unlinkSync(sh.STATE_PATH); } catch {} };

(async () => {
  // ---- enabled ----
  ok(sh.enabled(ON) === true, 'enabled: true when config.selfHeal.enabled');
  ok(sh.enabled(OFF) === false, 'enabled: false by default (disabled unless opted in)');

  // ---- the hardening: default verify gate is the FULL suite ----
  ok(sh.DEFAULTS.verify === 'npm run verify', 'hardening: DEFAULTS.verify === "npm run verify" (full functional gate, not parse-only)');

  // ---- enqueue rails ----
  ok(sh.enqueue({ problem: 'x' }, OFF).skipped === 'disabled', 'enqueue: no-op when disabled');
  ok(sh.enqueue({}, ON).skipped === 'no problem', 'enqueue: rejects empty mistake');
  const q1 = sh.enqueue({ key: 'k_a', problem: 'tool A broken' }, ON);
  ok(q1.queued === true, 'enqueue: queues a valid mistake');
  ok(sh.pending().find((m) => m.key === 'k_a').verify === 'npm run verify', 'enqueue: inherits the full-suite verify gate');
  ok(sh.enqueue({ key: 'k_a', problem: 'dup' }, ON).skipped === 'already queued', 'enqueue: dedups by key');
  ok(sh.enqueue({ key: 'k_t', problem: 'p', source: 'toolFailures' }, () => ({ selfHeal: { enabled: true, triggers: { toolFailures: false } } })).skipped
     === 'trigger off: toolFailures', 'enqueue: respects a disabled trigger');

  // ---- clusterAudit ----
  const now = Date.now();
  const evts = [
    { tool: 'write_file', ok: false, ts: new Date(now - 1000).toISOString(), result: 'EACCES' },
    { tool: 'write_file', ok: false, ts: new Date(now - 2000).toISOString(), result: 'EACCES' },
    { tool: 'write_file', ok: false, ts: new Date(now - 3000).toISOString(), result: 'EACCES' },
    { tool: 'ask_ai', ok: false, ts: new Date(now - 1000).toISOString(), result: 'timeout' },   // only 1 → below minFailures
    { tool: 'old_tool', ok: false, ts: new Date(now - 999 * 60 * 1000).toISOString(), result: 'x' }, // outside window
  ];
  const clusters = sh.clusterAudit(evts, ON);
  ok(clusters.length === 1 && clusters[0].key === 'toolfail:write_file', 'clusterAudit: clusters ≥minFailures of one tool, ignores singles + stale');
  ok(clusters[0].verify === 'npm run verify', 'clusterAudit: cluster mistakes use the full-suite verify');

  // ---- gate ----
  clearState();
  ok(sh.gate(OFF, { idle: true, treeClean: true }).reason === 'disabled', 'gate: blocked when disabled');
  ok(sh.gate(ON, { idle: false, treeClean: true }).reason === 'agent busy', 'gate: blocked when agent busy');
  ok(sh.gate(ON, { idle: true, treeClean: false }).reason === 'git tree dirty', 'gate: blocked when tree dirty');
  ok(sh.gate(ON, { idle: true, treeClean: true }).ok === true, 'gate: OK when enabled + idle + clean');
  writeState({ day: new Date().toISOString().slice(0, 10), countToday: 3 });
  ok(sh.gate(ON, { idle: true, treeClean: true }).reason === 'daily cap reached', 'gate: blocked at daily cap');
  writeState({ cooldownUntil: Date.now() + 60000 });
  ok(sh.gate(ON, { idle: true, treeClean: true }).reason === 'cooldown', 'gate: blocked during cooldown');
  clearState();

  // ---- runOne: frozen-zone revert (fix that touches a protected path is reverted, NOT committed) ----
  {
    const cmds = [];
    const runShell = async (cmd) => { cmds.push(cmd); return { stdout: /diff --name-only/.test(cmd) ? 'config.json\nmain.js\n' : '', success: true }; };
    sh.enqueue({ key: 'k_frozen', problem: 'fix that edits config' }, ON);
    const r = await sh.runOne(ON, { runFix: async () => ({ success: true }), notify: () => {}, runShell, proj: TMP });
    ok(r.fixed === false && Array.isArray(r.frozen) && r.frozen.includes('config.json'), 'runOne: frozen-zone fix → fixed=false, frozen reported');
    ok(cmds.some((c) => /checkout -- \. && git clean/.test(c)), 'runOne: frozen-zone fix → reverted (git checkout + clean)');
    ok(!cmds.some((c) => /git commit/.test(c)), 'runOne: frozen-zone fix → NOT committed');
  }

  // ---- runOne: happy path (non-frozen change kept + committed LOCALLY, never pushed) ----
  clearState();
  {
    const cmds = [];
    const runShell = async (cmd) => { cmds.push(cmd); return { stdout: /diff --name-only/.test(cmd) ? 'lib/foo.js\n' : '', success: true }; };
    sh.enqueue({ key: 'k_ok', problem: 'fix foo' }, ON);
    const r = await sh.runOne(ON, { runFix: async () => ({ success: true }), notify: () => {}, runShell, proj: TMP });
    ok(r.fixed === true && r.changed.includes('lib/foo.js'), 'runOne: clean fix → fixed=true, changed files reported');
    ok(cmds.some((c) => /git commit/.test(c)), 'runOne: clean fix → committed locally');
    ok(!cmds.some((c) => /git push/.test(c)), 'runOne: NEVER pushes');
  }

  // ---- runOne: failed fix → reverted by self_fix, counts toward cap (recordAttempt) ----
  clearState();
  {
    sh.enqueue({ key: 'k_fail', problem: 'unfixable' }, ON);
    const r = await sh.runOne(ON, { runFix: async () => ({ success: false }), notify: () => {}, runShell: async () => ({ stdout: '', success: true }), proj: TMP });
    ok(r.fixed === false, 'runOne: failed fix → fixed=false');
    ok(sh.status(ON).today >= 1, 'runOne: a failed attempt still counts toward the daily cap (anti-thrash)');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
