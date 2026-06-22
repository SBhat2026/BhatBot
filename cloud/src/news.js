'use strict';
// NYT news skim — headlines + abstracts for a quick daily read. Uses the PUBLIC NYT RSS feeds
// (no API key, no login needed) by default, so the morning "skim" is robust. If a NYT developer
// key is configured (config.nytApiKey / env NYT_API_KEY), the richer Top Stories API is used.
// Returns a compact list (title + abstract + url) so it costs few tokens to feed to the model.
// Deeper full-article reading (paywalled) can be done later via the logged-in browser session.

const SECTIONS = {
  world: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  us: 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml',
  politics: 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',
  business: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
  technology: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
  science: 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml',
  home: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
};

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseRss(xml, limit) {
  const items = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const block = m[0];
    const tag = (t) => { const x = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i').exec(block); return x ? decode(x[1]) : ''; };
    const title = tag('title');
    if (!title) continue;
    items.push({ title, abstract: tag('description'), url: tag('link'), date: tag('pubDate') });
  }
  return items;
}

// NYT Top Stories API (needs a free developer key) — richer abstracts. Optional.
async function viaApi(section, key, limit) {
  const sec = section === 'home' ? 'home' : section;
  const r = await fetch(`https://api.nytimes.com/svc/topstories/v2/${sec}.json?api-key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('NYT API ' + r.status);
  const j = await r.json();
  return (j.results || []).slice(0, limit).map((a) => ({ title: a.title, abstract: a.abstract, url: a.url, date: a.published_date }));
}

// Fetch a section skim. opts: { section, limit, apiKey }. Returns { success, section, items } or { error }.
async function skim({ section = 'world', limit = 6, apiKey = '' } = {}) {
  const sec = SECTIONS[section] ? section : 'world';
  try {
    let items;
    if (apiKey) { try { items = await viaApi(sec, apiKey, limit); } catch { /* fall back to RSS */ } }
    if (!items) {
      const r = await fetch(SECTIONS[sec], { headers: { 'user-agent': 'BhatBot/1.0' }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) return { error: `NYT RSS ${r.status}` };
      items = parseRss(await r.text(), limit);
    }
    if (!items.length) return { error: 'no headlines parsed' };
    return { success: true, section: sec, items };
  } catch (e) { return { error: e.message || String(e) }; }
}

// One-line-per-story compact text for a spoken/printed skim (cheap to feed to the model).
function format(res) {
  if (!res || res.error) return `Couldn't fetch NYT (${res && res.error || 'unknown'}).`;
  return `NYT ${res.section} — top ${res.items.length}:\n` +
    res.items.map((a, i) => `${i + 1}. ${a.title}${a.abstract ? ' — ' + a.abstract : ''}`).join('\n');
}

module.exports = { skim, format, SECTIONS };
