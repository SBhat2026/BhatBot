#!/usr/bin/env node
'use strict';
// Tests for lib/designation.js — the shared colour vocabulary for what an agent is DOING.
//
// Two of these are the load-bearing ones:
//   • the palette must stay PERCEPTUALLY separated, asserted in Oklab rather than hue degrees. An
//     earlier draft spaced nine hues evenly in HSL and produced two greens 33° apart that were the
//     same green to look at — equal numbers, unequal perception. Adding a tenth designation must
//     FAIL here rather than quietly crowd the wheel.
//   • the 3D office must not keep its own copy of the palette. It cannot require() a module (it runs
//     on file:// in an iframe), so the values are pushed in as data — and the only thing stopping a
//     second, drifting palette from growing there is a test that goes and looks.
//
//   node scripts/test-designation.js
const fs = require('fs');
const path = require('path');
const D = require('../lib/designation');
const visual = require('../lib/visualcheck');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const hexToRgbCss = (h) => {
  const n = parseInt(String(h).replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

// ── shape ─────────────────────────────────────────────────────────────────────────────────────────
ok(D.DESIGNATIONS.length >= 5, `there are ${D.DESIGNATIONS.length} designations`);
ok(D.DESIGNATIONS.every((d) => /^#[0-9a-f]{6}$/.test(d.glow) && /^#[0-9a-f]{6}$/.test(d.ink)),
  'every designation has a valid 6-digit glow and ink hex (chroma reduction never produced NaN)');
ok(new Set(D.DESIGNATIONS.map((d) => d.id)).size === D.DESIGNATIONS.length, 'ids are unique');
ok(new Set(D.DESIGNATIONS.map((d) => d.glow)).size === D.DESIGNATIONS.length, 'no two designations share a colour');

// ── perceptual separation — the one that matters ──────────────────────────────────────────────────
{
  // An Oklab ΔE of ~0.02 is a just-noticeable difference under ideal conditions. These are read at
  // across-the-room size on a lit 3D surface that desaturates everything, so the floor is 3 JND.
  const MIN = 0.06;
  let worst = Infinity, worstPair = '';
  for (let i = 0; i < D.DESIGNATIONS.length; i++) {
    for (let j = i + 1; j < D.DESIGNATIONS.length; j++) {
      const g = D.glowGap(D.DESIGNATIONS[i].id, D.DESIGNATIONS[j].id);
      if (g < worst) { worst = g; worstPair = `${D.DESIGNATIONS[i].id}/${D.DESIGNATIONS[j].id}`; }
    }
  }
  ok(worst >= MIN, `closest pair is ${worst.toFixed(3)} apart in Oklab (${worstPair}) — floor ${MIN}. `
    + 'If this failed you added a designation: drop one, or the office legend is claiming a distinction nobody can see.');
}

// ── red stays red ─────────────────────────────────────────────────────────────────────────────────
{
  ok(D.DESIGNATIONS.every((d) => !D.inReserved(d.hue)),
    'no designation sits in the reserved red band — red means error in every surface of this app');
  let nearest = Infinity;
  for (const d of D.DESIGNATIONS) nearest = Math.min(nearest, D.deltaE({ ...D.ERROR_LC, hue: D.ERROR_HUE }, { ...D.GLOW, hue: d.hue }));
  ok(nearest >= 0.1, `the error colour is ${nearest.toFixed(3)} from the nearest designation — a failing agent reads as failing`);
  // Red at office brightness is pink. The error pair carries its own lightness for exactly this reason.
  ok(D.ERROR_LC.L < D.GLOW.L, 'the error colour is darker than the designations, so it reads as red rather than pink');
}

// ── readable where it is actually used ────────────────────────────────────────────────────────────
{
  // `ink` is for legend dots, card borders and labels on the app's LIGHT surfaces. WCAG AA for a UI
  // component / large text is 3.0; these are dots and 1px borders, not body copy.
  const SURFACES = { day: '#FAFCFD', standby: '#FCFAF5' };
  for (const [name, bg] of Object.entries(SURFACES)) {
    const bad = D.DESIGNATIONS
      .map((d) => ({ id: d.id, c: visual.contrast(hexToRgbCss(d.ink), hexToRgbCss(bg)) }))
      .filter((x) => x.c < visual.AA_LARGE);
    ok(bad.length === 0, `every ink colour clears AA-large (${visual.AA_LARGE}) on the ${name} surface`
      + (bad.length ? ' — failing: ' + bad.map((x) => `${x.id} ${x.c.toFixed(2)}`).join(', ') : ''));
  }
  // `glow` is for the dark 3D scene, where the floor is the opposite direction.
  const bad = D.DESIGNATIONS
    .map((d) => ({ id: d.id, c: visual.contrast(hexToRgbCss(d.glow), hexToRgbCss('#0d1520')) }))
    .filter((x) => x.c < visual.AA_LARGE);
  ok(bad.length === 0, 'every glow colour clears AA-large against the night surface the office is lit for'
    + (bad.length ? ' — failing: ' + bad.map((x) => `${x.id} ${x.c.toFixed(2)}`).join(', ') : ''));
}

// ── classify ──────────────────────────────────────────────────────────────────────────────────────
{
  const cases = [
    ['find_papers', 'science'], ['sci_compute', 'science'], ['molecule', 'science'],
    ['claude_code', 'code'], ['edit_file', 'code'], ['run the test suite', 'code'],
    ['browser', 'browser'], ['smart_login', 'browser'], ['click the button on the website', 'browser'],
    ['web_search', 'research'], ['look up the weather', 'research'],
    ['triage_mail', 'comms'], ['reply to that email', 'comms'], ['calendar', 'comms'],
    ['deploy_drones', 'orchestrate'], ['plan_and_run', 'orchestrate'],
    ['generate_image', 'create'], ['blender', 'create'], ['render a video', 'create'],
    ['save_memory', 'memory'], ['remember that', 'memory'],
    ['forge_tool', 'forge'], ['build a tool for it', 'forge'],
  ];
  const wrong = cases.filter(([t, want]) => D.classify(t) !== want).map(([t, want]) => `${t} → ${D.classify(t)} (wanted ${want})`);
  ok(wrong.length === 0, `classify got all ${cases.length} real phrasings right` + (wrong.length ? ' — missed: ' + wrong.join('; ') : ''));

  // LONGEST MATCH WINS, and this is the case that proves it: 'make_model' contains 'model' (create)
  // and 'make_model' (science). Without the length rule the colour flips depending on list order.
  ok(D.classify('make_model') === 'science', "longest match wins: make_model is science, not create's 'model'");

  ok(D.classify('') === 'general' && D.classify(null) === 'general' && D.classify('xyzzy') === 'general',
    'anything unclassifiable is grey — a wrong colour asserts a division of labour that is not happening');
  ok(D.get('nope').id === 'general' && D.get(undefined).id === 'general', 'get() of an unknown id falls back, never throws');
}

// ── legend ────────────────────────────────────────────────────────────────────────────────────────
{
  ok(D.legend().length === D.DESIGNATIONS.length, 'legend() with no argument lists everything');
  const two = D.legend(['code', 'research']);
  ok(two.length === 2 && two.every((r) => r.ink && r.label), 'legend(active) lists only what is on the floor');
  ok(D.legend(['code', 'general']).some((r) => r.id === 'general'), 'the grey fallback appears in the legend when something is unclassified');
  ok(D.legend(['nonsense']).length === 0, 'an unknown id contributes no row rather than a blank one');
}

// ── the renderer must not keep a second palette ───────────────────────────────────────────────────
{
  const r = D.forRenderer();
  ok(Array.isArray(r.designations) && r.designations.length === D.DESIGNATIONS.length
    && r.designations.every((d) => d.id && d.glow && d.ink && typeof d.hue === 'number'),
    'forRenderer() hands over id/label/hue/glow/ink for every designation');
  ok(r.error && r.unknown && r.unknown.glow, 'forRenderer() also carries the error colour and the grey fallback');
  ok(!JSON.stringify(r).includes('match'), 'forRenderer() does not ship the match keywords — the renderer never classifies');

  // THE DRIFT GUARD. presence.html is on file:// and cannot require() this module, so a developer
  // fixing a colour there instead of here would produce an office whose legend is a lie. Every
  // designation colour that appears in that file must have arrived as data.
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'presence.html'), 'utf8');
  const leaked = D.DESIGNATIONS.flatMap((d) => [d.glow, d.ink]).filter((hex) => html.toLowerCase().includes(hex.toLowerCase()));
  ok(leaked.length === 0, 'no designation colour is hardcoded in src/presence.html'
    + (leaked.length ? ` — found ${leaked.join(', ')}; the office must read the palette it is given, not keep its own` : ''));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} designation: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
