#!/usr/bin/env node
'use strict';
// Universal cheap verify for self-heal: every tracked .js file must parse (node --check). This is
// the #1 thing a bad auto-fix breaks (a syntax error that bricks startup), and it runs in <2s with
// no side effects. Self-heal uses this (often AND-ed with a real test like `npm run smoke`) as the
// `verify` gate — if it exits non-zero, the fix is auto-reverted. Exit 0 = all files parse.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'OmniParser', 'phone-app']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && e.name.endsWith('.js')) files.push(p);
  }
})(ROOT);

let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { bad++; console.error('✗ ' + path.relative(ROOT, f) + '\n' + String((e.stderr || e.message || '')).split('\n').slice(0, 3).join('\n')); }
}
if (bad) { console.error(`\n${bad} file(s) failed to parse`); process.exit(1); }
console.log(`✓ ${files.length} JS files parse cleanly`);
process.exit(0);
