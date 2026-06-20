#!/usr/bin/env node
'use strict';
// Manual query tool for the semantic store.
//
// Usage:
//   node scripts/semantic/query.js "some query"
//   node scripts/semantic/query.js "some query" --kind=semantic --k=8 --min=0.15
//
// Prints top matches as JSON. Degrades gracefully (empty/skipped) without a key.

const path = require('path');
const semantic = require(path.join(__dirname, '..', '..', 'lib', 'semantic.js'));

function parseArgs(argv) {
  const opts = { kind: undefined, k: 6, min: 0.2 };
  const positional = [];
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--kind=(.+)$/))) opts.kind = m[1];
    else if ((m = a.match(/^--k=(\d+)$/))) opts.k = parseInt(m[1], 10);
    else if ((m = a.match(/^--min=([\d.]+)$/))) opts.min = parseFloat(m[1]);
    else positional.push(a);
  }
  opts.query = positional.join(' ').trim();
  return opts;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.query) {
    console.log(JSON.stringify({ ok: false, error: 'usage: node scripts/semantic/query.js "query" [--kind=semantic|episodic] [--k=N] [--min=F]' }, null, 2));
    return;
  }
  if (!semantic.isReady()) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no openaiKey — semantic search degrades to no-op', query: opts.query, results: [] }, null, 2));
    return;
  }
  const results = await semantic.search(opts.query, { kind: opts.kind, k: opts.k, minScore: opts.min });
  console.log(JSON.stringify({
    ok: true,
    query: opts.query,
    kind: opts.kind || 'any',
    stats: semantic.stats(),
    results: results.map((r) => ({
      score: Number(r.score.toFixed(4)),
      kind: r.kind,
      date: r.ts ? new Date(r.ts).toISOString().slice(0, 10) : null,
      text: r.text,
      meta: r.meta,
    })),
  }, null, 2));
})().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }, null, 2));
});
