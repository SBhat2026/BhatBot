#!/usr/bin/env node
'use strict';
// Tests for lib/health.js — biometric trend/flag analysis. Pure (no Garmin, no LLM). Verifies the
// math, the grounded flag thresholds, normalization (sleep_seconds→hours, weight→kg, same-day dedup),
// and that insights degrades to the offline brief without a model. In `npm run verify`.
const assert = require('assert');
const h = require('../lib/health.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// 30 days of baseline ~50 bpm resting HR, then today spikes to 58; HRV steady 60; sleep ~6h; vo2 rising.
const hist = [];
for (let i = 30; i >= 1; i--) {
  hist.push({ date: `2026-06-${String(i).padStart(2, '0')}`, resting_hr: 50, hrv_avg: 60, sleep_seconds: 6 * 3600, body_battery: 60, stress_avg: 30, vo2max: 48 + (30 - i) * 0.05, steps: 9000, weight_g: 70000, synced_at: `2026-06-${String(i).padStart(2, '0')}T08:00:00Z` });
}
const today = { date: '2026-07-01', resting_hr: 58, hrv_avg: 60, sleep_seconds: 6 * 3600, body_battery: 18, stress_avg: 55, training_readiness: 30, vo2max: 53, steps: 4000, weight_g: 69500, synced_at: '2026-07-01T08:00:00Z' };
hist.push(today);
// sustained elevated stress over the last week (a single spike intentionally does NOT trip the 7d-avg watch)
for (const r of hist.slice(-7)) r.stress_avg = 55;

(async () => {
  // ---- sleep correction offset (Garmin under-counts) ----
  h.setSleepOffset(1);
  ok(h.normalize([{ date: 'x', sleep_seconds: 6 * 3600 }])[0].sleep_hours === 7, 'sleep offset: +1h applied (6h raw → 7h)');
  h.setSleepOffset(0);   // neutralize for the core-math assertions below
  ok(h.normalize([{ date: 'x', sleep_seconds: 6 * 3600 }])[0].sleep_hours === 6, 'sleep offset: 0 → raw passthrough');

  // ---- normalize ----
  const n = h.normalize(hist);
  ok(n.length === 31, 'normalize: 31 distinct days');
  ok(n[n.length - 1].sleep_hours === 6, 'normalize: derives sleep_hours from seconds');
  ok(n[n.length - 1].weight_kg === 69.5, 'normalize: derives weight_kg from grams');
  // same-day dedup keeps the LAST
  const dup = h.normalize([{ date: '2026-07-01', resting_hr: 50 }, { date: '2026-07-01', resting_hr: 55 }]);
  ok(dup.length === 1 && dup[0].resting_hr === 55, 'normalize: dedups same date, keeps last sync');

  // ---- trends ----
  const t = h.trends(hist);
  ok(t.resting_hr.latest === 58 && t.resting_hr.avg30 != null, 'trends: latest + 30d baseline');
  ok(t.resting_hr.direction === 'up' && t.resting_hr.improving === false, 'trends: rising resting HR is NOT improving (lower-is-better)');
  ok(t.vo2max.direction === 'up' && t.vo2max.improving === true, 'trends: rising VO₂max IS improving');
  ok(t.training_readiness.latest === 30, 'trends: picks up a metric present only today');

  // ---- flags (grounded) ----
  const f = h.flags(hist);
  ok(f.some((x) => x.metric === 'resting_hr' && x.level === 'concern'), 'flags: resting HR +8 over baseline → concern');
  ok(f.some((x) => x.metric === 'sleep_hours' && x.level === 'watch'), 'flags: <7h average → watch');
  ok(f.some((x) => x.metric === 'body_battery' && x.level === 'watch'), 'flags: body battery 18 → watch');
  ok(f.some((x) => x.metric === 'stress_avg' && x.level === 'watch'), 'flags: stress 55 avg → watch');
  ok(f.some((x) => x.metric === 'vo2max' && x.level === 'good'), 'flags: VO₂max up → good');
  // no fabrication: a metric with no data produces no flag
  ok(!f.some((x) => x.metric === 'spo2_avg'), 'flags: no SpO₂ data → no SpO₂ flag (never fabricates)');

  // ---- portrait + brief + insights fallback ----
  const p = h.portrait(hist);
  ok(p.days_tracked === 31 && p.disclaimer.includes('not medical'), 'portrait: days + non-medical disclaimer');
  ok(typeof h.brief(p) === 'string' && h.brief(p).length > 10, 'brief: non-empty one-liner');
  ok(h.brief({ days_tracked: 0 }).includes('Garmin setup'), 'brief: prompts setup when empty');
  const ins = await h.insights(p, {});   // no anthropicRequest → must fall back, not throw
  ok(ins.text && ins.error === 'no anthropicRequest injected', 'insights: degrades to offline brief without a model');

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
