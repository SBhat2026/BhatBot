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
  // ⚠ LOAD-BEARING — the vectors live in their OWN file. Do not fold them back into graph.json.
  //
  // Measured on the live store: graph.json was 65.2MB, of which 61.0MB (93.5%) was embedding arrays.
  // save() therefore cost ~450ms of synchronous JSON.stringify plus a 65MB write — on the Electron
  // MAIN thread, on every weaver tick that creates a link. That is a periodic half-second freeze of
  // the whole app, and it is the single largest reason the second brain did not render smoothly.
  //
  // Vectors also change far less often than the graph around them: a link, a prune, a confirm, a
  // re-rank all touch the structure and none touch a single float. Splitting them means the common
  // save writes ~4MB instead of 65MB, and the vector file is rewritten only when a vector actually
  // changed (see `vecDirty`).
  // ── THE VECTORS ARE BINARY ─────────────────────────────────────────────────────────────────────
  // They were JSON: every float written out as ~17 characters of decimal text, 25 KB per 1536-dim
  // vector. Measured on the live store (2026-11-12): a 100 MB file, 532 ms and ~400 MB of peak RSS to
  // load it — the whole thing held as one string, then again as parsed arrays — and a full 100 MB
  // JSON.stringify + write on the main thread every time a single embedding changed.
  //
  // vectors.f32 is the same numbers as float32, which is the precision the embedding model produced
  // in the first place: 6 KB per vector, a quarter of the size, read as a buffer with no parse step.
  // In memory nothing changes — node.embedding is still a plain array, so every consumer that checks
  // Array.isArray keeps working. A store that only has the old vectors.json is read from it once and
  // rewritten in the new format on the next save; the old file is then renamed, not deleted, because
  // those vectors cost money to compute and a format change should not be able to lose them.
  const vecFile = path.join(base, 'vectors.f32');
  const legacyVecFile = path.join(base, 'vectors.json');
  const VEC_MAGIC = 'BBV1';
  let store = { nodes: {}, edges: {}, v: 1 };
  let vecDirty = false;         // has any embedding changed since the last vector write?

  // `loadFailed` is the difference between "there is no graph yet" and "the graph is unreadable".
  // Both used to produce an empty store, which meant a CORRUPT file was indistinguishable from a
  // first run — and the very next save() would then write {} over it.
  let loadFailed = false;
  let seenMtime = 0;                         // graph.json mtime this process last read or wrote — see freshen()
  let vecLoadFailed = false;

  /**
   * Merge the vector sidecar back onto the nodes.
   *
   * A MISSING sidecar is survivable — nodes simply look unembedded and the weaver re-embeds them one
   * bounded slice at a time. An UNREADABLE one is not the same thing, and must not be silently
   * treated as "no vectors": that would quietly re-bill for 1,800 embeddings and, worse, the next
   * save would write the empty result over the real file. Same reasoning as `loadFailed` on the
   * graph itself, which is the bug this codebase has already been bitten by once.
   */
  function loadVectors() {
    let buf = null;
    try { buf = fs.readFileSync(vecFile); } catch { buf = null; }
    if (buf) {
      try {
        if (buf.length < 8 || buf.toString('latin1', 0, 4) !== VEC_MAGIC) throw new Error('not a BBV1 vector file');
        const hlen = buf.readUInt32LE(4);
        if (8 + hlen > buf.length) throw new Error('header runs past the end of the file');
        const header = JSON.parse(buf.toString('utf8', 8, 8 + hlen));
        const dataStart = (8 + hlen + 3) & ~3;                    // floats start on a 4-byte boundary
        const total = header.entries.reduce((n, e) => n + e[1], 0);
        if (dataStart + total * 4 > buf.length) throw new Error(`truncated: header promises ${total} floats, file holds ${Math.floor((buf.length - dataStart) / 4)}`);
        // Copied into its own ArrayBuffer so the view is aligned whatever offset Node pooled the read at.
        const all = new Float32Array(buf.buffer.slice(buf.byteOffset + dataStart, buf.byteOffset + dataStart + total * 4));
        let pos = 0;
        for (const [id, dim] of header.entries) {
          if (store.nodes[id] && dim > 0) store.nodes[id].embedding = Array.from(all.subarray(pos, pos + dim));
          pos += dim;
        }
        return;
      } catch (e) {
        vecLoadFailed = true;
        try {
          const salvage = vecFile + '.corrupt-' + Date.now();
          fs.writeFileSync(salvage, buf);
          console.error(`[brain] ⚠ ${vecFile} is unreadable: ${e.message}`);
          console.error(`[brain]   kept a copy at ${salvage}. VECTOR WRITES ARE BLOCKED so it is not overwritten;`);
          console.error('[brain]   the graph itself is unaffected and still saves normally.');
        } catch {}
        return;
      }
    }
    // No binary sidecar: fall back to the JSON one a pre-migration store still has, and mark the
    // vectors dirty so the very next save writes the new format.
    let raw;
    try { raw = fs.readFileSync(legacyVecFile, 'utf8'); }
    catch { return; }                                    // genuinely absent, or pre-split store
    try {
      const vecs = JSON.parse(raw);
      let merged = 0;
      for (const id of Object.keys(vecs)) {
        if (store.nodes[id] && Array.isArray(vecs[id]) && vecs[id].length) { store.nodes[id].embedding = vecs[id]; merged++; }
      }
      if (merged) vecDirty = true;                       // → migrate to vectors.f32 on the next save
    } catch (e) {
      vecLoadFailed = true;
      try {
        const salvage = legacyVecFile + '.corrupt-' + Date.now();
        fs.writeFileSync(salvage, raw);
        console.error(`[brain] ⚠ ${legacyVecFile} does not parse: ${e.message}`);
        console.error(`[brain]   kept a copy at ${salvage}. VECTOR WRITES ARE BLOCKED so it is not overwritten;`);
        console.error('[brain]   the graph itself is unaffected and still saves normally.');
      } catch {}
    }
  }

  function load() {
    loadFailed = false;
    vecLoadFailed = false;
    let raw;
    try { seenMtime = fs.statSync(file).mtimeMs; raw = fs.readFileSync(file, 'utf8'); }
    catch { store = { nodes: {}, edges: {}, v: 1 }; return store; }   // genuinely absent: a first run
    try {
      const s = JSON.parse(raw);
      store = { v: 1, ...s, nodes: s.nodes || {}, edges: s.edges || {} };
      // A pre-split graph.json still carries its embeddings inline. Those are authoritative; keep
      // them and mark the sidecar dirty so the very next save performs the migration. Nothing has to
      // be converted up front, and an old store is never left without its vectors.
      let inline = 0;
      for (const n of Object.values(store.nodes)) if (Array.isArray(n.embedding) && n.embedding.length) inline++;
      loadVectors();
      if (inline) { vecDirty = true; }
    } catch (e) {
      // The file EXISTS and does not parse. Do not pretend the graph is empty.
      loadFailed = true;
      store = { nodes: {}, edges: {}, v: 1 };
      const kb = Math.round((raw.length || 0) / 1024);
      try {
        // Preserve the evidence before anything can overwrite it.
        const salvage = file + '.corrupt-' + Date.now();
        fs.writeFileSync(salvage, raw);
        console.error(`[brain] ⚠ ${file} exists (${kb}KB) but does not parse: ${e.message}`);
        console.error(`[brain]   kept a copy at ${salvage}. SAVES ARE BLOCKED until this is resolved,`);
        console.error('[brain]   so the damaged file is not overwritten with an empty graph.');
      } catch {}
    }
    return store;
  }

  /**
   * Persist the graph. ATOMIC, and refuses to destroy data.
   *
   * The old version was `writeFileSync(file, JSON.stringify(store))` — a non-atomic write of a file
   * that is currently 68MB. Killing the app mid-write (or filling the disk) truncates it; the next
   * load() then treated the unparseable remains as an empty graph, and the next save() wrote {} over
   * 1,772 nodes of accumulated second brain. Silent, total, unrecoverable.
   *
   * Three guards, cheapest first:
   *   • write to a temp file and rename() — atomic on POSIX, so a reader never sees a partial file.
   *     Same pattern lib/toolselect.js already uses for its vector cache.
   *   • never save when the load failed — the file on disk is better than what is in memory.
   *   • never shrink catastrophically: an empty store replacing a large file is the signature of
   *     this exact bug, so it needs an explicit override rather than happening by accident.
   */
  function save({ force = false } = {}) {
    if (loadFailed && !force) {
      console.error('[brain] refusing to save over an unparseable graph — pass { force: true } if that is really what you want');
      return store;
    }
    try {
      fs.mkdirSync(base, { recursive: true });
      const nodeCount = Object.keys(store.nodes || {}).length;
      if (!force && nodeCount === 0) {
        let prevSize = 0;
        try { prevSize = fs.statSync(file).size; } catch {}
        if (prevSize > 4096) {
          console.error(`[brain] refusing to write an EMPTY graph over ${Math.round(prevSize / 1024)}KB of existing data`);
          return store;
        }
      }
      // Serialize the graph WITHOUT the vectors. Cheapest correct way to do that without cloning
      // 1,800 nodes: swap each embedding out, stringify, swap it back. The store in memory is
      // untouched either side of this, so every caller still sees node.embedding as before.
      const held = [];
      for (const n of Object.values(store.nodes)) {
        if (n.embedding !== undefined) { held.push([n, n.embedding]); n.embedding = undefined; }
      }
      let body;
      try { body = JSON.stringify(store); }
      finally { for (const [n, v] of held) n.embedding = v; }

      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);                 // atomic swap — a reader sees old or new, never half
      try { seenMtime = fs.statSync(file).mtimeMs; } catch {}

      // The vectors ride separately and only when one actually changed. A link, a prune, a confirm
      // and a re-rank all leave every float exactly as it was, and those are the saves that happen
      // continuously while the app is open.
      if (vecDirty && !vecLoadFailed) {
        const entries = [], parts = [];
        let n = 0, floats = 0;
        for (const node of Object.values(store.nodes)) {
          if (Array.isArray(node.embedding) && node.embedding.length) { entries.push([node.id, node.embedding.length]); parts.push(node.embedding); floats += node.embedding.length; n++; }
        }
        // Same shape of guard as the graph's: never let an empty in-memory set erase a real file.
        let prevVec = 0;
        try { prevVec = fs.statSync(vecFile).size; } catch { try { prevVec = fs.statSync(legacyVecFile).size; } catch {} }
        if (n === 0 && prevVec > 4096 && !force) {
          console.error(`[brain] refusing to write an EMPTY vector store over ${Math.round(prevVec / 1024)}KB`);
        } else {
          const header = Buffer.from(JSON.stringify({ v: 1, n, entries }), 'utf8');
          const dataStart = (8 + header.length + 3) & ~3;
          const out = Buffer.alloc(dataStart + floats * 4);
          out.write(VEC_MAGIC, 0, 'latin1'); out.writeUInt32LE(header.length, 4); header.copy(out, 8);
          const view = new Float32Array(out.buffer, out.byteOffset + dataStart, floats);
          let pos = 0;
          for (const emb of parts) { view.set(emb, pos); pos += emb.length; }
          const vtmp = vecFile + '.tmp';
          fs.writeFileSync(vtmp, out);
          fs.renameSync(vtmp, vecFile);
          vecDirty = false;
          // The migration's last step, and only after the new file is safely in place: step the old
          // JSON aside. Renamed rather than removed — it is the only other copy of vectors that cost
          // money to compute, so it stays as `vectors.json.pre-f32` for him to delete.
          try { if (fs.existsSync(legacyVecFile)) fs.renameSync(legacyVecFile, legacyVecFile + '.pre-f32'); } catch {}
        }
      }
    } catch (e) {
      // A failed SAVE is not cosmetic: the work of this cycle is gone. It used to be swallowed.
      try { console.error('[brain] save failed — this cycle\'s changes were NOT persisted:', e.message); } catch {}
    }
    return store;
  }
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
    // Only an actual change to the vector makes the sidecar dirty. Compared by identity and length,
    // not deep-equality: embedBatch hands back a fresh array each time, and a 768-float compare on
    // every upsert would cost more than the write it saves. `n.embedding === null` is the explicit
    // invalidation recency.js performs, and counts as a change.
    const nextEmb = n.embedding !== undefined ? n.embedding : (prev && prev.embedding) || null;
    const prevEmb = (prev && prev.embedding) || null;
    if (nextEmb !== prevEmb) vecDirty = true;
    store.nodes[id] = {
      id, type: n.type,
      label: String(n.label || n.ref || id).slice(0, 200),
      ref: n.ref || (prev && prev.ref) || '',
      text: String(n.text != null ? n.text : (prev && prev.text) || '').slice(0, 6000),
      embedding: nextEmb,
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

  /**
   * TWO PROCESSES, ONE FILE. The headless synapse worker and the app both hold a brain on graph.json.
   * Each loaded it once and kept writing its own copy back, so the last writer won: on 25 Nov the
   * worker revived bhatbot and mandarin-learn ("worked on 0h ago") every cycle, and the app — still
   * holding the graph it loaded days earlier — wrote them straight back to archived, and its Projects
   * tab showed one project, "(home)". Every entry point now calls freshen() first: if the file on disk
   * is newer than the one this process last read or wrote, read it again before acting.
   */
  function freshen() {
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m > seenMtime + 1) { load(); return true; }
    } catch {}
    return false;
  }

  return { freshen, upsertNode, upsertEdge, getNode, nodes, edges, neighbors, prune, confirm, stats, graphView, getMeta, setMeta, save, load, loadFailed: () => loadFailed, vecLoadFailed: () => vecLoadFailed, dir: base, vecFile, _store: () => store, _vecDirty: () => vecDirty };
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
// ⚠ LOAD-BEARING (25 Nov). A vector's length is computed ONCE per vector, not once per pair, and the
// pair key is only built for pairs that clear the threshold. Profiled on the live app, cosine() was
// 20% of the main process's wall time: every pair recomputed both norms (two 1,536-float passes) and
// allocated a sorted string key before it was even scored.
const _norms = new WeakMap();
function normOf(v) { let n = _norms.get(v); if (n === undefined) { n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n); _norms.set(v, n); } return n; }
function cosineFast(a, b) {
  if (a.length !== b.length) return 0;
  const na = normOf(a), nb = normOf(b);
  if (!na || !nb) return 0;
  let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d / (na * nb);
}

