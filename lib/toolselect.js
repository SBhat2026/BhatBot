'use strict';
// Two-stage tool retrieval (context-rot prevention, W1). At ~50 tools, injecting every schema on
// every Claude turn burns input tokens before the task is read and dilutes tool selection. Instead:
//   1. embed each tool's (name + description) ONCE, cache the vectors keyed by a hash of the catalog,
//   2. per user turn, cosine-rank the catalog against the turn text and inject only the top-k
//      (UNION a small always-present CORE set) — the rest stay off the wire.
//
// Reuses lib/semantic.js's embedding layer (same OpenAI text-embedding-3-small, same graceful
// degradation). ZERO npm deps. Every function no-ops safely when no OpenAI key is present:
// select() returns null, which the caller treats as "use the full catalog" — so behaviour is
// identical to today for users without an embedding key, and the agent is never stranded.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const semantic = require('./semantic');

const CACHE_PATH = path.join(os.homedir(), '.bhatbot', 'toolvecs.json');

// Tools that must ALWAYS be available regardless of relevance score — the agent's escape hatches and
// the highest-frequency primitives. Keeps a niche turn from being stranded without a way to act,
// remember, or surface a result. Only those that actually exist in the catalog are added.
// mission_plan is CORE deliberately: it's the durable-plan escape hatch for long runs, and retrieval
// must never drop it — a task big enough to need a plan is exactly the kind whose opening turns don't
// say the word "plan", so it would never score into the top-k on its own.
const CORE = ['save_memory', 'read_file', 'write_file', 'run_shell', 'notify_user', 'ask_options', 'show_visuals', 'build_project', 'ask_ai', 'request_permissions', 'self_reflect', 'mission_plan'];

// Below this many tools, retrieval isn't worth it — just use them all.
const MIN_CATALOG = 16;

function catalogHash(tools) {
  const sig = tools.map((t) => `${t.name}:${String(t.description || '').length}`).join('|');
  return crypto.createHash('sha1').update(sig).digest('hex');
}
/** Per-tool signature, so ONE edited description does not invalidate all 85 vectors. */
function toolSig(t) { return crypto.createHash('sha1').update(toolText(t)).digest('hex').slice(0, 16); }
function toolText(t) { return `${t.name}: ${String(t.description || '').slice(0, 600)}`; }

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return null; } }
function saveCache(obj) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CACHE_PATH);
  } catch {}
}

// Ensure every tool has a cached, L2-normalized vector. Re-embeds only when the catalog signature
// changes (a tool added/removed or a description edited). Returns { vecs:{name:[...]}} or null.
/**
 * ⚠ LOAD-BEARING — the cache is keyed on the EMBEDDER as well as the catalog, and re-embeds only
 * what actually changed.
 *
 * Two separate bugs lived in the old version of this function:
 *
 *  1. THE MODEL WAS NEVER PART OF THE KEY, and the `model` field was hardcoded to
 *     'text-embedding-3-small' regardless of which embedder actually ran. On this machine the
 *     OpenAI key is dead and the real embedder is Ollama nomic-embed-text — so a 768-d cache was
 *     filed under the 1536-d model's name. If the embedder ever switches back, every cosine is
 *     computed between vectors of different lengths, `semantic.cosine` returns 0 for all of them,
 *     no tool clears minScore, select() returns null, and the FULL catalog silently goes on the
 *     wire every turn. That is the same ~25K-tokens-per-turn regression as 5bee725, arriving
 *     through a different door: not a dead gate, a stale cross-model cache.
 *
 *  2. THE WHOLE CATALOG RE-EMBEDDED ON ANY CHANGE. The validity test was one hash over every
 *     description plus `length === tools.length`, so connectors coming online (85 → 90 tools) or a
 *     single edited description threw away all 85 vectors and re-embedded from scratch — ~1.6s on
 *     the first turn's critical path, repeatedly, because the count flaps with connection state.
 *     Vectors are now kept per tool and keyed by that tool's own signature.
 */
