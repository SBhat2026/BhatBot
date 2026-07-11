'use strict';
// Semantic memory layer (task #12) — embedding-based long-term recall.
//
// Distinguishes EPISODIC memory (timestamped events: what happened, when) from
// SEMANTIC memory (durable facts / preferences). Embeddings come from OpenAI
// (text-embedding-3-small) via global fetch; the vector store is a single JSON
// file under ~/.bhatbot/semantic/store.json. Brute-force cosine search over
// normalized vectors — fine well past the 5000-record cap we enforce here.
//
// ZERO npm dependencies (Node built-ins + global fetch only). Every exported
// function degrades gracefully when no OpenAI key is present: it returns a
// {skipped:true} marker or an empty array, and NEVER throws. This means it can
// be wired into hot paths (saveMemoryEntry, recall, per-turn logging) with no
// behavioural change for users who haven't set openaiKey.
//
// Cost: text-embedding-3-small is ~$0.00002 per 1k tokens. A typical fact or
// turn is well under 1k tokens, so this is effectively free at personal scale.
//
// See lib/SEMANTIC_INTEGRATION.md for exact wiring instructions.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EMBED_URL = 'https://api.openai.com/v1/embeddings';
const EMBED_MODEL = 'text-embedding-3-small';
const FETCH_TIMEOUT_MS = 15000;
const MAX_RECORDS = 5000;          // total cap; evict oldest episodic first
const DEDUP_COSINE = 0.95;         // near-identical text within same kind → bump ts
const BATCH_SIZE = 64;             // OpenAI accepts arrays of inputs
const MAX_INPUT_CHARS = 8000;      // truncate over-long inputs before embedding

const BASE_DIR = path.join(os.homedir(), '.bhatbot', 'semantic');
const STORE_PATH = path.join(BASE_DIR, 'store.json');

// ---------------------------------------------------------------------------
// Key resolution — config.json (desktop) OR env (cloud). Cached briefly so we
// don't hit disk on every call, but cheap enough to re-read.
// ---------------------------------------------------------------------------
function readKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const cfgPath = path.join(os.homedir(), '.bhatbot', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    // GUARD: config.json holds a CRED_REF_* VAULT HANDLE, not the raw key (it gets auto-vaulted).
    // Shipping the handle as a bearer token 401s and silently kills all embeddings → recall dies.
    // The real key is bridged into process.env at boot (main.js syncResolvedSecretsToEnv). If it
    // isn't there and config only has a handle, return '' (skip) rather than send a doomed request.
    if (cfg && cfg.openaiKey && !String(cfg.openaiKey).startsWith('CRED_REF')) return cfg.openaiKey;
  } catch {}
  return '';
}

/**
 * isReady() → boolean
 * True iff an OpenAI key is resolvable (env or ~/.bhatbot/config.json).
 * When false, all embedding-dependent functions no-op gracefully.
 */
function isReady() { return !!readKey(); }

// ---------------------------------------------------------------------------
// Store I/O — single JSON file. Shape: { v:1, records:[{id,kind,text,ts,meta,vec}] }
// vec is L2-normalized at write time so search is a plain dot product.
// ---------------------------------------------------------------------------
function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.records)) return j;
  } catch {}
  return { v: 1, records: [] };
}
function saveStore(store) {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    // atomic-ish write: tmp then rename, so a crash mid-write can't corrupt the store
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, STORE_PATH);
  } catch {}
}

// Cap enforcement: drop oldest episodic first, then oldest of anything.
function enforceCap(store) {
  if (store.records.length <= MAX_RECORDS) return;
  const over = store.records.length - MAX_RECORDS;
  // sort a shallow copy by (episodic-first, then oldest ts) to pick eviction victims
  const victims = store.records
    .map((r, i) => ({ i, kind: r.kind, ts: r.ts || 0 }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'episodic' ? -1 : 1; // episodic evicted first
      return a.ts - b.ts;                                            // oldest first
    })
    .slice(0, over)
    .map((x) => x.i);
  const drop = new Set(victims);
  store.records = store.records.filter((_, i) => !drop.has(i));
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------
function normalize(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}
/** cosine(a,b) → similarity in [-1,1]. Plain dot product when both are normalized. */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den ? d / den : 0;
}

