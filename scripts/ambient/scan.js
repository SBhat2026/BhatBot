#!/usr/bin/env node
'use strict';
// Manual ambient scan — prints what BhatBot WOULD surface right now, without wiring into main.js.
// Usage:
//   node scripts/ambient/scan.js            # scan + print digest (respects config; OFF by default)
//   node scripts/ambient/scan.js --status   # show available/active watchers + enabled flag
//   node scripts/ambient/scan.js --mark      # also mark surfaced signals as seen (dedup write)
//   node scripts/ambient/scan.js --json      # raw JSON output
//
// With ambient.enabled !== true in ~/.bhatbot/config.json this prints {skipped:true} and
// makes ZERO osascript calls (no Calendar/Mail permission prompts).

const ambient = require('../../lib/ambient');

(async () => {
  const args = process.argv.slice(2);
  const flag = (f) => args.includes(f);

  if (flag('--status')) {
    console.log(JSON.stringify(ambient.sources(), null, 2));
    return;
  }

  const res = await ambient.scan();

  if (flag('--json')) { console.log(JSON.stringify(res, null, 2)); }
  else if (res.skipped) { console.log('ambient disabled (config.ambient.enabled !== true) → {skipped:true}'); }
  else {
    const d = ambient.digest(res.signals);
    console.log(d || '(no new signals)');
    if (res.quiet) console.log('\n[quiet hours — collected but suppressed]');
    if (res.errors) console.log('\n[watcher errors]', JSON.stringify(res.errors));
  }

  if (flag('--mark') && !res.skipped && res.signals && res.signals.length) {
    console.log('\n' + JSON.stringify(ambient.markSurfaced(res.signals)));
  }
})().catch((e) => { console.error('scan failed:', e && e.message); process.exit(1); });
