'use strict';
// Knowledge-graph memory (W4). The 3-tier memory (markdown + embeddings + Notion) is flat: it
// retrieves facts that look like the query, but can't traverse relationships. This adds a small
// typed graph ON TOP — entities are nodes, relationships are typed edges — so multi-hop questions
// ("what does the project I started last week use?") resolve by traversal, not similarity alone.
//
// Zero npm deps; single JSON file at ~/.bhatbot/graph.json (mirrors lib/semantic.js conventions:
// atomic write, graceful degradation, never throws). Embedding-based entity resolution is OPTIONAL
// and injected by the caller (so this module stays dependency-free and testable) — without it,
// query() falls back to normalized-string matching.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STORE_PATH = path.join(os.homedir(), '.bhatbot', 'graph.json');
const MAX_NODES = 4000;
const MAX_EDGES = 12000;

function load() {
  try { const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); if (j && j.nodes && j.edges) return j; } catch {}
  return { v: 1, nodes: {}, edges: [] };
}
function save(g) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(g));
    fs.renameSync(tmp, STORE_PATH);
  } catch {}
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function nodeId(type, name) { return `${norm(type) || 'thing'}:${norm(name)}`; }

// addNode({type,name,meta}) → id. Dedups by (type,name); merges meta + bumps ts.
function addNode(g, { type = 'thing', name, meta = {} } = {}) {
  if (!name || !norm(name)) return null;
  const id = nodeId(type, name);
  const ex = g.nodes[id];
  if (ex) { ex.ts = Date.now(); ex.meta = { ...(ex.meta || {}), ...meta }; if (name.length > (ex.name || '').length) ex.name = name; }
  else g.nodes[id] = { id, type: norm(type) || 'thing', name, meta, ts: Date.now() };
  return id;
}

// addEdge({from:{type,name}, rel, to:{type,name}, meta}) — creates endpoints as needed; dedups by
// (from,rel,to), refreshing ts. rel is a free-text relation label (lowercased, spaces→_).
function addEdge(g, { from, rel, to, meta = {} } = {}) {
  if (!from || !to || !rel) return false;
  const fid = addNode(g, from), tid = addNode(g, to);
  if (!fid || !tid) return false;
  const r = norm(rel).replace(/\s+/g, '_');
  const hit = g.edges.find((e) => e.from === fid && e.to === tid && e.rel === r);
  if (hit) { hit.ts = Date.now(); hit.meta = { ...(hit.meta || {}), ...meta }; }
  else g.edges.push({ from: fid, rel: r, to: tid, ts: Date.now(), meta });
  return true;
}

function enforceCaps(g) {
  const ids = Object.keys(g.nodes);
  if (ids.length > MAX_NODES) {
    const victims = ids.map((id) => g.nodes[id]).sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(0, ids.length - MAX_NODES).map((n) => n.id);
    const drop = new Set(victims);
    for (const id of victims) delete g.nodes[id];
    g.edges = g.edges.filter((e) => !drop.has(e.from) && !drop.has(e.to));
  }
  if (g.edges.length > MAX_EDGES) { g.edges.sort((a, b) => (a.ts || 0) - (b.ts || 0)); g.edges = g.edges.slice(g.edges.length - MAX_EDGES); }
}

// ingest(triples) — bulk add. triples: [{subject, predicate, object, subjectType?, objectType?}].
// Returns {added}. Persists once.
function ingest(triples) {
  if (!Array.isArray(triples) || !triples.length) return { added: 0 };
  const g = load();
  let added = 0;
  for (const t of triples) {
    const s = t.subject || t.from, o = t.object || t.to, p = t.predicate || t.rel;
    if (!s || !o || !p) continue;
    if (addEdge(g, { from: { type: t.subjectType || 'thing', name: s }, rel: p, to: { type: t.objectType || 'thing', name: o } })) added++;
  }
  enforceCaps(g);
  save(g);
  return { added };
}

// neighbors(id, depth) — BFS out to `depth` hops; returns edges encountered as readable triples.
function neighborsFrom(g, startIds, depth = 2, limit = 40) {
  const seen = new Set(startIds);
  let frontier = [...startIds];
  const out = [];
  for (let d = 0; d < depth && frontier.length && out.length < limit; d++) {
    const next = [];
    for (const e of g.edges) {
      if (seen.has(e.from) && !seen.has(e.to)) { out.push(e); next.push(e.to); }
      else if (seen.has(e.to) && !seen.has(e.from)) { out.push(e); next.push(e.from); }
      if (out.length >= limit) break;
    }
    for (const id of next) seen.add(id);
    frontier = next;
  }
  return out.slice(0, limit);
}

function edgeText(g, e) {
  const f = g.nodes[e.from], t = g.nodes[e.to];
  return `${(f && f.name) || e.from} —${e.rel.replace(/_/g, ' ')}→ ${(t && t.name) || e.to}`;
}

/**
 * query(text, {depth=2, resolve}) → { hits:[ "A —rel→ B", ... ], seeds:[names] }
 *   1. resolve seed entities from `text`: substring match over node names, plus (if provided) a
 *      `resolve(text)→[names]` embedding resolver for fuzzy matches; 2. BFS from those seeds.
 *   Synchronous when no resolver; otherwise pass already-resolved names via opts.seedNames.
 */
function query(text, { depth = 2, seedNames = [], limit = 40 } = {}) {
  const g = load();
  if (!Object.keys(g.nodes).length) return { hits: [], seeds: [] };
  const q = norm(text);
  const seeds = new Set();
  for (const id of Object.keys(g.nodes)) {
    const n = g.nodes[id];
    const nm = norm(n.name);
    if (nm && (q.includes(nm) || (nm.length > 4 && nm.split(' ').some((w) => w.length > 4 && q.includes(w))))) seeds.add(id);
  }
  for (const name of seedNames) { const id = Object.keys(g.nodes).find((k) => norm(g.nodes[k].name) === norm(name)); if (id) seeds.add(id); }
  if (!seeds.size) return { hits: [], seeds: [] };
  const edges = neighborsFrom(g, [...seeds], depth, limit);
  return { hits: edges.map((e) => edgeText(g, e)), seeds: [...seeds].map((id) => g.nodes[id].name) };
}

function stats() { const g = load(); return { nodes: Object.keys(g.nodes).length, edges: g.edges.length }; }
function allNodeNames() { const g = load(); return Object.values(g.nodes).map((n) => n.name); }

module.exports = { ingest, query, stats, addNode, addEdge, load, save, allNodeNames, STORE_PATH, _norm: norm };
