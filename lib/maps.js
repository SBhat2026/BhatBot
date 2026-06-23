'use strict';
// Mapping backend for the `maps` tool. Free by default (no key needed), upgrades when a Google
// Maps key is present in config:
//   • geocode  → Google Geocoding API if key, else OpenStreetMap Nominatim (free)
//   • route    → OSRM demo server (free, driving/walking/cycling)
//   • render   → handled in the window: Google Maps JS if key, else Leaflet + OSM tiles
//
// DI factory: ctx = { getKey }  (getKey() → google maps api key or '' )
// All lookups are best-effort and throw clear errors the tool turns into a spoken/textual reply.

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = 'https://router.project-osrm.org';
const UA = 'BhatBot/1.0 (personal assistant)';   // Nominatim requires a UA

module.exports = function makeMaps(ctx = {}) {
  const getKey = ctx.getKey || (() => '');

  async function jget(url, headers) {
    const r = await fetch(url, { headers: headers || {} });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('?')[0]}`);
    return r.json();
  }

  // Place/address → {lat, lon, label}. Google when keyed (better disambiguation), else Nominatim.
  async function geocode(query) {
    const q = String(query || '').trim();
    if (!q) throw new Error('empty location');
    const key = getKey();
    if (key) {
      const j = await jget(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${key}`);
      if (j.status !== 'OK' || !j.results.length) throw new Error(`Google geocode: ${j.status || 'no result'}`);
      const r = j.results[0];
      return { lat: r.geometry.location.lat, lon: r.geometry.location.lng, label: r.formatted_address, source: 'google' };
    }
    const arr = await jget(`${NOMINATIM}/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { 'User-Agent': UA });
    if (!arr.length) throw new Error(`no match for "${q}"`);
    return { lat: +arr[0].lat, lon: +arr[0].lon, label: arr[0].display_name, source: 'osm' };
  }

  const PROFILES = { driving: 'driving', drive: 'driving', car: 'driving', walking: 'foot', walk: 'foot', foot: 'foot', cycling: 'bike', bike: 'bike', bicycle: 'bike' };
  // from/to (place strings) → {distance_km, duration_min, geometry:[[lat,lon]...], from, to}.
  async function route(fromQ, toQ, mode) {
    const [a, b] = await Promise.all([geocode(fromQ), geocode(toQ)]);
    const profile = PROFILES[String(mode || 'driving').toLowerCase()] || 'driving';
    const j = await jget(`${OSRM}/route/v1/${profile}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`);
    if (j.code !== 'Ok' || !j.routes.length) throw new Error(`OSRM: ${j.code || 'no route'}`);
    const rt = j.routes[0];
    return {
      distance_km: +(rt.distance / 1000).toFixed(1),
      duration_min: Math.round(rt.duration / 60),
      geometry: rt.geometry.coordinates.map(([lon, lat]) => [lat, lon]),   // → [lat,lon] for Leaflet
      from: a, to: b, mode: profile,
    };
  }

  // Build the payload the map window renders. action: 'show' (center+marker) | 'route' (draw path).
  async function prepare(input = {}) {
    const key = getKey();
    const action = input.action || (input.from && input.to ? 'route' : 'show');
    if (action === 'route' || action === 'directions') {
      const r = await route(input.from, input.to, input.mode);
      return { kind: 'route', googleKey: key || undefined, ...r };
    }
    const g = await geocode(input.query || input.location || input.place);
    return { kind: 'point', googleKey: key || undefined, center: [g.lat, g.lon], label: g.label, source: g.source, zoom: input.zoom || 14 };
  }

  return { geocode, route, prepare };
};