/**
 * `anchors` (a Set of node ids) restricts which nodes PROPOSE links: each anchor is scored against the
 * whole list, nothing else is. Without it every node is an anchor — the old behaviour, O(N²). linkSlice
 * used to pass the whole graph and then throw away every edge not anchored in its 120-node window,
 * i.e. compute 2,200² pairs to keep 120×2,200 of them: 95% of the work discarded, ~4 s of frozen UI.
 */
function proposeConnections(nodeList, { threshold = 0.82, maxPerNode = 3, existingPairs = new Set(), anchors = null } = {}) {
  const withVec = (nodeList || []).filter((n) => Array.isArray(n.embedding) && n.embedding.length && n.status !== 'pruned');
  // Group key for the CROSS-project filter. Normalized to the LAST path segment because the two
  // importers disagree on form: repoNodes() keys a project by its absolute path
  // ("/Users/siddhantbhat/MCPSeedance") while fileindex keys by name ("MCPSeedance"). Compared raw,
  // those are different groups, so a repo linked to its own README and the graph filled with
  // within-project noise — the opposite of what this filter exists to do.
  const groupKey = (v) => String(v || '').replace(/\/+$/, '').split('/').pop().toLowerCase();
  const projectOf = (n) => groupKey((n.meta && (n.meta.repo || n.meta.root)) || n.id.split('/')[0] || n.id);
  const out = [];
  const proj = withVec.map(projectOf);
  for (let i = 0; i < withVec.length; i++) {
    const a = withVec[i]; let picked = 0;
    if (anchors && !anchors.has(a.id)) continue;
    const cands = [];
    for (let j = 0; j < withVec.length; j++) {
      if (i === j || proj[i] === proj[j]) continue;                // CROSS-project only (that's the value)
      const b = withVec[j];
      const score = cosineFast(a.embedding, b.embedding);
      if (score < threshold) continue;
      const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
      if (existingPairs.has(key)) continue;
      cands.push({ b, score, key });
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
