#!/usr/bin/env node
'use strict';
// Unit tests for the action-completion guard helpers (isPromissory, shouldExtendBudget, toolSig)
// in lib/pure.js. Pure — the model judge (verifyActionDone) lives in main.js and is exercised live.
// Run: node scripts/test-action-guard.js   (wired into npm run verify)
const { isPromissory, shouldExtendBudget, toolSig, progressLine } = require('../lib/pure');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { console.log('✅ ' + name); pass++; } else { console.log('❌ ' + name); fail++; } }

// --- isPromissory: intent/promise vs report-of-done ---
ok('"I\'ll open Spotify" → promissory', isPromissory("I'll open Spotify and play that now."));
ok('"let me pull that up" → promissory', isPromissory('Let me pull that up for you.'));
ok('"going to run the build" → promissory', isPromissory("I'm going to run the build."));
ok('"On it, sir." → promissory', isPromissory('On it, sir.'));
ok('"Shall I open it?" → promissory', isPromissory('Shall I open it?'));
ok('"Done — opened Spotify." → NOT promissory (report)', !isPromissory('Done — opened Spotify.'));
ok('"I opened the file and it works." → NOT promissory', !isPromissory('I opened the file and it works.'));
ok('"Here\'s the summary." → NOT promissory', !isPromissory("Here's the summary of the three issues."));
ok('plain answer → NOT promissory', !isPromissory('The capital of France is Paris.'));
ok('empty → NOT promissory', !isPromissory(''));

// --- shouldExtendBudget: extend only under ceiling AND while productive ---
ok('extend when under ceiling + productive', shouldExtendBudget({ maxIters: 20, hardCeiling: 60, unproductive: 0 }) === true);
ok('extend still true at 2 unproductive', shouldExtendBudget({ maxIters: 20, hardCeiling: 60, unproductive: 2 }) === true);
ok('STOP extending when stuck (3 unproductive)', shouldExtendBudget({ maxIters: 20, hardCeiling: 60, unproductive: 3 }) === false);
ok('STOP at the hard ceiling', shouldExtendBudget({ maxIters: 60, hardCeiling: 60, unproductive: 0 }) === false);

// --- toolSig: same call = same sig, different args = different ---
ok('identical calls share a signature', toolSig('read_file', { path: 'a' }) === toolSig('read_file', { path: 'a' }));
ok('different args → different signature', toolSig('read_file', { path: 'a' }) !== toolSig('read_file', { path: 'b' }));
ok('different tool → different signature', toolSig('read_file', { path: 'a' }) !== toolSig('write_file', { path: 'a' }));

// --- progressLine: tool-aware, deterministic, always a non-empty spoken line ---
ok('known tool → its specific line', progressLine('make_figure') === 'Building the figure.');
ok('browser tool → its line', progressLine('browser') === 'Still working through the page.');
ok('unknown tool → a generic line (non-empty)', typeof progressLine('nope', 0.0) === 'string' && progressLine('nope', 0.0).length > 0);
ok('no tool → a generic line', progressLine(undefined, 0.5).length > 0);
ok('rnd is deterministic for tests', progressLine(null, 0) === progressLine(null, 0));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
