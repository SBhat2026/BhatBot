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
const CORE = ['save_memory', 'read_file', 'write_file', 'run_shell', 'notify_user', 'ask_options', 'build_project', 'ask_ai', 'request_permissions', 'self_reflect'];

// Below this many tools, retrieval isn't worth it — just use them all.
const MIN_CATALOG = 16;

function catalogHash(tools) {
  const sig = tools.map((t) => `${t.name}:${String(t.description || '').length}`).join('|');
  return crypto.createHash('sha1').update(sig).digest('hex');
}
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
async function embedCatalog(tools) {
  if (!semantic.isReady()) return null;
  const hash = catalogHash(tools);
  const cache = loadCache();
  if (cache && cache.hash === hash && cache.vecs && Object.keys(cache.vecs).length === tools.length) return cache;
  const { vecs, error } = await semantic.embedBatch(tools.map(toolText));
  if (error) return cache && cache.vecs ? cache : null;   // keep stale cache over nothing
  const out = {};
  for (let i = 0; i < tools.length; i++) if (vecs[i]) out[tools[i].name] = vecs[i];
  if (!Object.keys(out).length) return null;
  const fresh = { hash, model: 'text-embedding-3-small', vecs: out, ts: Date.now() };
  saveCache(fresh);
  return fresh;
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
  if (!semantic.isReady()) return null;
  const cat = await embedCatalog(tools);
  if (!cat || !cat.vecs) return null;
  const { vecs: qv } = await semantic.embedBatch([q]);
  const qvec = qv && qv[0];
  if (!qvec) return null;

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
