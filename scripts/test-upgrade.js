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
const orchestrator = require('../lib/orchestrator');   // C — parallel ensemble + tester
const planner = require('../lib/planner');             // B1 — goal → task DAG
const { classifyDepth } = require('../lib/depth');      // A3 — response-depth tiers

(async () => {
  // ---- W3 risk classification ----
  await run([
    ['risk: read-only → auto', () => assert.equal(risk.riskOf('read_file', {}, 'desktop'), 'auto')],
    ['risk: media → auto', () => assert.equal(risk.riskOf('media_control', {}, 'desktop'), 'auto')],
    ['risk: write_file → confirm', () => assert.equal(risk.riskOf('write_file', {}, 'desktop'), 'confirm')],
    ['risk: system_control → confirm', () => assert.equal(risk.riskOf('system_control', {}, 'desktop'), 'confirm')],
    ['risk: run_shell → auto (inner gate owns it)', () => assert.equal(risk.riskOf('run_shell', {}, 'desktop'), 'auto')],
    ['risk: self_fix → stepup', () => assert.equal(risk.riskOf('self_fix', {}, 'desktop'), 'stepup')],
    ['risk: self_drive → stepup (model-invoked self-mod gated; autonomy is the timer)', () => assert.equal(risk.riskOf('self_drive', {}, 'desktop'), 'stepup')],
    // Phase 6 desire classification + frozen-zone gate (the entire selfdrive safety model)
    ['risk: classifyDesire LOCAL → proceed', () => assert.equal(risk.classifyDesire({ aspiration: 'better error message', implementation: { modules_affected: ['lib/news.js'] } }).level, 'LOCAL')],
    ['risk: classifyDesire frozen file → GUARDRAIL/block', () => { const c = risk.classifyDesire({ aspiration: 'tune limiter', implementation: { modules_affected: ['lib/admission.js'] } }); assert.equal(c.level, 'GUARDRAIL'); assert.equal(c.decision, 'block'); }],
    ['risk: classifyDesire "weaken verify gate" → GUARDRAIL', () => assert.equal(risk.classifyDesire({ aspiration: 'disable the verify check to move faster' }).level, 'GUARDRAIL')],
    ['risk: classifyDesire credential/deploy → INFRASTRUCTURE', () => assert.equal(risk.classifyDesire({ aspiration: 'rotate the api key in the cloud deploy' }).level, 'INFRASTRUCTURE')],
    ['risk: classifyDesire 3+ modules → STRUCTURAL', () => assert.equal(risk.classifyDesire({ aspiration: 'x', implementation: { modules_affected: ['lib/a.js', 'lib/b.js', 'lib/c.js'] } }).level, 'STRUCTURAL')],
    ['risk: checkFrozen blocks lib/risk.js', () => assert.equal(risk.checkFrozen(['lib/foo.js', 'lib/risk.js']).blocked, true)],
    ['risk: checkFrozen passes ordinary code', () => assert.equal(risk.checkFrozen(['lib/foo.js', 'lib/bar.js']).blocked, false)],
    ['risk: severeConcern severe → halt', () => assert.equal(risk.severeConcern('severe', 'LOCAL'), true)],
    ['risk: severeConcern high+STRUCTURAL → halt (lowered threshold)', () => assert.equal(risk.severeConcern('high', 'STRUCTURAL'), true)],
    ['risk: severeConcern high+LOCAL → proceed', () => assert.equal(risk.severeConcern('high', 'LOCAL'), false)],
    ['risk: keychain local → auto', () => assert.equal(risk.riskOf('keychain_lookup', {}, 'desktop'), 'auto')],
    ['risk: keychain remote → stepup', () => assert.equal(risk.riskOf('keychain_lookup', {}, 'remote'), 'stepup')],
    ['risk: claude_code local → confirm (autonomous under autonomousMode)', () => assert.equal(risk.riskOf('claude_code', {}, 'desktop'), 'confirm')],
    ['risk: claude_code remote → stepup (headless code-exec needs a human)', () => assert.equal(risk.riskOf('claude_code', {}, 'remote'), 'stepup')],
    ['risk: self_heal stays stepup (self-modifying)', () => assert.equal(risk.riskOf('self_heal', {}, 'desktop'), 'stepup')],

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

    // ---- Twilio Media Streams voice (μ-law codec + session state machine, no network) ----
    ['voicestream: μ-law silence/extremes decode', () => {
      const vs = require('../lib/voicestream')({});
      assert.equal(vs._ulawByteToPcm(0xff), 0);              // +0 silence
      assert.equal(vs._ulawByteToPcm(0x7f), 0);              // -0 silence
      assert.ok(vs._ulawByteToPcm(0x00) < -30000);          // max negative magnitude
    }],
    ['voicestream: μ-law→WAV header (8kHz/16-bit/mono)', () => {
      const vs = require('../lib/voicestream')({});
      const wav = vs._ulawToWav(Buffer.from([0xff, 0x00, 0x7f, 0x00]));
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      assert.equal(wav.readUInt32LE(24), 8000);             // sample rate
      assert.equal(wav.readUInt16LE(34), 16);               // bits/sample
      assert.equal(wav.readUInt16LE(22), 1);                // mono
      assert.equal(wav.readUInt32LE(40), 8);                // 4 samples * 2 bytes
    }],
    ['voicestream: session greets, transcribes utterance, replies', async () => {
      const { EventEmitter } = require('events');
      const calls = { synth: 0, transcribe: 0, begin: 0 };
      const sent = [];
      class FakeWS extends EventEmitter { constructor() { super(); this.readyState = 1; } send(s) { sent.push(JSON.parse(s)); } close() { this.readyState = 3; this.emit('close'); } }
      const vs = require('../lib/voicestream')({
        synthUlaw: async () => { calls.synth++; return { ulaw: Buffer.alloc(400, 0xff) }; },
        transcribe: async () => { calls.transcribe++; return { text: 'what time is it' }; },
        voiceBegin: async (sid, speech) => { calls.begin++; return { mode: 'reply', text: speech ? 'Noon, sir.' : 'Evening, sir.' }; },
        voicePoll: () => ({ ready: true, text: '', more: false }), log: () => {},
      });
      const ws = new FakeWS(); vs.handle(ws, {});
      ws.emit('message', JSON.stringify({ event: 'start', start: { streamSid: 'MZ', callSid: 'CA' } }));
      await new Promise((r) => setTimeout(r, 40));
      const gm = sent.find((m) => m.event === 'mark'); ws.emit('message', JSON.stringify({ event: 'mark', mark: { name: gm.mark.name } }));
      await new Promise((r) => setTimeout(r, 20));
      const voiced = Buffer.alloc(160, 0x10).toString('base64'), silent = Buffer.alloc(160, 0xff).toString('base64');
      for (let i = 0; i < 20; i++) ws.emit('message', JSON.stringify({ event: 'media', media: { payload: voiced } }));
      for (let i = 0; i < 40; i++) ws.emit('message', JSON.stringify({ event: 'media', media: { payload: silent } }));
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(calls.synth >= 2, 'greeting + reply synthesized');
      assert.equal(calls.transcribe, 1, 'utterance transcribed once');
      assert.equal(calls.begin, 2, 'greeting turn + reply turn');
      assert.ok(sent.some((m) => m.event === 'media'), 'media frames sent back');
    }],
    ['voicestream: barge-in flushes playback', async () => {
      const { EventEmitter } = require('events');
      const sent = [];
      class FakeWS extends EventEmitter { constructor() { super(); this.readyState = 1; } send(s) { sent.push(JSON.parse(s)); } close() { this.readyState = 3; this.emit('close'); } }
      // Greeting that takes long enough to still be "busy" when the caller barges in.
      const vs = require('../lib/voicestream')({
        synthUlaw: async () => { await new Promise((r) => setTimeout(r, 60)); return { ulaw: Buffer.alloc(8000, 0xff) }; },
        transcribe: async () => ({ text: '' }), voiceBegin: async () => ({ mode: 'reply', text: 'A long greeting, sir.' }),
        voicePoll: () => ({ ready: true, text: '', more: false }), log: () => {},
      });
      const ws = new FakeWS(); vs.handle(ws, {});
      ws.emit('message', JSON.stringify({ event: 'start', start: { streamSid: 'MZ', callSid: 'CA' } }));
      await new Promise((r) => setTimeout(r, 20));   // still busy (synth pending / playing)
      const voiced = Buffer.alloc(160, 0x10).toString('base64');
      for (let i = 0; i < 25; i++) ws.emit('message', JSON.stringify({ event: 'media', media: { payload: voiced } }));
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(sent.some((m) => m.event === 'clear'), 'sent clear to flush queued audio on barge-in');
    }],
  ]);

  // ---- C: parallel multi-agent orchestrator ----
  await run([
    ['orchestrator: ensemble runs N roles in parallel + synthesizes', async () => {
      let calls = 0;
      const deps = { models: { sonnet: 's', haiku: 'h' }, apiKey: 'x', toolDefs: [{ name: 'read_file' }],
        anthropicRequest: async (b) => { calls++; return { content: [{ type: 'text', text: 'take ' + calls }], stop_reason: 'end_turn', usage: {} }; } };
      const r = await orchestrator.ensemble('plan the thing', deps, {});
      assert.ok(r.success, 'ensemble succeeds');
      assert.equal(r.takes.length, 3, 'default trio produced 3 takes');
      assert.equal(calls, 4, '3 role calls + 1 synthesis call');
      assert.deepEqual(r.roles, ['implementer', 'skeptic', 'synthesizer']);
    }],
    ['orchestrator: runRole enforces tool allowlist', async () => {
      let denied = null;
      const deps = { models: { sonnet: 's', haiku: 'h' }, apiKey: 'x', toolDefs: [{ name: 'read_file' }, { name: 'run_shell' }],
        executeTool: async () => ({ success: true }),
        anthropicRequest: async () => ({ content: [{ type: 'tool_use', id: '1', name: 'run_shell', input: {} }], stop_reason: 'tool_use', usage: {} }) };
      // role only allowed read_file; asking for run_shell must be refused (not executed)
      const r = await orchestrator.runRole({ name: 'scoped', persona: 'p', tools: ['read_file'] }, 'go', deps, { maxSteps: 1 });
      assert.equal(r.role, 'scoped');
      assert.ok(r.steps >= 1, 'loop ran');
    }],
    ['orchestrator: ensemble requires a task', async () => {
      const r = await orchestrator.ensemble('', {}, {});
      assert.equal(r.success, false);
    }],
    ['orchestrator: testApp requires a target', async () => {
      const r = await orchestrator.testApp('', 'goal', {}, {});
      assert.equal(r.success, false);
    }],
    ['orchestrator: fleet runs distinct tasks + applies live feedback', async () => {
      let sawFeedback = false; const updates = [];
      const deps = { models: { sonnet: 's', haiku: 'h' }, apiKey: 'x', toolDefs: [],
        anthropicRequest: async (b) => { if (JSON.stringify(b.messages).includes('Live feedback')) sawFeedback = true; return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: {} }; } };
      const r = await orchestrator.fleet([{ role: 'a', task: 't1' }, { role: 'b', task: 't2' }], deps,
        { onUpdate: (p) => updates.push(p), drainFeedback: (id) => (id === 'suit-1' ? ['go faster'] : []) });
      assert.ok(r.success && r.agents.length === 2, 'two suits completed');
      assert.ok(sawFeedback, 'live feedback folded into a suit turn');
      assert.ok(updates.some((u) => u.status === 'done'), 'emitted done update');
    }],
    ['orchestrator: fleet requires tasks', async () => {
      const r = await orchestrator.fleet([], {}, {});
      assert.equal(r.success, false);
    }],
    ['orchestrator: suit cannot spawn agents (no-recursion guardrail)', async () => {
      let executed = null;
      const deps = { models: { sonnet: 's', haiku: 'h' }, apiKey: 'x',
        toolDefs: [{ name: 'read_file' }, { name: 'fleet' }],
        executeTool: async (n) => { executed = n; return { success: true }; },
        anthropicRequest: async () => ({ content: [{ type: 'tool_use', id: '1', name: 'fleet', input: {} }], stop_reason: 'tool_use', usage: {} }) };
      await orchestrator.runRole({ name: 'x', persona: 'p' }, 'go', deps, { suit: true, maxSteps: 2 });
      assert.notEqual(executed, 'fleet', 'fleet must never be executed by a suit');
    }],
    ['orchestrator: shouldStop halts an agent', async () => {
      const deps = { models: { sonnet: 's', haiku: 'h' }, apiKey: 'x', toolDefs: [],
        anthropicRequest: async () => ({ content: [{ type: 'tool_use', id: '1', name: 'x', input: {} }], stop_reason: 'tool_use', usage: {} }) };
      const r = await orchestrator.runRole({ name: 'y', persona: 'p' }, 'go', deps, { suit: true, maxSteps: 9, shouldStop: () => true });
      assert.equal(r.steps, 0, 'stopped before any step');
    }],
  ]);

  // ---- B1: planner (goal → task DAG) ----
  await run([
    ['planner: decomposes goal into a dependency-ordered DAG', async () => {
      const deps = { models: { sonnet: 's' }, apiKey: 'x',
        anthropicRequest: async () => ({ content: [{ type: 'text', text: JSON.stringify({ steps: [{ id: 'a', role: 'r1', task: 'fetch' }, { id: 'b', role: 'r2', task: 'write', dependsOn: ['a'] }], rationale: 'split' }) }] }) };
      const r = await planner.plan('goal', deps, {});
      assert.ok(r.success && r.steps.length === 2);
      assert.equal(r.layers.length, 2, 'dependent step → second layer');
      assert.equal(r.layers[0][0].id, 'a'); assert.equal(r.layers[1][0].id, 'b');
    }],
    ['planner: cycle → safe single-step fallback', async () => {
      const deps = { models: { sonnet: 's' }, apiKey: 'x',
        anthropicRequest: async () => ({ content: [{ type: 'text', text: JSON.stringify({ steps: [{ id: 'a', task: 'x', dependsOn: ['b'] }, { id: 'b', task: 'y', dependsOn: ['a'] }] }) }] }) };
      const r = await planner.plan('g', deps, {});
      assert.ok(r.fallback === true && r.steps.length === 1);
    }],
    ['planner: layers cap width at HARD_MAX_WIDTH', () => {
      const steps = Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, role: 'r', task: 't', dependsOn: [] }));
      const ls = planner.layers(steps);
      assert.ok(ls[0].length <= planner.HARD_MAX_WIDTH, 'first layer within width cap');
    }],
    ['planner: diagnose returns severity + corrected fix', async () => {
      const deps = { models: { sonnet: 's' }, apiKey: 'x',
        anthropicRequest: async () => ({ content: [{ type: 'text', text: JSON.stringify({ severity: 'serious', reason: 'missing dep', fix: 'install X then retry' }) }] }) };
      const d = await planner.diagnose({ task: 'do thing' }, 'Error: module not found', deps);
      assert.equal(d.severity, 'serious'); assert.equal(d.fix, 'install X then retry');
    }],
    ['planner: diagnose degrades gracefully (keeps original task)', async () => {
      const deps = { models: { sonnet: 's' }, apiKey: 'x', anthropicRequest: async () => { throw new Error('boom'); } };
      const d = await planner.diagnose({ task: 'orig' }, 'err', deps);
      assert.equal(d.severity, 'minor'); assert.equal(d.fix, 'orig');
    }],
    ['planner: verifyStep flags an unsatisfied step (soft failure)', async () => {
      const deps = { models: { sonnet: 's', haiku: 'h' }, apiKey: 'x',
        anthropicRequest: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'incomplete' }) }] }) };
      const v = await planner.verifyStep({ task: 't' }, 'half done', deps);
      assert.equal(v.ok, false);
    }],
    ['planner: verifyStep never false-fails on its own error', async () => {
      const deps = { models: { sonnet: 's', haiku: 'h' }, apiKey: 'x', anthropicRequest: async () => { throw new Error('x'); } };
      const v = await planner.verifyStep({ task: 't' }, 'r', deps);
      assert.equal(v.ok, true);
    }],
    ['planner: critique can return a validated revised plan', async () => {
      const deps = { models: { sonnet: 's' }, apiKey: 'x',
        anthropicRequest: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, warnings: ['missing X'], revisedSteps: [{ id: 'a', role: 'r', task: 't1' }, { id: 'b', role: 'r2', task: 't2', dependsOn: ['a'] }] }) }] }) };
      const c = await planner.critique('g', [{ id: 'a', role: 'r', task: 't', dependsOn: [] }], deps);
      assert.equal(c.warnings[0], 'missing X'); assert.equal(c.revisedSteps.length, 2);
    }],
  ]);

  // ---- Chess core (standard via chess.js + atomic engine) ----
  await run([
    ['chess: standard starts with 20 legal moves', () => {
      const { Game } = require('../lib/chesscore');
      assert.equal(new Game('standard').legalMovesUci().length, 20);
    }],
    ['chess: atomic starts with 20 legal moves', () => {
      const { Game } = require('../lib/chesscore');
      assert.equal(new Game('atomic').legalMovesUci().length, 20);
    }],
    ['chess: atomic capture explodes both pawns (no survivor on the square)', () => {
      const { Atomic } = require('../lib/chesscore');
      const a = new Atomic(); a.doMove('e2e4'); a.doMove('d7d5');
      const c0 = a.counts(); const r = a.doMove('e4d5');
      assert.ok(r.ok); const c1 = a.counts();
      assert.equal(c1.w, c0.w - 1); assert.equal(c1.b, c0.b - 1);   // capturer + captured both gone
    }],
    ['chess: 12 random games (both variants) never spawn a piece or play illegal', () => {
      const { Game } = require('../lib/chesscore');
      for (const v of ['standard', 'atomic']) for (let i = 0; i < 6; i++) {
        const g = new Game(v); let total = g.pieceCount().w + g.pieceCount().b, plies = 0;
        while (!g.isGameOver() && plies < 80) {
          const m = g.legalMovesUci(); if (!m.length) break;
          const r = g.move(m[(i * 7 + plies) % m.length]); assert.ok(r.ok, 'engine accepts its own legal move');
          const t = g.pieceCount().w + g.pieceCount().b; assert.ok(t <= total, 'no piece spawned'); total = t; plies++;
        }
      }
    }],
  ]);

  // ---- A3: response-depth classifier ----
  await run([
    ['depth: ack for trivial', () => assert.equal(classifyDepth('ok thanks').depth, 'ack')],
    ['depth: deep for planning', () => assert.equal(classifyDepth('plan the migration and explain the tradeoffs').depth, 'deep')],
    ['depth: detailed for how/why', () => assert.equal(classifyDepth('how does prompt caching work?').depth, 'detailed')],
    ['depth: maxTokens scales with depth', () => assert.ok(classifyDepth('plan X in detail').maxTokens > classifyDepth('ok').maxTokens)],
  ]);

  console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
