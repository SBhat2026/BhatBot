#!/usr/bin/env node
'use strict';
// UNTRUSTED-CODE WALL tests (lib/sandboxexec.js). The canary test is the load-bearing one: a real
// secret in the parent env MUST be invisible inside the sandbox, and HOME must point at a throwaway
// (never the real ~/.bhatbot). Run: node scripts/test-sandboxexec.js  (wired into npm run verify)
const fs = require('fs'), os = require('os'), path = require('path');
const sbx = require('../lib/sandboxexec');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- scrubEnv: allow-list only; secrets excluded by construction ----
process.env.BHATBOT_CANARY_SECRET = 'sk-do-not-leak-12345';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-canary';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sbxhome-'));
const env = sbx.scrubEnv(home);
ok(env.BHATBOT_CANARY_SECRET === undefined, 'scrubEnv: canary secret NOT copied');
ok(env.ANTHROPIC_API_KEY === undefined, 'scrubEnv: ANTHROPIC_API_KEY NOT copied');
ok(env.HOME === home && env.HOME !== os.homedir(), 'scrubEnv: HOME points at the throwaway, not the real home');
ok(env.PATH === process.env.PATH, 'scrubEnv: PATH is inherited (tools findable)');
ok(/\.npmrc$/.test(env.NPM_CONFIG_USERCONFIG) && env.NPM_CONFIG_USERCONFIG.startsWith(home), 'scrubEnv: npm userconfig redirected into throwaway');
ok(Object.keys(env).every((k) => !/key|token|secret|password|auth/i.test(k)), 'scrubEnv: no secret-shaped keys present at all');

(async () => {
  // ---- THE CANARY: run node inside the wall, print the env, assert the secret is invisible ----
  const script = 'console.log(JSON.stringify({secret: process.env.BHATBOT_CANARY_SECRET || null, anth: process.env.ANTHROPIC_API_KEY || null, home: process.env.HOME}))';
  const r = await sbx.run(process.execPath, ['-e', script], { home, timeoutMs: 20000, allowNetwork: true });
  ok(r.code === 0, 'run: sandboxed node process exits 0');
  let out = {}; try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch {}
  ok(out.secret === null, '🔒 CANARY: BHATBOT_CANARY_SECRET is INVISIBLE inside the sandbox');
  ok(out.anth === null, '🔒 CANARY: ANTHROPIC_API_KEY is INVISIBLE inside the sandbox');
  ok(out.home === home, 'run: sandboxed process sees the throwaway HOME');

  // ---- timeout: a hung command is killed ----
  const t0 = Date.now();
  const r2 = await sbx.run(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { home, timeoutMs: 1200, allowNetwork: true });
  ok(r2.timedOut === true && (Date.now() - t0) < 10000, 'run: a hung process is killed at the timeout');

  // ---- cwd honored + working exit code passthrough ----
  const r3 = await sbx.run(process.execPath, ['-e', 'process.exit(7)'], { home, timeoutMs: 20000, allowNetwork: true });
  ok(r3.code === 7, 'run: child exit code passes through');

  // report which isolation lane ran (informational)
  console.log(`   (lane: ${r.lane}${sbx.sandboxAvailable() ? '' : ' — sandbox-exec unavailable, env-scrub floor only'})`);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.BHATBOT_CANARY_SECRET;
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
