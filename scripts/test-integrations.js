#!/usr/bin/env node
'use strict';
// Tests the first-wave external adapters: docker (probe + graceful), simctl (probe + list),
// scholar (pure Atom parse + dedupe, fixture — no live network). Everything DEGRADES when a tool is
// absent so this passes on any machine. Run: node scripts/test-integrations.js  (in npm run verify)
const docker = require('../lib/integrations/docker');
const simctl = require('../lib/integrations/simctl');
const scholar = require('../lib/integrations/scholar');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

(async () => {
  // ---- docker: probe returns a boolean; run without image degrades gracefully ----
  const dAvail = await docker.available();
  ok(typeof dAvail === 'boolean', 'docker: available() returns a boolean (no throw)');
  const dRun = await docker.run({});
  ok(dRun.code === -1 && /image required/.test(dRun.stderr), 'docker: run without image → graceful error');
  ok(docker.baseImageFor('python').includes('python') && docker.baseImageFor('node').includes('node'), 'docker: baseImageFor maps stacks');
  ok(typeof docker.INSTALL_HINT === 'string' && docker.INSTALL_HINT.length > 20, 'docker: has an install hint for when absent');

  // ---- simctl: probe boolean; if present, listDevices returns a normalized array ----
  const sAvail = await simctl.available();
  ok(typeof sAvail === 'boolean', 'simctl: available() returns a boolean');
  if (sAvail) {
    const { devices, error } = await simctl.listDevices();
    ok(!error && Array.isArray(devices), 'simctl: listDevices returns an array when Xcode present');
    ok(devices.every((d) => d.udid && d.name && 'booted' in d), 'simctl: devices are normalized {udid,name,state,booted}');
    const { device } = await simctl.pickDevice();
    ok(device === null || (device && device.udid), 'simctl: pickDevice returns a device or null');
  } else {
    console.log('   (Xcode absent — simctl degrades; skipping live-list assertions)');
  }

  // ---- scholar: pure Atom parse over a recorded fixture (no network) ----
  const FIXTURE = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><id>http://arxiv.org/abs/2401.01234v1</id>
      <title>Graph Neural Networks for Protein-Protein Interaction</title>
      <summary>We present a GNN approach to PPI prediction with strong results.</summary>
      <published>2024-01-15T00:00:00Z</published>
      <author><name>A. Researcher</name></author><author><name>B. Coauthor</name></author>
      <link title="pdf" href="http://arxiv.org/pdf/2401.01234v1"/></entry>
    <entry><id>http://arxiv.org/abs/2402.05678v2</id>
      <title>Attention Is All You Need Again</title>
      <summary>Another transformer paper.</summary>
      <published>2024-02-20T00:00:00Z</published>
      <author><name>C. Author</name></author></entry>
  </feed>`;
  const recs = scholar.parseArxivAtom(FIXTURE);
  ok(recs.length === 2, 'scholar: parses both entries from the Atom fixture');
  ok(recs[0].title === 'Graph Neural Networks for Protein-Protein Interaction', 'scholar: title extracted');
  ok(recs[0].authors.length === 2 && recs[0].authors[0] === 'A. Researcher', 'scholar: authors extracted');
  ok(recs[0].year === 2024 && recs[0].id === '2401.01234', 'scholar: year + arxiv id extracted');
  ok(/pdf\/2401\.01234/.test(recs[0].pdfUrl), 'scholar: pdf url extracted');
  ok(scholar.parseArxivAtom('garbage').length === 0, 'scholar: junk input → empty (no throw)');

  // ---- scholar: mergeDedupe collapses the same paper from two sources, keeps higher citations ----
  const merged = scholar.mergeDedupe(
    [{ source: 'arxiv', title: 'Same Paper', authors: [], pdfUrl: '' }],
    [{ source: 'semanticscholar', title: 'same paper', citations: 42, pdfUrl: 'x.pdf' }],
  );
  ok(merged.length === 1 && merged[0].citations === 42, 'scholar: mergeDedupe collapses duplicate titles, keeps richer record');

  // arxiv() with an injected fetch (no real network) returns parsed results
  const fakeFetch = async () => ({ ok: true, text: async () => FIXTURE });
  const live = await scholar.arxiv('gnn', { fetch: fakeFetch });
  ok(!live.error && live.results.length === 2, 'scholar: arxiv() uses injected fetch → parsed results');

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
