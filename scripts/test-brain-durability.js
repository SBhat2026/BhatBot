'use strict';
// GRAPH DURABILITY — the second brain must not be destroyable by a mistimed kill.
//
// graph.json is currently 68MB / 1,772 nodes: everything BhatBot has learned. Before this, save()
// was a non-atomic writeFileSync of that whole file and load() treated an unparseable file as an
// empty graph. So the chain was:
//     kill the app mid-write  →  truncated file
//     next boot               →  load() silently yields {} (looks like a first run)
//     next save               →  {} is written over 68MB, permanently
// No error at any step. This pins all three guards.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const brain = require('../lib/brain');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brain-dur-'));
const quiet = (fn) => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };

// ── a genuinely absent file is a first run, not an error ──────────────────────────────────────
{
  const dir = tmpdir();
  const b = brain.createBrain({ dir });
  ok(b.loadFailed() === false, 'no file yet → not a failure, just an empty graph');
  b.upsertNode({ type: 'project', ref: 'p1', label: 'One' }, 1);
  b.save();
  ok(fs.existsSync(path.join(dir, 'graph.json')), 'and it saves normally');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── a CORRUPT file is not an empty graph ──────────────────────────────────────────────────────
{
  const dir = tmpdir();
  const file = path.join(dir, 'graph.json');
  const b1 = brain.createBrain({ dir });
  for (let i = 0; i < 50; i++) b1.upsertNode({ type: 'project', ref: 'p' + i, label: 'P' + i }, 1);
  b1.save();
  const good = fs.readFileSync(file, 'utf8');
  ok(Object.keys(JSON.parse(good).nodes).length === 50, 'precondition: 50 nodes on disk');

  // Truncate it the way a killed process would.
  fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));
  const b2 = quiet(() => brain.createBrain({ dir }));
  ok(b2.loadFailed() === true, 'a truncated file is reported as a LOAD FAILURE, not silently empty');
  ok(b2.stats().nodes === 0, 'the in-memory store is empty (nothing else is possible)');

  // The critical assertion: it must refuse to overwrite.
  const before = fs.readFileSync(file, 'utf8');
  quiet(() => b2.save());
  ok(fs.readFileSync(file, 'utf8') === before, 'save() REFUSES to overwrite the damaged file — this is the step that used to destroy everything');

  const salvaged = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  ok(salvaged.length === 1, 'and the damaged bytes are preserved for salvage');
  ok(fs.readFileSync(path.join(dir, salvaged[0]), 'utf8') === before, 'byte-identical to what was on disk');

  quiet(() => b2.save({ force: true }));
  ok(fs.readFileSync(file, 'utf8') !== before, 'an explicit { force: true } can still override — the guard is a safety catch, not a wall');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── never write an empty graph over a populated one ───────────────────────────────────────────
{
  const dir = tmpdir();
  const file = path.join(dir, 'graph.json');
  const b = brain.createBrain({ dir });
  for (let i = 0; i < 200; i++) b.upsertNode({ type: 'file', ref: 'f' + i, label: 'F' + i }, 1);
  b.save();
  const size = fs.statSync(file).size;
  ok(size > 4096, 'precondition: a substantial graph on disk');

  // A fresh handle whose store is empty for any reason must not be able to flatten it.
  const empty = brain.createBrain({ dir });
  empty._store().nodes = {};
  empty._store().edges = {};
  quiet(() => empty.save());
  ok(fs.statSync(file).size === size, 'an empty store cannot overwrite a populated file by accident');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── the write is ATOMIC ───────────────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'brain.js'), 'utf8');
  ok(/renameSync\(tmp, file\)/.test(src), 'save() renames a temp file into place — a reader sees old or new, never half');
  // Check the FUNCTION BODY, not the file: save()'s own comment quotes the old line verbatim, and a
  // grep-shaped assertion that matches a comment about the bug is the same mistake twice.
  const saveBody = src.slice(src.indexOf('function save({ force'), src.indexOf('  load();'));
  const code = saveBody.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  ok(!/writeFileSync\(file,/.test(code), 'and no longer writes 68MB directly over the live file');
  ok(/save failed/.test(src), 'a failed save is reported — losing a cycle of work used to be swallowed entirely');

  // Prove the temp file does not survive a normal save.
  const dir = tmpdir();
  const b = brain.createBrain({ dir });
  b.upsertNode({ type: 'project', ref: 'x', label: 'X' }, 1);
  b.save();
  ok(!fs.existsSync(path.join(dir, 'graph.json.tmp')), 'no .tmp left behind after a successful save');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`✅ brain durability: ${pass} assertions passed`);
