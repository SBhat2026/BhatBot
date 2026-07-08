#!/usr/bin/env node
'use strict';
// PROJECT PERSISTENCE for the build_project completion engine: locked specs + produced artifacts are
// saved on the project record and folded into the resume context, so "continue <project>" picks up the
// ACTUAL build (exact specs + artifact files), not a vague gist. Runs against a temp DIR via a require
// override of the projects module's data dir. Run: node scripts/test-projects-build.js (in verify).
const fs = require('fs'), os = require('os'), path = require('path');

// Point the projects module at a throwaway dir before requiring it (it reads DIR at module init).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-proj-'));
process.env.BHATBOT_PROJECTS_DIR = tmp;   // honored if supported; otherwise we clean up whatever DIR it uses
const projects = require('../lib/projects');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

(async () => {
  const p = projects.open('Iron Man Suit');
  const slug = p.slug;
  ok(slug && p.name === 'Iron Man Suit', 'open: creates a project record');

  // ---- recordSpec: locked specs merge + persist ----
  projects.recordSpec(slug, { height: '70.5in', build: 'lean, 38R', colors: 'blue/silver' });
  projects.recordSpec(slug, { features: 'repulsors, energy shield, grapple', flight: 'yes', chest: '38R (assumed)' });
  const rec1 = projects.get(slug);
  ok(rec1.specs.height === '70.5in' && rec1.specs.features.includes('repulsors'), 'recordSpec: merges successive spec objects');
  ok(rec1.specs.chest === '38R (assumed)', 'recordSpec: keeps assumed-default specs');

  // ---- recordArtifact: produced deliverables with paths ----
  projects.recordArtifact(slug, { kind: 'studio', title: 'Iron Man Suit', path: '/tmp/studio/index.html' });
  projects.recordArtifact(slug, { kind: 'sim', title: 'physics', meta: { summary: 'T/W 3.2, ceiling 18km' } });
  const rec2 = projects.get(slug);
  ok(rec2.artifacts.length === 2 && rec2.artifacts[0].kind === 'studio' && rec2.artifacts[0].path.endsWith('index.html'), 'recordArtifact: stores artifacts with kind + path');
  ok(rec2.artifacts[1].meta && rec2.artifacts[1].meta.summary.includes('T/W'), 'recordArtifact: keeps meta (physics numbers)');

  // ---- resume context surfaces BOTH specs and artifacts ----
  projects.setActive(slug);
  const ctx = projects.contextBlock();
  ok(/ACTIVE PROJECT: Iron Man Suit/.test(ctx), 'contextBlock: names the active project');
  ok(/SPECS —/.test(ctx) && /blue\/silver/.test(ctx), 'contextBlock: folds locked specs into resume context');
  ok(/ARTIFACTS —/.test(ctx) && /studio/.test(ctx) && /index\.html/.test(ctx), 'contextBlock: folds produced artifacts (with paths) into resume context');

  // ---- persistence survives a reload (durable across turns/rate-limits) ----
  const reloaded = projects.get(slug);
  ok(reloaded.specs.colors === 'blue/silver' && reloaded.artifacts.length === 2, 'persistence: specs + artifacts survive a fresh load');

  // ---- normalize is backward-compatible with old records (no specs/artifacts fields) ----
  const legacyPath = path.join((projects._DIR || tmp), slug + '.json');
  try {
    const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    delete raw.specs; delete raw.artifacts;
    fs.writeFileSync(legacyPath, JSON.stringify(raw));
    const back = projects.get(slug);
    ok(back && typeof back.specs === 'object' && Array.isArray(back.artifacts), 'normalize: legacy record without specs/artifacts loads with empty defaults');
  } catch (e) { ok(false, 'normalize legacy check: ' + e.message); }

  try { fs.rmSync(tmp, { recursive: true, force: true }); if (projects._DIR && projects._DIR !== tmp) { /* leave real dir untouched */ } } catch {}
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
