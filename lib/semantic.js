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
// ── LOCAL EMBEDDING FALLBACK ─────────────────────────────────────────────────────────────────────
// The whole second brain — recall, the connection graph, the always-on weaver — was hostage to one
// OpenAI key, and that key silently 401'd ("Incorrect API key provided"). Every embedding-dependent
// feature degraded to nothing, QUIETLY, because embedBatch returns `{skipped:true}` instead of
// throwing. A knowledge graph that stops growing when a key rotates is not an always-on system.
//
// Ollama serves embeddings locally: free, private, offline, and small enough not to fight the
// thermal governor (nomic-embed-text is ~137M params — nothing like a 30B chat model).
// It is the FALLBACK, not the default: text-embedding-3-small is better, so we prefer it whenever
// the key actually works, and drop to local the moment it does not.
//
// DIMENSIONS DIFFER (1536 vs 768) and vectors from different models are NOT comparable. brain.cosine
// already returns 0 on a length mismatch, so a mixed store degrades to "no link" rather than to
// nonsense similarity — but embedBatch also reports which model it used so callers can re-embed.
const OLLAMA_EMBED_URL = 'http://127.0.0.1:11434/api/embed';
const OLLAMA_EMBED_MODEL = process.env.BHATBOT_EMBED_MODEL || 'nomic-embed-text';
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
 * True iff an OpenAI key is resolvable (env or ~/.bhatbot/config.json), OR the local Ollama embedder
 * has already answered successfully this session.
 *
 * SYNCHRONOUS, therefore CONSERVATIVE: it cannot probe a local server, so before the first local
 * embed it reports false even when Ollama is running and healthy. Async callers should prefer
 * `await embedderReady()` — see the note there for what this distinction cost.
 */
function isReady() { return !!readKey() || _ollamaEmbedOk === true; }

/**
 * embedderReady() → Promise<boolean>
 * True if ANY embedding backend can serve us: an OpenAI key, or a reachable local Ollama.
 *
 * WHY THIS EXISTS. embedBatch() was deliberately upgraded to fall back to local Ollama so a dead or
 * rotated OpenAI key could not silently kill the second brain. `isReady()` was left gating on the
 * OpenAI key alone. So every caller that asked "can I embed?" BEFORE doing any work answered no on a
 * machine with a perfectly good local embedder, and three subsystems quietly switched themselves off:
 *   • tool retrieval (lib/toolselect.js) returned null every turn, so the FULL 83-tool, ~24K-token
 *     catalog went on the wire on every single request — the exact context-rot it exists to prevent;
 *   • semantic recall (main.js refreshSemanticRecall) — the "BhatBot forgot everything" failure the
 *     surrounding comments describe as fixed. The embed path was fixed; the GATE was not;
 *   • semantic.index() — skipped, so nothing new was embedded either.
 * A negative probe is cached only briefly, not for the session, so starting Ollama mid-session
 * recovers on the next check.
 */
let _probeAt = 0, _probeVal = false;
async function embedderReady({ ttlMs = 60000, now = Date.now() } = {}) {
  if (readKey()) return true;
  if (_ollamaEmbedOk === false) return false;            // proven bad by a real embed this session
  if (_ollamaEmbedOk === true) return true;
  if (_probeAt && now - _probeAt < ttlMs) return _probeVal;
  _probeAt = now;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    try {
      const r = await fetch(OLLAMA_EMBED_URL.replace('/api/embed', '/api/tags'), { signal: ctrl.signal });
      _probeVal = !!(r && r.ok);
    } finally { clearTimeout(t); }
  } catch { _probeVal = false; }
  return _probeVal;
}

