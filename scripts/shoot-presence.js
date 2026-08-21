'use strict';
// Render src/presence.html with a scripted roster and save PNGs — a visual regression harness for
// the FLEET office that needs no API key, no agent run, and no spend. Drives the SAME postMessage
// contract main.js uses, so what you see here is what the app renders.
//
//   node scripts/shoot-presence.js [outDir]
//
// Serves src/ on an ephemeral port (the GLB + draco decoder must come over http — file:// blocks
// the module/wasm fetches), then captures: empty room, 3 agents, 6 agents, a hover card, and the
// post-click state.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SRC = path.join(__dirname, '..', 'src');
const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'presence-shots');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.wasm':'application/wasm',
  '.glb':'model/gltf-binary', '.json':'application/json', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml' };

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      // Mount presence.html in an IFRAME, exactly as the FLEET tab does. Loading it top-level would
      // make window.parent === window, so the click handler's postMessage to the host is skipped and
      // the test would "fail" on a condition that cannot happen in the app.
      if (rel === '__wrap') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><meta charset=utf-8><style>html,body{margin:0;height:100%;overflow:hidden;background:#05080d}iframe{border:0;width:100%;height:100%;display:block}</style>'
          + '<iframe id=f src="presence.html"></iframe>'
          + '<script>window.__clicks=[];addEventListener("message",e=>{if(e.data&&e.data.type==="agent-click")window.__clicks.push(e.data)});</script>');
      }
      const f = path.join(SRC, rel);
      if (!f.startsWith(SRC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

// The roster shape presenceSnapshot() emits.
const CODENAMES = ['ORACLE', 'SCOUT', 'FORGE', 'ATLAS', 'ECHO', 'MEDIC'];
const TASKS = [
  'grep the repo for orphaned tool_use pairs',
  'draft the migration plan for lib/history.js',
  'run the fleet spill regression suite',
  'audit prompt-cache breakpoint placement',
  'summarise the last 200 blackboard posts',
  'rebuild the project file index',
];
const STATES = ['working', 'thinking', 'working', 'idle', 'done', 'error'];
const roster = (n) => Array.from({ length: n }, (_, i) => ({
  id: i === n - 1 && n > 1 ? 'job:weaver' : 'suit-' + i,
  role: ['research', 'design', 'code', 'test', 'review', 'weaver'][i % 6],
  name: i === n - 1 && n > 1 ? 'weaver' : CODENAMES[i % CODENAMES.length],
  state: STATES[i % STATES.length],
  status: ['working', 'queued', 'running', 'parked', 'done', 'failed'][i % 6],
  task: TASKS[i % TASKS.length],
  step: ['calling run_shell', 'reading main.js', 'waiting on rate budget', '', 'writing report', 'retrying'][i % 6],
  since: Date.now() - (i + 1) * 41000,
  steerable: !(i === n - 1 && n > 1),
}));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/__wrap`;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', (r) => errors.push('404/FAIL: ' + r.url()));

  await page.goto(url, { waitUntil: 'load' });
  const frame = page.frameLocator('#f');
  const fr = await (await page.$('#f')).contentFrame();
  // The scene is ready when the loading veil is gone (both GLBs decoded through draco).
  await fr.waitForFunction(() => getComputedStyle(document.getElementById('loading')).display === 'none', null, { timeout: 60000 });
  // Push through the SAME channel main.js uses: a postMessage from the host into the iframe.
  const push = (n) => page.evaluate((agents) => document.getElementById('f').contentWindow.postMessage({ type: 'presence', agents }, '*'), roster(n));
  const shot = async (name, ms = 2600) => { await page.waitForTimeout(ms); await page.screenshot({ path: path.join(OUT, name) }); console.log('  ▸', name); };

  const probe = () => fr.evaluate(() => window.__presenceProbe());
  /** Wait until nobody is mid-walk, so seating/animation assertions aren't racing the pathfinder. */
  async function settle(maxMs = 75000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const p = await probe();
      if (p.length && p.every((a) => !a.walking)) return p;
      await page.waitForTimeout(400);
    }
    return probe();
  }

  await shot('01-empty.png', 1200);
  await push(3); await settle(); await shot('02-three-agents.png', 600);
  await push(6); const seated = await settle(); await shot('03-six-agents.png', 600);

  console.log('\n  agent placement after settling:');
  for (const a of seated) console.log(`    ${a.name.padEnd(8)} ${a.state.padEnd(9)} clip=${String(a.clip).padEnd(9)} once=${a.clipOnce?1:0} off=${a.offTarget} poi=${a.poi}`);

  // --- hover: the camera orbits continuously, so a screen position goes stale within a frame or
  // two. Re-probe immediately before each attempt instead of trusting a coordinate measured half a
  // second ago, and retry a few times.
  async function hoverAgent(id, tries = 14) {
    for (let i = 0; i < tries; i++) {
      const p = (await probe()).find((a) => a.id === id);
      if (!p || !p.onScreen) { await page.waitForTimeout(150); continue; }
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(90);
      const on = await fr.evaluate(() => document.getElementById('hovercard').classList.contains('on'));
      if (on) return p;
    }
    return null;
  }
  const target = seated.find((a) => a.steerable !== false && a.onScreen) || seated[0];
  const hit = await hoverAgent(target.id);
  console.log('  hover target:', target.name, hit ? `resolved at ${hit.x},${hit.y}` : 'NOT RESOLVED');
  const hoverOn = await fr.evaluate(() => {
    const c = document.getElementById('hovercard');
    return { on: c.classList.contains('on'), name: document.getElementById('hc-name').textContent,
      task: document.getElementById('hc-task').textContent, step: document.getElementById('hc-step').textContent,
      foot: document.getElementById('hc-foot').textContent };
  });
  // --- click FIRST, then screenshot ------------------------------------------------------------
  // A screenshot at deviceScaleFactor 2 under swiftshader takes long enough for the orbiting camera
  // to carry the agent out from under the (stationary) cursor. Capturing between the hover and the
  // click made the click land on empty floor and report a false failure.
  if (hit) { await page.mouse.down(); await page.mouse.up(); }   // cursor is already on the agent
  await page.waitForTimeout(500);
  const clicked = await page.evaluate(() => window.__clicks);
  if (hoverOn.on) await shot('04-hover-card.png', 150);
  await shot('05-after-click.png', 300);

  const tally = await fr.evaluate(() => document.getElementById('tally').textContent);
  await browser.close(); server.close();

  // --- report ---------------------------------------------------------------------------------
  const fails = [];
  console.log('\nHUD tally:', tally);
  if (!/6 agents/.test(tally)) fails.push('tally did not report 6 agents');

  const onScreen = seated.filter((a) => a.onScreen).length;
  console.log(`on-screen: ${onScreen}/${seated.length}`);
  if (onScreen < seated.length) fails.push(`${seated.length - onScreen} agent(s) framed off-screen`);

  // The whole point of the POI work: state must decide both WHERE they sit and WHICH clip plays.
  const workers = seated.filter((a) => a.state === 'working');
  const thinkers = seated.filter((a) => a.state === 'thinking');
  console.log('working →', workers.map((a) => `${a.poi}/${a.clip}`).join(', ') || '(none)');
  console.log('thinking →', thinkers.map((a) => `${a.poi}/${a.clip}`).join(', ') || '(none)');
  if (!workers.every((a) => a.poi && a.poi.startsWith('poi-sit_work') && a.clip === 'Sit_Work')) fails.push('a working agent is not sitting at a work desk playing Sit_Work');
  if (!thinkers.every((a) => a.poi && a.poi.startsWith('poi-sit_idle') && a.clip === 'Sit_Idle')) fails.push('a thinking agent is not on a sofa/cafe seat playing Sit_Idle');
  if (new Set(seated.map((a) => a.poi)).size !== seated.length) fails.push('two agents claimed the same anchor');

  console.log('\nhover card:', hoverOn.on ? `"${hoverOn.name}" — ${hoverOn.task} | ${hoverOn.step} | ${hoverOn.foot}` : '(did not open)');
  if (!hoverOn.on) fails.push('hover card did not open over an agent');
  else if (!hoverOn.task) fails.push('hover card opened but showed no task');

  console.log('agent-click →', JSON.stringify(clicked));
  if (!(clicked && clicked.length && clicked[0].id)) fails.push('click produced no id (the original dashboard bug)');

  if (errors.length) { console.log('\nconsole/network errors:'); errors.slice(0, 12).forEach((e) => console.log('   ', e)); fails.push(errors.length + ' console/network error(s)'); }
  console.log('\nshots →', OUT);
  if (fails.length) { console.log('\n❌ ' + fails.length + ' failure(s):'); fails.forEach((f) => console.log('   ✗ ' + f)); process.exit(1); }
  console.log('\n✅ presence scene verified: placement, per-state clips, hover read-out, and click-with-id all correct');
})();
