'use strict';
// BioArt parser tests — pure (no network): RSC record extraction, filesinfo, entity decode.
const b = require('../lib/bioart');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

// entity decode
ok(b.decodeEntities('Toll&#45;like&#32;Receptor') === 'Toll-like Receptor', 'decode: numeric entities → text');
ok(b.decodeEntities('A&amp;B') === 'A&B', 'decode: named entity');

// filesinfo map
const fi = b.parseFilesInfo('All:1,2,3|EPS:1,3|PNG:2|SVG:9');
ok(fi.PNG[0] === '2' && fi.SVG[0] === '9' && fi.ALL.length === 3, 'filesinfo: format→ids parsed');

// RSC record parse (minimal synthetic fixture in the observed shape)
const rsc = '...garbage...'
  + '"id":["700"],"title":["Toll&#45;like&#32;Receptor"],"thumbnail":["/bioarts/700/files/784255"],'
  + '"content":["Toll-like Receptor <p>Gold colored receptor</p> keywords"],'
  + '"filesinfo":["All:784254,784255|EPS:784254|PNG:784255|SVG:784256"],"license":["Public&#32;Domain"]'
  + 'more...'
  + '"id":["699"],"title":["Babesia Cell"],"thumbnail":["/bioarts/699/files/783372"],'
  + '"content":["Babesia Cell desc"],"filesinfo":["All:1|PNG:1"],"license":["Public Domain"]'
  + '"id":["1"]';   // trailing facet row with no title → must be skipped
const recs = b.parseSearchRSC(rsc);
ok(recs.length === 2, `parse: 2 real records (got ${recs.length}, facet skipped)`);
ok(recs[0].id === '700' && recs[0].title === 'Toll-like Receptor', 'parse: id + decoded title');
ok(recs[0].thumbnail === 'https://bioart.niaid.nih.gov/api/bioarts/700/files/784255', 'parse: thumbnail → full /api url');
ok(recs[0].formats.includes('PNG') && recs[0].formats.includes('SVG') && !recs[0].formats.includes('ALL'), 'parse: formats listed, ALL excluded');
ok(recs[0].description.includes('Gold colored receptor') && !recs[0].description.includes('<p>'), 'parse: description tag-stripped');
ok(recs[0].detail === 'https://bioart.niaid.nih.gov/bioart/700', 'parse: detail page url');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
