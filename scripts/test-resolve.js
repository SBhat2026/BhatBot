'use strict';
// DaVinci Resolve bridge — action validation + graceful degradation when Resolve isn't running.
const assert = require('assert');
const resolve = require('../lib/resolve');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

ok(Array.isArray(resolve.ACTIONS) && resolve.ACTIONS.includes('status'), 'ACTIONS includes status');
ok(resolve.ACTIONS.includes('render') && resolve.ACTIONS.includes('add_marker'), 'ACTIONS includes render/add_marker');

(async () => {
  // Unknown action → rejected before spawning python.
  const bad = await resolve.resolveTool({ action: 'frobnicate' });
  ok(bad.success === false && /unknown/i.test(bad.error), 'unknown action → error');

  // status with Resolve NOT running → graceful, well-worded error (module imports; handle is None).
  // (If a tester happens to have Resolve open, success is also acceptable.)
  const st = await resolve.resolveTool({ action: 'status' });
  ok(st && (st.success === true || (st.success === false && /not running|scripting|not available|timed out/i.test(st.error))),
    'status degrades gracefully when Resolve is closed');

  console.log(`✅ resolve: ${n} assertions passed`);
})().catch((e) => { console.error('❌ resolve:', e.message); process.exit(1); });