// ---------------------------------------------------------------------------
// Embedding via OpenAI — batched, timeout-guarded, never throws.
// embedBatch(texts) → { vecs:[[...]|null], skipped?, error? }  (vecs aligned to input)
// ---------------------------------------------------------------------------
async function embedBatch(texts) {
  const key = readKey();
  if (!key) return { skipped: true, vecs: texts.map(() => null) };
  const inputs = texts.map((t) => String(t || '').slice(0, MAX_INPUT_CHARS));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      return { error: `openai ${r.status} ${detail}`, vecs: texts.map(() => null) };
    }
    const j = await r.json();
    const data = Array.isArray(j.data) ? j.data : [];
    // OpenAI preserves input order via .index; map defensively.
    const vecs = inputs.map(() => null);
    for (const d of data) {
      if (typeof d.index === 'number' && Array.isArray(d.embedding)) vecs[d.index] = normalize(d.embedding);
    }
    return { vecs };
  } catch (e) {
    return { error: (e && e.message) || 'fetch failed', vecs: texts.map(() => null) };
  } finally {
    clearTimeout(timer);
  }
}
async function embedOne(text) {
  const { vecs, skipped, error } = await embedBatch([text]);
  return { vec: vecs[0], skipped, error };
}

function newId() { return 'sm_' + crypto.randomBytes(6).toString('hex'); }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * upsert({text, kind='semantic', meta={}}) → result
 *   Embeds `text` and stores a record. If a record of the SAME kind is
 *   near-identical (cosine ≥ 0.95), its ts (and meta) are refreshed instead of
 *   adding a duplicate.
 *   Returns: { id, deduped?:true, action:'insert'|'update' }
 *         or { skipped:true } when no key / embedding unavailable.
 */
async function upsert({ text, kind = 'semantic', meta = {} } = {}) {
  if (!text || !String(text).trim()) return { skipped: true, reason: 'empty' };
  kind = kind === 'episodic' ? 'episodic' : 'semantic';
  const { vec, skipped } = await embedOne(text);
  if (skipped || !vec) return { skipped: true };
  const store = loadStore();
  // dedup within same kind only (comparable semantics)
  for (const rec of store.records) {
    if (rec.kind !== kind || !rec.vec || rec.vec.length !== vec.length) continue;
    if (cosine(rec.vec, vec) >= DEDUP_COSINE) {
      rec.ts = Date.now();
      rec.text = String(text);            // keep latest phrasing
      rec.meta = { ...(rec.meta || {}), ...(meta || {}) };
      rec.vec = vec;
      saveStore(store);
      return { id: rec.id, deduped: true, action: 'update' };
    }
  }
  const id = newId();
  store.records.push({ id, kind, text: String(text), ts: Date.now(), meta: meta || {}, vec });
  enforceCap(store);
  saveStore(store);
  return { id, action: 'insert' };
}

/**
 * search(query, {kind, k=6, minScore=0.2}) → [{text, kind, ts, score, meta}]
 *   Cosine-ranked top matches. `kind` (optional) restricts to 'episodic' or
 *   'semantic'. Results below minScore are dropped. Sorted by score desc.
 *   Returns [] when no key, empty store, or embedding unavailable (never throws).
 */
