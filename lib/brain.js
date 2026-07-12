'use strict';
// SYNAPSE — BhatBot's second brain. A hybrid knowledge graph (typed nodes + typed, sourced, prunable
// edges) layered over BhatBot's existing memory: projects (projects.js), semantic memories
// (semantic.js), the user's repos, and Notion. Vectors live in semantic.js; THIS module holds the
// GRAPH and the connection logic. Pure + fs-backed (no Electron) so it runs on the Mac AND in the
// cloud brain, and is unit-testable. See SECOND_BRAIN_PLAN.md.
//
// Design (2026 SOTA): hybrid vector+KG, self-evolving (a Connector recursively proposes cross-project
// links; a Scout enriches from the web), temporal + sourced (every edge has a rationale + provenance),
// with human curation (prune = permanent, teaches the Gardener; confirm = promote).

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const NODE_TYPES = ['project', 'file', 'memory', 'concept', 'finding', 'notion'];
const EDGE_TYPES = ['relates-to', 'applies-pattern', 'derived-from', 'contradicts', 'cites', 'mentions', 'part-of'];
const STATUSES = ['proposed', 'confirmed', 'pruned'];

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
function nodeId(type, ref) { return type + ':' + (slug(ref) || hash(ref)); }
function edgeId(from, to, type) { const [a, b] = [from, to].sort(); return 'e:' + type + ':' + hash(a + '|' + b); }
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ─── the store ──────────────────────────────────────────────────────────────────────────────────
function createBrain({ dir } = {}) {
  const base = dir || path.join(os.homedir(), '.bhatbot', 'brain');
  const file = path.join(base, 'graph.json');
  let store = { nodes: {}, edges: {}, v: 1 };

  function load() {
    try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); store = { v: 1, ...s, nodes: s.nodes || {}, edges: s.edges || {} }; }
    catch { store = { nodes: {}, edges: {}, v: 1 }; }
    return store;
  }
  function save() { try { fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(file, JSON.stringify(store)); } catch {} return store; }
  load();

  // Small key/value meta store (suggestions, budget spend, timestamps) that rides in graph.json.
  function getMeta(key) { return store.meta ? store.meta[key] : undefined; }
  function setMeta(key, val) { if (!store.meta) store.meta = {}; store.meta[key] = val; return val; }

  // Upsert a node. Deterministic id from (type, ref) → re-importing the same thing UPDATES, never dups.
  function upsertNode(n, ts = 0) {
    if (!n || !NODE_TYPES.includes(n.type)) return null;
    const id = n.id || nodeId(n.type, n.ref || n.label);
    const prev = store.nodes[id];
    if (prev && prev.status === 'pruned' && !n._revive) return prev;   // stay pruned unless explicitly revived
    store.nodes[id] = {
      id, type: n.type,
      label: String(n.label || n.ref || id).slice(0, 200),
      ref: n.ref || (prev && prev.ref) || '',
      text: String(n.text != null ? n.text : (prev && prev.text) || '').slice(0, 6000),
      embedding: n.embedding || (prev && prev.embedding) || null,
      importance: n.importance != null ? n.importance : (prev ? prev.importance : 1),
      status: n.status || (prev && prev.status) || 'confirmed',   // imported facts are confirmed; workers emit 'proposed'
      createdBy: (prev && prev.createdBy) || n.createdBy || 'import',
      createdAt: prev ? prev.createdAt : ts, updatedAt: ts,
      meta: { ...(prev && prev.meta), ...(n.meta || {}) },
    };
    return store.nodes[id];
  }
  // Upsert an edge. Reinforcing an existing proposed edge bumps its confidence toward confirmation.
  function upsertEdge(e, ts = 0) {
    if (!e || !e.from || !e.to || e.from === e.to || !EDGE_TYPES.includes(e.type)) return null;
    if (!store.nodes[e.from] || !store.nodes[e.to]) return null;      // both endpoints must exist
    const id = e.id || edgeId(e.from, e.to, e.type);
    const prev = store.edges[id];
    if (prev && prev.status === 'pruned' && !e._revive) return prev;  // never re-propose a pruned edge
    store.edges[id] = {
      id, from: e.from, to: e.to, type: e.type,
      rationale: String(e.rationale != null ? e.rationale : (prev && prev.rationale) || '').slice(0, 600),
      confidence: e.confidence != null ? e.confidence : (prev ? prev.confidence : 0.5),
      provenance: e.provenance || (prev && prev.provenance) || {},
      status: e.status || (prev && prev.status) || 'proposed',
      createdBy: (prev && prev.createdBy) || e.createdBy || 'connector',
      reinforced: (prev ? (prev.reinforced || 0) : 0) + (prev ? 1 : 0),
      createdAt: prev ? prev.createdAt : ts, updatedAt: ts,
    };
    return store.edges[id];
  }

  function getNode(id) { return store.nodes[id] || null; }
  function nodes(f = {}) { return Object.values(store.nodes).filter((n) => (!f.type || n.type === f.type) && (!f.status || n.status === f.status)); }
  function edges(f = {}) { return Object.values(store.edges).filter((e) => (!f.type || e.type === f.type) && (!f.status || e.status === f.status)); }
  function neighbors(id) { return Object.values(store.edges).filter((e) => e.status !== 'pruned' && (e.from === id || e.to === id)).map((e) => ({ edge: e, other: e.from === id ? e.to : e.from })); }

  // Human curation. Prune = permanent (Gardener never re-proposes). Confirm = promote a proposal.
  function prune(kind, id) { const t = kind === 'edge' ? store.edges[id] : store.nodes[id]; if (t) { t.status = 'pruned'; return true; } return false; }
  function confirm(kind, id) { const t = kind === 'edge' ? store.edges[id] : store.nodes[id]; if (t && t.status !== 'pruned') { t.status = 'confirmed'; return true; } return false; }

  function stats() {
    const ns = Object.values(store.nodes), es = Object.values(store.edges);
    const byType = {}; for (const n of ns) if (n.status !== 'pruned') byType[n.type] = (byType[n.type] || 0) + 1;
    return {
      nodes: ns.filter((n) => n.status !== 'pruned').length, edges: es.filter((e) => e.status !== 'pruned').length,
      byType, proposed: es.filter((e) => e.status === 'proposed').length, confirmed: es.filter((e) => e.status === 'confirmed').length,
      pruned: ns.filter((n) => n.status === 'pruned').length + es.filter((e) => e.status === 'pruned').length,
      findings: ns.filter((n) => n.type === 'finding' && n.status !== 'pruned').length,
    };
  }
  // Snapshot for the viz (drops embeddings — heavy + not needed client-side).
  function graphView({ includePruned = false } = {}) {
    const ns = Object.values(store.nodes).filter((n) => includePruned || n.status !== 'pruned')
      .map(({ embedding, text, ...n }) => ({ ...n, text: String(text || '').slice(0, 300) }));
    const es = Object.values(store.edges).filter((e) => includePruned || e.status !== 'pruned');
    return { nodes: ns, edges: es, stats: stats(), meta: store.meta || {} };
  }

  return { upsertNode, upsertEdge, getNode, nodes, edges, neighbors, prune, confirm, stats, graphView, getMeta, setMeta, save, load, dir: base, _store: () => store };
}

