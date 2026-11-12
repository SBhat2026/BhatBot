'use strict';
// SYNAPSE substrate tests — the hybrid node/edge store, curation (prune/confirm), import builders,
// and the pure Connector. Uses a temp dir so it never touches the real brain. In the verify chain.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const brain = require('../lib/brain');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const dir = path.join(os.tmpdir(), 'bb-brain-test-' + process.pid);
fs.rmSync(dir, { recursive: true, force: true });

// ── store: upsert, idempotent, endpoints-must-exist, persistence ────────────
{
  const b = brain.createBrain({ dir });
  const p = b.upsertNode({ type: 'project', ref: 'uricase', label: 'Uricase Challenge', text: 'de novo urate oxidase' });
  const q = b.upsertNode({ type: 'project', ref: 'protfunc', label: 'ProtFunc', text: 'protein function prediction' });
  ok(p && q, 'nodes upserted');
  ok(b.upsertNode({ type: 'project', ref: 'uricase', label: 'Uricase Challenge' }).id === p.id, 'same (type,ref) → same id (idempotent, no dup)');
  ok(b.nodes({ type: 'project' }).length === 2, 'two project nodes');
  ok(b.upsertNode({ type: 'bogus', ref: 'x' }) === null, 'invalid node type rejected');

  const e = b.upsertEdge({ from: p.id, to: q.id, type: 'relates-to', rationale: 'both proteins', confidence: 0.9 });
  ok(e && e.status === 'proposed', 'edge upserts as proposed by default');
  ok(b.upsertEdge({ from: p.id, to: 'nonexistent:node', type: 'relates-to' }) === null, 'edge to missing node rejected');
  ok(b.upsertEdge({ from: p.id, to: p.id, type: 'relates-to' }) === null, 'self-edge rejected');
  ok(b.neighbors(p.id).length === 1, 'neighbors found');

  b.save();
  const b2 = brain.createBrain({ dir });
  ok(b2.nodes().length === 2 && b2.edges().length === 1, 'graph persists across load');
}

// ── curation: prune is permanent, confirm promotes ─────────────────────────
{
  const b = brain.createBrain({ dir });
  const edge = b.edges()[0];
  ok(b.confirm('edge', edge.id) && b.edges({ status: 'confirmed' }).length === 1, 'confirm promotes a proposal');
  ok(b.prune('edge', edge.id) && b.edges({ status: 'pruned' }).length === 1, 'prune marks pruned');
  // re-proposing a pruned edge must NOT revive it
  b.upsertEdge({ from: edge.from, to: edge.to, type: edge.type, status: 'proposed' });
  ok(b.edges({ status: 'pruned' }).length === 1 && b.edges({ status: 'proposed' }).length === 0, 'pruned edge is never re-proposed');
  // a pruned node stays pruned on re-import
  const pn = b.nodes({ type: 'project' })[0];
  b.prune('node', pn.id);
  b.upsertNode({ type: 'project', ref: pn.ref, label: pn.label });
  ok(b.getNode(pn.id).status === 'pruned', 'pruned node stays pruned on re-import');
  ok(!b.graphView().nodes.find((n) => n.id === pn.id), 'graphView hides pruned nodes');
  ok(b.graphView().nodes.every((n) => !('embedding' in n)), 'graphView strips embeddings');
}

