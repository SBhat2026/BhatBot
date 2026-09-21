#!/usr/bin/env node
'use strict';
// Re-score a completed run against the CURRENT answer key, and report the hypotheses.
// Separate from the runner on purpose: correcting a key must never require re-spending on a run, and
// the correction must be visible as its own step rather than folded silently into the result.
const fs = require('fs');
const os = require('os');
const path = require('path');
const truth = require('./groundtruth');

const dir = process.argv[2] || fs.readdirSync(path.join(os.homedir(), '.bhatbot', 'experiments'))
  .filter((d) => /^\d{4}-/.test(d)).sort().pop();
const base = path.isAbsolute(dir) ? dir : path.join(os.homedir(), '.bhatbot', 'experiments', dir);
const r = JSON.parse(fs.readFileSync(path.join(base, 'result.json'), 'utf8'));

const KEY = new Set(truth.hits);
const NET = new Set(truth.networked);
const score = (names) => {
  const u = [...new Set(names)];
  const tp = u.filter((n) => KEY.has(n));
  return { named: u, tp, near: u.filter((n) => !KEY.has(n) && NET.has(n)), fab: u.filter((n) => !NET.has(n)),
    missed: [...KEY].filter((k) => !u.includes(k)),
    precision: u.length ? +(tp.length / u.length).toFixed(3) : 0, recall: +(tp.length / KEY.size).toFixed(3) };
};

const A = score(r.arms.a.named), B = score(r.arms.b.named);
const aUsd = r.arms.a.spendUsd, bUsd = r.arms.b.spendUsd;
const aS = r.arms.a.ms / 1000, bS = r.arms.b.ms / 1000;

const row = (n, s, usd, secs) => `  ${n.padEnd(9)} recall ${String(s.recall).padEnd(6)} precision ${String(s.precision).padEnd(6)} `
  + `TP ${s.tp.length}  near ${s.near.length}  fab ${s.fab.length}   $${usd.toFixed(4)}  ${secs.toFixed(1)}s`;

console.log(`ANSWER KEY (${KEY.size}): ${[...KEY].join(', ')}\n`);
console.log(row('A solo', A, aUsd, aS));
console.log('             found: ' + (A.tp.join(', ') || '—') + (A.fab.length ? '   |  wrong: ' + A.fab.join(', ') : ''));
console.log(row('B fanout', B, bUsd, bS));
console.log('             found: ' + (B.tp.join(', ') || '—') + (B.fab.length ? '   |  wrong: ' + B.fab.join(', ') : ''));
console.log('\n  union of both arms: ' + [...new Set([...A.tp, ...B.tp])].sort().join(', '));
console.log('  neither arm found:  ' + [...KEY].filter((k) => !A.tp.includes(k) && !B.tp.includes(k)).join(', '));
console.log(`\n  cost ratio B/A ${(bUsd / aUsd).toFixed(2)}×   wall-clock ratio B/A ${(bS / aS).toFixed(2)}×`);
console.log(`  true positives per dollar — A ${(A.tp.length / aUsd).toFixed(1)}   B ${(B.tp.length / bUsd).toFixed(1)}`);

// ── H5: did anyone actually listen? ───────────────────────────────────────────────────────────────
const names = (r.arms.b.perDrone || []).map((d) => d.persona);
const posts = r.arms.b.board || [];
const byAgent = {};
for (const p of posts) byAgent[p.agent] = (byAgent[p.agent] || 0) + 1;
const cited = (r.arms.b.perDrone || []).filter((d) =>
  names.some((n) => n !== d.persona && new RegExp('\\b' + n + '\\b').test(d.summary || '')));
console.log(`\n  H5 — board posts by agent: ${JSON.stringify(byAgent)}`);
console.log(`       drones whose report names a sibling: ${cited.length ? cited.map((d) => d.persona).join(', ') : 'none'}`);

fs.writeFileSync(path.join(base, 'rescored.json'), JSON.stringify({ keySize: KEY.size, key: [...KEY], a: A, b: B,
  ratios: { cost: bUsd / aUsd, wall: bS / aS }, boardByAgent: byAgent, citedSibling: cited.map((d) => d.persona) }, null, 2));
console.log('\nwritten → ' + path.join(base, 'rescored.json'));
