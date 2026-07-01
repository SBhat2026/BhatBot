#!/usr/bin/env node
'use strict';
// Tests for lib/codescan.js — the source-opportunity scanner that gives self-drive concrete,
// code-grounded work so reflect() finds actionable desires without a human focus. Runs against the
// real repo (read-only, <1s). Wired into `npm run verify`.
const path = require('path');
const cs = require('../lib/codescan');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const ROOT = path.join(__dirname, '..');
const r = cs.scan(ROOT);

ok(r && typeof r.summary === 'string' && r.summary.length > 10, 'scan: returns a summary line');
ok(Array.isArray(r.oversized_modules), 'scan: oversized_modules is an array');
ok(Array.isArray(r.swallowed_errors), 'scan: swallowed_errors is an array');
ok(Array.isArray(r.untested_modules), 'scan: untested_modules is an array');
ok(Array.isArray(r.docs_backlog), 'scan: docs_backlog is an array');
ok(r.totals && r.totals.source_files > 20, 'scan: counted a realistic number of source files');
// main.js is known-huge → must appear as an oversized module with real numbers.
const bigMain = r.oversized_modules.find((m) => m.file === 'main.js');
ok(bigMain && bigMain.lines > 1500 && bigMain.kb > 80, 'scan: flags main.js as oversized with concrete size');
// every opportunity must NAME a real file (that's what makes a desire automatable).
const named = [...r.oversized_modules, ...r.swallowed_errors, ...r.untested_modules].every((o) => typeof o.file === 'string' && o.file.length);
ok(named, 'scan: every code opportunity names a real file');
// bounded so it fits inside the reflection prompt.
ok(JSON.stringify(r).length < 12000, 'scan: output stays compact (<12KB) for the reflection prompt');
ok(r.oversized_modules.length <= 10 && r.swallowed_errors.length <= 10 && r.docs_backlog.length <= 15, 'scan: lists are capped');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
