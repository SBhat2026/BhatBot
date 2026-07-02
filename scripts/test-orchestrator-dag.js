#!/usr/bin/env node
'use strict';
// Tests T6 (DAG dependencies + ready-set scheduling) and T5 (blackboard lifecycle) in the
// orchestrator, headless via injected planFn/runAgentFn. Run: node scripts/test-orchestrator-dag.js
const fs = require('fs'), os = require('os'), path = require('path');
const orch = require('../lib/agents/orchestrator');
const { createBlackboard } = require('../lib/blackboard');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// A runAgent stub that records batch composition and returns a chosen status per task goal.
function makeRunAgent(order, statusByGoal = {}) {
  return async (task) => {
    order.push(task.id);
    const status = statusByGoal[task.goal] || 'ok';
    // echo back what peer_findings it saw, so we can assert dependency-summary injection
    return { kind: 'result', task_id: task.id, agent: task.agent, status,
      summary: `did ${task.goal}`, state_updates: [], artifacts: [], memory_writes: [], next: [], confidence: 1, cost: {},
      _sawPeers: (task.context && task.context.peers) || [] };
  };
}

(async () => {
  // ---- DAG: t3 needs t1+t2 → t1,t2 in the FIRST batch, t3 only after ----
  {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-dag-'));
    const board = createBlackboard({ dir: wsDir });
    const batches = [];
    const runAgentFn = async (task) => { return { kind: 'result', task_id: task.id, agent: task.agent, status: 'ok', summary: `did ${task.goal}`, next: [], confidence: 1, cost: {} }; };
    const planFn = async () => ([
      { id: 't1', agent: 'research', goal: 'research A' },
      { id: 't2', agent: 'research', goal: 'research B' },
      { id: 't3', agent: 'coding', goal: 'synthesize', needs: ['t1', 't2'] },
    ]);
    // capture which tasks start together via onTask 'start'
    let curBatch = [];
    const onTask = (t, phase) => { if (phase === 'start') curBatch.push(t.goal); if (phase === 'done') { /* flush at batch edges handled below */ } };
    // Track batch edges by hooking runAgent through a wrapper that snapshots the concurrent set.
    const seenStarts = [];
    const wrapRun = async (task, opts) => { seenStarts.push(task.goal); return runAgentFn(task, opts); };
    const r = await orch.run('goal', { wsDir, concurrency: 3, adapters: { board }, planFn, runAgentFn: wrapRun, onTask });
    ok(r.completed === 3, 'DAG: all three tasks completed');
    // t3 must start strictly after t1 and t2
    const i1 = seenStarts.indexOf('research A'), i2 = seenStarts.indexOf('research B'), i3 = seenStarts.indexOf('synthesize');
    ok(i3 > i1 && i3 > i2, 'DAG: synthesize (needs t1,t2) started only after both deps');
    fs.rmSync(wsDir, { recursive: true, force: true });
  }

  // ---- DAG: failed dependency BLOCKS the dependent with a reason; run does not crash ----
  {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-dag2-'));
    const order = [];
    const planFn = async () => ([
      { id: 't1', agent: 'research', goal: 'flaky' },
      { id: 't2', agent: 'coding', goal: 'depends', needs: ['t1'] },
    ]);
    const runAgentFn = makeRunAgent(order, { flaky: 'failed' });
    const r = await orch.run('goal', { wsDir, concurrency: 2, planFn, runAgentFn });
    const tasks = JSON.parse(fs.readFileSync(path.join(wsDir, 'tasks.json'), 'utf8')).tasks;
    const dep = tasks.find((t) => t.goal === 'depends');
    ok(dep.status === 'blocked' && /did not complete/.test(dep.blockedReason || ''), 'DAG: dependent of a failed task → blocked with reason');
    ok(!order.includes('depends'), 'DAG: a blocked dependent never runs its agent');
    fs.rmSync(wsDir, { recursive: true, force: true });
  }

  // ---- dependency summaries are injected into the dependent's peer context ----
  {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-dag3-'));
    let sawPeers = null;
    const planFn = async () => ([
      { id: 't1', agent: 'research', goal: 'upstream' },
      { id: 't2', agent: 'coding', goal: 'downstream', needs: ['t1'] },
    ]);
    const runAgentFn = async (task) => {
      if (task.goal === 'downstream') sawPeers = (task.context && task.context.peers) || [];
      return { kind: 'result', task_id: task.id, agent: task.agent, status: 'ok', summary: `did ${task.goal}`, next: [], confidence: 1, cost: {} };
    };
    await orch.run('goal', { wsDir, concurrency: 1, planFn, runAgentFn });
    ok(Array.isArray(sawPeers) && sawPeers.some((p) => /upstream/.test(p) && /did upstream/.test(p)), 'DAG: dependent receives its upstream dep summary in peers');
    fs.rmSync(wsDir, { recursive: true, force: true });
  }

  // ---- T5: orchestrator posts task status to the blackboard; base posts findings (via real board) ----
  {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-board-run-'));
    const board = createBlackboard({ dir: wsDir });
    const planFn = async () => ([{ id: 't1', agent: 'research', goal: 'do a thing' }]);
    const runAgentFn = async (task, opts) => {
      // a real agent would post via adapters.board; assert the board handle was threaded in
      ok(opts.adapters && opts.adapters.board, 'T5: runAgent receives the board handle in adapters');
      return { kind: 'result', task_id: task.id, agent: task.agent, status: 'ok', summary: 'done', next: [], confidence: 1, cost: {} };
    };
    await orch.run('goal', { wsDir, concurrency: 1, adapters: { board }, planFn, runAgentFn });
    ok(board.all().some((e) => e.kind === 'status' && /started: do a thing/.test(e.text)), 'T5: orchestrator posted task-start status to the board');
    fs.rmSync(wsDir, { recursive: true, force: true });
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
