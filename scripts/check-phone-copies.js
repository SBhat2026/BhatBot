#!/usr/bin/env node
'use strict';
// scripts/check-phone-copies.js — drift detector for the three phone-UI copies.
//
//   src/mobile.html          ← SOURCE OF TRUTH (served by the desktop app; edited by hand)
//   phone-app/Web/mobile.html ← the installable PWA copy
//   cloud/public/mobile.html  ← served by the always-on cloud backend
//
// These have historically drifted silently — a feature added to src (e.g. the Health screen) never
// reached the other two, so phone/cloud users quietly missed it. This script makes that drift LOUD:
// it reports which source lines are missing from each copy so a reviewer can decide, per feature,
// whether to port it or whether the divergence is intentional (e.g. Health needs the Mac's Garmin
// link, so it may not belong on the cloud copy). It does NOT auto-overwrite — the copies aren't
// guaranteed byte-identical by design, so a forced sync could push a Mac-only feature onto a
// surface that can't support it.
//
// Usage:  node scripts/check-phone-copies.js         (report; exits 1 if drift found)
//         npm run check:phone
// Wire into a pre-commit hook once the copies are deliberately reconciled; it's intentionally NOT
// in `npm run verify` today because the known Health drift would fail the whole suite.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'mobile.html');
const COPIES = [
  path.join(ROOT, 'phone-app', 'Web', 'mobile.html'),
  path.join(ROOT, 'cloud', 'public', 'mobile.html'),
];

// Named feature markers so the report says WHAT drifted, not just how many lines.
const FEATURES = [
  { name: 'Health screen', marker: 'view-health' },
  { name: 'Nexus screen', marker: 'view-nexus' },
  { name: 'Voice control', marker: 'bb_voice' },
  { name: 'Activity feed', marker: 'view-activity' },
];

function sigLines(txt) {
  // Significant = trimmed, non-empty, non-trivial. Set semantics so pure reordering isn't flagged.
  return new Set(txt.split('\n').map((l) => l.trim()).filter((l) => l.length > 3));
}

function rel(p) { return path.relative(ROOT, p); }

if (!fs.existsSync(SRC)) { console.error('✗ source of truth missing: ' + rel(SRC)); process.exit(2); }
const srcTxt = fs.readFileSync(SRC, 'utf8');
const srcSig = sigLines(srcTxt);

let drift = false;
console.log(`Phone-copy drift check — source of truth: ${rel(SRC)} (${srcSig.size} significant lines)\n`);

for (const copy of COPIES) {
  if (!fs.existsSync(copy)) { console.log(`⚠ ${rel(copy)} — MISSING`); drift = true; continue; }
  const copyTxt = fs.readFileSync(copy, 'utf8');
  const copySig = sigLines(copyTxt);
  const missing = [...srcSig].filter((l) => !copySig.has(l));   // in src, not in copy
  const extra = [...copySig].filter((l) => !srcSig.has(l));     // in copy, not in src
  if (!missing.length && !extra.length) { console.log(`✅ ${rel(copy)} — in sync`); continue; }
  drift = true;
  console.log(`⚠ ${rel(copy)} — ${missing.length} source line(s) missing, ${extra.length} local-only line(s)`);
  const feats = FEATURES.filter((f) => srcTxt.includes(f.marker) && !copyTxt.includes(f.marker));
  if (feats.length) console.log(`   missing features: ${feats.map((f) => f.name).join(', ')}`);
  for (const l of missing.slice(0, 3)) console.log(`   − ${l.slice(0, 90)}`);
  if (missing.length > 3) console.log(`   … +${missing.length - 3} more missing`);
}

console.log('');
if (drift) { console.log('DRIFT DETECTED — review above; port missing features or document intentional divergence.'); process.exit(1); }
console.log('✅ all phone copies in sync.');
process.exit(0);
