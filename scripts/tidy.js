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
const SKIP_TOP = new Set(['Library', 'Pictures', 'Music', 'Movies', 'Applications', 'Public', 'vec', 'bhatbot',
  'miniforge3', 'anaconda3', 'miniconda3', 'BhatBot-Cleanup-Review']);
function roots() {
  const out = [{ path: HOME, shallow: true }];
  for (const e of fs.readdirSync(HOME, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_TOP.has(e.name)) continue;
    if (fs.existsSync(path.join(HOME, e.name, 'pyvenv.cfg'))) continue;           // a Python environment, not files
    out.push({ path: path.join(HOME, e.name) });
  }
  return out;
}

if (cmd === 'scan') {
  let conf = null;
  try { conf = (JSON.parse(fs.readFileSync(path.join(HOME, '.bhatbot', 'config.json'), 'utf8')).autonomy || {}).confidential || null; } catch {}
  const t0 = Date.now();
  const r = tidy.scan({ roots: roots(), home: HOME, exclude: [DEST], confidential: conf });
  // Installers get an honest reason: whether the app is actually in Applications, and where the file
  // came from (macOS records the download URL), so "can I get it back?" is answered on the card.
  const apps = (() => { try { return fs.readdirSync('/Applications').map((a) => a.toLowerCase()); } catch { return []; } })();
  const { spawnSync } = require('child_process');
  for (const f of r.findings.filter((x) => x.category === 'installers' && /\.dmg$/i.test(x.path))) {
    let from = '';
    try { from = ((spawnSync('/usr/bin/mdls', ['-raw', '-name', 'kMDItemWhereFroms', f.path], { encoding: 'utf8', timeout: 4000 }).stdout || '').match(/https?:\/\/([^/"]+)/) || [])[1] || ''; } catch {}
    const stem = path.basename(f.path).replace(/[-_ ]?v?\d[\d.]*\.dmg$|\.dmg$/i, '').toLowerCase();
    const site = from.replace(/^www\./, '');
    // A file named by its platform ("mac-arm64.dmg") says nothing about what it installs; the
    // download path does. Known sources first, then a name match.
    const fromPath = (() => { try { return (spawnSync('/usr/bin/mdls', ['-raw', '-name', 'kMDItemWhereFroms', f.path], { encoding: 'utf8', timeout: 4000 }).stdout || ''); } catch { return ''; } })();
    const installed = /claude-science/.test(fromPath) ? apps.find((a) => a === 'claude science.app')
      : stem && !/^mac-?arm/.test(stem) ? apps.find((a) => a.endsWith('.app') && a.includes(stem)) : null;
    f.reason = (installed ? `installer for ${installed.replace(/\.app$/, '')}, which is already installed` : 'installer for an app that is not installed')
      + (site ? ` — re-downloadable from ${site}` : '');
  }
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