// ---------------------------------------------------------------------------
// Store I/O — single JSON file. Shape: { v:1, records:[{id,kind,text,ts,meta,vec}] }
// vec is L2-normalized at write time so search is a plain dot product.
// ---------------------------------------------------------------------------
let _storeCorrupt = false;
function loadStore() {
  let raw;
  try { raw = fs.readFileSync(STORE_PATH, 'utf8'); }
  catch { _storeCorrupt = false; return { v: 1, records: [] }; }   // absent: nothing indexed yet
  try {
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.records)) { _storeCorrupt = false; return j; }
    throw new Error('missing records array');
  } catch (e) {
    // Present but unusable. An empty return here reads as "nothing remembered", and the next
    // saveStore() would then write that emptiness over everything — the same chain that could
    // destroy the knowledge graph. Flagged so saveStore can refuse.
    _storeCorrupt = true;
    try { console.error(`[semantic] ⚠ ${STORE_PATH} exists (${Math.round(raw.length / 1024)}KB) but is unusable: ${e.message} — refusing to overwrite it`); } catch {}
    return { v: 1, records: [] };
  }
}
function saveStore(store) {
  // Never write over a store we could not read. loadStore() returns an empty shape when the file is
  // unparseable, so without this the next save quietly replaces a real store with that emptiness.
  if (_storeCorrupt) {
    try { console.error('[semantic] refusing to save over an unreadable store — move or repair it first'); } catch {}
    return;
  }
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    // Atomic write: tmp then rename, so a crash mid-write can't corrupt the store.
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    // A failed save means this cycle's embeddings are gone. That was swallowed entirely.
    try { console.error('[semantic] save failed — new records were NOT persisted:', e.message); } catch {}
  }
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
// Ollama's local embedder. Returns the same shape as the OpenAI path so callers never branch.
let _ollamaEmbedOk = null;   // null = untried, false = unavailable (don't keep retrying per batch)
async function embedBatchLocal(inputs) {
  if (_ollamaEmbedOk === false) return { skipped: true, vecs: inputs.map(() => null) };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);   // local, but a cold model load is slow
  try {
    const r = await fetch(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: inputs }),
      signal: ctrl.signal,
    });
    if (!r.ok) { _ollamaEmbedOk = false; return { error: `ollama ${r.status}`, vecs: inputs.map(() => null) }; }
    const j = await r.json();
    const raw = j.embeddings || (j.embedding ? [j.embedding] : []);
    if (!raw.length) { _ollamaEmbedOk = false; return { error: 'ollama returned no embeddings', vecs: inputs.map(() => null) }; }
    _ollamaEmbedOk = true;
    return { vecs: inputs.map((_, i) => (Array.isArray(raw[i]) ? normalize(raw[i]) : null)), model: OLLAMA_EMBED_MODEL, local: true };
  } catch (e) {
    _ollamaEmbedOk = false;
    return { error: 'ollama embed: ' + e.message, vecs: inputs.map(() => null) };
  } finally { clearTimeout(timer); }
}

// ── ONE EMBEDDING PER STRING PER TURN ────────────────────────────────────────────────────────────
// A single turn embeds the user's text at least three times: semantic recall, episodic-vector recall,
// and tool retrieval each call down here with the SAME string, independently, because none of them
// knows the others exist. That is two wasted provider round-trips on the critical path before the
// first token (~45ms each warm, ~600ms on the first call of a session while the local model loads).
//
// A short TTL rather than a permanent cache: embeddings are deterministic for a given model, so
// correctness does not need expiry — but the model can change under us (an OpenAI key arriving mid-
// session flips the provider), and a vector produced by a different model is not comparable to the
// stored ones. 60s is far longer than a turn and far shorter than a provider switch anyone would
// notice, so it collapses the duplicates without ever mixing vector spaces.
//
// THE MEMO ALONE IS NOT ENOUGH, and this is the interesting half. Once the preamble stages were made
// to run CONCURRENTLY (main.js agentLoop), the three callers stopped taking turns: they all start at
// t=0, all miss the cache in the same tick, and all issue their own request. A cache only helps
// callers that are separated in time, and the whole point of the other optimisation was to stop
// separating them in time. So the two changes silently cancelled — measured, not guessed: semantic
// recall stayed at 430ms while a warm standalone embed is 45ms.
//
// The fix is single-flight: register the in-flight PROMISE under the text, so the second and third
// callers await the first caller's request instead of starting their own. Cache for callers apart in
// time, coalescing for callers together in it.
const _memo = new Map();                 // text → { vec, model, at }
const _inflight = new Map();             // text → Promise<vec|null>, only while a request is open
const MEMO_TTL_MS = 60000;
const MEMO_MAX = 64;
function memoGet(text, model) {
  const hit = _memo.get(text);
  if (!hit || hit.model !== model || Date.now() - hit.at > MEMO_TTL_MS) return null;
  return hit.vec;
}
function memoPut(text, model, vec) {
  if (!vec) return;
  if (_memo.size >= MEMO_MAX) _memo.delete(_memo.keys().next().value);   // insertion-ordered → oldest
  _memo.set(text, { vec, model, at: Date.now() });
}
// Counts requests that actually reached a provider. Exported for tests: "did this cost a round
// trip?" is the only question that matters here, and timing is a flaky way to ask it.
let _providerCalls = 0;
/** Exposed so a test can prove a repeat is served without touching the provider. */
function _memoStats() { return { size: _memo.size, inflight: _inflight.size, providerCalls: _providerCalls }; }
function _memoClear() { _memo.clear(); _inflight.clear(); _providerCalls = 0; }

