#!/usr/bin/env node
'use strict';
// Visual check for the voice-first SUMMON RAIL + DRAWERS (the 2026-07-07 UI pass). Renders the REAL
// <style> from src/index.html plus a production-shaped fragment — titlebar, the left icon rail, the
// orb stage, and one open Manage drawer — in headless Chromium (Playwright), with body.zen.voicefirst
// .ambient.drawer-open set, and screenshots it to scripts/_rail-shot.png. Proves the additive
// voice-first layout renders (rail on the left, drawer over the orb, orb visible behind) without
// booting Electron / the vault. Manual check (not in the verify chain), like health-visual-check.js.
//   node scripts/voicefirst-visual-check.js
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'scripts', '_rail-shot.png');

(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  // Force the hover-expanded rail state in a static screenshot (Playwright can't :hover for a shot).
  const forceOpen = `body.voicefirst #railnav{width:236px;padding:16px 12px;background:color-mix(in srgb,var(--surface) 95%,transparent);border-right:1px solid var(--line);box-shadow:26px 0 64px -26px rgba(0,0,0,.72)}
    body.voicefirst .railbtn{opacity:1;transform:none} #railhint{opacity:0}`;
  const frag = `<!doctype html><html><head><meta charset="utf8"><style>${style}
    body{margin:0} #chat{display:none} ${forceOpen}
  </style></head><body class="zen voicefirst ambient drawer-open" style="background:var(--bg);height:100vh;overflow:hidden">
    <div id="titlebar"><span class="brand">BHATBOT</span></div>
    <nav id="railnav"><span id="railhint">tabs</span>
      <button class="railbtn" data-panel="manage"><span>🛰</span><small>Manage</small></button>
      <button class="railbtn" data-panel="health"><span>❤</span><small>Health</small></button>
      <button class="railbtn" data-panel="activity"><span>📊</span><small>Activity</small></button>
      <button class="railbtn" data-panel="vanguard"><span>🦾</span><small>Fleet</small></button>
      <button class="railbtn" data-panel="notes"><span>🧠</span><small>Memory</small></button>
      <button class="railbtn active" data-panel="routines"><span>🧭</span><small>Routines</small></button>
      <span class="railspacer"></span>
      <button class="railbtn" data-panel="voice"><span>🎚</span><small>Voice</small></button>
      <button class="railbtn" data-panel="settings"><span>⚙</span><small>Config</small></button>
    </nav>
    <div id="drawerscrim"></div>
    <div id="vstage" style="display:flex">
      <div id="orb" data-state="idle"><span class="glow"></span><span class="core"></span>
        <i class="ring r3"></i><i class="ring r4"></i></div>
      <div id="vstatus">listening</div><div id="vcap">Good evening, sir.</div>
      <div id="vhint">say "Jarvis" — or just talk · &#8984;K to type</div>
    </div>
    <div id="routines-panel" class="stage-panel active">
      <div class="panel-head"><b>🧭 ROUTINES</b></div>
      <div id="routines-list" style="padding:8px 12px">
        <div class="rt-row pinned"><div class="rt-sig">📌 browser→screen_parse→vision_click</div>
          <div class="rt-meta">used 7× · 100% success · ~4s · e.g. "play jazz on spotify"</div>
          <div class="rt-acts"><button class="rt-btn">Unpin</button><button class="rt-btn warn">Prune</button></div></div>
        <div class="rt-row"><div class="rt-sig">read_file→edit_file→run_shell</div>
          <div class="rt-meta">used 3× · 67% success · ~9s · e.g. "fix the failing test"</div>
          <div class="rt-acts"><button class="rt-btn">📌 Pin</button><button class="rt-btn warn">Prune</button></div></div>
      </div>
    </div>
  </body></html>`;
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1100, height: 680 }, deviceScaleFactor: 2 });
  await pg.setContent(frag, { waitUntil: 'load' });
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: OUT });
  await b.close();
  console.log('✅ voice-first rail/drawer rendered →', OUT);
})().catch((e) => { console.error('visual check failed:', e.message); process.exit(1); });
