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

fs.rmSync(dir, { recursive: true, force: true });
console.log(`✅ brain: ${pass} assertions passed`);
