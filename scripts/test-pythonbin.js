#!/usr/bin/env node
'use strict';
// "python3" is whichever interpreter PATH offers today. On this machine that has been a Homebrew
// build without Pillow, a framework build with it, and whatever a venv activation left behind — all
// answering to the same name. So a bare `python3` works until it doesn't, and the failure reads as
// "the tool is broken" rather than "the wrong interpreter answered". It already cost a false verify
// failure here once.
const assert = require('assert');
const path = require('path');
const py = require(path.join(__dirname, '..', 'lib', 'pythonbin'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };

console.log('[pythonbin]');

{
  py.reset();
  const r = py.resolve({ requires: 'sys' });        // every python has sys
  assert.ok(r.proven, 'a universally available module must resolve: ' + JSON.stringify(r.tried));
  assert.ok(r.bin, 'and it names the interpreter');
  ok('an interpreter that satisfies the requirement is found and PROVEN');
}
{
  py.reset();
  const r = py.resolve({ requires: 'this_module_does_not_exist_anywhere_12345' });
  // THE IMPORTANT PART. It still returns something usable — a caller that needs to run anyway can —
  // but `proven:false` and `why` mean a failure downstream can be EXPLAINED instead of guessed at.
  assert.strictEqual(r.proven, false);
  assert.ok(r.bin, 'a best guess is still offered rather than nothing');
  assert.match(r.why, /import this_module_does_not_exist/);
  assert.ok(r.tried.length > 0, 'and it reports what it tried: ' + JSON.stringify(r.tried));
  ok('an unsatisfiable requirement returns proven:false with a reason, not a silent wrong answer');
}
{
  py.reset();
  const a = py.resolve({ requires: 'sys' });
  const b = py.resolve({ requires: 'sys' });
  assert.strictEqual(a.bin, b.bin);
  assert.strictEqual(a, b, 'cached by requirement — probing spawns a process, so it happens once');
  ok('resolution is cached per requirement');
}
{
  py.reset();
  // Different requirements resolve INDEPENDENTLY. This is the whole reason the module exists:
  // main.js picks its interpreter by probing for kokoro_onnx, which proves nothing about Pillow,
  // and reusing that answer for image work is how the wrong python gets chosen confidently.
  const a = py.resolve({ requires: 'sys' });
  const b = py.resolve({ requires: 'json' });
  assert.notStrictEqual(a, b, 'they are separate cache entries even when they agree');
  ok('each requirement is resolved on its own evidence');
}
{
  const list = py.candidates('/my/configured/python');
  assert.strictEqual(list[0], '/my/configured/python', 'a configured path is tried FIRST — it is a decision, not a guess');
  assert.ok(list.includes('python3'), 'and bare python3 remains the last resort');
  assert.strictEqual(list.indexOf('python3'), list.length - 1, 'LAST, because PATH is the least predictable of them');
  assert.strictEqual(new Set(list).size, list.length, 'no duplicates — each candidate costs a spawn');
  ok('candidate order puts an explicit choice first and PATH last');
}
{
  // filetools is the caller this was written for, and the one toolcheck flagged every run.
  const ft = require(path.join(__dirname, '..', 'lib', 'filetools'));
  assert.strictEqual(typeof ft.pythonBin, 'function', 'filetools exposes which interpreter it chose');
  const r = ft.pythonBin();
  assert.ok(r.bin, 'and it resolves one');
  ok('lib/filetools.js resolves its own interpreter rather than trusting PATH');
}

console.log(`[pythonbin] ${pass} assertions passed`);
