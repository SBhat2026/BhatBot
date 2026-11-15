#!/usr/bin/env node
'use strict';
// lib/worldwatch.js — "show me Tokyo" → the nearest live camera on worldwatcher.live.
// Fixture cameras in the real /api/cameras shape (including its stray leading space in " Tokyo").
//   node scripts/test-worldwatch.js      (wired into npm run verify)
const { createWorldWatch, placeOf, haversineKm } = require('../lib/worldwatch');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };

const CAMS = [
  { public_id: 'OElNZpiX', name: 'Kabukicho Ichibangai', coords: [35.6943, 139.7011], location: ' Tokyo', country: 'Japan', tags: ['urban', 'sound'] },
  { public_id: 'V1360A0b', name: 'Omoide Yokocho', coords: [35.6933, 139.6996], location: 'Tokyo', country: 'Japan', tags: ['urban', 'railway'] },
  { public_id: 'gIryhcjz', name: 'Dam Square', coords: [52.3725, 4.8940], location: 'Amsterdam', country: 'Netherlands', tags: ['urban'] },
  { public_id: 'phl00001', name: 'City Hall', coords: [39.9526, -75.1652], location: 'Philadelphia', country: 'United States', tags: ['urban'] },
  { public_id: 'nyc00001', name: 'Times Square', coords: [40.7580, -73.9855], location: 'New York', country: 'United States', tags: ['urban', 'sound'] },
  { public_id: 'broken', name: 'No coords' },
];
(async () => {
  let fetches = [], geo = null;
  const fetchJson = async (u) => {
    fetches.push(u);
    if (/api\/cameras/.test(u)) return CAMS;
    if (/geocoding-api/.test(u)) return geo ? { results: [geo] } : { results: [] };
    throw new Error('unexpected ' + u);
  };
  let stored = null;
  const W = createWorldWatch({ fetchJson, cache: { get: () => stored, set: (v) => { stored = v; } } });

  // the spoken frame is stripped
  for (const [said, want] of [['show me Tokyo', 'tokyo'], ['Jarvis, pull up a live webcam of Amsterdam please', 'amsterdam'], ["what's it like in New York right now", 'new york'], ['take me to the Alps', 'alps'], ['Tokyo', 'tokyo']]) {
    ok(placeOf(said) === want, `"${said}" → "${placeOf(said)}"`);
  }

  let r = await W.find('show me Tokyo');
  ok(r.ok && r.url === 'https://worldwatcher.live/cam/OElNZpiX', `Tokyo resolves from the camera list itself, despite its stray leading space (${r.url})`);
  ok(r.via === 'camera list' && r.distanceKm === 0 && r.alternatives === 1, 'with no network geocode, and it says another Tokyo camera exists');
  ok(fetches.filter((u) => /geocoding/.test(u)).length === 0, 'no geocoder call for a city the list already knows');

  r = await W.find('show me Japan');
  ok(r.ok && /Tokyo/.test(r.place), 'a country resolves to one of its cameras');

  geo = { latitude: 40.3573, longitude: -74.6672, name: 'Princeton', admin1: 'New Jersey', country: 'United States' };
  r = await W.find('show me Princeton');
  ok(r.ok && r.via === 'geocoded' && r.resolved === 'Princeton, New Jersey, United States', `a place with no camera is geocoded (${r.resolved})`);
  ok(/Philadelphia|New York/.test(r.place) && r.distanceKm > 30, `and the nearest camera is reported WITH its distance, not passed off as Princeton (${r.place}, ${r.distanceKm} km)`);

  geo = null;
  r = await W.find('show me Atlantis');
  ok(!r.ok && /could not find/.test(r.why), `an unknown place fails honestly (${r.why})`);
  ok(!(await W.find('show me')).ok, 'no place at all is not a request');

  // the list is fetched once and cached
  const before = fetches.filter((u) => /api\/cameras/.test(u)).length;
  await W.find('Amsterdam'); await W.find('Tokyo');
  ok(fetches.filter((u) => /api\/cameras/.test(u)).length === before, 'the camera list is fetched once, not per request');
  ok(stored && stored.list.length === 5, 'and cached to disk, minus the malformed entry');

  // a dead network falls back to the stale cache rather than to nothing
  const W2 = createWorldWatch({ fetchJson: async () => { throw new Error('offline'); }, cache: { get: () => ({ at: 0, list: stored.list }), set: () => {} } });
  r = await W2.find('Amsterdam');
  ok(r.ok && /Amsterdam/.test(r.place), 'offline, a stale camera list still answers — cameras rarely move');

  // Ambiguous names: the camera list's only "Princeton" is in Indiana; from home in NJ, he means NJ.
  const CAMS3 = [...CAMS, { public_id: 'prIN0001', name: 'West Broadway Street line crossing', coords: [38.3556, -87.5742], location: 'Princeton', country: 'USA', tags: [] }];
  const both = [{ latitude: 38.3517, longitude: -87.5675, name: 'Princeton', admin1: 'Indiana', country: 'United States' },
    { latitude: 40.3573, longitude: -74.6672, name: 'Princeton', admin1: 'New Jersey', country: 'United States' }];
  let geoCalls = 0;
  const fj3 = async (u) => { if (/api\/cameras/.test(u)) return CAMS3; if (/geocoding/.test(u)) { geoCalls++; return { results: both }; } throw new Error(u); };
  const W3 = createWorldWatch({ fetchJson: fj3, home: () => [39.7698, -74.8874] });
  r = await W3.find('what is it like in Princeton');
  ok(r.ok && /New Jersey/.test(r.resolved || '') && !/Indiana/.test(r.place), `with home in NJ, "Princeton" is the NJ one, not Indiana's camera (${r.place}, ${r.distanceKm} km)`);
  r = await W3.find('show me Tokyo');
  ok(r.ok && /Tokyo/.test(r.place) && geoCalls === 1, 'a city with several cameras is never second-guessed (no extra geocode)');
  const W4 = createWorldWatch({ fetchJson: fj3 });
  r = await W4.find('Princeton');
  ok(r.ok && r.id === 'prIN0001', 'without a home, the camera list match stands');

  const n = await W.nearest(39.7698, -74.8874);
  ok(n && /Philadelphia/.test(n.place), `nearest to home (Atco, NJ) is Philadelphia (${n && n.place}, ${n && n.distanceKm} km)`);
  ok(Math.round(haversineKm([0, 0], [0, 1])) === 111, 'one degree of longitude at the equator is ~111 km');

  console.log(`\n${fail === 0 ? '✅' : '❌'} worldwatch: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