// ─── pure import builders (no I/O; caller supplies the data) ──────────────────────────────────────
// A BhatBot project record → a project node.
function projectNode(rec) {
  if (!rec || !(rec.slug || rec.name)) return null;
  const text = [rec.name, rec.summary, (rec.highlights || []).slice(-6).join('; '), rec.specs ? JSON.stringify(rec.specs) : '']
    .filter(Boolean).join('\n').slice(0, 6000);
  return { type: 'project', ref: rec.slug || rec.name, label: rec.name || rec.slug, text, importance: 3, meta: { status: rec.status, root: rec.specs && rec.specs.root, kind: 'bhatbot-project' } };
}
// A semantic memory record → a memory node (carries its embedding straight through — free reuse).
function memoryNode(m, i = 0) {
  if (!m || !m.text) return null;
  return { type: 'memory', ref: m.id || ('mem-' + hash((m.text || '') + i)), label: String(m.text).replace(/\s+/g, ' ').slice(0, 90), text: String(m.text).slice(0, 3000), embedding: m.vec || m.embedding || null, meta: { kind: m.kind, source: (m.meta && m.meta.source) } };
}
// KEY files of a repo at the "summaries + key files" depth: READMEs, *.md docs, entrypoints — not all.
const ENTRY_FILES = new Set(['index.js', 'main.js', 'main.py', 'app.js', 'app.py', 'server.js', 'index.ts', 'pipeline.py', '__main__.py', 'package.json', 'pyproject.toml', 'cargo.toml']);
function keyFilesFor(fileList, cap = 15) {
  const out = [];
  for (const f of fileList || []) {
    const b = (String(f).split('/').pop() || '').toLowerCase();
    if (/^readme/.test(b) || /\.md$/.test(b) || ENTRY_FILES.has(b)) out.push(f);
  }
  // READMEs and top-level docs first, then entrypoints; cap to honour the chosen depth.
  out.sort((a, b) => (/(^|\/)readme/i.test(b) ? 1 : 0) - (/(^|\/)readme/i.test(a) ? 1 : 0));
  return out.slice(0, cap);
}
// A repo → a project node + key-file nodes + part-of edges.
function repoNodes(repo) {
  if (!repo || !repo.name) return { nodes: [], edges: [] };
  const projRef = repo.path || repo.name;
  const pid = nodeId('project', projRef);
  const nodes = [{ type: 'project', ref: projRef, label: repo.name, text: [repo.name, repo.readme].filter(Boolean).join('\n').slice(0, 6000), importance: 2, meta: { root: repo.path, kind: 'repo' } }];
  const edges = [];
  for (const f of (repo.files || [])) {
    const fref = projRef + '/' + f.path;
    nodes.push({ type: 'file', ref: fref, label: f.path, text: String(f.text || '').slice(0, 6000), meta: { repo: repo.name } });
    edges.push({ from: nodeId('file', fref), to: pid, type: 'part-of', rationale: 'file of ' + repo.name, confidence: 1, status: 'confirmed', createdBy: 'import' });
  }
  return { nodes, edges };
}
// A Notion page → a page node + section nodes + part-of edges.
function notionNodes(page) {
  if (!page || !page.id) return { nodes: [], edges: [] };
  const pref = 'notion:' + page.id;
  const pid = nodeId('notion', pref);
  const nodes = [{ type: 'notion', ref: pref, label: (page.title || page.id).slice(0, 120), text: String(page.text || page.title || '').slice(0, 6000), meta: { url: page.url } }];
  const edges = [];
  for (const s of (page.sections || [])) {
    const sref = pref + '#' + (slug(s.heading || s.text || '') || hash(s.text || ''));
    nodes.push({ type: 'notion', ref: sref, label: String(s.heading || 'section').slice(0, 90), text: String(s.text || '').slice(0, 3000), meta: { url: page.url } });
    edges.push({ from: nodeId('notion', sref), to: pid, type: 'part-of', rationale: 'section of ' + (page.title || page.id), confidence: 1, status: 'confirmed', createdBy: 'import' });
  }
  return { nodes, edges };
}

