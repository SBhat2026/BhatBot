#!/usr/bin/env node
'use strict';
// Resume a workspace from its latest checkpoint — zero transcript needed. Prints the
// resume token (state digest + open tasks + next actions) a new session would seed from.
//   node scripts/resume.js [<slug>]
const ws = require('../lib/workspace');
const ctx = require('../lib/context');

const slug = process.argv[2] || ws.getActive();
if (!slug) { console.error('no active workspace; pass a slug'); process.exit(1); }
const w = ws.load(slug);
const cp = ctx.resume(w.dir);
if (!cp) { console.log(`${slug}: no checkpoint yet. Run an orchestration first.`); process.exit(0); }
console.log(`# resume ${slug}  (checkpoint ${cp.ts}, state v${cp.version})`);
console.log(`state: ${cp.state_digest || '(empty)'}`);
console.log(`open tasks (${cp.open_tasks.length}):`);
for (const t of cp.open_tasks) console.log(`  • [${t.status}] ${t.agent}: ${t.goal}`);
if (cp.next_actions && cp.next_actions.length) { console.log('next:'); for (const n of cp.next_actions) console.log('  → ' + n); }
