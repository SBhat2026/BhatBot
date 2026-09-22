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
const vm = require('vm');
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
    // PARSE BEFORE JUDGING. This is a grep, and a grep will happily report a file as "guarded"
    // because the word AbortSignal appears in a comment that a bad edit dropped into the middle of a
    // template literal. That happened on 2026-09-21 while fixing these very files: two modules did
    // not compile and this script said 0 unguarded. vm.Script parses without executing, so the
    // number now means what it claims.
    let parses = true;
    try { new vm.Script(src, { filename: rel }); } catch { parses = false; }
    const networked = NET.test(src);
    if (!networked) continue;
    out.push({ file: rel, guarded: parses && GUARD.test(src), parses });
  }
  return out;
}

const all = scan(LIB);
const broken = all.filter((x) => !x.parses).map((x) => x.file);
const hits = all.filter((x) => !x.guarded).map((x) => x.file).sort();
module.exports = { hits, networked: all.map((x) => x.file).sort(), all };

if (require.main === module) {
  console.log(`lib/ modules that touch the network: ${all.length}`);
  if (broken.length) console.log(`⚠ ${broken.length} DO NOT PARSE and are counted as unguarded: ${broken.join(', ')}`);
  console.log(`of those, UNGUARDED (the answer key): ${hits.length}\n`);
  for (const h of hits) console.log('  ' + h);
  if (!hits.length) console.log('  (none — every networked module in lib/ has a deadline)');
}
