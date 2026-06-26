'use strict';
// web_search — first-class search tool (Phase 2, Deliverable #3).
// Takes a query, returns ranked results (title, url, snippet) directly into the tool loop without
// the agent already knowing a URL. Read-only + stateless → PARALLEL_SAFE.
//
// Provider precedence (cheapest-that-works, keyless by default):
//   1. Brave Search API   (config.braveKey)    — best quality, ~$ per 1k, recorded to the ledger
//   2. Serper.dev (Google)(config.serperKey)   — recorded to the ledger
//   3. Tavily             (config.tavilyKey)   — recorded to the ledger
//   4. DuckDuckGo HTML    (no key)             — FREE ($0); the default in this environment
//
// Returns { ok, provider, usd, items:[{title,url,snippet}] }. usd is folded into the cost ledger
// by the caller via recordToolCost (only the keyed providers cost anything; DDG is $0).

const TIMEOUT_MS = 12000;

// per-call USD estimate for the paid providers (folded into ~/.bhatbot/costs.json by the caller).
const PROVIDER_USD = { brave: 0.005, serper: 0.001, tavily: 0.008, duckduckgo: 0 };

function decodeEntities(s = '') {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n); } catch { return _; } });
}
function stripTags(s = '') { return decodeEntities(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(); }

async function jget(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, text, json };
  } finally { clearTimeout(t); }
}

// --- Brave Search API ---
async function brave(query, limit, key) {
  const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const r = await jget(u, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': key } });
  if (!r.ok || !r.json) throw new Error('brave ' + r.status + ' ' + String(r.text).slice(0, 80));
  const items = ((r.json.web && r.json.web.results) || []).slice(0, limit)
    .map((x) => ({ title: stripTags(x.title || ''), url: x.url || '', snippet: stripTags(x.description || '') }));
  return items;
}

// --- Serper.dev (Google) ---
async function serper(query, limit, key) {
  const r = await jget('https://google.serper.dev/search', {
    method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!r.ok || !r.json) throw new Error('serper ' + r.status);
  const items = (r.json.organic || []).slice(0, limit)
    .map((x) => ({ title: stripTags(x.title || ''), url: x.link || '', snippet: stripTags(x.snippet || '') }));
  return items;
}

// --- Tavily ---
async function tavily(query, limit, key) {
  const r = await jget('https://api.tavily.com/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: 'basic' }),
  });
  if (!r.ok || !r.json) throw new Error('tavily ' + r.status);
  const items = (r.json.results || []).slice(0, limit)
    .map((x) => ({ title: stripTags(x.title || ''), url: x.url || '', snippet: stripTags(x.content || '') }));
  return items;
}

// --- DuckDuckGo HTML (keyless, free) ---
function unwrapDdg(href = '') {
  // DDG wraps target URLs as //duckduckgo.com/l/?uddg=<encoded>&...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return href; } }
  return href.startsWith('//') ? 'https:' + href : href;
}
async function duckduckgo(query, limit) {
  const r = await jget('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
  });
  if (!r.ok) throw new Error('duckduckgo ' + r.status);
  const html = r.text;
  const items = [];
  // Each result: <a ... class="result__a" href="URL">TITLE</a> ... <a class="result__snippet">SNIPPET</a>
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = []; let sm;
  while ((sm = snipRe.exec(html))) snippets.push(stripTags(sm[1]));
  let lm, i = 0;
  while ((lm = linkRe.exec(html)) && items.length < limit) {
    const url = unwrapDdg(lm[1]);
    const title = stripTags(lm[2]);
    if (!url || !title) { i++; continue; }
    items.push({ title, url, snippet: snippets[i] || '' });
    i++;
  }
  return items;
}

// Main entry. Deterministic for the same query on a given provider (no randomness).
async function search({ query, limit = 6, config = {} } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'empty query' };
  limit = Math.max(1, Math.min(Number(limit) || 6, 12));

  const chain = [];
  if (config.braveKey) chain.push(['brave', () => brave(q, limit, config.braveKey)]);
  if (config.serperKey) chain.push(['serper', () => serper(q, limit, config.serperKey)]);
  if (config.tavilyKey) chain.push(['tavily', () => tavily(q, limit, config.tavilyKey)]);
  chain.push(['duckduckgo', () => duckduckgo(q, limit)]);   // always-available keyless fallback

  let lastErr = '';
  for (const [provider, fn] of chain) {
    try {
      const items = await fn();
      if (items && items.length) return { ok: true, provider, usd: PROVIDER_USD[provider] || 0, items };
      lastErr = provider + ' returned 0 results';
    } catch (e) { lastErr = provider + ': ' + e.message; }
  }
  return { ok: false, error: 'all search providers failed (' + lastErr + ')', items: [] };
}

// Compact numbered list for the model: "1. TITLE — snippet  <url>"
function format(res) {
  if (!res || !res.ok) return 'No results (' + ((res && res.error) || 'unknown') + ').';
  return res.items.map((it, i) => `${i + 1}. ${it.title}${it.snippet ? ' — ' + it.snippet : ''}\n   ${it.url}`).join('\n');
}

module.exports = { search, format, PROVIDER_USD };
