'use strict';
// ── SCHOLARLY adapters (FORGE / Phase 6 research depth) ───────────────────────────────────────────
// Normalized access to arXiv (keyless), Semantic Scholar (key optional), and a normalized record
// shape so the research role + triangulation pattern can reason over papers uniformly and ingest
// abstracts/PDFs into lib/semantic.js.
//
// DECISION — hand-rolled arXiv Atom parse (no xml2js dep): the arXiv feed is small + regular, and the
// codebase already parses feeds this way (lib/news.js RSS). Network fetch is isolated behind functions
// so tests use RECORDED fixtures (parseArxivAtom is pure) — no live network in the suite.
//
// normalized record: { source, id, title, authors:[], year, abstract, pdfUrl, url, citations? }

// Pure: parse an arXiv Atom XML string → normalized records. Robust to missing fields.
function parseArxivAtom(xml) {
  const entries = String(xml || '').split(/<entry>/).slice(1).map((e) => e.split(/<\/entry>/)[0]);
  const pick = (s, tag) => { const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : ''; };
  return entries.map((e) => {
    const idUrl = pick(e, 'id');
    const arxivId = (idUrl.match(/abs\/([^v\s]+)/) || [])[1] || idUrl.split('/').pop() || '';
    const authors = (e.match(/<name>([\s\S]*?)<\/name>/g) || []).map((m) => m.replace(/<\/?name>/g, '').trim());
    const published = pick(e, 'published');
    const pdf = (e.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/) || [])[1] || (idUrl ? idUrl.replace('/abs/', '/pdf/') : '');
    return {
      source: 'arxiv', id: arxivId, title: pick(e, 'title'),
      authors, year: published ? Number(published.slice(0, 4)) : null,
      abstract: pick(e, 'summary'), pdfUrl: pdf, url: idUrl,
    };
  }).filter((r) => r.title);
}

// Live arXiv search. deps.fetch defaults to global fetch (Node 18+); injectable for tests.
async function arxiv(query, { max = 8, fetch: fetchFn } = {}) {
  const f = fetchFn || globalThis.fetch;
  if (!f) return { error: 'no fetch available', results: [] };
  const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent('all:' + query)}&start=0&max_results=${Math.min(max, 25)}`;
  try {
    const r = await f(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { error: `arxiv ${r.status}`, results: [] };
    return { results: parseArxivAtom(await r.text()) };
  } catch (e) { return { error: 'arxiv fetch failed: ' + e.message, results: [] };
  }
}

// Semantic Scholar (key optional; keyless tier is rate-limited). Normalized to the same shape.
async function semanticScholar(query, { max = 8, key, fetch: fetchFn } = {}) {
  const f = fetchFn || globalThis.fetch;
  if (!f) return { error: 'no fetch available', results: [] };
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${Math.min(max, 25)}&fields=title,authors,year,abstract,openAccessPdf,url,citationCount`;
  try {
    const r = await f(url, { headers: key ? { 'x-api-key': key } : {}, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { error: `semanticscholar ${r.status}${r.status === 429 ? ' (rate-limited; a key raises limits)' : ''}`, results: [] };
    const j = await r.json();
    return { results: (j.data || []).map((p) => ({ source: 'semanticscholar', id: p.paperId, title: p.title, authors: (p.authors || []).map((a) => a.name), year: p.year, abstract: p.abstract || '', pdfUrl: (p.openAccessPdf || {}).url || '', url: p.url, citations: p.citationCount })) };
  } catch (e) { return { error: 'semanticscholar fetch failed: ' + e.message, results: [] }; }
}

// Merge + dedupe by normalized title (triangulation: same paper from two sources → one record).
function mergeDedupe(...lists) {
  const seen = new Map();
  for (const list of lists) for (const r of (list || [])) {
    const key = (r.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, r);
    else { const ex = seen.get(key); if ((r.citations || 0) > (ex.citations || 0)) seen.set(key, { ...ex, ...r }); if (!ex.pdfUrl && r.pdfUrl) ex.pdfUrl = r.pdfUrl; }
  }
  return [...seen.values()];
}

module.exports = { parseArxivAtom, arxiv, semanticScholar, mergeDedupe };
