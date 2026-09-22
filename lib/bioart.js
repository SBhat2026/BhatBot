'use strict';
// NIH BioArt integration — search + fetch the NIAID "BioArt Source" library of professional,
// PUBLIC-DOMAIN scientific/medical illustrations (2000+, formats PNG/SVG/EPS/AI). Gives BhatBot a
// library of real, high-quality figures to compose from instead of AI-generating every illustration.
//
// The site is a Next.js SPA with no documented API. Two facts discovered from its live traffic:
//   • Images are a stable REST path:  GET /api/bioarts/{id}/files/{fileId}   (no auth, public domain)
//   • Search is a Next.js Server Action (POST /discover?searchTerm=… with a `next-action` id + an RSC
//     "text/x-component" response). The action id is deploy-versioned. It rotated once already
//     (2026-07 → 2026-09), which is the whole reason for `discoverAction()` below: rather than fail
//     and wait for a human to paste a new constant, search re-derives the id from the site's own
//     client bundle — the id is literally emitted there as
//     createServerReference("<id>", …, "discoverSearch") — and caches it beside the image cache.
//     A redeploy therefore costs one extra page fetch, not an outage.
// The RSC parser is PURE (parseSearchRSC) so it unit-tests without network.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'https://bioart.niaid.nih.gov';
const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const CACHE_DIR = path.join(os.homedir(), '.bhatbot', 'bioart');
// Default search Server-Action id (re-observed live 2026-09-21). Override via config.bioart.searchAction
// to pin it; otherwise a rotation is healed automatically by discoverAction().
const DEFAULT_SEARCH_ACTION = '4026f1528e81a7884142b2affd16c95633da420e11';
const ACTION_CACHE = path.join(CACHE_DIR, 'action.json');

function cfg() { try { return (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).bioart) || {}; } catch { return {}; } }

let _reprobed = false;                                      // re-derive at most once per process
let _learned = null;                                        // id re-derived this process
function learned() {
  if (_learned) return _learned;
  try { _learned = JSON.parse(fs.readFileSync(ACTION_CACHE, 'utf8')).searchAction || null; } catch { _learned = null; }
  return _learned;
}
// An explicit config pin always wins — if you set it, you meant it. Otherwise prefer whatever was
// last learned from the live bundle, and fall back to the constant on a cold machine.
function searchAction() { return cfg().searchAction || learned() || DEFAULT_SEARCH_ACTION; }

/** PURE: pick the `discoverSearch` action id out of a Next.js client chunk. */
function parseActionId(js, name) {
  const re = new RegExp('createServerReference\\)\\("([0-9a-f]{32,64})"[^)]*?"' + (name || 'discoverSearch') + '"');
  const m = String(js || '').match(re);
  return m ? m[1] : null;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// TIMEOUTS ARE NOT OPTIONAL ON THIS PATH. NIH BioArt already proved it can rot under us once by rotating its action id; a slow redeploy is the same class of event.
// `AbortSignal.timeout(ms)` rejects the fetch instead of leaving the caller parked forever on a host
// that accepted the connection and then went quiet — the failure mode that took the morning brief
// down 683 times in 16 days. See TIMEOUTS.md and scripts/exp/groundtruth.js, which is the check.
const BIOART_TIMEOUT_MS = 20000;
const BIOART_ASSET_TIMEOUT_MS = 60000;   // an EPS/AI illustration is megabytes — give the bytes longer than the query

/** Re-derive the search action id from the live site. Returns the id, or null if the shape changed. */
async function discoverAction() {
  try {
    const html = await (await fetch(`${BASE}/discover`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(BIOART_TIMEOUT_MS) })).text();
    // The discover route's own chunk is the only one that carries discoverSearch; its filename is
    // hashed per deploy, so it has to be read out of the page rather than guessed.
    const chunks = (html.match(/\/_next\/static\/chunks\/app\/[^"']*discover[^"']*\.js/g) || []);
    for (const c of [...new Set(chunks)]) {
      const js = await (await fetch(BASE + c.replace(/\(/g, '%28').replace(/\)/g, '%29'), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(BIOART_TIMEOUT_MS) })).text();
      const id = parseActionId(js, 'discoverSearch');
      if (!id) continue;
      _learned = id;
      try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(ACTION_CACHE, JSON.stringify({ searchAction: id, learnedAt: new Date().toISOString() }, null, 2)); } catch {}
      return id;
    }
  } catch {}
  return null;
}

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
async function searchOnce(term, action, limit, sort) {
  term = String(term).trim();
  const url = `${BASE}/discover?searchTerm=${encodeURIComponent(term)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'next-action': action,
      'content-type': 'text/plain;charset=UTF-8',
      'accept': 'text/x-component',
      'user-agent': UA,
    },
    // The first segment IS the query. Sending the literal `type:bioart` here (as this did until
    // 2026-09-21) asks for "everything", so every search quietly returned the same generic first
    // page — the results looked plausible, which is why it went unnoticed. The term only ever
    // filtered from this slot; the ?searchTerm= in the URL is for the page's own breadcrumb.
    body: JSON.stringify([`${term}?start=0&size=${Math.min(limit, 50)}&sort=${sort}`]),
  });
  return parseSearchRSC(await res.text());
}

async function search(term, { limit = 12, sort = 'score desc' } = {}) {
  if (!term) return { success: false, error: 'search needs a term.' };
  try {
    let all = await searchOnce(term, searchAction(), limit, sort);
    // Zero results is ambiguous — a term with no matches looks exactly like a rotated action id. It
    // costs one bundle fetch to tell them apart, and only when the answer was empty anyway. Once per
    // process, so a run of genuinely-empty searches doesn't re-scrape the bundle each time.
    if (!all.length && !_reprobed) {
      _reprobed = true;
      const fresh = await discoverAction();
      if (fresh) all = await searchOnce(term, fresh, limit, sort);
    }
    if (!all.length) return { success: false, error: `BioArt returned no results for "${term}" (search action ${searchAction()} is current; the term may simply have no matches).` };
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
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(BIOART_ASSET_TIMEOUT_MS) });
    if (!res.ok) return { success: false, error: `BioArt file fetch failed (${res.status}).` };
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (String(format || '').toLowerCase() || 'png').replace(/[^a-z]/g, '') || 'png';
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const out = dest || path.join(CACHE_DIR, `${id}_${fid}.${ext}`);
    fs.writeFileSync(out, buf);
    return { success: true, id, fileId: fid, path: out, bytes: buf.length, url, license: 'Public Domain' };
  } catch (e) { return { success: false, error: e.message }; }
}

module.exports = { search, fetchAsset, parseSearchRSC, parseFilesInfo, decodeEntities, parseActionId, discoverAction, searchAction, BASE, CACHE_DIR, DEFAULT_SEARCH_ACTION };
