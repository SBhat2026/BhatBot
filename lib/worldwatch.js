'use strict';
// ── WORLD WATCHER — "show me Tokyo" ──────────────────────────────────────────────────────────────
//
// worldwatcher.live is a map of ~1,600 public live webcams. It has no documented API, but its own
// front end loads every camera from /api/cameras — { public_id, name, coords:[lat,lng], location,
// country, tags } — and gives each one a page at /cam/<public_id>. That is enough to drive it:
// resolve a place to coordinates, take the nearest live camera, and open its page in the World zone.
//
// Siddhant chose two uses (2026-11-12): on request ("show me Tokyo"), and tied to his context — the
// city of his next meeting, otherwise somewhere near home. No ambient decoration, no vision calls.
//
// Resolution order, cheapest first:
//   1. the camera list itself — a city or country named in the request ("Tokyo", "Amsterdam") is
//      matched against camera locations with no network call at all;
//   2. Open-Meteo's free geocoder for anything else ("Princeton", "the Alps"), then nearest camera.
// Distance is always reported, because "the nearest camera to Princeton" being in Philadelphia is
// information, and presenting it as Princeton would be a small lie.
//
// Pure + DI: `fetchJson` and `cache` are injected, so the matching is testable without the network.

const BASE = 'https://worldwatcher.live';
const CAMERAS_TTL_MS = 12 * 3600 * 1000;

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function haversineKm(a, b) {
  const R = 6371, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Strip the conversational frame: "show me the weather in Tokyo right now" → "tokyo". */
function placeOf(text) {
  let t = norm(text);
  t = t.replace(/^(hey |ok |okay )?(jarvis|bhatbot|bhat bot)\b ?/, '');
  t = t.replace(/^(can you |could you |please )?(show|open|pull up|bring up|take me to|go to|let me see|let s see|what s it like in|what is it like in|look at)( me)?( a| the)?( live)?( webcam| camera| cam| view| feed)?( of| in| at| from| on)? ?/, '');
  t = t.replace(/\b(right now|now|please|live|webcam|camera|cam|weather|today|tonight)\b/g, ' ');
  t = t.replace(/^(the|in|at|of) /, '');
  return t.replace(/\s+/g, ' ').trim();
}

// `home()` → [lat,lng] | null. Place names repeat ("Princeton" is in New Jersey AND Indiana, and the
// camera list only has the Indiana one); when a name is ambiguous the reading nearest home wins,
// because that is the one he means.
const AMBIGUOUS_KM = 300;
// Camera cities whose names are also everyday words — "a nice view", "the mobile app", "reading the news".
const MENTION_STOP = new Set(['nice', 'mobile', 'reading', 'bath', 'split', 'orange', 'hope', 'liberty', 'independence', 'eden', 'paradise',
  'home', 'central', 'union', 'normal', 'plain', 'darwin', 'victoria', 'jackson', 'lincoln', 'washington', 'york', 'march', 'may', 'sale', 'deal', 'gap', 'zoom']);
function createWorldWatch({ fetchJson, cache, now = () => Date.now(), log = () => {}, home = () => null } = {}) {
  let mem = null;

  async function cameras() {
    if (mem && now() - mem.at < CAMERAS_TTL_MS) return mem.list;
    let c = null;
    try { c = cache && cache.get(); } catch {}
    if (c && Array.isArray(c.list) && now() - c.at < CAMERAS_TTL_MS) { mem = c; return c.list; }
    try {
      const j = await fetchJson(`${BASE}/api/cameras`);
      const list = (Array.isArray(j) ? j : (j && (j.cameras || j.data)) || [])
        .filter((x) => x && x.public_id && Array.isArray(x.coords) && x.coords.length === 2)
        .map((x) => ({ id: x.public_id, name: String(x.name || '').trim(), location: String(x.location || '').trim(), country: String(x.country || '').trim(), coords: x.coords, tags: x.tags || [] }));
      if (list.length) { mem = { at: now(), list }; try { cache && cache.set(mem); } catch {} return list; }
    } catch (e) { log('[worldwatch] camera list fetch failed: ' + (e && e.message)); }
    // A stale list beats none: cameras rarely move.
    if (c && Array.isArray(c.list)) { mem = c; return c.list; }
    return [];
  }

  const view = (cam, extra = {}) => ({
    url: `${BASE}/cam/${cam.id}`, id: cam.id, name: cam.name,
    place: [cam.location, cam.country].filter(Boolean).join(', '), coords: cam.coords, ...extra,
  });

  /** Nearest camera to a coordinate. */
  async function nearest(lat, lng, extra = {}) {
    const list = await cameras();
    let best = null, bestKm = Infinity;
    for (const c of list) { const d = haversineKm([lat, lng], c.coords); if (d < bestKm) { bestKm = d; best = c; } }
    return best ? view(best, { distanceKm: Math.round(bestKm), ...extra }) : null;
  }

  const homeAt = () => { try { const h = home(); return Array.isArray(h) && h.length === 2 && h.every(Number.isFinite) ? h : null; } catch { return null; } };

  /** Best reading of a place name: the most prominent one, or — when home is known — the one nearest home. */
  async function geocode(q) {
    const h = homeAt();
    try {
      const j = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?count=${h ? 10 : 1}&language=en&format=json&name=${encodeURIComponent(q)}`);
      const rs = (j && Array.isArray(j.results) ? j.results : []).filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
      if (!rs.length) return null;
      let r = rs[0];
      if (h) r = [...rs].sort((a, b) => haversineKm(h, [a.latitude, a.longitude]) - haversineKm(h, [b.latitude, b.longitude]))[0];
      return { lat: r.latitude, lng: r.longitude, label: [r.name, r.admin1, r.country].filter(Boolean).join(', ') };
    } catch { return null; }
  }

  /**
   * find(request) → { ok, url, name, place, distanceKm, via, asked } | { ok:false, why }
   * `request` can be a whole spoken sentence; the place is extracted from it.
   */
  async function find(request) {
    const q = placeOf(request);
    if (!q) return { ok: false, why: 'no place in that request' };
    const list = await cameras();
    if (!list.length) return { ok: false, why: 'the World Watcher camera list could not be loaded' };
    // 1. a camera's own location, then its country, then its name — no network.
    const byLoc = list.filter((c) => norm(c.location) === q);
    const byCountry = byLoc.length ? [] : list.filter((c) => norm(c.country) === q);
    const byName = byLoc.length || byCountry.length ? [] : list.filter((c) => norm(c.name).includes(q) && q.length >= 4);
    const hits = byLoc.length ? byLoc : byCountry.length ? byCountry : byName;
    if (hits.length) {
      // Several cameras in one city: prefer the busiest-looking (urban, with sound), else the first.
      const score = (c) => (c.tags.includes('urban') ? 2 : 0) + (c.tags.includes('sound') ? 1 : 0);
      const pick = [...hits].sort((a, b) => score(b) - score(a))[0];
      // A lone match far from home may be the wrong place with the right name. Countries and places
      // with several cameras are not ambiguous, so they never pay for the extra lookup.
      const h = homeAt();
      if (h && hits.length === 1 && !byCountry.length) {
        const away = haversineKm(h, pick.coords);
        if (away > AMBIGUOUS_KM) {
          const g = await geocode(q);
          if (g && haversineKm(h, [g.lat, g.lng]) < away - AMBIGUOUS_KM) {
            const near = await nearest(g.lat, g.lng, { via: 'geocoded near home', asked: q, resolved: g.label });
            if (near) return { ok: true, ...near };
          }
        }
      }
      return { ok: true, ...view(pick, { distanceKm: 0, via: 'camera list', asked: q, alternatives: hits.length - 1 }) };
    }
    // 2. anywhere else: geocode, then the nearest camera, honestly labelled.
    const g = await geocode(q);
    if (!g) return { ok: false, why: `could not find a place called "${q}"` };
    const near = await nearest(g.lat, g.lng, { via: 'geocoded', asked: q, resolved: g.label });
    return near ? { ok: true, ...near } : { ok: false, why: 'no cameras loaded' };
  }

  /**
   * mentions(text) → the camera city a piece of text talks about, or null. Used to OFFER a live
   * view when a reply names a city ("…protests in Paris…"), never to open one. Only whole camera-city
   * names count, longest first, and a few names that are ordinary English words are ignored.
   */
  async function mentions(text) {
    const t = ' ' + norm(text) + ' ';
    if (t.length < 8) return null;
    const list = await cameras();
    const byLoc = new Map();
    for (const c of list) {
      const l = norm(c.location);
      if (l.length < 4 || MENTION_STOP.has(l)) continue;
      if (!byLoc.has(l)) byLoc.set(l, []);
      byLoc.get(l).push(c);
    }
    let best = null;
    for (const [l, cams] of byLoc) if (t.includes(' ' + l + ' ') && (!best || l.length > best[0].length)) best = [l, cams];
    if (!best) return null;
    const score = (c) => (c.tags.includes('urban') ? 2 : 0) + (c.tags.includes('sound') ? 1 : 0);
    const pick = [...best[1]].sort((a, b) => score(b) - score(a))[0];
    return { ok: true, city: pick.location, ...view(pick, { distanceKm: 0, via: 'mentioned' }) };
  }

  return { find, nearest, cameras, placeOf, mentions, BASE };
}

module.exports = { createWorldWatch, placeOf, haversineKm, BASE };
