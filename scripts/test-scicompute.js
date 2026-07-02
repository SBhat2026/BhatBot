#!/usr/bin/env node
'use strict';
// Tests the scientific-compute pack (lib/scicompute.js). Pure helpers (capabilities/buildScript/
// registry) run on any machine; the live compute assertions only run when the venv is present, so this
// passes headless and in verify. Run: node scripts/test-scicompute.js
const sci = require('../lib/scicompute');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

(async () => {
  // ---- registry + helper surface are well-formed ----
  ok(sci.REGISTRY.torch && /mps|Apple/i.test(sci.REGISTRY.torch), 'registry: torch entry mentions Apple-Silicon/MPS');
  ok(sci.REGISTRY.QuantLib && sci.REGISTRY.mpmath, 'registry: quant (QuantLib) + numerics (mpmath) present');
  ok(Array.isArray(sci.HELPERS.quant) && sci.HELPERS.quant.some((h) => h.startsWith('black_scholes')), 'helpers: quant list includes black_scholes');
  ok(sci.HELPERS.ml.some((h) => /DEVICE/.test(h)), 'helpers: ml list exposes DEVICE');

  // ---- capabilities degrades cleanly when the venv is absent ----
  const caps = sci.capabilities();
  ok(typeof caps.success === 'boolean', 'capabilities: returns a result object');
  if (!sci.isInstalled()) {
    ok(caps.success === false && caps.installed === false, 'capabilities: not-installed → installed:false');
    ok(/scicompute-setup\.sh/.test(caps.error), 'capabilities: install hint points at scicompute-setup.sh');
    ok(caps.registry && caps.helpers, 'capabilities: still surfaces registry + helpers when absent');
  } else {
    ok(caps.installed === true && Array.isArray(caps.available), 'capabilities: installed → lists available libs');
  }

  // ---- buildScript frames user code correctly (no Python needed) ----
  const script = sci.buildScript('emit(x=1)\nprint("hi")');
  ok(script.includes('def black_scholes') && script.includes('def mc_gbm'), 'buildScript: injects quant helpers into PREAMBLE');
  ok(script.includes('def emit') && script.includes('def solve_ode'), 'buildScript: emit + solve_ode helpers present');
  ok(/\n    emit\(x=1\)\n    print\("hi"\)/.test(script), 'buildScript: indents user code under try:');
  ok(script.includes('except Exception as _e:') && script.includes(sci.SENTINEL), 'buildScript: wraps in try/except + emits sentinel');
  ok(script.includes("DEVICE = 'mps'"), 'buildScript: MPS device auto-detection baked in');

  // ---- run guards ----
  const noCode = await sci.run({});
  ok(noCode.success === false && /code|not set up/.test(noCode.error), 'run: missing code/venv → graceful error');

  // ---- LIVE: only when the venv exists (a real quant + figure round-trip) ----
  if (sci.isInstalled()) {
    const r = await sci.run({ code:
      'prices = [100,101,99,102,105,103]\n' +
      'rets = returns(prices)\n' +
      'bs = black_scholes(100,100,1,0.02,0.2,"call")\n' +
      'plt.plot(prices)\n' +
      'emit(n=len(rets), sharpe=sharpe(rets), bs_call=bs)' });
    ok(r.success && r.result && typeof r.result.bs_call === 'number', 'live: quant round-trip returns black_scholes value');
    ok(!!r._image, 'live: matplotlib figure returned as a vision block');
  } else {
    console.log('   (scicompute-venv absent — skipping live compute assertions; run scripts/scicompute-setup.sh to enable)');
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
