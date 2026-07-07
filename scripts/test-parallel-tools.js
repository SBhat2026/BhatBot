#!/usr/bin/env node
'use strict';
// Verifies the READ-BURST throughput win inside a sub-agent (orchestrator.runRole): when a suit fires
// several INDEPENDENT read-only tools in one turn they execute CONCURRENTLY (wall-clock ~1×, not N×),
// while anything NOT in the parallel-safe set — or board tools — stays strictly SEQUENTIAL so shared
// state can't race and tool_use/result pairing order is preserved. Fully mocked model + executor.
// Run: node scripts/test-parallel-tools.js  (wired into npm run verify)
const orch = require('../lib/orchestrator');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { console.log('✅ ' + name); pass++; } else { console.log('❌ ' + name); fail++; } };

const SLEEP = 60;                        // ms each mock tool "runs"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A mock model that, on its first turn, fires the tools named in `fire`, then finishes.
function mkDeps({ fire, parallelSafe, track }) {
  return {
    apiKey: 'k',
    models: { sonnet: 'sonnet', haiku: 'sonnet' },
    toolDefs: fire.map((n) => ({ name: n, input_schema: { type: 'object', properties: {} } })),
    parallelSafe,
    anthropicRequest: async ({ messages }) => {
      const first = (messages || []).length <= 1;
      if (first) return { content: fire.map((n, i) => ({ type: 'tool_use', id: 'tu' + i, name: n, input: {} })), stop_reason: 'tool_use' };
      return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
    },
    executeTool: async (name) => { track.active++; track.peak = Math.max(track.peak, track.active); await sleep(SLEEP); track.active--; return { success: true, tool: name }; },
  };
}

(async () => {
  // --- two parallel-safe reads → run concurrently (peak overlap = 2, wall-clock ~1×) ---
  {
    const track = { active: 0, peak: 0 };
    const deps = mkDeps({ fire: ['read_file', 'fetch_url'], parallelSafe: (n) => ['read_file', 'fetch_url'].includes(n), track });
    const t0 = Date.now();
    const r = await orch.runRole({ name: 'p', persona: 'x', tools: ['read_file', 'fetch_url'] }, 'go', deps, { maxSteps: 3 });
    const ms = Date.now() - t0;
    ok('two read-safe tools completed', r && r.result === 'done');
    ok('they ran CONCURRENTLY (peak overlap = 2)', track.peak === 2);
    ok(`wall-clock ~1× not 2× (${ms}ms < ${SLEEP * 1.8 | 0}ms)`, ms < SLEEP * 1.8);
  }

  // --- a non-parallel-safe tool in the burst → forces the whole turn sequential (no overlap) ---
  {
    const track = { active: 0, peak: 0 };
    const deps = mkDeps({ fire: ['read_file', 'write_file'], parallelSafe: (n) => n === 'read_file', track });
    const t0 = Date.now();
    await orch.runRole({ name: 'p', persona: 'x', tools: ['read_file', 'write_file'] }, 'go', deps, { maxSteps: 3 });
    const ms = Date.now() - t0;
    ok('mixed burst stayed SEQUENTIAL (peak overlap = 1)', track.peak === 1);
    ok(`wall-clock ~2× (${ms}ms >= ${SLEEP * 1.8 | 0}ms)`, ms >= SLEEP * 1.8);
  }

  // --- no parallelSafe predicate → backward-compatible sequential path ---
  {
    const track = { active: 0, peak: 0 };
    const deps = mkDeps({ fire: ['read_file', 'fetch_url'], parallelSafe: undefined, track });
    await orch.runRole({ name: 'p', persona: 'x', tools: ['read_file', 'fetch_url'] }, 'go', deps, { maxSteps: 3 });
    ok('no predicate → sequential (backward compatible, peak = 1)', track.peak === 1);
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
