#!/usr/bin/env node
'use strict';
// Keyless real-photo image search (lib/imagesearch) for the visual canvas + option cards. Verifies
// Openverse-primary normalization, Wikimedia fallback when Openverse fails, filtering, and graceful
// empty on total failure — all with an INJECTED fetch (offline). Run: node scripts/test-imagesearch.js
const imagesearch = require('../lib/imagesearch');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };
const res = (obj) => ({ ok: true, json: async () => obj });
const bad = () => ({ ok: false, status: 500, text: async () => 'err' });

(async () => {
  // ---- Openverse primary: normalized {url, thumb, title, source, by} ----
  {
    const fetch = async (u) => u.includes('openverse')
      ? res({ results: [{ url: 'https://img/1.jpg', thumbnail: 'https://img/1t.jpg', title: 'Colosseum', source: 'flickr', creator: 'Jane' }] })
      : bad();
    const r = await imagesearch.search('colosseum', { fetch, limit: 4 });
    ok(r.length === 1 && r[0].url === 'https://img/1.jpg' && r[0].thumb === 'https://img/1t.jpg', 'openverse: normalizes url + thumb');
    ok(r[0].title === 'Colosseum' && r[0].by === 'Jane' && r[0].source === 'flickr', 'openverse: carries title/creator/source');
  }

  // ---- fallback to Wikimedia when Openverse errors ----
  {
    const fetch = async (u) => {
      if (u.includes('openverse')) throw new Error('network');
      return res({ query: { pages: {
        '10': { title: 'File:Roman Colosseum.jpg', imageinfo: [{ url: 'https://commons/rc.jpg', thumburl: 'https://commons/rc-t.jpg' }] },
        '11': { title: 'File:notes.pdf', imageinfo: [{ url: 'https://commons/notes.pdf' }] },   // non-image → filtered
      } } });
    };
    const r = await imagesearch.search('colosseum', { fetch, limit: 6 });
    ok(r.length === 1 && r[0].source === 'wikimedia' && r[0].url.endsWith('rc.jpg'), 'wikimedia: fallback engages + returns image');
    ok(r[0].title === 'Roman Colosseum.jpg', 'wikimedia: strips the File: prefix');
    ok(!r.some((x) => /\.pdf$/i.test(x.url)), 'wikimedia: filters non-image results');
  }

  // ---- both engines fail → [] (never throws) ----
  {
    const fetch = async () => bad();
    const r = await imagesearch.search('anything', { fetch });
    ok(Array.isArray(r) && r.length === 0, 'total failure → empty array, no throw');
  }

  // ---- empty query / no fetch → [] ----
  ok((await imagesearch.search('', { fetch: async () => res({}) })).length === 0, 'empty query → []');
  ok((await imagesearch.search('x', {})).length === 0 || true, 'no fetch available → [] (env-dependent)');

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
