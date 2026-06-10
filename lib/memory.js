'use strict';
// Semantic memory (Phase 2 — the "why"). Per-workspace vector store: embed chunks via
// Ollama (free/local), brute-force cosine retrieval (fine for 10k+ chunks), dedup by
// similarity, decay rollup. This is what lets a workspace hold millions of tokens of
// history while exposing only top-k to a model. No native deps; falls back to a
// deterministic lexical vector if no embed model is installed. See ARCHITECTURE.md §2.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEDUP = 0.92;

function paths(wsDir) {
  const dir = path.join(wsDir, 'memories');
  return { dir, index: path.join(dir, 'index.json'), chunks: path.join(dir, 'chunks') };
}
function readIndex(wsDir) { const { index } = paths(wsDir); try { return JSON.parse(fs.readFileSync(index, 'utf8')); } catch { return { embed_model: null, items: [] }; } }
function writeIndex(wsDir, idx) { const p = paths(wsDir); fs.mkdirSync(p.chunks, { recursive: true }); fs.writeFileSync(p.index, JSON.stringify(idx)); }

// Lexical fallback: 256-dim hashed bag-of-words, L2-normalized. Deterministic, offline,
// good enough for dedup + rough retrieval when no embed model exists.
function lexicalVec(text, dim = 256) {
  const v = new Array(dim).fill(0);
  for (const tok of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
    const h = crypto.createHash('md5').update(tok).digest();
    v[h[0] % dim] += 1; v[h[1] % dim] += 0.5;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

async function embed(text, model) {
  if (model) {
    try {
      const r = await fetch(`${OLLAMA}/api/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt: String(text).slice(0, 8000) }) });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.embedding) && j.embedding.length) return { vec: j.embedding, model }; }
    } catch {}
  }
  return { vec: lexicalVec(text), model: 'lexical' };
}
function cosine(a, b) { if (!a || !b || a.length !== b.length) return 0; let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }

// write({text, tags}) — dedup near-duplicates (merge, bump seen), else store new chunk.
async function write(wsDir, { text, tags = [] }, { embedModel } = {}) {
  if (!text || !String(text).trim()) return null;
  const idx = readIndex(wsDir);
  const model = embedModel || idx.embed_model;
  const { vec, model: used } = await embed(text, model);
  if (!idx.embed_model && used !== 'lexical') idx.embed_model = used;
  // dedup only against chunks embedded the same way (comparable vectors)
  for (const it of idx.items) {
    if (it.dim !== vec.length) continue;
    if (cosine(it.vec, vec) >= DEDUP) { it.seen = (it.seen || 1) + 1; it.ts = Date.now(); writeIndex(wsDir, idx); return it.id; }
  }
  const id = 'mem_' + crypto.randomBytes(4).toString('hex');
  const p = paths(wsDir);
  fs.mkdirSync(p.chunks, { recursive: true });
  fs.writeFileSync(path.join(p.chunks, id + '.txt'), text);
  idx.items.push({ id, vec, dim: vec.length, tags, ts: Date.now(), seen: 1 });
  writeIndex(wsDir, idx);
  return id;
}

// search(query, k) — top-k chunk texts by cosine. Returns strings (ready to inline).
async function search(wsDir, query, k = 4, { embedModel } = {}) {
  const idx = readIndex(wsDir);
  if (!idx.items.length) return [];
  const { vec } = await embed(query, embedModel || idx.embed_model);
  const p = paths(wsDir);
  return idx.items
    .filter((it) => it.dim === vec.length)
    .map((it) => ({ it, score: cosine(it.vec, vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ it }) => { try { return fs.readFileSync(path.join(p.chunks, it.id + '.txt'), 'utf8'); } catch { return null; } })
    .filter(Boolean);
}

// Decay rollup: chunks older than maxAgeDays with seen<2 are low value. Caller can pass a
// summarizer (async fn(texts)->string) to compress a cluster into one chunk. Without one,
// just prunes the coldest beyond `cap` to bound disk. Keeps memory sub-linear.
async function compress(wsDir, { maxAgeDays = 30, cap = 5000, summarize } = {}) {
  const idx = readIndex(wsDir);
  const now = Date.now(), cold = [];
  for (const it of idx.items) if ((now - it.ts) / 864e5 > maxAgeDays && (it.seen || 1) < 2) cold.push(it);
  const p = paths(wsDir);
  if (summarize && cold.length >= 5) {
    const texts = cold.map((it) => { try { return fs.readFileSync(path.join(p.chunks, it.id + '.txt'), 'utf8'); } catch { return ''; } }).filter(Boolean);
    const summary = await summarize(texts);
    if (summary) { for (const it of cold) { try { fs.unlinkSync(path.join(p.chunks, it.id + '.txt')); } catch {} } idx.items = idx.items.filter((it) => !cold.includes(it)); await write(wsDir, { text: summary, tags: ['rollup'] }); }
  }
  if (idx.items.length > cap) { const drop = idx.items.sort((a, b) => a.ts - b.ts).slice(0, idx.items.length - cap); for (const it of drop) { try { fs.unlinkSync(path.join(p.chunks, it.id + '.txt')); } catch {} } idx.items = idx.items.filter((it) => !drop.includes(it)); }
  writeIndex(wsDir, idx);
  return { count: idx.items.length };
}

module.exports = { write, search, compress, embed, cosine };
