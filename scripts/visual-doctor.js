#!/usr/bin/env node
'use strict';
// ── WHAT IS ACTUALLY ON SCREEN, ASSERTED ──────────────────────────────────────────────────────────
// Renders the real src/index.html in headless Chromium, collects geometry and COMPUTED style for the
// elements that matter, and runs lib/visualcheck against it. Exits non-zero on an error-level finding.
//
// The three visual scripts that predate this one render the UI and save a PNG. None of them can fail,
// so when nobody opens the PNG a regression ships — which is how the COMMAND view's centre column sat
// empty with the orb at 0×0, and how the office painted its characters as silhouettes on the light
// themes. A picture cannot tell you a contrast ratio. This can.
//
//   npm run visual:doctor                  # day theme, desktop width
//   npm run visual:doctor -- night 1280    # a specific theme and width
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { check } = require(path.join(ROOT, 'lib', 'visualcheck'));

// The elements a person is supposed to SEE on the COMMAND view. `shouldShow` is the assertion that
// caught the empty centre panel: present in the DOM is not the same as present on screen.
const MUST_SHOW = ['#orb', '#cmdstage', '#cmd-left', '#cmd-center', '#cmd-right', '#vstage', '#rail'];
// Conditionally visible, so they are SAMPLED (contrast, overflow) but never asserted present.
const CONDITIONAL = ['#inputbar', '#ta', '#chat'];
// What must hold however the UI is configured. Losing every way to talk to BhatBot is a failure
// nobody would spot in a screenshot, because everything else on the page looks fine.
const INVARIANTS = [
  { name: 'reachable', anyOf: ['#vstage', '#inputbar', '#ta'], detail: 'no way to reach BhatBot — neither the voice stage nor the text bar is visible' },
];
const ALSO_SAMPLE = ['.hcard-h', '.stage-head', '#vhint', '#railmodel', '.navbtn', '#wavebars', '#jobs-board', '#fleet-mini', '.sh-t'];

function serve(port) {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  const SRC = path.join(ROOT, 'src');
  return new Promise((res) => {
    const s = http.createServer((req, q) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const f = path.join(SRC, path.normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, ''));
      if (!f.startsWith(SRC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { q.writeHead(404); return q.end(); }
      q.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(f).pipe(q);
    }).listen(port, '127.0.0.1', () => res(s));
  });
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.error('✗ playwright not installed — npx playwright install chromium'); process.exit(2); }

  const theme = process.argv.find((a) => /^(day|night|standby)$/.test(a)) || 'day';
  const width = Number(process.argv.find((a) => /^\d{3,4}$/.test(a))) || 1512;
  const PORT = 7397;
  const server = await serve(PORT);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 945 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate((t) => { try { window.bhatbotTheme.set(t); } catch {} }, theme);
  await page.waitForTimeout(1200);          // let theme + layout settle

  const snapshot = await page.evaluate(({ must, also, cond }) => {
    // The painted background, not the inherited one: walking up to the first non-transparent
    // ancestor is what makes a contrast number mean anything.
    const paintedBg = (el) => {
      for (let n = el; n && n !== document.documentElement.parentElement; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const m = c && c.match(/rgba?\(([^)]+)\)/);
        if (m) { const p = m[1].split(',').map(parseFloat); if (p[3] == null || p[3] > 0.5) return c; }
      }
      return 'rgb(255,255,255)';
    };
    const blankCanvas = (cv) => {
      try {
        const ctx = cv.getContext('2d'); if (!ctx || !cv.width || !cv.height) return true;
        const d = ctx.getImageData(0, 0, Math.min(cv.width, 200), Math.min(cv.height, 200)).data;
        const first = [d[0], d[1], d[2], d[3]];
        for (let i = 4; i < d.length; i += 4) if (d[i] !== first[0] || d[i + 1] !== first[1] || d[i + 2] !== first[2] || d[i + 3] !== first[3]) return false;
        return true;
      } catch { return false; }        // tainted or WebGL — not our business to guess
    };
    const grab = (el, sel, shouldShow) => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
      return {
        sel, shouldShow,
        w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        color: cs.color, bg: paintedBg(el),
        fontPx: parseFloat(cs.fontSize) || 16, weight: cs.fontWeight,
        text: own.slice(0, 60),
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        overflowX: cs.overflowX, overflow: cs.overflow,
        interactive: /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.hasAttribute('data-panel') || cs.cursor === 'pointer',
        isCanvas: el.tagName === 'CANVAS',
        canvasBlank: el.tagName === 'CANVAS' ? blankCanvas(el) : false,
      };
    };
    const out = [];
    for (const sel of must) { const el = document.querySelector(sel); if (el) out.push(grab(el, sel, true)); else out.push({ sel, shouldShow: true, w: 0, h: 0, display: 'missing' }); }
    for (const sel of also) document.querySelectorAll(sel).forEach((el, i) => out.push(grab(el, `${sel}[${i}]`, false)));
    for (const sel of cond) { const el = document.querySelector(sel); if (el) out.push(grab(el, sel, false)); }
    return { elements: out, theme: document.documentElement.getAttribute('data-theme') };
  }, { must: MUST_SHOW, also: ALSO_SAMPLE, cond: CONDITIONAL });

  snapshot.invariants = INVARIANTS;
  const findings = check(snapshot);
  const errs = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  console.log(`\n── visual doctor ── theme:${snapshot.theme} width:${width} ── ${snapshot.elements.length} elements\n`);
  if (errors.length) { console.log('  PAGE ERRORS:'); for (const e of errors.slice(0, 4)) console.log('    ✗ ' + e); console.log(''); }
  for (const f of [...errs, ...warns]) console.log(`  ${f.level === 'error' ? '✗' : '⚠'} ${f.rule.padEnd(13)} ${f.sel}\n      ${f.detail}`);
  if (!findings.length) console.log('  ✓ nothing invisible, unreadable, overflowing, blank or overlapping');
  console.log(`\n  ${errs.length} error(s), ${warns.length} warning(s)\n`);

  const shot = path.join(require('os').tmpdir(), `bhatbot-visual-${theme}-${width}.png`);
  await page.screenshot({ path: shot });
  console.log(`  screenshot: ${shot}\n`);

  await browser.close(); server.close();
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
