'use strict';
// SHARED READ-CACHE — a small, process-global, TTL'd cache for the RESULTS of side-effect-free
// read tools (read_file, fetch_url, web_search, find_papers, molecule, maps, predict_function,
// math_reason, list_directory…). Two wins, one mechanism:
//   • FLEET DEDUP: when several suits in a fan-out read the SAME file/url within seconds, only the
//     first pays — the rest hit the cache. (The cache is process-global, so every agent shares it.)
//   • SPECULATIVE PREFETCH: procedural memory can `prefetch()` the obvious first read of a recurring
//     task WHILE the model call is still in flight; when the model then asks for it, it's already warm.
// Deliberately conservative: SHORT ttl (default 45s) so content can't go stale, NEVER caches secrets
// (keychain/1Password/TOTP are excluded by the caller), and any WRITE to a path invalidates matching
// read_file/list_directory entries so a read-after-write in the same batch never sees stale bytes.
// Pure/standalone (no deps); main.js owns the enable flag + the cacheable-tool allowlist.

const DEFAULT_TTL = 45 * 1000;
const MAX_ENTRIES = 400;

// name+input → a stable string key. Sorts object keys so {a,b} and {b,a} collide. CRED_REF handles
// should already be stripped by the caller (we never cache credential tools anyway).
function keyOf(name, input) {
  let body;
  try { body = stableStringify(input == null ? {} : input); } catch { body = String(input); }
  return name + '|' + body;
}
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function createReadCache(opts = {}) {
  const ttl = opts.ttlMs || DEFAULT_TTL;
  const now = opts.now || (() => Date.now());
  const store = new Map();   // key → { value | promise, expires, pending }
  let hits = 0, misses = 0, prefetches = 0, dedups = 0;

  const fresh = (e) => e && e.expires > now();
  function evictIfNeeded() {
    if (store.size <= MAX_ENTRIES) return;
    // drop the oldest-expiring entries first
    const sorted = [...store.entries()].sort((a, b) => a[1].expires - b[1].expires);
    for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) store.delete(sorted[i][0]);
  }

  // Synchronous peek: a settled, fresh value (not a still-in-flight prefetch). Returns undefined on miss.
  function get(name, input) {
    const e = store.get(keyOf(name, input));
    if (fresh(e) && e.settled) { hits++; return e.value; }
    if (!fresh(e)) misses++;
    return undefined;
  }
  // Await a value, whether it's settled or a prefetch still in flight. undefined ⇒ genuine miss.
  async function getAsync(name, input) {
    const e = store.get(keyOf(name, input));
    if (!fresh(e)) { misses++; return undefined; }
    if (e.settled) { hits++; return e.value; }
    if (e.promise) { dedups++; try { return await e.promise; } catch { return undefined; } }
    return undefined;
  }
  function set(name, input, value) {
    store.set(keyOf(name, input), { value, settled: true, expires: now() + ttl });
    evictIfNeeded();
    return value;
  }
  // Kick off `run()` for a read now and remember the in-flight promise so a concurrent/near-future
  // caller (getAsync) rides the SAME request instead of issuing a second one. Fire-and-forget safe.
  function prefetch(name, input, run) {
    const k = keyOf(name, input);
    const e = store.get(k);
    if (fresh(e)) return;            // already warm or in flight — nothing to do
    prefetches++;
    const p = Promise.resolve().then(run);
    store.set(k, { promise: p, settled: false, expires: now() + ttl });
    p.then((v) => { store.set(k, { value: v, settled: true, expires: now() + ttl }); },
           () => { store.delete(k); });   // a failed prefetch caches nothing
    evictIfNeeded();
  }
  // A write to `filePath` makes any cached read of that path (or a directory listing of its folder)
  // stale — drop them so a read-after-write in the same batch always re-reads.
  function invalidatePath(filePath) {
    if (!filePath) return;
    const p = String(filePath);
    for (const k of store.keys()) {
      if ((k.startsWith('read_file|') || k.startsWith('list_directory|')) && k.includes(p)) store.delete(k);
    }
  }
  function clear() { store.clear(); }
  function stats() { return { size: store.size, hits, misses, prefetches, dedups }; }

  return { get, getAsync, set, prefetch, invalidatePath, clear, stats, keyOf };
}

module.exports = { createReadCache, keyOf };
