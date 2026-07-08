#!/usr/bin/env node
'use strict';
// TEST-DRIVE of the build_project multi-part 3D assembly (the deterministic half — no model/GUI).
// Proves that given N model-written geometry functions, stitch() produces a COMPLETE, well-formed,
// renderable Three.js document: skeleton intact, importmap present, every part function embedded, each
// invoked, spec-sheet + physics numbers shown, all placeholders resolved. This is the closest headless
// "activation" of the suit-build pipeline. Run: node scripts/test-studioscene.js  (wired into verify).
const scene = require('../lib/studioscene');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// helpers
ok(scene.esc('<b>"a"&b</b>') === '&lt;b&gt;&quot;a&quot;&amp;b&lt;/b&gt;', 'esc: escapes HTML metacharacters');
const notes = '### exterior-geometry\nblue plates, 1.8m tall\n\n### power-systems\narc reactor 2.4MW';
ok(scene.laneNotes(notes, 'power-systems').includes('arc reactor'), 'laneNotes: slices the matching lane section');
ok(scene.laneNotes(notes, 'exterior-geometry').includes('blue plates'), 'laneNotes: matches hyphenated role names');
ok(scene.laneNotes('no headings here', 'x').includes('no headings'), 'laneNotes: no section → returns the notes');

// ---- the test-drive: assemble a "suit" from mock subsystem functions ----
const goal = 'wearable Iron-Man-style powered suit';
const spec = { height: '70.5in', colors: 'blue/silver', features: 'repulsors, energy shield', chest: '38R (assumed)' };
const physics = { summary: 'thrust_to_weight: 3.2\nflight_ceiling_km: 18\nrepulsor_draw_MW: 2.4' };
const parts = [
  'function part_0(THREE,scene,group,specs){const m=new THREE.Mesh(new THREE.CylinderGeometry(0.4,0.5,1.6),new THREE.MeshStandardMaterial({color:0x3366aa,metalness:0.8}));m.position.y=1;group.add(m);}',
  'function part_1(THREE,scene,group,specs){const h=new THREE.Mesh(new THREE.SphereGeometry(0.28),new THREE.MeshStandardMaterial({color:0xcccccc,metalness:0.9}));h.position.y=2;group.add(h);}',
  'function part_2(THREE,scene,group,specs){const r=new THREE.Mesh(new THREE.CircleGeometry(0.12,24),new THREE.MeshStandardMaterial({color:0x66ffff,emissive:0x33cccc}));r.position.set(0,1.3,0.5);group.add(r);}',
];
const html = scene.stitch(goal, spec, physics, parts);

ok(/^<!doctype html>/i.test(html), 'stitch: produces a complete HTML document');
ok(html.includes('</html>'), 'stitch: document is closed');
ok(/<script type="importmap">[\s\S]*three@0\.160/.test(html), 'stitch: keeps the Three.js importmap');
ok(html.includes('OrbitControls'), 'stitch: keeps orbit controls (interactive)');
ok(html.includes('part_0(') && html.includes('part_1(') && html.includes('part_2('), 'stitch: embeds every subsystem function');
ok((html.match(/try\{part_\d+\(THREE,scene,group,SPECS\)/g) || []).length === 3, 'stitch: invokes each part exactly once');
ok(html.includes('blue/silver') && html.includes('38R (assumed)'), 'stitch: spec sheet shows specs incl. assumed defaults');
ok(html.includes('thrust_to_weight') || /3\.2/.test(html), 'stitch: spec sheet folds in the physics numbers');
ok(!html.includes('__PARTS__') && !html.includes('__SPECSHEET__') && !html.includes('__SPECSJSON__') && !html.includes('__TITLE__'), 'stitch: no unresolved placeholders remain');
ok(html.includes('"height":"70.5in"'), 'stitch: SPECS json injected for the runtime');

// empty parts → still a valid (empty-scene) document, never a broken one
const empty = scene.stitch(goal, spec, null, []);
ok(/^<!doctype html>/i.test(empty) && !empty.includes('__PARTS__'), 'stitch: zero parts → still a valid document');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
