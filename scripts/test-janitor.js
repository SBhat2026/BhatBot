#!/usr/bin/env node
'use strict';
// BhatBot's own janitor (2026-11-14: "I want BhatBot to be making the decisions, not Claude").
// Runs the real collect → review page → purge / restore path on a throwaway tree, checks the
// autonomy gate asks first and learns, and checks main.js actually schedules it.
//   node scripts/test-janitor.js      (wired into npm run verify)
const fs = require('fs');
const os = require('os');
const path = require('path');
const tidy = require('../lib/tidy');
const { createAutonomy, classify } = require('../lib/autonomy');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-'));
const home = path.join(root, 'home'), dest = path.join(home, 'BhatBot-Cleanup-Review');
const put = (p, data, ageDays = 30) => { const f = path.join(home, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); const t = Date.now() / 1000 - ageDays * 86400; fs.utimesSync(f, t, t); return f; };
const big = Buffer.alloc(2 << 20, 7);
put('Documents/paper/figure.png', big);
const dup = put('Downloads/figure.png', big);
put('Downloads/notes.txt.bak', 'old');
put('Documents/keep.txt', 'mine');
const outside = put('Documents/not-collected.txt', 'never touched');

const r = tidy.scan({ roots: [{ path: home }], home, exclude: [dest] });
const cats = new Set(r.findings.map((f) => f.category));
ok(r.findings.some((f) => f.path === dup && f.category === 'duplicates'), 'the Downloads copy is found as a duplicate');
ok(cats.has('backups'), 'the .bak is found as a backup');
ok(!r.findings.some((f) => /keep\.txt|figure\.png$/.test(f.path) && f.path.includes('/Documents/')), 'originals are never collected');

tidy.apply(r.findings, { dest, home });
let p = tidy.pending(dest);
ok(p.items.length === r.findings.length && !fs.existsSync(dup), 'collect MOVES findings into the review folder');
ok(p.bytes >= big.length && p.byCat.duplicates.n === 1, 'pending() reports what is waiting, by category');

const html = tidy.reviewPage({ items: p.items, skipped: r.skipped, filesWalked: r.stats.filesWalked, home, dest });
ok(/Cleanup Review/.test(html) && /Exact duplicates/.test(html) && /~\/Downloads\/figure\.png/.test(html), 'the review page names each item by where it came from');
ok(/prefers-color-scheme:dark/.test(html) && /Nothing has been deleted/.test(html), 'and says nothing is deleted yet, in both themes');

// ── the gate: a purge is a delete, so the first one asks, and his yeses are learned ──
const c1 = classify('tidy_files', { action: 'purge', count: 3, bytes: 3e6 });
ok(c1 && c1.cls === 'delete' && c1.signature === 'delete:tidy:all' && !c1.important, `a purge is a learnable delete (${c1 && c1.label})`);
ok(classify('tidy_files', { action: 'purge', category: 'dependencies' }).important, 'purging old-project dependencies is a judgement call — always asks');
ok(classify('tidy_files', { action: 'purge', judgement: true }).important, 'and so is an all-purge that includes them');
ok(classify('tidy_files', { action: 'purge', bytes: 60e9 }).important, 'and so is a huge one (60 GB)');
ok(classify('tidy_files', { action: 'collect' }) === null && classify('tidy_files', { action: 'restore' }) === null, 'collect and restore are reversible — never asked about');
let st = null;
const A = createAutonomy({ load: () => st, save: (s) => { st = JSON.parse(JSON.stringify(s)); } });
let d = A.decide('tidy_files', { action: 'purge' });
ok(d.verdict === 'ask', 'the first purge asks');
for (let i = 0; i < 5 && d.verdict === 'ask'; i++) { A.learn(d, true); d = A.decide('tidy_files', { action: 'purge' }); }
ok(d.verdict === 'allow' && /standard/.test(d.why), `after his yeses a routine purge stops asking (${d.reasons[0]})`);
A.learn(A.decide('tidy_files', { action: 'purge', category: 'duplicates' }), false);
ok(A.decide('tidy_files', { action: 'purge', category: 'duplicates' }).verdict === 'ask', 'a "no" is remembered for that category');

// ── restore one category, purge the rest ──
const back = tidy.restore(dest, { only: 'duplicates' });
ok(back.restored === 1 && fs.existsSync(dup), 'restore puts one category back exactly where it was');
const gone = tidy.purge(dest);
p = tidy.pending(dest);
ok(gone.purged >= 1 && p.items.length === 0, `purge deletes what is still collected (${gone.purged})`);
ok(fs.existsSync(dup) && fs.existsSync(outside), 'and nothing it did not collect — the restored file and the untouched one are still there');
ok(fs.existsSync(path.join(dest, 'manifest.json')) && !fs.existsSync(path.join(dest, 'backups')), 'the manifest stays as the record; emptied folders go');
// a manifest entry pointing outside the folder is refused
const mp = path.join(dest, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
m.items.push({ category: 'backups', to: outside, from: outside, bytes: 1 }); fs.writeFileSync(mp, JSON.stringify(m));
const evil = tidy.purge(dest);
ok(evil.purged === 0 && evil.failed.length === 1 && fs.existsSync(outside), 'a manifest entry outside the review folder is never deleted');

// ── it is BhatBot's job: wired, scheduled, and gated ──
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/case 'tidy_files':/.test(main), 'the tool is handled');
ok(/setInterval\(\(\) => \{ janitorTick\(\)/.test(main) && /setTimeout\(\(\) => \{ janitorTick\(\)/.test(main), 'the janitor runs on its own clock (soon after launch, then every 6 h)');
ok(/await executeTool\('tidy_files', \{ action: 'purge'/.test(main), 'its purge goes through executeTool — the autonomy gate, the audit log');
ok(/c\.autonomyPolicy === false\) \{ tidySaveState[\s\S]{0,120}openPath[\s\S]{0,40}return; \}/.test(main), 'with the gate switched off it shows the page and never purges unasked');
ok(/tidy\.restore\(TIDY_DEST\)/.test(main.slice(main.indexOf('async function janitorTick'))), 'a "no" puts the files back');
const all = require('../lib/tools-schema')();
ok(all.some((t) => t.name === 'tidy_files'), 'the model can call it');

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} janitor: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
