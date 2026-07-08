'use strict';
// Real-photo image search with NO API key — for the visual canvas + visual option cards ("find
// pictures of the Colosseum independently"). Openverse (broad CC-licensed catalog) is primary;
// Wikimedia Commons (excellent for landmarks/places/people) is the fallback. Returns a normalized
// [{ url, thumb, title, source, by }]. `fetch` is injectable so it's unit-testable offline.

const DEFAULT_LIMIT = 6;

async function openverse(q, limit, fetchFn) {
  const u = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${limit}&mature=false`;
  const r = await fetchFn(u, { headers: { 'User-Agent': 'BhatBot/1.0 (personal assistant)' } });
  if (!r.ok) throw new Error('openverse ' + r.status);
  const j = await r.json();
  return (j.results || []).map((x) => ({
    url: x.url, thumb: x.thumbnail || x.url, title: x.title || q, source: x.source || 'openverse', by: x.creator || '',
  })).filter((x) => x.url);
}

async function wikimedia(q, limit, fetchFn) {
  const u = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=${limit}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1000&format=json&origin=*`;
  const r = await fetchFn(u);
  if (!r.ok) throw new Error('wikimedia ' + r.status);
  const j = await r.json();
  const pages = (j.query && j.query.pages) || {};
  return Object.values(pages).map((p) => {
    const ii = (p.imageinfo || [])[0] || {};
    return { url: ii.url, thumb: ii.thumburl || ii.url, title: (p.title || q).replace(/^File:/, ''), source: 'wikimedia', by: '' };
  }).filter((x) => x.url && /\.(jpe?g|png|gif|webp)$/i.test(x.url));
}

// search(query, {limit, fetch}) → normalized results (best-effort; [] on total failure).
async function search(query, opts = {}) {
  const limit = Math.max(1, Math.min(opts.limit || DEFAULT_LIMIT, 20));
  const fetchFn = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const q = String(query || '').trim();
  if (!fetchFn || !q) return [];
  for (const eng of [openverse, wikimedia]) {
    try {
      const out = await eng(q, limit, fetchFn);
      if (out && out.length) return out.slice(0, limit);
    } catch { /* try the next engine */ }
  }
  return [];
}

module.exports = { search, openverse, wikimedia };