// ─── the CONNECTOR (pure): propose cross-project links from node embeddings ───────────────────────
// Given nodes that carry embeddings, score every pair from DIFFERENT projects and propose a
// 'relates-to' edge above the similarity threshold. Skips pairs that already have an edge (any status,
// so pruned pairs are never re-proposed by the caller who passes existingPairs). Returns candidate
// edges WITHOUT rationale — the caller adds an LLM "why related" note before committing.
function proposeConnections(nodeList, { threshold = 0.82, maxPerNode = 3, existingPairs = new Set() } = {}) {
  const withVec = (nodeList || []).filter((n) => Array.isArray(n.embedding) && n.embedding.length && n.status !== 'pruned');
  const projectOf = (n) => (n.meta && (n.meta.repo || n.meta.root)) || n.id.split('/')[0] || n.id;
  const out = [];
  for (let i = 0; i < withVec.length; i++) {
    const a = withVec[i]; let picked = 0;
    const cands = [];
    for (let j = 0; j < withVec.length; j++) {
      if (i === j) continue;
      const b = withVec[j];
      if (projectOf(a) === projectOf(b)) continue;                 // CROSS-project only (that's the value)
      const key = [a.id, b.id].sort().join('|');
      if (existingPairs.has(key)) continue;
      const score = cosine(a.embedding, b.embedding);
      if (score >= threshold) cands.push({ b, score, key });
    }
    cands.sort((x, y) => y.score - x.score);
    for (const c of cands) {
      if (picked >= maxPerNode) break;
      if (existingPairs.has(c.key)) continue;
      existingPairs.add(c.key); picked++;
      out.push({ from: a.id, to: c.b.id, type: 'relates-to', confidence: +c.score.toFixed(3), status: 'proposed', createdBy: 'connector', provenance: { via: 'embedding', score: +c.score.toFixed(3) } });
    }
  }
  return out;
}

module.exports = {
  createBrain, proposeConnections,
  projectNode, memoryNode, repoNodes, notionNodes, keyFilesFor,
  nodeId, edgeId, slug, cosine, NODE_TYPES, EDGE_TYPES, STATUSES,
};
