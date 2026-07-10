'use strict';
// NIH BioArt integration — search + fetch the NIAID "BioArt Source" library of professional,
// PUBLIC-DOMAIN scientific/medical illustrations (2000+, formats PNG/SVG/EPS/AI). Gives BhatBot a
// library of real, high-quality figures to compose from instead of AI-generating every illustration.
//
// The site is a Next.js SPA with no documented API. Two facts discovered from its live traffic:
//   • Images are a stable REST path:  GET /api/bioarts/{id}/files/{fileId}   (no auth, public domain)
//   • Search is a Next.js Server Action (POST /discover?searchTerm=… with a `next-action` id + an RSC
//     "text/x-component" response). The action id is deploy-versioned, so it lives in a config-
//     overridable constant and search degrades with a CLEAR message if the site redeploys and rotates it.
// The RSC parser is PURE (parseSearchRSC) so it unit-tests without network.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'https://bioart.niaid.nih.gov';
const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const CACHE_DIR = path.join(os.homedir(), '.bhatbot', 'bioart');
// Default search Server-Action id (observed live 2026-07). Override via config.bioart.searchAction
// if BioArt redeploys and search starts returning zero results.
const DEFAULT_SEARCH_ACTION = '402d27d1b06fb56c06f3c7e81f64d55e22a6390363';

function cfg() { try { return (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).bioart) || {}; } catch { return {}; } }
function searchAction() { return cfg().searchAction || DEFAULT_SEARCH_ACTION; }

// ---- HTML-entity + tag cleanup (RSC content is entity-encoded) -----------
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch { return ' '; } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Parse the format→fileIds map: "All:1,2,3|EPS:1,3|PNG:2|SVG:...|AI:...".
function parseFilesInfo(raw) {
  const out = {};
  for (const group of String(raw || '').split('|')) {
    const [fmt, ids] = group.split(':');
    if (fmt && ids) out[fmt.trim().toUpperCase()] = ids.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return out;
}

// PURE: turn the RSC ("text/x-component") search response into structured records. Fields come as
// Solr-style `"key":["value"]`; records are delimited by their "id" field. No I/O — testable.
function parseSearchRSC(text) {
  const s = String(text || '');
  const results = [];
  // Each record: capture id, then the nearest following title/thumbnail/content/filesinfo/license.
  const idRe = /"id":\["(\d+)"\]/g;
  let m;
  const idxs = [];
  while ((m = idRe.exec(s))) idxs.push({ id: m[1], at: m.index });
  for (let i = 0; i < idxs.length; i++) {
    const start = idxs[i].at;
    const end = i + 1 < idxs.length ? idxs[i + 1].at : Math.min(s.length, start + 4000);
    const chunk = s.slice(start, end);
    const field = (k) => { const mm = chunk.match(new RegExp('"' + k + '":\\["([\\s\\S]*?)"\\]')); return mm ? mm[1] : ''; };
    const title = decodeEntities(field('title'));
    if (!title) continue;                                   // facet/aggregate rows have no title → skip
    const thumb = field('thumbnail');                       // e.g. /bioarts/700/files/784255
    const filesinfo = parseFilesInfo(decodeEntities(field('filesinfo')));
    const contentRaw = decodeEntities(field('content'));
    results.push({
      id: idxs[i].id,
      title,
      description: stripTags(contentRaw).slice(0, 300),
      thumbnail: thumb ? BASE + '/api' + thumb.replace(/^\/api/, '') : null,
      formats: Object.keys(filesinfo).filter((f) => f !== 'ALL'),
      filesinfo,
      license: decodeEntities(field('license')) || 'Public Domain',
      detail: BASE + '/bioart/' + idxs[i].id,
    });
  }
  return results;
}

// Remember each search result's filesinfo by id so a later `get` can resolve format→fileId from just
// the id (no need to round-trip the whole record back through the model). Bounded LRU-ish.
const _recordCache = new Map();
function rememberRecords(results) {
  for (const r of results || []) { _recordCache.set(String(r.id), r.filesinfo); if (_recordCache.size > 400) _recordCache.delete(_recordCache.keys().next().value); }
}

// ---- network -------------------------------------------------------------
async function search(term, { limit = 12, sort = 'score desc' } = {}) {
  if (!term) return { success: false, error: 'search needs a term.' };
  try {
    const url = `${BASE}/discover?searchTerm=${encodeURIComponent(term)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'next-action': searchAction(),
        'content-type': 'text/plain;charset=UTF-8',
        'accept': 'text/x-component',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      },
      body: JSON.stringify([`type:bioart?start=0&size=${Math.min(limit, 50)}&sort=${sort}`]),
    });
    const text = await res.text();
    const all = parseSearchRSC(text);
    if (!all.length) return { success: false, error: 'BioArt returned no parseable results — the site may have redeployed and rotated its search action id. Update config.bioart.searchAction (see lib/bioart.js).' };
    const results = all.slice(0, limit);
    rememberRecords(results);
    return { success: true, count: results.length, query: term, results };
  } catch (e) { return { success: false, error: e.message }; }
}

// Fetch a specific illustration's bytes. Pass fileId directly, or a format (PNG/SVG/EPS/AI) resolved
// from a prior search record's filesinfo. Saves under ~/.bhatbot/bioart and returns the local path.
async function fetchAsset({ id, fileId, format, filesinfo, dest } = {}) {
  if (!id) return { success: false, error: 'fetchAsset needs an id.' };
  let fid = fileId;
  const fi = filesinfo || _recordCache.get(String(id));   // fall back to the remembered search record
  if (!fid && format && fi) { const g = fi[String(format).toUpperCase()]; fid = g && g[0]; }
  if (!fid && fi) { const g = fi.PNG || fi.ALL; fid = g && g[0]; }
  if (!fid) return { success: false, error: 'Need a fileId, or run `bioart search` first so the id\'s formats are known.' };
  try {
    const url = `${BASE}/api/bioarts/${id}/files/${fid}`;
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) return { success: false, error: `BioArt file fetch failed (${res.status}).` };
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (String(format || '').toLowerCase() || 'png').replace(/[^a-z]/g, '') || 'png';
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const out = dest || path.join(CACHE_DIR, `${id}_${fid}.${ext}`);
    fs.writeFileSync(out, buf);
    return { success: true, id, fileId: fid, path: out, bytes: buf.length, url, license: 'Public Domain' };
  } catch (e) { return { success: false, error: e.message }; }
}

module.exports = { search, fetchAsset, parseSearchRSC, parseFilesInfo, decodeEntities, BASE, CACHE_DIR, DEFAULT_SEARCH_ACTION };