async function embedCatalog(tools) {
  if (!(await semantic.embedderReady())) return null;
  const cache = loadCache();
  // Ask the embedder what it IS rather than assuming. One cached probe, not a per-call cost.
  const probe = await semantic.embedBatch(['embedder probe']);
  const model = (probe && probe.model) || 'unknown';
  const dim = (probe && probe.vecs && probe.vecs[0] && probe.vecs[0].length) || 0;

  const usable = cache && cache.model === model && cache.dim === dim && cache.vecs && cache.sigs ? cache : null;
  const vecs = usable ? { ...usable.vecs } : {};
  const sigs = usable ? { ...usable.sigs } : {};
  if (cache && !usable) {
    try { console.log(`[toolselect] tool vectors were built by ${cache.model || 'an unknown model'} (${cache.dim || '?'}d), now embedding with ${model} (${dim}d) — re-embedding`); } catch {}
  }

  // Only tools whose own text changed (or that we have never seen) need a vector.
  const stale = tools.filter((t) => sigs[t.name] !== toolSig(t) || !vecs[t.name]);
  // Drop vectors for tools that have left the catalog, so the file cannot grow forever.
  const live = new Set(tools.map((t) => t.name));
  for (const n of Object.keys(vecs)) if (!live.has(n)) { delete vecs[n]; delete sigs[n]; }

  if (stale.length) {
    const { vecs: fresh, error } = await semantic.embedBatch(stale.map(toolText));
    if (error) return usable || (cache && cache.vecs ? cache : null);   // keep a usable cache over nothing
    for (let i = 0; i < stale.length; i++) {
      if (fresh[i]) { vecs[stale[i].name] = fresh[i]; sigs[stale[i].name] = toolSig(stale[i]); }
    }
  }
  if (!Object.keys(vecs).length) return null;
  const out = { hash: catalogHash(tools), model, dim, vecs, sigs, ts: Date.now() };
  if (stale.length) saveCache(out);
  return out;
}

/**
 * select(queryText, tools, {k=12, minScore=0.18}) → { tools:[...], names:[...], scores:{} } | null
 *   Returns the relevant tool SUBSET (top-k by cosine + CORE), preserving catalog order. Returns
 *   null — meaning "fall back to the full catalog" — when: no embedding key, catalog too small,
 *   embedding/query failed, or no tool clears minScore (low confidence → don't guess, send all).
 */
async function select(queryText, tools, { k = 12, minScore = 0.18 } = {}) {
  const q = String(queryText || '').trim();
  if (!q || !Array.isArray(tools) || tools.length < MIN_CATALOG) return null;
  // embedderReady, NOT isReady: isReady() gates on an OpenAI key alone, so on a machine using the
  // local Ollama embedder this returned null on every turn and retrieval was silently off — the
  // whole catalog went on the wire every request. See the note in lib/semantic.js.
  if (!(await semantic.embedderReady())) return null;
  const cat = await embedCatalog(tools);
  if (!cat || !cat.vecs) return null;
  const { vecs: qv } = await semantic.embedBatch([q]);
  const qvec = qv && qv[0];
  if (!qvec) return null;

  // ⚠ LOAD-BEARING — failsafe for the whole bug class above. If the query and the catalog were embedded by
  // different models, every cosine is between mismatched lengths, semantic.cosine returns 0, nothing
  // clears minScore, and select() returns null — which the caller reads as "low confidence, send the
  // full catalog". Retrieval is then OFF and nothing anywhere says so; the only symptom is ~25K
  // extra tokens on every single turn. Silent degradation of exactly this shape has now shipped
  // twice, so it gets an explicit check and a log line rather than a graceful zero.
  if (cat.dim && qvec.length !== cat.dim) {
    try { console.warn(`[toolselect] query is ${qvec.length}-d but the tool vectors are ${cat.dim}-d — retrieval disabled this turn (full catalog on the wire). The cache should have been rebuilt; this is a bug, not a config.`); } catch {}
    return null;
  }

  const scores = {};
  const ranked = [];
  for (const t of tools) {
    const v = cat.vecs[t.name];
    if (!v) continue;
    const s = semantic.cosine(qvec, v);
    scores[t.name] = +s.toFixed(4);
    ranked.push([t.name, s]);
  }
  ranked.sort((a, b) => b[1] - a[1]);
  const top = ranked.filter(([, s]) => s >= minScore).slice(0, k).map(([n]) => n);
  if (!top.length) return null;   // low confidence across the board → caller uses full catalog

  const keep = new Set(top);
  for (const n of CORE) if (cat.vecs[n] || tools.some((t) => t.name === n)) keep.add(n);
  // Never silently drop a tool we couldn't rank: a newly-added tool whose vector isn't in the cache
  // yet (re-embed pending/failed) has no score, so it'd otherwise vanish from every turn. Treat
  // un-vectored catalog tools as always-present until the cache catches up.
  for (const t of tools) if (!cat.vecs[t.name]) keep.add(t.name);
  const subset = tools.filter((t) => keep.has(t.name));   // preserve original catalog order
  if (subset.length >= tools.length) return null;          // selected ~everything → no point
  return { tools: subset, names: subset.map((t) => t.name), scores };
}

module.exports = { select, embedCatalog, CACHE_PATH, CORE };
