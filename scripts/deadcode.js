#!/usr/bin/env node
'use strict';
// ── WHAT IS BUILT BUT CONNECTED TO NOTHING? ───────────────────────────────────────────────────────
// A module with a passing test suite and no caller is the most expensive kind of dead code, because
// every signal says it is finished. Three were found this way on 2026-09-22 — including
// lib/sandboxexec.js, the untrusted-code wall that lib/drone.js promises every hermetic drone in its
// own system prompt, and which nothing invoked.
//
// THE SCAN MUST BE EXHAUSTIVE OR IT LIES. The first version of this audit read main.js, mcp-server.js,
// lib/, src/ and scripts/ — and reported lib/addressivity.js as dead. It is not: preload.js requires
// it, and preload*.js was not in the list. Acting on that would have broken the voice path. A
// too-narrow scan does not produce a smaller answer, it produces a WRONG one, so the file list is
// derived by walking the repo rather than enumerated by hand.
//
//   node scripts/deadcode.js          # report
//   node scripts/deadcode.js --strict # exit 1 if anything is unreferenced (for verify)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = /node_modules|[/\\]dist[/\\]|\.git|__pycache__|venv|OmniParser|[/\\]vendor[/\\]/;

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Everything that could possibly reference a lib module: the whole repo, minus vendored trees.
const files = walk(ROOT);
const sources = new Map();
for (const f of files) { try { sources.set(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')); } catch {} }

const mods = fs.readdirSync(path.join(ROOT, 'lib'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => f.slice(0, -3));

// A reference is the module name in quotes inside something that looks like a require/import — which
// catches require('./x'), require('../lib/x'), and require(path.join(ROOT,'lib','x')) alike. Matching
// the bare name anywhere would count prose in a comment as a caller.
function referenced(mod) {
  const q = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = new RegExp(`(require|import|from)\\s*\\(?[^\\n;]{0,80}['"\`/]${q}['"\`]`);
  const own = `lib/${mod}.js`, test = `scripts/test-${mod}.js`;
  const hits = [];
  for (const [f, s] of sources) {
    if (f === own || f === test) continue;      // a module is not its own caller, nor is its test
    if (pat.test(s)) hits.push(f);
  }
  return hits;
}

const dead = [];
for (const m of mods) {
  const hits = referenced(m);
  if (!hits.length) dead.push({ mod: m, bytes: fs.statSync(path.join(ROOT, 'lib', `${m}.js`)).size, tested: fs.existsSync(path.join(ROOT, 'scripts', `test-${m}.js`)) });
}

console.log(`\nscanned ${sources.size} files for callers of ${mods.length} lib modules\n`);
if (!dead.length) {
  console.log('  ✓ every module in lib/ is referenced by something');
} else {
  console.log('  UNREFERENCED — built, possibly tested, and called by nothing:\n');
  for (const d of dead.sort((a, b) => b.bytes - a.bytes)) {
    console.log(`    ${d.mod.padEnd(20)} ${String(d.bytes).padStart(7)}B   test:${d.tested ? 'yes  ← green tests, no caller' : 'no'}`);
  }
  console.log('\n  Each is either a missing seam or a file to delete. A passing test suite is not evidence of either.');
}
if (process.argv.includes('--strict') && dead.length) process.exit(1);
