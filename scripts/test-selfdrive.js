#!/usr/bin/env node
'use strict';
// Safety-rail tests for the PROACTIVE self-improvement governor (lib/selfdrive.js). It auto-edits AND
// PUSHES the repo unsupervised when enabled (aggressive default), so its rails are security-critical:
// enable toggle, gate (idle/treeClean/budget/cap/cooldown), desire selection (impact/rank/skip
// resolved+attempted), frozen-zone revert (incl. its OWN guardrails so it can't disable itself), and
// the keep→commit→push happy path. Pure policy (deps injected) → plain node. Temp $HOME isolates
// selfdrive.json. Wired into `npm run verify`.
//   node scripts/test-selfdrive.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-selfdrive-'));
process.env.HOME = TMP;
const sd = require('../lib/selfdrive');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };
const ON = () => ({});                                    // aggressive default = enabled with no config
const OFF = () => ({ selfDrive: { enabled: false } });
const writeState = (s) => { fs.mkdirSync(path.dirname(sd.STATE_PATH), { recursive: true }); fs.writeFileSync(sd.STATE_PATH, JSON.stringify(s)); };
const clearState = () => { try { fs.unlinkSync(sd.STATE_PATH); } catch {} };

(async () => {
  // ---- enabled (aggressive: on by default) ----
  ok(sd.enabled(ON) === true, 'enabled: TRUE by default (aggressive posture)');
  ok(sd.enabled(OFF) === false, 'enabled: false when explicitly disabled');
  ok(sd.DEFAULTS.push === true && sd.DEFAULTS.verify === 'npm run verify', 'defaults: aggressive (push) + full-suite verify gate');

  // ---- frozen zone INCLUDES the loop's own guardrails (can't disable itself) ----
  for (const f of ['lib/selfdrive.js', 'lib/risk.js', 'scripts/verify-syntax.js', '.env', 'config.json']) {
    ok(sd.DEFAULTS.frozen.includes(f), `frozen: ${f} protected even in aggressive mode`);
  }
  ok(sd.frozenViolations(['lib/foo.js', 'lib/risk.js'], ON).join() === 'lib/risk.js', 'frozenViolations: flags a guardrail edit, passes ordinary code');

  // ---- gate ----
  clearState();
  ok(sd.gate(OFF, { idle: true, treeClean: true }).reason === 'disabled', 'gate: blocked when disabled');
  ok(sd.gate(ON, { idle: false, treeClean: true }).reason === 'agent busy', 'gate: blocked when busy');
  ok(sd.gate(ON, { idle: true, treeClean: false }).reason === 'git tree dirty', 'gate: blocked when tree dirty');
  ok(/rate budget/.test(sd.gate(ON, { idle: true, treeClean: true, budget: { ok: false, reason: 'opus OTPM spent' } }).reason), 'gate: blocked when rate budget spent (run-until-limit)');
  ok(sd.gate(ON, { idle: true, treeClean: true, budget: { ok: true } }).ok === true, 'gate: OK when enabled + idle + clean + budget free');
  writeState({ day: new Date().toISOString().slice(0, 10), countToday: sd.DEFAULTS.maxPerDay });
  ok(sd.gate(ON, { idle: true, treeClean: true }).reason === 'daily cap reached', 'gate: blocked at daily cap');
  writeState({ cooldownUntil: Date.now() + 60000 });
  ok(sd.gate(ON, { idle: true, treeClean: true }).reason === 'cooldown', 'gate: blocked during cooldown');
  clearState();

  // ---- pickDesire: impact > rank, skip resolved + attempted + below minImpact ----
  const desires = [
    { id: 'lowimp', rank: 1, impact: 'low' },
    { id: 'bighi', rank: 3, impact: 'high' },
    { id: 'medone', rank: 2, impact: 'medium' },
    { id: 'done', rank: 1, impact: 'high' },
  ];
  ok(sd.pickDesire(desires, new Set(['done']), ON).id === 'bighi', 'pickDesire: highest impact wins, skips resolved');
  writeState({ attempts: { bighi: Date.now() } });
  ok(sd.pickDesire(desires, new Set(['done']), ON).id === 'medone', 'pickDesire: skips recently-attempted, falls to next-best');
  clearState();
  ok(sd.pickDesire([{ id: 'x', rank: 1, impact: 'low' }], new Set(), () => ({ selfDrive: { minImpact: 'medium' } })) === null, 'pickDesire: null when all below minImpact');

  // ---- cycle: happy path → implement + verify pass → commit + PUSH + resolve(helped) ----
  clearState();
  {
    const cmds = []; const resolved = [];
    const r = await sd.cycle(ON, {
      reflect: async () => ({ desires: [{ id: 'speedup', rank: 1, impact: 'high', aspiration: 'be faster', implementation: { summary: 'cache', modules_affected: ['lib/x.js'] } }] }),
      listResolvedIds: () => new Set(),
      resolveDesire: (id, o) => resolved.push({ id, helped: o.helped }),
      pipeline: async () => ({ brief: 'do the thing', verify: 'npm run verify' }),
      runFix: async (a) => { ok(a.apply === true && a.skipPerms === true, 'cycle: coder invoked with apply + skipPerms (unattended)'); return { success: true }; },
      runShell: async (cmd) => { cmds.push(cmd); return { stdout: /diff --name-only/.test(cmd) ? 'lib/x.js\n' : '', success: true }; },
      notify: () => {}, proj: TMP,
    });
    ok(r.fixed === true && r.desire === 'speedup', 'cycle: clean implement → fixed=true');
    ok(cmds.some((c) => /git checkout -B self-drive/.test(c)), 'cycle: works on isolated self-drive branch');
    ok(cmds.some((c) => /git commit/.test(c)) && cmds.some((c) => /git push -u origin self-drive/.test(c)), 'cycle: commits AND pushes (aggressive)');
    ok(resolved.length === 1 && resolved[0].helped === true, 'cycle: resolves the desire as helped');
  }

  // ---- cycle: fix touches a FROZEN guardrail → reverted, NOT committed, resolved(not helped) ----
  clearState();
  {
    const cmds = []; const resolved = [];
    const r = await sd.cycle(ON, {
      reflect: async () => ({ desires: [{ id: 'sneaky', rank: 1, impact: 'high', aspiration: 'edit my own gate' }] }),
      listResolvedIds: () => new Set(),
      resolveDesire: (id, o) => resolved.push({ id, helped: o.helped }),
      pipeline: async () => ({ brief: '', verify: 'npm run verify' }),
      runFix: async () => ({ success: true }),
      runShell: async (cmd) => { cmds.push(cmd); return { stdout: /diff --name-only/.test(cmd) ? 'lib/selfdrive.js\n' : '', success: true }; },
      notify: () => {}, proj: TMP,
    });
    ok(r.fixed === false && Array.isArray(r.frozen) && r.frozen.includes('lib/selfdrive.js'), 'cycle: editing its OWN guardrail → reverted (footgun blocked)');
    ok(cmds.some((c) => /checkout -- \. && git clean/.test(c)) && !cmds.some((c) => /git commit/.test(c)), 'cycle: frozen violation → reverted, never committed');
    ok(resolved[0] && resolved[0].helped === false, 'cycle: frozen violation → resolved as not-helped');
  }

  // ---- cycle: verify fails → runFix returns !success → resolved(not helped), no commit ----
  clearState();
  {
    const cmds = []; const resolved = [];
    const r = await sd.cycle(ON, {
      reflect: async () => ({ desires: [{ id: 'hard', rank: 1, impact: 'high', aspiration: 'do hard thing' }] }),
      listResolvedIds: () => new Set(),
      resolveDesire: (id, o) => resolved.push({ id, helped: o.helped }),
      pipeline: async () => ({ brief: '' }),
      runFix: async () => ({ success: false, error: 'verify failed' }),
      runShell: async (cmd) => { cmds.push(cmd); return { stdout: '', success: true }; },
      notify: () => {}, proj: TMP,
    });
    ok(r.fixed === false && !cmds.some((c) => /git commit/.test(c)), 'cycle: verify-failed fix → not committed');
    ok(resolved[0] && resolved[0].helped === false, 'cycle: verify-failed → resolved as not-helped');
  }

  // ---- cycle: no eligible desire ----
  clearState();
  {
    const r = await sd.cycle(ON, {
      reflect: async () => ({ desires: [{ id: 'onlyone', rank: 1, impact: 'high' }] }),
      listResolvedIds: () => new Set(['onlyone']),
      resolveDesire: () => {}, pipeline: async () => ({}), runFix: async () => ({ success: true }),
      runShell: async () => ({ stdout: '', success: true }), notify: () => {}, proj: TMP,
    });
    ok(r.ran === false && /no eligible/.test(r.reason), 'cycle: no-op when every desire is resolved');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
