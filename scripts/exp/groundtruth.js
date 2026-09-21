#!/usr/bin/env node
'use strict';
// GROUND TRUTH for the fan-out experiment, computed mechanically so the score is not my opinion.
//
// The question put to the agents: which modules in lib/ make an OUTBOUND NETWORK CALL that can hang
// forever — i.e. a fetch()/https.request() with no timeout, no AbortSignal and no explicit abort?
// That is a real defect class (the morning brief's 20s ProtFunc hang was one), it is spread across
// ~111 files so no single agent can read them all, and it is decidable from the source text, which
// is what makes it scorable at all.
//
// THE KEY WAS WRONG ONCE ALREADY, and it is worth saying how. The first version matched the literal
// token `fetch(`. lib/imagesearch.js takes its fetch as a PARAMETER — `fetchFn(u, …)` — so the key
// scored it as touching no network at all, and both experiment arms that named it were marked down
// for a fabrication they had not committed. They had read the file; the regex had not. Injected
// fetches are matched now. The lesson is not that regexes are bad: it is that an answer key is a
// measuring instrument and gets checked against reality like any other.
//
// DECISION RULE (applied identically to every file, so agents and key are judged the same way):
//   networked  := the file contains `fetch(` / `https.request(` / `http.request(` / `axios`,
//                 or calls an INJECTED fetch (`fetchFn(`, `doFetch(`, `fetchImpl(`, `_fetch(`)
//   guarded    := that file also contains AbortSignal.timeout | signal: | setTimeout(...abort
//                 | timeout: | req.setTimeout | .destroy() on a timer
//   HIT        := networked AND NOT guarded
const fs = require('fs');
const path = require('path');
const LIB = path.join(__dirname, '..', '..', 'lib');

const NET = /\bfetch\s*\(|https?\.request\s*\(|require\(['"]axios['"]\)|\b(?:fetchFn|doFetch|fetchImpl|_fetch)\s*\(/;
const GUARD = /AbortSignal\.timeout|AbortController|\bsignal\s*:|setTimeout\([^)]*abort|\btimeout\s*:|\btimeoutMs\b|setTimeout\([^)]*destroy|req\.setTimeout/;

function scan(dir, prefix = '') {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) { out.push(...scan(path.join(dir, d.name), prefix + d.name + '/')); continue; }
    if (!d.name.endsWith('.js')) continue;
    const rel = prefix + d.name;
    const src = fs.readFileSync(path.join(dir, d.name), 'utf8');
    const networked = NET.test(src);
    if (!networked) continue;
    out.push({ file: rel, guarded: GUARD.test(src) });
  }
  return out;
}

const all = scan(LIB);
const hits = all.filter((x) => !x.guarded).map((x) => x.file).sort();
module.exports = { hits, networked: all.map((x) => x.file).sort(), all };

if (require.main === module) {
  console.log(`lib/ modules that touch the network: ${all.length}`);
  console.log(`of those, UNGUARDED (the answer key): ${hits.length}\n`);
  for (const h of hits) console.log('  ' + h);
}
