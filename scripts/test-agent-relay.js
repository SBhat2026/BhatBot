#!/usr/bin/env node
'use strict';
// Tests the cross-agent relay plumbing: a task's peer findings survive buildTask → assemble so a
// sibling agent actually receives what other agents reported. Pure-ish (uses a temp workspace).
// Run: node scripts/test-agent-relay.js  (wired into npm run verify)
const fs = require('fs'), os = require('os'), path = require('path');
const protocol = require('../lib/agents/protocol');
const ctx = require('../lib/context');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { console.log('✅ ' + name); pass++; } else { console.log('❌ ' + name); fail++; } }

const peers = ['t_0001 research: found the config lives in ~/.bhatbot', 't_0002 coding: patched loader'];

// 1. buildTask carries peers through the context envelope.
const task = protocol.buildTask({ id: 't_0003', agent: 'coding', goal: 'wire it up', context: { peers } });
ok('buildTask keeps peers', Array.isArray(task.context.peers) && task.context.peers.length === 2);
ok('buildTask defaults peers to []', protocol.buildTask({ id: 'x', agent: 'coding', goal: 'g' }).context.peers.length === 0);

// 2. assemble surfaces peers to the agent context (this is what base.js puts in peer_findings).
(async () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-relay-'));
  try {
    const assembled = await ctx.assemble({ wsDir, task });
    ok('assemble returns peers', Array.isArray(assembled.peers) && assembled.peers.length === 2);
    ok('assemble peers match input', assembled.peers[0].includes('research') && assembled.peers[1].includes('coding'));
    const noPeers = await ctx.assemble({ wsDir, task: protocol.buildTask({ id: 'y', agent: 'research', goal: 'g' }) });
    ok('assemble peers default empty', Array.isArray(noPeers.peers) && noPeers.peers.length === 0);
  } finally { fs.rmSync(wsDir, { recursive: true, force: true }); }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
