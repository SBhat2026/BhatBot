#!/usr/bin/env node
'use strict';
// Deterministic unit tests for the JARVIS-upgrade modules (W1–W8). No network, no running app —
// pure-logic regression coverage so future edits can't silently break the risk gate, the knowledge
// graph, the plugin sandbox, the A2A envelope, or tool-retrieval's safe fallbacks.
//
//   npm run test:upgrade        (exit non-zero on any failure)
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
// Isolate file-backed stores (graph.json, a2a.jsonl, toolvecs.json live under $HOME/.bhatbot) to a
// throwaway dir BEFORE requiring the modules, so tests never touch the real user data.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-upgrade-test-'));
process.env.HOME = TMP_HOME;
process.on('exit', () => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {} });

let passed = 0, failed = 0;
// run sequentially so async tests report in order, then summarize
async function run(cases) {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('✅', name); }
    catch (e) { failed++; console.log('❌', name, '—', e.message); }
  }
}

const risk = require('../lib/risk');
const graph = require('../lib/graph');
const sandbox = require('../lib/sandbox');
const a2a = require('../lib/a2a');
const toolselect = require('../lib/toolselect');

(async () => {
  // ---- W3 risk classification ----
  await run([
    ['risk: read-only → auto', () => assert.equal(risk.riskOf('read_file', {}, 'desktop'), 'auto')],
    ['risk: media → auto', () => assert.equal(risk.riskOf('media_control', {}, 'desktop'), 'auto')],
    ['risk: write_file → confirm', () => assert.equal(risk.riskOf('write_file', {}, 'desktop'), 'confirm')],
    ['risk: system_control → confirm', () => assert.equal(risk.riskOf('system_control', {}, 'desktop'), 'confirm')],
    ['risk: run_shell → auto (inner gate owns it)', () => assert.equal(risk.riskOf('run_shell', {}, 'desktop'), 'auto')],
    ['risk: self_fix → stepup', () => assert.equal(risk.riskOf('self_fix', {}, 'desktop'), 'stepup')],
    ['risk: keychain local → auto', () => assert.equal(risk.riskOf('keychain_lookup', {}, 'desktop'), 'auto')],
    ['risk: keychain remote → stepup', () => assert.equal(risk.riskOf('keychain_lookup', {}, 'remote'), 'stepup')],

    // ---- W4 knowledge graph (uses a temp store) ----
    ['graph: ingest + 2-hop traversal', () => {
      process.env.HOME = process.env.HOME; // no-op; graph uses ~/.bhatbot — test via in-memory ops
      const r = graph.ingest([
        { subject: 'Siddhant', predicate: 'works on', object: 'PRISM', subjectType: 'person', objectType: 'project' },
        { subject: 'PRISM', predicate: 'uses', object: 'ESM-2', subjectType: 'project', objectType: 'tool' },
      ]);
      assert.ok(r.added >= 1, 'expected edges added');
      const q = graph.query('PRISM', { depth: 2 });
      assert.ok(q.hits.some((h) => /ESM-2/.test(h)), '2-hop should reach ESM-2');
    }],
    ['graph: empty query → no hits', () => {
      const q = graph.query('zzz_nonexistent_entity_qqq', { depth: 2 });
      assert.deepEqual(q.hits, []);
    }],

    // ---- W6 sandbox ----
    ['sandbox: pure compute', async () => { const r = await sandbox.runSandboxed('return input.a*input.b;', { a: 6, b: 7 }); assert.equal(r.result, 42); }],
    ['sandbox: fs blocked by default', async () => { const r = await sandbox.runSandboxed('return require("fs").readFileSync("/etc/hosts");', {}); assert.equal(r.success, false); assert.match(r.error, /not allowed/); }],
    ['sandbox: timeout kills hang', async () => { const r = await sandbox.runSandboxed('while(true){}', {}, { timeoutMs: 400 }); assert.equal(r.success, false); assert.match(r.error, /timeout/); }],
    ['sandbox: throw captured', async () => { const r = await sandbox.runSandboxed('throw new Error("x");', {}); assert.equal(r.success, false); }],

    // ---- W7 A2A envelope ----
    ['a2a: completed lifecycle', async () => {
      const env = a2a.makeEnvelope({ to: 'research', task: 'find X' });
      assert.equal(env.status, 'submitted');
      const done = await a2a.handoff(env, { localAgents: ['research'], run: async () => ({ success: true, result: 'ok' }) });
      assert.equal(done.status, 'completed');
      assert.equal(done.result, 'ok');
    }],
    ['a2a: failure lifecycle', async () => {
      const env = a2a.makeEnvelope({ to: 'coding', task: 'break' });
      const done = await a2a.handoff(env, { localAgents: ['coding'], run: async () => ({ success: false, error: 'nope' }) });
      assert.equal(done.status, 'failed');
    }],
    ['a2a: missing to/task throws', () => { assert.throws(() => a2a.makeEnvelope({ task: 'x' })); }],

    // ---- W1 tool retrieval safe fallbacks (no network) ----
    ['toolselect: small catalog → null (full)', async () => { const r = await toolselect.select('hi', [{ name: 'a', description: 'x' }]); assert.equal(r, null); }],
    ['toolselect: empty query → null', async () => { const big = Array.from({ length: 20 }, (_, i) => ({ name: 't' + i, description: 'desc ' + i })); const r = await toolselect.select('', big); assert.equal(r, null); }],
    ['toolselect: CORE list present', () => { assert.ok(toolselect.CORE.includes('save_memory')); }],
  ]);

  console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