// ── import builders ─────────────────────────────────────────────────────────
{
  const pn = brain.projectNode({ slug: 'nexus', name: 'Nexus', summary: 'research navigator', highlights: ['Phase 2 done'], status: 'active', specs: { root: '/x/nexus' } });
  ok(pn.type === 'project' && /research navigator/.test(pn.text) && pn.meta.root === '/x/nexus', 'projectNode folds summary + root');

  const mn = brain.memoryNode({ id: 'sm_1', text: 'FABLE retrieval refactor pattern', kind: 'semantic', vec: [0.1, 0.2] });
  ok(mn.type === 'memory' && mn.embedding.length === 2, 'memoryNode carries its embedding through');

  const kf = brain.keyFilesFor(['README.md', 'src/index.js', 'a/b/c.js', 'docs/spec.md', 'main.py', 'random.txt']);
  ok(kf.includes('README.md') && kf.includes('docs/spec.md') && kf.includes('src/index.js') && kf.includes('main.py') && !kf.includes('a/b/c.js') && !kf.includes('random.txt'), 'keyFilesFor picks READMEs/docs/entrypoints only');

  const rn = brain.repoNodes({ name: 'bhatbot', path: '/x/bhatbot', readme: 'jarvis agent', files: [{ path: 'README.md', text: 'readme' }, { path: 'main.js', text: 'entry' }] });
  ok(rn.nodes.length === 3 && rn.edges.length === 2 && rn.edges.every((e) => e.type === 'part-of'), 'repoNodes → project + file nodes + part-of edges');

  const nn = brain.notionNodes({ id: 'pg1', title: 'Roadmap', url: 'http://n/pg1', text: 'top', sections: [{ heading: 'Q3', text: 'ship synapse' }] });
  ok(nn.nodes.length === 2 && nn.edges.length === 1 && nn.edges[0].type === 'part-of', 'notionNodes → page + section + part-of');
}

// ── Connector: cross-project only, threshold, dedup, maxPerNode ─────────────
{
  // a & b nearly identical vectors but SAME project → must NOT connect; a & c different projects, similar → connect.
  const nodesL = [
    { id: 'file:projA/x', status: 'confirmed', meta: { repo: 'projA' }, embedding: [1, 0, 0] },
    { id: 'file:projA/y', status: 'confirmed', meta: { repo: 'projA' }, embedding: [0.99, 0.01, 0] },
    { id: 'file:projB/z', status: 'confirmed', meta: { repo: 'projB' }, embedding: [0.98, 0.02, 0] },
    { id: 'file:projC/w', status: 'confirmed', meta: { repo: 'projC' }, embedding: [0, 1, 0] },
  ];
  const props = brain.proposeConnections(nodesL, { threshold: 0.9, maxPerNode: 3 });
  ok(props.length > 0, 'connector proposes cross-project links');
  ok(props.every((e) => e.status === 'proposed' && e.createdBy === 'connector' && e.type === 'relates-to'), 'proposals are proposed relates-to edges');
  ok(!props.find((e) => (e.from === 'file:projA/x' && e.to === 'file:projA/y') || (e.from === 'file:projA/y' && e.to === 'file:projA/x')), 'never links two nodes in the SAME project');
  ok(!props.find((e) => e.from.includes('projC') || e.to.includes('projC')), 'dissimilar node (projC) is not linked');
  const seen = new Set(props.map((e) => [e.from, e.to].sort().join('|')));
  ok(seen.size === props.length, 'no duplicate pair proposals');
}


