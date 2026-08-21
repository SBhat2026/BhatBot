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

// INLINE RENDERER SCRIPTS. The walk above only sees .js, so src/index.html — 266KB, and the entire
// UI — had NO syntax check at all: a stray brace in an inline <script> bricks every panel at load
// with nothing but a console error, and `npm run verify` stayed green. The renderers are where most
// of the recent churn is (the SYNAPSE and FLEET 3D views), so this is exactly the file that needs it.
//
// Each block is checked in the right mode: `type="module"` blocks parse as ESM (they use top-level
// import/await), everything else as a script. importmap/JSON blocks are data, not code — skipped.
{
  const SRC = path.join(ROOT, 'src');
  const os = require('os');
  let htmlFiles = [];
  try { htmlFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.html')).map((f) => path.join(SRC, f)); } catch {}
  let blocks = 0, htmlBad = 0;
  for (const f of htmlFiles) {
    const html = fs.readFileSync(f, 'utf8');
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let m, i = 0;
    while ((m = re.exec(html))) {
      const attrs = m[1] || '', code = m[2];
      i++;
      if (/\bsrc\s*=/.test(attrs)) continue;                                  // external file
      if (/type\s*=\s*["'](importmap|application\/json|text\/template)/i.test(attrs)) continue;
      if (!code.trim()) continue;
      const isModule = /type\s*=\s*["']module["']/i.test(attrs);
      // Line-align the temp file so a reported line number maps back to the .html directly.
      const line = html.slice(0, m.index).split('\n').length;
      const tmp = path.join(os.tmpdir(), `vs-${path.basename(f)}-${i}.${isModule ? 'mjs' : 'js'}`);
      fs.writeFileSync(tmp, '\n'.repeat(line - 1) + code);
      blocks++;
      try { execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch (e) {
        htmlBad++;
        console.error('✗ ' + path.relative(ROOT, f) + ` (inline <script> #${i}, starts at line ${line})\n` +
          String((e.stderr || e.message || '')).split('\n').slice(0, 4).join('\n'));
      } finally { try { fs.unlinkSync(tmp); } catch {} }
    }
  }
  if (htmlBad) { console.error(`\n${htmlBad} inline script(s) failed to parse`); process.exit(1); }
  console.log(`✓ ${blocks} inline <script> blocks across ${htmlFiles.length} renderer(s) parse cleanly`);
}

// EXPORT-CONTRACT check (added after the lib/prompts.js name-collision regression that broke every
// agent turn — runtime-only, so --check missed it). For modules main.js destructures at require-time,
// a missing export = a runtime crash node --check can't see. Assert the critical exports actually exist.
const CONTRACTS = {
  './lib/prompts': ['classifyMode', 'selectModePrompt'],
  './lib/static-prompt': ['STATIC_PROMPT'],
  './lib/introspect': ['buildSelfPortrait', 'telemetryDelta'],
  './lib/reflect': ['reflect', 'resolveDesire', 'classifyActionability'],
  './lib/risk': ['riskOf', 'classifyDesire', 'checkFrozen', 'severeConcern', 'FROZEN_ZONE'],
  './lib/narrate': ['render', 'drill'],
  './lib/runtime-state': ['pushActivity', 'getActivity', 'snapshot', 'bind'],
  './lib/configsec': ['sanitizeWrite', 'migrate', 'findPlaintext'],
  './lib/agents/select': ['pick', 'run', 'shouldEscalate'],
  './tools/system': ['__factory'],   // factory: module.exports is a function
  './tools/media': ['__factory'],    // factory: module.exports is a function
  './tools/browser': ['__factory'],  // factory: module.exports is a function
  './window-manager': ['__factory'], // factory: module.exports is a function (SPLIT_PLAN step 8)
  './lib/history': ['validateHistory', 'evictOldImages', 'isRetryableTool', 'TRANSIENT_RE'],  // SPLIT_PLAN step 9
  './lib/selfdrive': ['startSession', 'runCycle', 'pickDesire', 'status', 'enabled', 'checkFrozenIntegrity', 'budgetPlan', 'requestStop', 'isRunning'],  // Phase 6 on-demand self-improvement
  './lib/health': ['trends', 'flags', 'portrait', 'brief', 'insights', 'normalize', 'setSleepOffset'],   // Health — biometric analysis
  './lib/garmin': ['available', 'sync', 'status', 'login', 'readHistory'],             // Health — Garmin link
  './lib/opsstatus': ['gather'],                                                        // Manage — ops aggregator
  './lib/localstt': ['available', 'transcribe', 'venvReady'],                           // Voice — offline mlx-whisper fallback
};
let missing = 0;
for (const [mod, exps] of Object.entries(CONTRACTS)) {
  let m; try { m = require(path.join(ROOT, mod)); } catch (e) { missing++; console.error(`✗ ${mod} failed to load: ${e.message}`); continue; }
  for (const name of exps) {
    if (name === '__factory') { if (typeof m !== 'function') { missing++; console.error(`✗ ${mod} should export a factory function`); } continue; }
    if (typeof m[name] === 'undefined') { missing++; console.error(`✗ ${mod} is missing export "${name}"`); }
  }
}
if (missing) { console.error(`\n${missing} export-contract violation(s)`); process.exit(1); }
console.log(`✓ export contracts intact (${Object.keys(CONTRACTS).length} modules)`);
process.exit(0);
