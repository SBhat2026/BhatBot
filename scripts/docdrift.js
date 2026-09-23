#!/usr/bin/env node
'use strict';
// ── DOES THE DOCUMENTATION DESCRIBE THIS REPO? ────────────────────────────────────────────────────
// A plan naming a file it intends to create is fine and normal. A document asserting that a file is
// "✅ built" when the file does not exist is a different thing — it is wrong, and ARCHITECTURE.md in
// particular is read by self-drive and reflection, so a false claim there is not just misleading a
// human. It is an instruction.
//
// Found on 2026-09-22: ARCHITECTURE.md listed `lib/router.js` as "✅ built" (it never existed under
// that name — `lib/routermodel.js` does the routing) and described agent tool execution as "not yet
// wired" long after base.js began calling runToolLoop. One claim invented a file, the other denied a
// working feature.
//
// So the rule is narrow on purpose: flag a lib path that does not exist ONLY on a line that also
// claims it is done. Everything aspirational passes untouched.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLAIMS_DONE = /✅|\bbuilt\b|\bshipped\b|\bdone\b|\bworking\b/i;
const findings = [];

for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.md'))) {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/lib\/([a-z0-9\-/]+)\.js/gi)) {
      if (fs.existsSync(path.join(ROOT, 'lib', `${m[1]}.js`))) continue;
      if (!CLAIMS_DONE.test(line)) continue;              // a plan may name what does not exist yet
      findings.push({ file: f, line: i + 1, module: `lib/${m[1]}.js`, text: line.trim().slice(0, 120) });
    }
  });
}

if (!findings.length) {
  console.log('\n  ✓ no document claims a lib module is built that does not exist\n');
} else {
  console.log(`\n  ${findings.length} claim(s) about modules that are not there:\n`);
  for (const f of findings) console.log(`    ${f.file}:${f.line}  ${f.module}\n      ${f.text}`);
  console.log('\n  Either the module was renamed and the doc was not, or the doc describes work that never happened.\n');
}
if (process.argv.includes('--strict') && findings.length) process.exit(1);
