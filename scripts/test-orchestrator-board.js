#!/usr/bin/env node
'use strict';
// T7 — verify the shared blackboard is injected into fan-out agents (ensemble + fleet) so siblings
// see each other's live status/findings DURING a parallel batch. Fully mocked anthropicRequest +
// an in-memory board. Run: node scripts/test-orchestrator-board.js  (wired into npm run verify)
const os = require('os');
const path = require('path');
const orch = require('../lib/orchestrator');
const { createBlackboard } = require('../lib/blackboard');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { console.log('✅ ' + name); pass++; } else { console.log('❌ ' + name); fail++; } }

// Capture every system prompt the mock model receives, so we can assert the board block was folded in.
const seenSystems = [];
const seenToolNames = [];   // union of tool names offered across all calls
function mkDeps(board, opts = {}) {
  return {
    apiKey: 'k',
    models: { sonnet: 'sonnet', haiku: 'sonnet' },
    toolDefs: [],
    makeBoard: () => board,
    anthropicRequest: async ({ system, tools, messages }) => {
      seenSystems.push(system);
      (tools || []).forEach((t) => seenToolNames.push(t.name));
      // The lead INTEGRATOR call: its system says "INTEGRATE" → return a recognizable merged result.
      if (/INTEGRATE/i.test(system || '')) return { content: [{ type: 'text', text: 'INTEGRATED-DELIVERABLE' }], stop_reason: 'end_turn' };
      // A suit's FIRST turn, when it has board tools: call board_post once (exercise the handler),
      // then finish on the next turn.
      const firstTurn = (messages || []).length <= 1;
      if (opts.useBoardTool && firstTurn && (tools || []).some((t) => t.name === 'board_post')) {
        return { content: [{ type: 'tool_use', id: 'tu1', name: 'board_post', input: { kind: 'finding', text: 'found X' } }], stop_reason: 'tool_use' };
      }
      return { content: [{ type: 'text', text: 'take from an agent' }], stop_reason: 'end_turn' };
    },
  };
}

(async () => {
  // --- ensemble injects the shared board into each role, and posts findings ---
  seenSystems.length = 0;
  const board = createBlackboard({ dir: path.join(os.tmpdir(), 'bb-test-' + Date.now()) });
  const deps = mkDeps(board);
  const res = await orch.ensemble('design a caching layer', deps, { roles: [
    { name: 'a', persona: 'role a' }, { name: 'b', persona: 'role b' },
  ] });
  ok('ensemble returns a synthesized result', res.success && typeof res.result === 'string');
  ok('ensemble ran both roles', res.takes.length === 2);
  // Every role turn saw the fleet-board header folded into its system prompt (>=2 role calls + synth).
  ok('board block folded into agent system prompts', seenSystems.some((s) => /FLEET BLACKBOARD/.test(s || '')));
  // Each role posted a starting status + a finding → board has entries for both agents.
  const posts = board.all();
  ok('board captured status + finding posts', posts.length >= 4);
  ok('both agents posted findings', posts.filter((p) => p.kind === 'finding' && (p.agent === 'a' || p.agent === 'b')).length === 2);

  // --- fleet: shares a board, offers board tools, suits actively post, lead integrates ---
  seenSystems.length = 0; seenToolNames.length = 0;
  const board2 = createBlackboard({ dir: path.join(os.tmpdir(), 'bb-test2-' + Date.now()) });
  const deps2 = mkDeps(board2, { useBoardTool: true });
  const fres = await orch.fleet([{ role: 'x', task: 'job one' }, { role: 'y', task: 'job two' }], deps2, {});
  ok('fleet ran both suits', fres.success && fres.agents.length === 2);
  ok('fleet folded board into suit prompts', seenSystems.some((s) => /FLEET BLACKBOARD/.test(s || '')));
  ok('suits are offered the board_post/read/claim tools', ['board_post', 'board_read', 'board_claim'].every((n) => seenToolNames.includes(n)));
  ok('suit persona names the team roster', seenSystems.some((s) => /YOUR TEAM/.test(s || '')));
  ok('board_post tool call was handled (agent-authored finding on the board)', board2.all().some((p) => p.kind === 'finding' && p.text === 'found X'));
  ok('lead integrator merged suits into ONE deliverable', fres.result === 'INTEGRATED-DELIVERABLE');

  // --- no board factory → no crash, no injection (backward compatible) ---
  seenSystems.length = 0;
  const depsNB = mkDeps(null); depsNB.makeBoard = undefined;
  const r2 = await orch.ensemble('x', depsNB, { roles: [{ name: 'a', persona: 'p' }] });
  ok('ensemble works without a board (backward compatible)', r2.success);
  ok('no board block when no factory', !seenSystems.some((s) => /FLEET BLACKBOARD/.test(s || '')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