/**
 * Cache + coalesce in front of the provider. Three outcomes per text:
 *   already known   → served from the memo, no request
 *   already asked   → awaits the open request, no second request
 *   genuinely new   → one request, and every concurrent asker for the same text joins it
 */
async function embedBatch(texts) {
  const key = readKey();
  const inputs = texts.map((t) => String(t || '').slice(0, MAX_INPUT_CHARS));
  const provider = key ? EMBED_MODEL : OLLAMA_EMBED_MODEL;

  const vecs = inputs.map((t) => memoGet(t, provider));
  const joinIdx = [], freshIdx = [];
  for (let i = 0; i < inputs.length; i++) {
    if (vecs[i]) continue;
    (_inflight.has(inputs[i]) ? joinIdx : freshIdx).push(i);
  }
  if (!joinIdx.length && !freshIdx.length) return { vecs, model: provider, cached: true };

  // One request for the genuinely new texts, registered per-text so a concurrent caller can join it.
  let freshP = null;
  if (freshIdx.length) {
    freshP = embedUncached(inputs.filter((_, i) => freshIdx.includes(i)), key, provider);
    freshIdx.forEach((i, j) => {
      const p = freshP.then((r) => ((r && r.vecs) || [])[j] || null, () => null)
        .finally(() => { if (_inflight.get(inputs[i]) === p) _inflight.delete(inputs[i]); });
      _inflight.set(inputs[i], p);
    });
  }
  // Await the joiners and our own request together — a joiner may be waiting on a request that has
  // been open longer than ours, so serialising them would make the coalescing slower than not doing it.
  const joined = await Promise.all(joinIdx.map((i) => _inflight.get(inputs[i]) || Promise.resolve(null)));
  joinIdx.forEach((i, j) => { vecs[i] = joined[j]; });
  const fresh = freshP ? await freshP : null;
  if (fresh && Array.isArray(fresh.vecs)) freshIdx.forEach((i, j) => { vecs[i] = fresh.vecs[j] || null; });

  if (fresh && fresh.error && !vecs.some(Boolean)) return { ...fresh, vecs };
  return { vecs, model: (fresh && fresh.model) || provider, ...(fresh && fresh.fellBackFrom ? { fellBackFrom: fresh.fellBackFrom } : {}) };
}

/** The provider call itself. Everything above this line is caching; everything below is the network. */
async function embedUncached(inputs, key, provider) {
  _providerCalls++;
  // Store under the model that ACTUALLY produced the vector, not the one we expected — a 401
  // fallback silently switches provider, and filing an Ollama vector under the OpenAI tag would
  // hand a later caller a vector from the wrong space, which no amount of cosine can detect.
  const remember = (res) => {
    const tag = (res && res.model) || provider;
    if (res && Array.isArray(res.vecs)) for (let i = 0; i < inputs.length; i++) memoPut(inputs[i], tag, res.vecs[i]);
    return res;
  };
  const texts = inputs;
  // No key at all → straight to local rather than silently skipping (the old behaviour, which is
  // how a rotated key turned the entire knowledge graph into a no-op without a single log line).
  if (!key) return remember(await embedBatchLocal(inputs));
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
      // A DEAD KEY MUST NOT KILL THE SECOND BRAIN. 401/403 means the key is wrong or revoked and no
      // amount of retrying fixes it — fall through to the local embedder so the graph keeps growing.
      // (This is exactly the failure that froze the graph: a rotated key, a silent skip, no log.)
      if (r.status === 401 || r.status === 403 || r.status === 429) {
        const local = await embedBatchLocal(inputs);
        if (local.vecs && local.vecs.some(Boolean)) return remember({ ...local, fellBackFrom: `openai ${r.status}` });
      }
      return { error: `openai ${r.status} ${detail}`, vecs: texts.map(() => null) };
    }
    const j = await r.json();
    const data = Array.isArray(j.data) ? j.data : [];
    // OpenAI preserves input order via .index; map defensively.
    const vecs = inputs.map(() => null);
    for (const d of data) {
      if (typeof d.index === 'number' && Array.isArray(d.embedding)) vecs[d.index] = normalize(d.embedding);
    }
    return remember({ vecs, model: EMBED_MODEL });
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
  if (!(await embedderReady())) return { skipped: true, added: 0, updated: 0, total: 0 };
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
  embedderReady,
  upsert,
  search,
  recent,
  stats,
  maintain,
  backfill,
  // exposed for tooling/tests + the tool-retrieval layer (lib/toolselect.js):
  embedBatch, embedBatchLocal, OLLAMA_EMBED_MODEL, EMBED_MODEL,
  _memoStats, _memoClear,
  embedOne,
  cosine,
  STORE_PATH,
};
