#!/usr/bin/env node
'use strict';
// Workspace CLI (Phase 1).  node scripts/ws.js <cmd>
//   create "<name>"   create + activate a workspace
//   list              list workspaces
//   use <slug>        set active workspace
//   show [slug]       print goals + state digest + open tasks (active if omitted)
const ws = require('../lib/workspace');
const State = require('../lib/state');

const [cmd, ...args] = process.argv.slice(2);

function show(slug) {
  const w = ws.load(slug);
  const s = State.open(w.dir);
  console.log(`# ${w.workspace.name} (${slug})`);
  console.log(`north_star: ${w.goals.north_star || '—'}`);
  console.log(`state v${s.version()}: ${s.digest() || '(empty)'}`);
  console.log(`open tasks: ${w.openTasks.length}`);
  for (const t of w.openTasks) console.log(`  • [${t.status}] ${t.agent}: ${t.goal}`);
}

switch (cmd) {
  case 'create': {
    if (!args[0]) { console.error('usage: ws create "<name>"'); process.exit(1); }
    const { slug, dir } = ws.create(args.join(' '));
    ws.setActive(slug);
    console.log(`✓ created + active: ${slug}\n  ${dir}`);
    break;
  }
  case 'list': {
    const all = ws.list(); const active = ws.getActive();
    if (!all.length) { console.log('(no workspaces) — ws create "<name>"'); break; }
    for (const w of all) console.log(`${w.slug === active ? '*' : ' '} ${w.slug}  —  ${w.name}`);
    break;
  }
  case 'use': {
    if (!args[0]) { console.error('usage: ws use <slug>'); process.exit(1); }
    console.log('✓ active: ' + ws.setActive(args[0]));
    break;
  }
  case 'show': {
    const slug = args[0] || ws.getActive();
    if (!slug) { console.error('no active workspace'); process.exit(1); }
    show(slug);
    break;
  }
  default:
    console.log('usage: ws <create|list|use|show> [args]');
}
