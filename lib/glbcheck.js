'use strict';
// ── IS THAT A REAL 3D MODEL? ──────────────────────────────────────────────────────────────────────
// generate_3d returns a .glb and, until now, nothing looked inside it. "The file exists and is
// 4MB" is not evidence of a model: a featureless blob, a single untextured quad and a faithful
// reconstruction are all files of roughly that size.
//
// Parses the container directly — the JSON chunk of a GLB carries the whole scene description, so
// vertex and triangle counts, materials, textures and the bounding box are all readable without a
// renderer, in milliseconds, with no dependency.
//
// WHAT "DETAIL SURVIVED" MEANS, concretely. TRELLIS is asked for a mesh with `mesh_simplify`, which
// decimates. A reconstruction of a recursive solid either keeps the recursion or it does not, and
// triangle count is the measurable proxy: a Menger-style sponge rendered faithfully needs tens of
// thousands of triangles, and a smoothed lump needs a few hundred.
const fs = require('fs');

function parse(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 20) throw new Error('too short to be a GLB');
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  const version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  return { json, version, total, bytes: buf.length, jsonLen };
}

/** inspect(file) → the facts that distinguish a model from a file. */
function inspect(file) {
  const { json, version, bytes } = parse(file);
  const acc = json.accessors || [];
  const meshes = json.meshes || [];

  let vertices = 0, triangles = 0, prims = 0;
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let hasUV = false, hasNormals = false;

  for (const m of meshes) {
    for (const p of (m.primitives || [])) {
      prims++;
      const pos = acc[p.attributes && p.attributes.POSITION];
      if (pos) {
        vertices += pos.count || 0;
        if (pos.min && pos.max) {
          for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], pos.min[i]); max[i] = Math.max(max[i], pos.max[i]); }
        }
      }
      if (p.attributes && p.attributes.TEXCOORD_0 != null) hasUV = true;
      if (p.attributes && p.attributes.NORMAL != null) hasNormals = true;
      const idx = acc[p.indices];
      // mode 4 (or absent) is TRIANGLES; anything else is not a surface we can count this way.
      if (idx && (p.mode == null || p.mode === 4)) triangles += Math.floor((idx.count || 0) / 3);
    }
  }

  const size = min[0] === Infinity ? [0, 0, 0] : [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const images = (json.images || []).length;
  const materials = (json.materials || []).length;
  // A texture that exists but is 8×8 is not a texture. Resolution is not in the JSON, so the
  // embedded image's byte length stands in for it — a real 1024² albedo is not 300 bytes.
  const texBytes = (json.bufferViews || [])
    .filter((_, i) => (json.images || []).some((im) => im.bufferView === i))
    .reduce((n, bv) => n + (bv.byteLength || 0), 0);

  return { bytes, version, meshes: meshes.length, primitives: prims, vertices, triangles,
    hasUV, hasNormals, images, materials, texBytes, size: size.map((n) => +n.toFixed(4)) };
}

/**
 * verdict(info, { minTriangles }) → { ok, problems[] }
 * Thresholds are arguments, not constants: what counts as "detailed enough" is a property of the
 * subject, and a rule that is right for a fractal is wrong for a sphere.
 */
function verdict(info, { minTriangles = 5000, minTexBytes = 20000, requireUV = true } = {}) {
  const problems = [];
  if (!info.meshes) problems.push('no meshes at all — the file is a container with nothing in it');
  if (!info.vertices) problems.push('no vertices');
  if (info.triangles < minTriangles) {
    problems.push(`${info.triangles} triangles is below the ${minTriangles} expected for this subject — detail was decimated away`);
  }
  if (requireUV && !info.hasUV) problems.push('no UVs — nothing can be textured');
  if (info.images && info.texBytes < minTexBytes) problems.push(`texture is only ${info.texBytes}B — present but effectively blank`);
  if (!info.images) problems.push('no embedded texture');
  const vol = info.size[0] * info.size[1] * info.size[2];
  // A degenerate bounding box means every vertex collapsed onto a plane or a point.
  if (!(vol > 1e-6)) problems.push(`bounding box is degenerate (${info.size.join(' × ')}) — the mesh is flat or collapsed`);
  return { ok: problems.length === 0, problems };
}

module.exports = { inspect, verdict, parse };
