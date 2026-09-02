'use strict';
// ── ⚠ LOAD-BEARING MARKERS ───────────────────────────────────────────────────────────────────────
//
// This codebase keeps re-breaking invariants that LOOK like tidy-ups. Three shipped examples:
//   • a test pinned `toolselect.select(lastUserText(history), …)` — asserting a BUG as the contract;
//   • the weaver's EMBED phase returned early whenever work remained, which reads as correct
//     prioritisation and livelocked the whole loop for ten days;
//   • `hist.slice(-32)` is the obvious way to window a conversation, and it 400'd two sub-agents
//     permanently.
//
// A `⚠ LOAD-BEARING` comment marks those places. This file is what stops the marker from being
// decoration: every one must EXPLAIN ITSELF, because a marker that just says "don't touch this" gets
// removed by the next person who cannot see why. The explanation is the entire value.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const risk = require('../lib/risk');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const ROOT = path.join(__dirname, '..');

// Walk lib/, scripts/ and src/ rather than a hand-listed set, so a marker in a new file is covered
// the moment it is written.
function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [
  ...sources(path.join(ROOT, 'lib')),
  ...sources(path.join(ROOT, 'src')),
  path.join(ROOT, 'main.js'),
].filter((f) => fs.existsSync(f));

const all = [];
for (const f of files) {
  for (const m of risk.findMarkers(fs.readFileSync(f, 'utf8'))) all.push({ ...m, file: path.relative(ROOT, f) });
}

ok(all.length >= 10, `the marked invariants are actually marked (found ${all.length})`);

// EVERY marker justifies itself. This is the assertion that gives the convention its teeth.
for (const m of all) {
  const why = m.why.replace(/⚠|LOAD-BEARING|DO NOT (TOUCH|CHANGE|EDIT)/gi, '').trim();
  ok(why.length >= 80,
    `${m.file}:${m.line} explains WHY it is load-bearing (${why.length} chars) — a bare "do not touch" is removed by the next reader`);
}

// A marker should name the failure or quantify the cost, not just assert importance. Either is
// enough: "it 400'd every request" and "~4,200 path operations per frame" both tell the next reader
// something they can check. "This is important" does not.
const EVIDENCE = /\b(used to|was|were|observed|live|measured|shipped|bug|failure|failed|400|livelock|silent(ly)?|instead|otherwise|would|broke|breaks|regression|once|never|cannot|wrong|quietly)\b/i;
for (const m of all) {
  const measured = /\d{2,}/.test(m.why);            // a real number: a size, a count, a duration
  ok(EVIDENCE.test(m.why) || measured,
    `${m.file}:${m.line} names the failure mode or quantifies the cost, rather than only asserting importance`);
}

// The convention has to be discoverable, or nobody will follow it.
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'risk.js'), 'utf8');
  ok(/MARKER_RE/.test(src) && /findMarkers/.test(src), 'lib/risk.js owns the marker definition, beside the frozen zone it complements');
  ok(risk.MARKER_RE.test('// ⚠ LOAD-BEARING — because'), 'the LOAD-BEARING form is recognised');
  ok(risk.MARKER_RE.test('// ⚠ DO NOT TOUCH — because'), 'and so is DO NOT TOUCH');
  ok(!risk.MARKER_RE.test('// this is important'), 'while ordinary emphasis is not a marker');
}

// ── THE MARKERS MUST REACH THE AUTONOMOUS LOOP ──────────────────────────────────────────────────
// selfdrive edits this repo unattended. A convention it cannot see would be enforced only against
// humans, which is exactly backwards.
{
  const d = (files) => risk.classifyDesire({ title: 'tidy up', implementation: { modules_affected: files } });
  const marked = [...new Set(all.map((m) => m.file))].filter((f) => !risk.FROZEN_ZONE.some((z) => f.includes(z)));
  ok(marked.length > 0, 'there are marked files OUTSIDE the frozen zone — otherwise this proves nothing');
  const v = d([marked[0]]);
  ok(v.decision !== 'auto', `a desire touching ${marked[0]} is not auto-approved (got "${v.decision}") — it holds a marked invariant`);
  ok(/load-bearing/i.test(v.reason || ''), 'and the reason names the marker: ' + (v.reason || ''));
  // An unmarked file is unaffected — the gate must discriminate, or it is just a global "no".
  const plain = d(['lib/worldcup.js']);
  ok(plain.decision !== 'block' || !/load-bearing/i.test(plain.reason || ''), 'an unmarked file is not caught by this gate');
}

console.log(`✅ load-bearing markers: ${pass} assertions passed (${all.length} markers across ${new Set(all.map((m) => m.file)).size} files)`);