async function search(query, { kind, k = 6, minScore = 0.2 } = {}) {
  if (!query || !String(query).trim()) return [];
  const store = loadStore();
  if (!store.records.length) return [];
  const { vec, skipped } = await embedOne(query);
  if (skipped || !vec) return [];
  const scored = [];
  for (const rec of store.records) {
    if (kind && rec.kind !== kind) continue;
    if (!rec.vec || rec.vec.length !== vec.length) continue;
    const score = cosine(rec.vec, vec);
    if (score >= minScore) scored.push({ text: rec.text, kind: rec.kind, ts: rec.ts, score, meta: rec.meta || {} });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * recent({kind, k=20}) → [{text, kind, ts, meta}]
 *   Newest records first. No embedding call (works without a key).
 */
function recent({ kind, k = 20 } = {}) {
  const store = loadStore();
  let recs = store.records;
  if (kind) recs = recs.filter((r) => r.kind === kind);
  return recs
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, k)
    .map((r) => ({ text: r.text, kind: r.kind, ts: r.ts, meta: r.meta || {} }));
}

/**
 * stats() → { total, episodic, semantic, ready, capacity }
 *   Counts by kind. No embedding call.
 */
function stats() {
  const store = loadStore();
  let episodic = 0, semantic = 0;
  for (const r of store.records) (r.kind === 'episodic' ? episodic++ : semantic++);
  return { total: store.records.length, episodic, semantic, ready: isReady(), capacity: MAX_RECORDS };
}

/**
 * backfill(items) → { added, updated, skipped, total } | { skipped:true }
 *   Bulk upsert. items: [{text, kind, ts, meta}]. Batches embedding requests
 *   (up to BATCH_SIZE inputs/request). Honors explicit ts when provided.
 *   Dedups within same kind against existing store (cosine ≥ 0.95 → update ts).
 *   Tolerates per-batch failures (those items count as skipped) and never throws.
 */
async function backfill(items) {
  if (!Array.isArray(items) || !items.length) return { added: 0, updated: 0, skipped: 0, total: stats().total };
  if (!isReady()) return { skipped: true, added: 0, updated: 0, total: 0 };
  const clean = items
    .filter((it) => it && it.text && String(it.text).trim())
    .map((it) => ({
      text: String(it.text),
      kind: it.kind === 'episodic' ? 'episodic' : 'semantic',
      ts: typeof it.ts === 'number' ? it.ts : (it.ts ? Date.parse(it.ts) || Date.now() : Date.now()),
      meta: it.meta || {},
    }));
  const store = loadStore();
  let added = 0, updated = 0, skipped = 0;

  for (let i = 0; i < clean.length; i += BATCH_SIZE) {
    const batch = clean.slice(i, i + BATCH_SIZE);
    const { vecs, error } = await embedBatch(batch.map((b) => b.text));
    if (error) { skipped += batch.length; continue; }
    for (let j = 0; j < batch.length; j++) {
      const vec = vecs[j];
      const item = batch[j];
      if (!vec) { skipped++; continue; }
      // dedup against current store (including items added earlier in this run)
      let merged = false;
      for (const rec of store.records) {
        if (rec.kind !== item.kind || !rec.vec || rec.vec.length !== vec.length) continue;
        if (cosine(rec.vec, vec) >= DEDUP_COSINE) {
          rec.ts = Math.max(rec.ts || 0, item.ts);
          rec.meta = { ...(rec.meta || {}), ...item.meta };
          merged = true;
          updated++;
          break;
        }
      }
      if (merged) continue;
      store.records.push({ id: newId(), kind: item.kind, text: item.text, ts: item.ts, meta: item.meta, vec });
      added++;
    }
  }
  enforceCap(store);
  saveStore(store);
  return { added, updated, skipped, total: store.records.length };
}

/**
 * maintain({ maxEpisodicAgeDays=45, dedupThreshold=0.95 }) → { before, after, decayed, merged }
 *   Always-on upkeep: decay stale episodics + merge near-duplicates that drifted in over time.
 *   Delegates the decision logic to lib/memmaint.planMaintenance (pure/testable); this is the thin
 *   I/O wrapper that loads the store, applies the plan, and persists. No embedding calls (uses stored
 *   vectors), so it's cheap to run on a timer. Never throws.
 */
function maintain({ maxEpisodicAgeDays = 45, dedupThreshold = 0.95 } = {}) {
  try {
    const memmaint = require('./memmaint');
    const store = loadStore();
    const before = store.records.length;
    const plan = memmaint.planMaintenance(store.records, { now: Date.now(), maxEpisodicAgeDays, dedupThreshold, cosine });
    if (!plan.decay.length && !plan.merge.length) return { before, after: before, decayed: 0, merged: 0 };
    const drop = new Set([...plan.decay, ...plan.merge.map((m) => m.drop)]);
    store.records = store.records.filter((r) => !drop.has(r.id));
    saveStore(store);
    return { before, after: store.records.length, decayed: plan.decay.length, merged: plan.merge.length };
  } catch (e) { return { error: e.message }; }
}

module.exports = {
  isReady,
  upsert,
  search,
  recent,
  stats,
  maintain,
  backfill,
  // exposed for tooling/tests + the tool-retrieval layer (lib/toolselect.js):
  embedBatch,
  embedOne,
  cosine,
  STORE_PATH,
};