// ── THE VECTOR SIDECAR IS BINARY ─────────────────────────────────────────────────────────────────
//
// It was JSON: ~17 characters of decimal text per float, 25 KB per vector, a 100 MB file that took
// half a second and ~400 MB of peak RSS to load and was rewritten whole whenever one embedding
// changed. vectors.f32 is the same numbers at the precision the model produced them.
{
  const os = require('os');
  const { createBrain, cosine } = brain;
  const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-vec-'));
  const mk = (seed, n) => Array.from({ length: n }, (_, i) => Math.sin(seed * 13 + i) * 0.07);
  const b = createBrain({ dir: vdir });
  b.upsertNode({ type: 'file', ref: '/a.js', label: 'a', text: 'a', embedding: mk(1, 1536) }, 1);
  b.upsertNode({ type: 'file', ref: '/b.js', label: 'b', text: 'b', embedding: mk(2, 768) }, 1);   // a different width
  b.upsertNode({ type: 'memory', ref: 'm', label: 'm', text: 'no vector yet' }, 1);
  b.save();
  ok(fs.existsSync(path.join(vdir, 'vectors.f32')) && !fs.existsSync(path.join(vdir, 'vectors.json')), 'vectors are written as vectors.f32, not JSON');
  const bytes = fs.statSync(path.join(vdir, 'vectors.f32')).size;
  ok(bytes < (1536 + 768) * 4 + 400, `at four bytes a float plus a small header (${bytes} bytes for 2,304 floats)`);

  const b2 = createBrain({ dir: vdir });
  const a2 = b2.nodes().find((n) => n.label === 'a'), bb2 = b2.nodes().find((n) => n.label === 'b'), m2 = b2.nodes().find((n) => n.label === 'm');
  ok(Array.isArray(a2.embedding) && a2.embedding.length === 1536, 'a reload gives back a PLAIN array — every consumer checks Array.isArray');
  ok(a2.embedding.every((x, i) => Math.abs(x - mk(1, 1536)[i]) < 1e-7), 'with the same values, to float32 precision');
  ok(bb2.embedding.length === 768, 'vectors of different widths coexist in one file');
  ok(!m2.embedding, 'and a node with no vector still has none');
  ok(Math.abs(cosine(a2.embedding, mk(1, 1536)) - 1) < 1e-6, 'cosine against the original is 1 — similarity is unaffected by the format');

  // A link, a prune or a confirm changes no vector and must not rewrite the file.
  const m0 = fs.statSync(path.join(vdir, 'vectors.f32')).mtimeMs;
  b2.prune('node', m2.id); b2.save();
  ok(fs.statSync(path.join(vdir, 'vectors.f32')).mtimeMs === m0, 'a save that changed no vector does not rewrite the vector file');

  // MIGRATION: a store that only has the old JSON sidecar.
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-vec-mig-'));
  const seed = createBrain({ dir: mdir });
  seed.upsertNode({ type: 'file', ref: '/x.js', label: 'x', text: 'x', embedding: mk(5, 1536) }, 1);
  seed.save();
  const xid = seed.nodes()[0].id;
  fs.rmSync(path.join(mdir, 'vectors.f32'));
  fs.writeFileSync(path.join(mdir, 'vectors.json'), JSON.stringify({ [xid]: mk(5, 1536) }));     // what an old install has on disk
  const old = createBrain({ dir: mdir });
  ok(old.getNode(xid).embedding.length === 1536, 'a store with only vectors.json still loads its vectors');
  ok(old._vecDirty() === true, 'and is marked for migration');
  old.save();
  ok(fs.existsSync(path.join(mdir, 'vectors.f32')), 'the next save writes the binary sidecar');
  ok(!fs.existsSync(path.join(mdir, 'vectors.json')) && fs.existsSync(path.join(mdir, 'vectors.json.pre-f32')),
    'and the old JSON is RENAMED, not deleted — those vectors cost money and a format change must not be able to lose them');
  ok(createBrain({ dir: mdir }).getNode(xid).embedding.length === 1536, 'after which it loads from the binary file alone');

  // CORRUPTION: unreadable is not the same as absent, and must never be overwritten with nothing.
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-vec-bad-'));
  const cb = createBrain({ dir: cdir });
  cb.upsertNode({ type: 'file', ref: '/y.js', label: 'y', text: 'y', embedding: mk(9, 1536) }, 1);
  cb.save();
  const good = fs.readFileSync(path.join(cdir, 'vectors.f32'));
  fs.writeFileSync(path.join(cdir, 'vectors.f32'), good.subarray(0, Math.floor(good.length / 2)));   // a torn write
  const quiet = console.error; console.error = () => {};
  const torn = createBrain({ dir: cdir });
  ok(torn.vecLoadFailed() === true, 'a truncated vector file is detected as unreadable, not read as short vectors');
  ok(fs.readdirSync(cdir).some((f) => f.startsWith('vectors.f32.corrupt-')), 'a copy of the damaged file is kept');
  torn.upsertNode({ type: 'file', ref: '/z.js', label: 'z', text: 'z', embedding: mk(3, 1536) }, 2);
  torn.save();
  console.error = quiet;
  ok(fs.statSync(path.join(cdir, 'vectors.f32')).size === Math.floor(good.length / 2), 'and vector writes stay blocked, so the damaged file is not overwritten');
  fs.writeFileSync(path.join(cdir, 'vectors.f32'), 'this is not a vector file at all');
  console.error = () => {};
  ok(createBrain({ dir: cdir }).vecLoadFailed() === true, 'a file with the wrong magic is refused too');
  console.error = quiet;

  for (const d of [vdir, mdir, cdir]) fs.rmSync(d, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`✅ brain: ${pass} assertions passed`);
