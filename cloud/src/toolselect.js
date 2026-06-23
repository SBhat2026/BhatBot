'use strict';
// Two-stage tool retrieval — CLOUD parity of desktop lib/toolselect.js (W1). Embeds each tool's
// name+description once (cached on the Fly volume), and per turn injects only the top-k most
// relevant + a small always-present CORE set. Falls back to the full catalog when there's no
// OpenAI key, the catalog is small, or confidence is low — so behaviour is unchanged otherwise.
// Uses OpenAI text-embedding-3-small directly (cloud has no semantic.js); never throws.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_PATH = path.join(DATA_DIR, 'toolvecs.json');
const KEY = process.env.OPENAI_API_KEY || '';
const EMBED_URL = 'https://api.openai.com/v1/embeddings';
const MIN_CATALOG = 16;
// Cloud essentials that must always be available regardless of relevance score.
const CORE = ['remember', 'recall', 'web_fetch', 'wake_mac', 'contacts'];

function catalogHash(tools) { return crypto.createHash('sha1').update(tools.map((t) => `${t.name}:${String(t.description || '').length}`).join('|')).digest('hex'); }
function toolText(t) { return `${t.name}: ${String(t.description || '').slice(0, 600)}`; }
function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return null; } }
function saveCache(o) { try { fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true }); const tmp = CACHE_PATH + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, CACHE_PATH); } catch {} }

function normalize(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); }
function cosine(a, b) { if (!a || !b || a.length !== b.length) return 0; let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

async function embed(texts) {
  if (!KEY) return null;
  try {
    const r = await fetch(EMBED_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts.map((t) => String(t || '').slice(0, 8000)) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const out = texts.map(() => null);
    for (const d of (j.data || [])) if (typeof d.index === 'number' && Array.isArray(d.embedding)) out[d.index] = normalize(d.embedding);
    return out;
  } catch { return null; }
}

async function embedCatalog(tools) {
  const hash = catalogHash(tools);
  const cache = loadCache();
  if (cache && cache.hash === hash && cache.vecs && Object.keys(cache.vecs).length === tools.length) return cache;
  const vecs = await embed(tools.map(toolText));
  if (!vecs) return cache && cache.vecs ? cache : null;
  const out = {}; for (let i = 0; i < tools.length; i++) if (vecs[i]) out[tools[i].name] = vecs[i];
  if (!Object.keys(out).length) return null;
  const fresh = { hash, vecs: out, ts: Date.now() };
  saveCache(fresh);
  return fresh;
}

// select(queryText, tools, {k,minScore}) → filtered tool array | null (null ⇒ use full catalog).
async function select(queryText, tools, { k = 12, minScore = 0.18 } = {}) {
  const q = String(queryText || '').trim();
  if (!q || !Array.isArray(tools) || tools.length < MIN_CATALOG || !KEY) return null;
  const cat = await embedCatalog(tools);
  if (!cat || !cat.vecs) return null;
  const qv = await embed([q]);
  const qvec = qv && qv[0];
  if (!qvec) return null;
  const ranked = [];
  for (const t of tools) { const v = cat.vecs[t.name]; if (v) ranked.push([t.name, cosine(qvec, v)]); }
  ranked.sort((a, b) => b[1] - a[1]);
  const top = ranked.filter(([, s]) => s >= minScore).slice(0, k).map(([n]) => n);
  if (!top.length) return null;
  const keep = new Set(top);
  for (const n of CORE) if (tools.some((t) => t.name === n)) keep.add(n);
  const subset = tools.filter((t) => keep.has(t.name));
  if (subset.length >= tools.length) return null;
  return { tools: subset, names: subset.map((t) => t.name) };
}

module.exports = { select, CORE, CACHE_PATH };
