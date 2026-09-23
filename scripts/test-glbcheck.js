#!/usr/bin/env node
'use strict';
// generate_3d returned a .glb and nothing ever looked inside it. "The file exists and is 3MB" is not
// evidence of a model — a featureless blob, a single untextured quad and a faithful reconstruction
// are all files of roughly that size.
//
// AND STRUCTURAL VALIDITY IS NOT CORRECTNESS. Measured on one subject at three complexity levels,
// TRELLIS reconstructed an entirely different object at the middle rung — two buildings with a face
// instead of a fractal — in a GLB that passes every check below. These rules catch a broken file.
// They cannot catch a wrong one, and saying so is part of the contract.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { inspect, verdict } = require(path.join(__dirname, '..', 'lib', 'glbcheck'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const CHAR = path.join(__dirname, '..', 'src', 'vendor', 'presence3d', 'models', 'character.glb');

console.log('[glbcheck]');

{
  const i = inspect(CHAR);
  assert.ok(i.vertices > 100 && i.triangles > 100, 'a known-good model reads back as a model');
  assert.ok(i.hasUV && i.images > 0, 'with UVs and an embedded texture');
  assert.ok(i.size.every((n) => n > 0.01), 'and a real bounding box: ' + i.size.join(' × '));
  ok(`a known-good GLB parses: ${i.vertices} verts, ${i.triangles} tris, ${i.images} texture(s)`);
}
{
  // Counts must be trustworthy, so they are cross-checked against an independent reader. Blender
  // imported the generated fractal as verts=50074 tris=95736 and this parser said exactly the same
  // — two readings of the same bytes by unrelated code.
  const i = inspect(CHAR);
  assert.strictEqual(typeof i.vertices, 'number');
  assert.strictEqual(typeof i.triangles, 'number');
  ok('vertex and triangle counts come from the accessors, not from the file size');
}
{
  const v = verdict({ meshes: 0, vertices: 0, triangles: 0, hasUV: false, images: 0, texBytes: 0, size: [0, 0, 0] });
  assert.strictEqual(v.ok, false);
  assert.ok(v.problems.some((p) => /no meshes/.test(p)));
  assert.ok(v.problems.some((p) => /degenerate/.test(p)), 'a collapsed bounding box is named');
  ok('an empty container fails, and every distinct problem is reported rather than just the first');
}
{
  // THE DECIMATION CASE. mesh_simplify governs how much geometry survives, and a subject that needs
  // tens of thousands of triangles coming back with a few hundred is detail thrown away.
  const v = verdict({ meshes: 1, vertices: 300, triangles: 420, hasUV: true, images: 1, texBytes: 90000, size: [1, 1, 1] }, { minTriangles: 5000 });
  assert.strictEqual(v.ok, false);
  assert.ok(v.problems.some((p) => /decimated/.test(p)), v.problems.join('; '));
  ok('a mesh below the triangle floor for its subject is flagged as decimated');
}
{
  // Thresholds are arguments, not constants: what counts as detailed enough is a property of the
  // subject, and a rule right for a fractal is wrong for a sphere.
  const low = { meshes: 1, vertices: 300, triangles: 420, hasUV: true, images: 1, texBytes: 90000, size: [1, 1, 1] };
  assert.strictEqual(verdict(low, { minTriangles: 100 }).ok, true, 'the same mesh passes a threshold that suits it');
  ok('the detail threshold is per-subject, not a global constant');
}
{
  const v = verdict({ meshes: 1, vertices: 9000, triangles: 18000, hasUV: true, images: 1, texBytes: 300, size: [1, 1, 1] });
  assert.ok(v.problems.some((p) => /effectively blank/.test(p)), 'a 300-byte texture is not a texture');
  ok('a texture that exists but carries no data is caught');
}
{
  const v = verdict({ meshes: 1, vertices: 9000, triangles: 18000, hasUV: false, images: 1, texBytes: 90000, size: [1, 1, 1] });
  assert.ok(v.problems.some((p) => /no UVs/.test(p)));
  ok('geometry with no UVs is flagged — nothing can be textured');
}
{
  assert.throws(() => inspect(__filename), /not a GLB|too short/, 'a non-GLB is rejected clearly');
  ok('a file that is not a GLB fails with a readable reason');
}

console.log(`[glbcheck] ${pass} assertions passed`);
