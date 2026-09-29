#!/usr/bin/env node
'use strict';
// ── WHAT IS THIS ACTUALLY COSTING IN WATTS? ───────────────────────────────────────────────────────
//
// Siddhant asked for memory and energy that scale with how much of the computer is in use. Memory is
// already measured everywhere. Energy was not measured at all, and "reasonable" is not a number.
//
// macOS will tell you, without sudo and without a dependency: AppleSmartBattery publishes the current
// flowing in or out of the pack, and current × voltage is watts.
//
//   ioreg -rn AppleSmartBattery  →  "Amperage" = 18446744073709549226
//                                   "Voltage"  = 12674
//
// That amperage is not a number in the twenty-quintillion range. It is a SIGNED 64-bit value printed
// as unsigned: `BigInt.asIntN(64, …)` turns it into −2390 mA, and −2390 mA × 12674 mV = −30.3 W. Read
// it naively and you get 2.3 × 10^17 watts, which is roughly the power output of the sun and does at
// least have the virtue of being obviously wrong.
//
// TWO HONEST LIMITS, both of which matter more than the reading:
//
//   1. IT ONLY WORKS ON BATTERY. On AC the same field reports CHARGE current, not system draw, so the
//      number stops meaning what its name suggests. This returns null there rather than a plausible
//      lie — and since a four-hour unattended run is a plugged-in run, that makes this an instrument
//      for benchmark sessions and not a runtime input. It lives in scripts/ for that reason.
//   2. It is whole-system draw. It cannot separate BhatBot from the browser, the display, or whatever
//      else is running, so it is only a fair comparison against a measurement taken the same way on
//      the same machine in the same state.
//
//   node scripts/bench-power.js                  # one reading
//   node scripts/bench-power.js --watch 60       # sample for 60s and report the integral
//   node scripts/bench-power.js --json
const { execSync } = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const JSON_OUT = process.argv.includes('--json');

/** read() → { watts, volts, milliamps, onAC, ok, why } — watts is null whenever it would be a lie. */
function read() {
  let t = '';
  try { t = execSync('ioreg -rn AppleSmartBattery', { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return { ok: false, watts: null, why: 'ioreg failed: ' + (e && e.message || e) }; }

  const raw = (k) => { const m = t.match(new RegExp(`"${k}" = (-?\\d+)`)); return m ? BigInt(m[1]) : null; };
  const signed = (v) => (v === null ? null : Number(BigInt.asIntN(64, v)));
  const milliamps = signed(raw('Amperage'));
  const volts = signed(raw('Voltage'));
  const onAC = /"ExternalConnected" = Yes/.test(t);

  if (milliamps === null || volts === null) return { ok: false, watts: null, onAC, why: 'no battery fields — desktop Mac?' };
  if (onAC) {
    return { ok: false, watts: null, onAC: true, milliamps, volts,
      why: 'on AC: this field reports charge current, not system draw. Unplug to measure.' };
  }
  return { ok: true, onAC: false, milliamps, volts, watts: Math.abs((milliamps * volts) / 1e6) };
}

/**
 * watch(seconds) → { samples, meanW, minW, maxW, wh }
 *
 * Trapezoidal integration over the samples actually taken, not sample-count × interval — a sample the
 * machine was too busy to deliver on time would otherwise be credited with the interval it missed,
 * which is exactly backwards: load is when the readings matter most and when they are latest.
 */
async function watch(seconds, everyMs = 2000) {
  const out = [];
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const r = read();
    if (r.ok) out.push({ at: Date.now(), w: r.watts });
    else if (!out.length) return { error: r.why, samples: 0 };
    await new Promise((res) => setTimeout(res, everyMs));
  }
  if (out.length < 2) return { error: 'not enough samples', samples: out.length };
  let wh = 0;
  for (let i = 1; i < out.length; i++) wh += ((out[i].w + out[i - 1].w) / 2) * ((out[i].at - out[i - 1].at) / 3600000);
  const ws = out.map((x) => x.w);
  return {
    samples: out.length, spanS: Math.round((out[out.length - 1].at - out[0].at) / 1000),
    meanW: +(ws.reduce((a, b) => a + b, 0) / ws.length).toFixed(2),
    minW: +Math.min(...ws).toFixed(2), maxW: +Math.max(...ws).toFixed(2), wh: +wh.toFixed(4),
  };
}

if (require.main === module) {
  (async () => {
    const secs = Number(arg('watch', 0));
    if (!secs) {
      const r = read();
      if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
      if (!r.ok) { console.log(`— no reading: ${r.why}`); process.exit(1); }
      console.log(`${r.watts.toFixed(1)} W  (${r.milliamps} mA × ${r.volts} mV, discharging)`);
      return;
    }
    console.log(`sampling for ${secs}s…`);
    const w = await watch(secs);
    if (JSON_OUT) { console.log(JSON.stringify(w, null, 2)); process.exit(w.error ? 1 : 0); }
    if (w.error) { console.log('— ' + w.error); process.exit(1); }
    console.log(`${w.samples} samples over ${w.spanS}s — mean ${w.meanW} W (${w.minW}–${w.maxW}), ${w.wh} Wh consumed`);
  })();
}

module.exports = { read, watch };
