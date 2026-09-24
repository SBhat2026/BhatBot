#!/usr/bin/env node
'use strict';
// ── CAN IT ACTUALLY OPEN A BROWSER? ───────────────────────────────────────────────────────────────
// Five tools (`browser`, `browser_workflow`, `browser_observe`, `browser_devtools`, `smart_login`)
// are one `chromium.launch()` away from working or dead, and nothing reported which until you asked
// the agent to browse — at which point the failure reads as "the tool is broken" rather than "no
// browser binary is installed".
//
// BACKLOG.md carried an entry saying all five were dead because the Playwright cache directory did
// not exist. On 2026-09-23 it did exist and both launch paths worked. The claim had gone stale and
// nobody re-checked it for weeks, which is the actual failure this script exists to prevent: a
// standing worry that answers itself every time it is asked.
//
// It launches HEADLESS on purpose. The app launches headful (a real visible window), but a headless
// launch exercises the same binary, the same sandbox flags and the same profile machinery without
// stealing focus from whatever you are doing — and a headless success with a headful failure would
// be a window-server permission problem, which the report says out loud.
//
//   node scripts/browser-doctor.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
const line = (s) => console.log(s);

async function tryLaunch(label, opts) {
  const t0 = Date.now();
  let b;
  try {
    const { chromium } = require('playwright');
    b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], ...opts });
    const p = await b.newPage();
    // A page that renders and reports its own title proves more than a process that started: a
    // launched-but-broken Chromium exits the moment it is asked to do anything.
    await p.setContent('<title>browser-doctor</title><h1>ok</h1>');
    const title = await p.title();
    const h1 = await p.textContent('h1');
    await b.close();
    const ms = Date.now() - t0;
    const good = title === 'browser-doctor' && h1 === 'ok';
    line(`${good ? '✓' : '✗'} ${label} — ${good ? `rendered and read back its own title in ${ms}ms` : `launched but rendered wrong (title=${title} h1=${h1})`}`);
    return good;
  } catch (e) {
    try { if (b) await b.close(); } catch {}
    line(`✗ ${label} — ${String((e && e.message) || e).split('\n')[0].slice(0, 160)}`);
    return false;
  }
}

(async () => {
  let version = '(not installed)';
  try { version = require('playwright/package.json').version; } catch {}
  line(`playwright        : ${version}`);
  const have = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter((d) => !d.startsWith('.')) : [];
  line(`browser cache     : ${have.length ? have.join(', ') : '(empty — nothing downloaded)'}`);
  const chromeApp = fs.existsSync('/Applications/Google Chrome.app');
  line(`system Chrome     : ${chromeApp ? 'present (usable as channel:"chrome")' : 'absent'}`);
  line('');

  const bundled = await tryLaunch('bundled chromium (what main.js uses)', {});
  // Only worth reporting when the bundled one failed: it is the fallback, not the default. Pinning
  // the channel ties the browser stack to whatever Chrome ships, so it is a remedy, not a preference.
  let channel = null;
  if (!bundled && chromeApp) channel = await tryLaunch('channel:"chrome" (fallback)', { channel: 'chrome' });

  line('');
  if (bundled) {
    line('✓ the browser tools can launch — browser, browser_workflow, browser_observe, browser_devtools, smart_login');
    process.exit(0);
  }
  if (channel) {
    line('✗ the bundled browser is broken, but system Chrome works.');
    line('  FIX: `npx playwright install chromium` (~150MB), or add `channel: "chrome"` to');
    line('  ensureBrowser() in main.js — the second pins the stack to whatever Chrome ships.');
    process.exit(1);
  }
  line('✗ no browser can launch — five tools are dead until this is fixed.');
  line('  FIX: `npx playwright install chromium`');
  process.exit(1);
})();
