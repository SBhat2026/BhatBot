#!/usr/bin/env node
'use strict';
// Task 4 regression test — cross-model overflow spill in lib/orchestrator.js runRole().
// A downgrade-safe role (tester/skeptic) must route to Haiku when Sonnet is pinned at its admission
// floor AND Haiku has headroom; primary-generation roles never downgrade; and paths without the
// injected budget probes are unaffected. Mocks anthropicRequest so it runs offline in <1s.
//   node scripts/test-fleet-spill.js
const { runRole } = require('../lib/orchestrator');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// deps factory: fleetWidth returns the given sonnet/haiku widths; captures the model actually used.
function makeDeps({ sonnet = 12, haiku = 12, canDowngradeRoles = ['tester', 'skeptic'], withProbes = true } = {}) {
  const state = { model: null, downgraded: false };
  const deps = {
    apiKey: 'k', toolDefs: [], executeTool: async () => ({ success: true }),
    models: { sonnet: 'SONNET', haiku: 'HAIKU' },
    anthropicRequest: async ({ model }) => { state.model = model; return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }; },
  };
  if (withProbes) {
    deps.fleetWidth = (m) => (m === 'SONNET' ? sonnet : haiku);
    deps.fleetFloor = 3;
    deps.canDowngrade = (role) => canDowngradeRoles.includes(role.name || role.role);
    deps.logDowngrade = () => { state.downgraded = true; };
  }
  return { deps, state };
}

(async () => {
  // 1) Sonnet pinned at floor, Haiku has headroom, downgrade-safe role → spills to Haiku.
  {
    const { deps, state } = makeDeps({ sonnet: 3, haiku: 10 });
    await runRole({ name: 'tester', persona: 'p' }, 'verify the build', deps, { maxSteps: 1 });
    ok(state.model === 'HAIKU' && state.downgraded, 'saturated Sonnet + safe role → Haiku spill (logged)');
  }
  // 2) Sonnet healthy → safe role stays on Sonnet.
  {
    const { deps, state } = makeDeps({ sonnet: 12, haiku: 12 });
    await runRole({ name: 'tester', persona: 'p' }, 'verify the build', deps, { maxSteps: 1 });
    ok(state.model === 'SONNET' && !state.downgraded, 'healthy Sonnet → safe role stays on Sonnet');
  }
  // 3) Primary-generation role never downgrades, even when Sonnet is saturated.
  {
    const { deps, state } = makeDeps({ sonnet: 3, haiku: 10 });
    await runRole({ name: 'implementer', persona: 'p' }, 'write the feature', deps, { maxSteps: 1 });
    ok(state.model === 'SONNET' && !state.downgraded, 'saturated Sonnet + primary role → stays on Sonnet');
  }
  // 4) Sonnet at floor but Haiku ALSO at/below it → no benefit, stay on Sonnet.
  {
    const { deps, state } = makeDeps({ sonnet: 3, haiku: 3 });
    await runRole({ name: 'tester', persona: 'p' }, 'verify', deps, { maxSteps: 1 });
    ok(state.model === 'SONNET' && !state.downgraded, 'both at floor → no spill');
  }
  // 5) No budget probes injected (ensemble/test paths) → unaffected, stays on Sonnet.
  {
    const { deps, state } = makeDeps({ withProbes: false });
    await runRole({ name: 'tester', persona: 'p' }, 'verify', deps, { maxSteps: 1 });
    ok(state.model === 'SONNET', 'no probes injected → default Sonnet (no crash)');
  }
  // 6) An explicit role.model:'haiku' is honored regardless (baseline unchanged).
  {
    const { deps, state } = makeDeps({ sonnet: 12, haiku: 12 });
    await runRole({ name: 'x', persona: 'p', model: 'haiku' }, 'q', deps, { maxSteps: 1 });
    ok(state.model === 'HAIKU', 'explicit role.model:haiku honored');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
