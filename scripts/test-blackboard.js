#!/usr/bin/env node
'use strict';
// Tests for lib/blackboard.js (T5 shared cross-agent state). Pure — temp dir, no app boot.
// Run: node scripts/test-blackboard.js  (wired into npm run verify)
const fs = require('fs'), os = require('os'), path = require('path');
const { createBlackboard } = require('../lib/blackboard');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-board-'));
try {
  const bb = createBlackboard({ dir });

  // post normalizes + caps
  const e = bb.post({ agent: 'ORACLE', taskId: 't1', kind: 'finding', text: '  config lives in   ~/.bhatbot ' });
  ok(e.kind === 'finding' && e.text === 'config lives in ~/.bhatbot', 'post: normalizes whitespace');
  ok(bb.post({ agent: 'X', kind: 'bogus', text: 'x' }).kind === 'status', 'post: unknown kind → status');
  ok(bb.post({ agent: 'X', text: 'y'.repeat(400) }).text.length === 280, 'post: text capped at 280');

  // persistence: a fresh handle on the same dir sees prior posts
  const bb2 = createBlackboard({ dir });
  ok(bb2.read({ kind: 'finding' }).some((r) => r.text.includes('config lives')), 'persist: new handle reads prior JSONL');
  ok(fs.existsSync(path.join(dir, 'blackboard.jsonl')), 'persist: JSONL file written');

  // read filters
  bb.post({ agent: 'FORGE', kind: 'status', text: 'patching loader' });
  ok(bb.read({ kind: 'status' }).every((r) => r.kind === 'status'), 'read: kind filter');
  const cutoff = '2030-01-01T00:00:00.000Z';   // explicit ts avoids same-ms races
  bb.post({ agent: 'FORGE', kind: 'status', text: 'done', ts: '2030-01-01T00:00:01.000Z' });
  const since = bb.read({ sinceTs: cutoff });
  ok(since.length === 1 && since[0].text === 'done', 'read: sinceTs returns only entries after the cutoff');

  // fleetStatusBlock: latest status per agent + recent findings, bounded
  const block = bb.fleetStatusBlock();
  ok(/FLEET BLACKBOARD/.test(block) && /FORGE: done/.test(block), 'fleetStatusBlock: shows latest status per agent');
  ok(/ORACLE/.test(block) && /finding/.test(block), 'fleetStatusBlock: includes recent findings');
  ok(bb.fleetStatusBlock({ activeAgents: ['FORGE'] }).indexOf('ORACLE:') === -1 || !/• ORACLE/.test(bb.fleetStatusBlock({ activeAgents: ['FORGE'] })), 'fleetStatusBlock: activeAgents restricts the status roster');

  // claim / isClaimed: soft coordination
  bb.claim('main.js', 'FORGE', 't2');
  ok(bb.isClaimed('main.js') === true, 'claim: isClaimed true after claim');
  ok(bb.isClaimed('main.js', { byOther: 'ORACLE' }) === true, 'claim: isClaimed byOther true (FORGE≠ORACLE)');
  ok(bb.isClaimed('main.js', { byOther: 'FORGE' }) === false, 'claim: isClaimed byOther false for the claimant');
  ok(bb.isClaimed('unclaimed.js') === false, 'claim: unclaimed resource → false');

  // heartbeat + lastPost: liveness for the fleet supervisor
  bb.heartbeat('DRONE-1', 'd1', 'exercising signup');
  ok(bb.lastPost('DRONE-1').kind === 'heartbeat', 'heartbeat: lastPost returns the ping');
  ok(bb.lastPost('NOBODY') === null, 'heartbeat: lastPost null for unknown agent');

  // empty board → empty block (no crash)
  const empty = createBlackboard({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'bb-empty-')) });
  ok(empty.fleetStatusBlock() === '', 'empty board → empty fleetStatusBlock');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
