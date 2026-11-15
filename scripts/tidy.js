#!/usr/bin/env node
'use strict';
// node scripts/tidy.js scan            → writes the plan, moves nothing
// node scripts/tidy.js apply           → moves the plan's findings into ~/BhatBot-Cleanup-Review
// node scripts/tidy.js restore [cat]   → puts everything (or one category) back where it was
// The review folder is NOT on iCloud and is on the same disk, so every move is an instant rename.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tidy = require('../lib/tidy');

const HOME = os.homedir();
const DEST = path.join(HOME, 'BhatBot-Cleanup-Review');
const PLAN = path.join(HOME, '.bhatbot', 'tidy-plan.json');
const cmd = process.argv[2] || 'scan';

// Scanned: his own documents and projects. NOT scanned: the system's and apps' own data, the photo
// and music libraries, Python installs and environments, ~/vec (it has its own retention rules),
// BhatBot itself (a build is written into it), and the review folder.
// (lib/tidy.js defaultRoots — the same choice the app's own janitor makes.)
const roots = () => tidy.defaultRoots(HOME);

if (cmd === 'scan') {
  let conf = null;
  try { conf = (JSON.parse(fs.readFileSync(path.join(HOME, '.bhatbot', 'config.json'), 'utf8')).autonomy || {}).confidential || null; } catch {}
  const t0 = Date.now();
  const r = tidy.scan({ roots: roots(), home: HOME, exclude: [DEST], confidential: conf });
  tidy.labelInstallers(r.findings);
  const byCat = {};
  for (const f of r.findings) { const c = byCat[f.category] || (byCat[f.category] = { n: 0, bytes: 0 }); c.n++; c.bytes += f.bytes; }
  fs.writeFileSync(PLAN, JSON.stringify({ at: Date.now(), ...r }, null, 1));
  console.log(`walked ${r.stats.filesWalked} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const [k, v] of Object.entries(byCat)) console.log(`  ${k.padEnd(13)} ${String(v.n).padStart(5)} items  ${(v.bytes / 1e9).toFixed(2)} GB`);
  console.log(`  total         ${String(r.stats.findings).padStart(5)} items  ${(r.stats.bytes / 1e9).toFixed(2)} GB`);
  console.log('skipped (never touched):', JSON.stringify(r.skipped));
  console.log('plan: ' + PLAN);
} else if (cmd === 'apply') {
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  const m = tidy.apply(plan.findings, { dest: DEST, home: HOME });
  const moved = m.items.filter((i) => i.to && !i.restoredAt).length, failed = m.items.filter((i) => !i.to);
  console.log(`moved ${moved} into ${DEST}${failed.length ? ` · ${failed.length} could not be moved (${[...new Set(failed.map((f) => f.error))].join(', ')})` : ''}`);
} else if (cmd === 'restore') {
  const r = tidy.restore(DEST, { only: process.argv[3] || null });
  console.log(`restored ${r.restored}${r.failed.length ? ` · ${r.failed.length} could not be restored` : ''}`);
} else {
  console.log('usage: node scripts/tidy.js scan | apply | restore [category]');
}
