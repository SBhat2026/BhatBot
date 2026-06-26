'use strict';
// Episodic VECTOR recall (Phase 3, Deliverable #3). READ-PATH ONLY upgrade to the episodic tier
// (~/.bhatbot/notes/*.md). The old path (main.js recallEpisodic) injected idf-lexical top-k; for long
// sessions that still drifts and can't tell "rephrased same question" from "new question". This adds
// a semantic layer: embed the query, cosine-rank the episodic notes, inject ONLY the top-k.
//
//   await recall({ notesDir, query, k, embedModel })  → [{ file, title, body, score }]
//   seenBefore(recallResult, threshold)               → { hit, score, entry } | { hit:false }
//
// Guarantees:
//   • Does NOT touch the note files or any write path — only reads them + a sidecar vector cache.
//   • Deterministic: same query → same embedding → same ranking (no randomness in the path).
//   • Degrades gracefully: <2 notes, or embeddings unavailable, → returns [] (caller keeps lexical).
//   • Reuses lib/memory.js embed()/cosine() (Ollama local; deterministic lexical fallback offline).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mem = require('./memory');      // embed(text,model) / cosine(a,b)

const CACHE_FILE = '.episodic-vec.json';   // sidecar in notesDir; pure cache, safe to delete
const SEEN_THRESHOLD = 0.86;               // top-1 cosine ≥ this ⇒ "I've answered something like this"

function hashText(t) { return crypto.createHash('md5').update(String(t)).digest('hex').slice(0, 12); }
function titleOf(txt, fallback) { return (txt.match(/^#\s+(.+)$/m) || [])[1] || fallback; }
function bodyOf(txt, max = 280) {
  return txt.split('\n').filter((l) => l.trim() && !/^#/.test(l)).slice(0, 4).join(' ').replace(/\s+/g, ' ').slice(0, max);
}

function loadCache(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf8')); } catch { return { model: null, items: {} }; } }
function saveCache(dir, cache) { try { fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify(cache)); } catch {} }

// Build/refresh per-note embeddings, keyed by content hash so a note is embedded once and reused
// until its text changes. This is what keeps recall deterministic AND off the hot path after warm-up.
async function ensureVectors(dir, embedModel) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return { cache: { items: {} }, files: [] }; }
  const cache = loadCache(dir);
  if (embedModel && cache.model && cache.model !== embedModel) { cache.items = {}; cache.model = embedModel; }  // model changed → rebuild
  let dirty = false;
  for (const f of files) {
    let txt = ''; try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const h = hashText(txt);
    const cur = cache.items[f];
    if (cur && cur.h === h && Array.isArray(cur.vec)) continue;   // up to date
    const { vec, model } = await mem.embed(txt.slice(0, 4000), embedModel || cache.model);
    cache.items[f] = { h, vec, title: titleOf(txt, f.replace(/\.md$/, '')), body: bodyOf(txt) };
    cache.model = cache.model || model;
    dirty = true;
  }
  // drop entries for deleted files
  for (const k of Object.keys(cache.items)) if (!files.includes(k)) { delete cache.items[k]; dirty = true; }
  if (dirty) saveCache(dir, cache);
  return { cache, files };
}

async function recall({ notesDir, query, k = 8, embedModel } = {}) {
  try {
    if (!notesDir || !fs.existsSync(notesDir)) return [];
    const { cache, files } = await ensureVectors(notesDir, embedModel);
    if (!files || files.length < 2) return [];             // nothing worth recalling yet
    const q = String(query || '').trim();
    if (!q) return [];
    const { vec: qv } = await mem.embed(q, cache.model || embedModel);
    const scored = Object.entries(cache.items)
      .map(([file, it]) => ({ file, title: it.title, body: it.body, score: mem.cosine(qv, it.vec) }))
      .filter((x) => isFinite(x.score) && x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(k, 10)));             // ≤10 by default per the spec
    return scored;
  } catch { return []; }
}

// "Have I answered this before?" — top-1 above threshold ⇒ surface it to the agent BEFORE generation.
function seenBefore(scored, threshold = SEEN_THRESHOLD) {
  if (!Array.isArray(scored) || !scored.length) return { hit: false, score: 0 };
  const top = scored[0];
  return top.score >= threshold ? { hit: true, score: top.score, entry: top } : { hit: false, score: top.score };
}

// Render the top-k as the same compact block shape main.js already injects for episodic recall.
function format(scored) {
  if (!scored || !scored.length) return '';
  return scored.map((s) => `- (${s.title}) ${s.body}`).join('\n');
}

module.exports = { recall, seenBefore, format, SEEN_THRESHOLD, ensureVectors };
