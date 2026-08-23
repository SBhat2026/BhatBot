#!/usr/bin/env node
'use strict';
// ── SILENT-DEGRADE AUDIT ─────────────────────────────────────────────────────────────────────────
//
// This session found the same bug five separate times, always with the same shape: something fails,
// the failure is swallowed into a legitimate-looking empty value, and the caller cannot tell the
// difference between "nothing was there" and "something broke".
//
//   • a corrupt graph.json read as an empty graph — and the next save wrote {} over 68MB
//   • a dropped timeout argument let one background item run for 2h50m
//   • a $ cap that could never fire because nothing reported cost
//   • a subagent that ran out of steps returned "(completed, no text output)" as a SUCCESS
//   • a DAG result envelope that failed to parse dropped every structured field
//
// Eyeballing found those. This finds them again, and finds the next one — so the check survives the
// person doing it. Run it as part of a review pass:  node scripts/check-silent-degrade.js
//
// It is a REVIEW AID, not a gate. It reports and exits 0 unless --strict, because the honest answer
// for most matches is "this one is fine": `fs.existsSync` in a try genuinely IS the answer, and
// making it loud would be noise that trains you to ignore the real ones.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'OmniParser', 'phone-app', 'BhatBall', 'cloud']);

// Patterns worth a human look, ordered by how badly they bit us.
const CHECKS = [
  {
    id: 'destructive-write',
    why: 'a non-atomic write of persistent state — a crash mid-write truncates the file, and the next read may treat the remains as empty',
    // writeFileSync straight to a real path, with no tmp+rename anywhere in the same function.
    re: /fs\.writeFileSync\(\s*(?!.*\.tmp)([A-Za-z_$][\w$.]*(?:PATH|FILE|file|path))\s*,/,
    ok: (src) => /renameSync\(/.test(src),
  },
  {
    id: 'corrupt-reads-as-empty',
    why: 'a parse failure returns an empty collection, so a CORRUPT file is indistinguishable from an absent one',
    re: /catch\s*(\([^)]*\))?\s*\{\s*return\s*(\{\s*\}|\[\s*\]|\{\s*v:\s*1)/,
    ok: (src, line) => /console\.(warn|error)/.test(line) || /existsSync|statSync|readdirSync/.test(line),
  },
  {
    id: 'model-output-parse',
    why: 'model output parsed with a regex; when it fails the caller usually degrades to "found nothing", which looks like a real empty answer',
    re: /\.match\(\/\\?\{\[\\s\\S\]\*\\?\}\/\)|\.match\(\/\\?\[\[\\s\\S\]\*\\?\]\/\)/,
    ok: (src, line, fn) => /console\.(warn|error)|parseFailed|schema/.test(fn),
  },
  {
    id: 'swallowed-await',
    why: 'an awaited call inside an empty catch — if it throws, the work silently did not happen',
    re: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    ok: (src, line) => !/await/.test(line),
  },
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.startsWith('test-')) out.push(p);
  }
  return out;
}

/** The enclosing function body, so a check can see whether the failure is handled nearby. */
function around(lines, i, span = 12) {
  return lines.slice(Math.max(0, i - span), Math.min(lines.length, i + span)).join('\n');
}

const files = walk(path.join(ROOT, 'lib')).concat([path.join(ROOT, 'main.js')]);
const findings = [];

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;   // a comment ABOUT the bug is not the bug
    for (const c of CHECKS) {
      if (!c.re.test(line)) continue;
      if (c.ok && c.ok(src, line, around(lines, i))) continue;
      findings.push({ file: path.relative(ROOT, f), line: i + 1, id: c.id, why: c.why, code: line.trim().slice(0, 110) });
    }
  }
}

const byCheck = {};
for (const f of findings) (byCheck[f.id] = byCheck[f.id] || []).push(f);

console.log(`\nSilent-degrade audit — ${files.length} files\n`);
for (const c of CHECKS) {
  const hits = byCheck[c.id] || [];
  console.log(`${hits.length ? '⚠' : '✓'} ${c.id}  (${hits.length})`);
  if (hits.length) {
    console.log(`    ${c.why}`);
    for (const h of hits.slice(0, 8)) console.log(`      ${h.file}:${h.line}  ${h.code}`);
    if (hits.length > 8) console.log(`      … and ${hits.length - 8} more`);
  }
}
console.log(`\n${findings.length} site(s) worth a look. Most are fine — "file missing → empty" IS the answer.`);
console.log('What matters is whether a CALLER can tell a failure from a legitimately empty result.\n');

if (process.argv.includes('--strict') && findings.length) process.exit(1);
