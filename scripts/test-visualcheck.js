#!/usr/bin/env node
'use strict';
// The visual rules, driven against hand-built snapshots — so the rules are tested without rendering
// anything, and each one is pinned to the regression that motivated it.
//
// Three scripts in this repo already render the UI and save a PNG. None of them can FAIL. That is
// how the COMMAND view's centre column sat empty with the orb at 0×0, and how the office painted its
// characters as silhouettes on a light theme: a picture cannot tell you a contrast ratio, and nobody
// opens the picture anyway.
const assert = require('assert');
const path = require('path');
const vc = require(path.join(__dirname, '..', 'lib', 'visualcheck'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const el = (o) => ({ display: 'block', visibility: 'visible', opacity: '1', w: 100, h: 20, x: 0, y: 0, fontPx: 14, weight: '400', ...o });
const rules = (f) => f.map((x) => x.rule);

console.log('[visualcheck]');

{
  // THE ORB. `display:block`, in the DOM, 0×0 on screen — invisible to every test that asked only
  // whether the element existed.
  const f = vc.check({ elements: [el({ sel: '#orb', w: 0, h: 0, shouldShow: true })] });
  assert.deepStrictEqual(rules(f), ['zero-size']);
  assert.strictEqual(f[0].level, 'error');
  ok('an element that should be visible but renders at 0×0 is an ERROR');
}
{
  const f = vc.check({ elements: [el({ sel: '#x', display: 'none', shouldShow: true })] });
  assert.deepStrictEqual(rules(f), ['hidden']);
  ok('display:none on something that must show is caught, and named as hidden rather than zero-size');
}
{
  // Not everything is meant to be on screen at once, and flagging that would drown the report.
  const f = vc.check({ elements: [el({ sel: '#drawer', display: 'none', shouldShow: false })] });
  assert.deepStrictEqual(f, []);
  ok('something legitimately hidden is not a finding');
}
{
  // THE SILHOUETTES. Contrast is measured against the background a run actually PAINTS — the token
  // the markup inherits is not what the eye sees.
  const f = vc.check({ elements: [el({ sel: '#vhint', text: 'say Jarvis', color: 'rgb(155,170,180)', bg: 'rgb(244,247,249)', fontPx: 11 })] });
  assert.deepStrictEqual(rules(f), ['contrast']);
  ok('text too faint against its painted background is caught');
}
{
  const f = vc.check({ elements: [el({ sel: '#t', text: 'hi', color: 'rgb(20,24,28)', bg: 'rgb(244,247,249)', fontPx: 11 })] });
  assert.deepStrictEqual(f, []);
  ok('readable text passes');
}
{
  // WCAG's own carve-out: large text needs only 3:1, and applying 4.5 everywhere would demand
  // changes that make headings worse, not better.
  const faint = { color: 'rgb(120,135,145)', bg: 'rgb(255,255,255)' };
  assert.ok(vc.check({ elements: [el({ sel: '#body', text: 'x', fontPx: 12, ...faint })] }).length, 'body text at this contrast fails');
  assert.strictEqual(vc.check({ elements: [el({ sel: '#head', text: 'x', fontPx: 28, ...faint })] }).length, 0, 'the same colour passes at heading size');
  ok('the large-text threshold is honoured rather than flattened to one number');
}
{
  // THE ORB'S HALO. Rings and glows paint outside their box by design; nothing is lost, so nothing
  // is wrong. Only a CLIPPED overflow costs the reader something.
  const visible = vc.check({ elements: [el({ sel: '#orb', scrollW: 253, clientW: 232, overflowX: 'visible' })] });
  assert.deepStrictEqual(visible, [], 'decorative overflow is not a finding');
  const clipped = vc.check({ elements: [el({ sel: '#card', scrollW: 400, clientW: 200, overflowX: 'hidden' })] });
  assert.deepStrictEqual(rules(clipped), ['overflow-x']);
  ok('overflow is only a finding when it is actually clipped or scrolls');
}
{
  // THE BLANK SYNAPSE PANEL — empty and broken look identical.
  const f = vc.check({ elements: [el({ sel: '#sy-canvas', isCanvas: true, canvasBlank: true })] });
  assert.deepStrictEqual(rules(f), ['blank-canvas']);
  ok('a canvas with nothing drawn in it is surfaced');
}
{
  const f = vc.check({ elements: [
    el({ sel: '#a', interactive: true, x: 0, y: 0, w: 100, h: 40 }),
    el({ sel: '#b', interactive: true, x: 5, y: 2, w: 100, h: 40 }),
  ] });
  assert.deepStrictEqual(rules(f), ['overlap']);
  ok('two interactive elements stacked on each other are caught — one of them is unclickable');
}
{
  // Nesting is normal. A button inside a toolbar overlaps it completely and is not a bug.
  const f = vc.check({ elements: [
    el({ sel: '#bar', interactive: true, x: 0, y: 0, w: 100, h: 40 }),
    el({ sel: '#bar .btn', interactive: true, x: 0, y: 0, w: 100, h: 40 }),
  ] });
  assert.deepStrictEqual(f, [], 'a descendant selector is not an overlapping sibling');
  ok('nesting is not reported as an overlap');
}
{
  // THE INVARIANT. Per-element rules cannot say "the input bar is visible unless voice-first hid
  // it" — asserting it unconditionally produced a false error on exactly that. What is guaranteed
  // is weaker: there is always SOME way to reach BhatBot.
  const inv = [{ name: 'reachable', anyOf: ['#vstage', '#inputbar'], detail: 'no way to reach BhatBot' }];
  const okCase = vc.check({ invariants: inv, elements: [el({ sel: '#vstage' }), el({ sel: '#inputbar', display: 'none' })] });
  assert.deepStrictEqual(okCase, [], 'one of the two visible satisfies it');
  const bad = vc.check({ invariants: inv, elements: [el({ sel: '#vstage', display: 'none' }), el({ sel: '#inputbar', w: 0, h: 0 })] });
  assert.deepStrictEqual(rules(bad), ['invariant']);
  assert.strictEqual(bad[0].level, 'error');
  ok('an any-of invariant passes on either, and fails only when every option is gone');
}

console.log(`[visualcheck] ${pass} assertions passed`);
