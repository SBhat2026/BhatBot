#!/usr/bin/env node
'use strict';
// Visual + functional check for the in-window Health (biometrics) panel. Generates ~30 days of
// realistic raw Garmin rows (the shape garmin_worker.daily() returns), runs them through the REAL
// lib/health.js (normalize/trends/flags/portrait), then renders the EXACT production markup + CSS +
// renderHealth() from src/index.html in headless Chromium (Playwright) and screenshots it. Proves the
// page renders correctly without needing a live Garmin login.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const health = require('../lib/health');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'scripts', '_health-shot.png');

// ---- 30 days of plausible biometrics, with gentle trends (HRV up, resting HR down, VO2max up) ----
function buildHistory() {
  const rows = [];
  const start = new Date('2026-05-31T08:00:00Z');
  for (let i = 0; i < 30; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const date = d.toISOString().slice(0, 10);
    const f = i / 29; // 0..1 progress
    rows.push({
      date,
      synced_at: d.toISOString(),
      resting_hr: Math.round(54 - 4 * f + (i % 3 === 0 ? 1 : 0)),       // improving (down)
      hrv_avg: Math.round(58 + 14 * f - (i % 4 === 0 ? 3 : 0)),          // improving (up)
      sleep_seconds: Math.round((6.6 + 0.8 * f) * 3600),                 // climbing toward 7.4h
      sleep_score: Math.round(74 + 12 * f),
      body_battery: Math.round(48 + 30 * f) - (i % 5 === 0 ? 20 : 0),
      stress_avg: Math.round(42 - 8 * f),
      training_readiness: Math.round(58 + 20 * f),
      steps: 7200 + Math.round(2500 * Math.sin(i)) + Math.round(1500 * f),
      intensity_minutes: 30 + (i % 7 === 0 ? 90 : Math.round(40 * f)),
      vo2max: Math.round((48 + 5 * f) * 10) / 10,                        // improving (up)
      spo2_avg: 96 + (i % 3 === 0 ? 1 : 0),
      respiration_avg: 14,
      weight_g: Math.round((72.5 - 1.2 * f) * 1000),
      activities: i === 29 ? [
        { type: 'running', name: 'Morning Run', duration_s: 2730, distance_m: 7600, avg_hr: 152, training_effect: 3.4 },
        { type: 'strength_training', name: 'Push Day', duration_s: 3300, distance_m: null, avg_hr: 118 },
      ] : [],
    });
  }
  return rows;
}

(async () => {
  const portrait = health.portrait(buildHistory());
  // functional asserts
  const probs = [];
  if (!portrait.days_tracked) probs.push('days_tracked is 0');
  if (!portrait.trends || !portrait.trends.resting_hr) probs.push('no resting_hr trend');
  if (!Array.isArray(portrait.flags)) probs.push('flags not an array');
  if (!portrait.activities.length) probs.push('no activities on latest day');
  console.log('portrait: days=%d latest=%s flags=%d activities=%d',
    portrait.days_tracked, portrait.latest_date, portrait.flags.length, portrait.activities.length);
  console.log('flags:', portrait.flags.map((f) => `${f.level}:${f.metric}`).join(', ') || '(none)');
  if (probs.length) { console.error('✗ FUNCTIONAL:', probs.join('; ')); process.exit(1); }

  // pull the real CSS block + the panel markup from src/index.html so the shot is faithful
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const css = (idx.match(/#health-body[\s\S]*?\.hl-insight-text[^}]*}/) || [''])[0];

  const HL_ICON = { resting_hr: '❤️', hrv_avg: '〰️', sleep_hours: '😴', sleep_score: '🌙', body_battery: '🔋', stress_avg: '😰', training_readiness: '⚡', steps: '👟', intensity_minutes: '🏃', vo2max: '🫁', spo2_avg: '🩸', respiration_avg: '🌬️', weight_kg: '⚖️' };

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; background:#0c1118; color:#e6edf6; font:14px -apple-system,system-ui,sans-serif; }
    #health-panel { display:flex; flex-direction:column; height:560px; width:420px; }
    .panel-head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid rgba(120,160,200,.12); }
    .tag { font-size:11px; color:#9fb2c8; border:1px solid rgba(120,160,200,.2); border-radius:6px; padding:2px 7px; }
    code { background:rgba(255,255,255,.06); padding:1px 4px; border-radius:4px; }
    ${css}
  </style></head><body>
    <div id="health-panel">
      <div class="panel-head"><b>❤ Health</b><span class="tag" id="health-sync">⟳ Sync</span><span class="tag" id="health-insights">✦ Insights</span></div>
      <div id="health-body"></div>
      <div id="health-disclaimer">Decision-support over your own Garmin data — not medical advice.</div>
    </div>
    <script>
      const HL_ICON = ${JSON.stringify(HL_ICON)};
      const $ = (s) => document.querySelector(s);
      ${hlFmtSrc()}
      ${renderHealthSrc()}
      renderHealth(${JSON.stringify(portrait)});
    </script>
  </body></html>`;

  function renderHealthSrc() {
    // lift the exact renderHealth function text out of src/index.html
    const m = idx.match(/function renderHealth\(p\) \{[\s\S]*?\n\}/);
    return m ? m[0] : (() => { throw new Error('renderHealth not found in index.html'); })();
  }
  function hlFmtSrc() {
    // lift the exact hlFmt helper out of src/index.html so formatting is faithful
    const m = idx.match(/function hlFmt\(v, unit\) \{[^\n]*\}/);
    return m ? m[0] : (() => { throw new Error('hlFmt not found in index.html'); })();
  }

  const tmp = path.join(ROOT, 'scripts', '_health-harness.html');
  fs.writeFileSync(tmp, html);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 560 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('file://' + tmp);
  await page.waitForTimeout(300);
  const cardCount = await page.$$eval('.hl-card', (els) => els.length);
  const flagCount = await page.$$eval('.hl-flag', (els) => els.length);
  await page.locator('#health-panel').screenshot({ path: OUT });
  await browser.close();
  fs.unlinkSync(tmp);

  if (errs.length) { console.error('✗ PAGE ERRORS:', errs.join(' | ')); process.exit(1); }
  console.log('rendered: %d metric cards, %d flags → %s', cardCount, flagCount, OUT);
  if (!cardCount) { console.error('✗ no metric cards rendered'); process.exit(1); }
  console.log('✓ health panel renders');
})().catch((e) => { console.error('✗', e); process.exit(1); });
