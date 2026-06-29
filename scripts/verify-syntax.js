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
  './lib/health': ['trends', 'flags', 'portrait', 'brief', 'insights', 'normalize'],   // Health — biometric analysis
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
