#!/usr/bin/env node
'use strict';
// ── TOOLCHECK — does each tool actually work on THIS machine? ─────────────────────────────────────
//
// `npm run verify` proves the code is correct. It cannot prove that Blender is installed, that
// Playwright downloaded its browsers, that a model endpoint still exists, or that the python on PATH
// has Pillow. Every one of those has been false here at some point, and each failed SILENTLY — the
// tool stayed in the catalogue advertising a capability the machine could not deliver, and nobody
// found out until it was asked to do the thing.
//
// So this exercises the real runtimes, end to end, and COSTS NOTHING: no Anthropic or OpenAI call,
// web search pinned to the free provider, and every network hop is to something without a meter.
// Run it after any environment change.
//
//   node scripts/toolcheck.js           # everything
//   node scripts/toolcheck.js blender   # one check by name
//
// Exit 0 only if every check passed or was skipped for a stated reason.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcheck-'));
const only = process.argv[2];

const results = [];
const t0 = Date.now();

async function check(name, note, fn) {
  if (only && name !== only) return;
  const start = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - start;
    if (out && out.skip) { results.push({ name, state: 'skip', why: out.skip, ms }); return; }
    results.push({ name, state: 'ok', why: (out && out.evidence) || '', ms });
  } catch (e) {
    results.push({ name, state: 'fail', why: String(e && e.message || e).split('\n')[0].slice(0, 150), ms: Date.now() - start });
  }
}

/** A python that can actually import what we need — not merely the first one on PATH. */
function pythonWith(mod) {
  const candidates = [
    process.env.BHATBOT_PYTHON,
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/bin/python3',
    'python3',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const r = spawnSync(p, ['-c', `import ${mod}`], { timeout: 15000, stdio: 'ignore' });
      if (r.status === 0) return p;
    } catch {}
  }
  return null;
}

// ── files, shell, and the local utility belt ──────────────────────────────────────────────────────
check('files', 'read/write/edit round-trip', async () => {
  const f = path.join(TMP, 'a.txt');
  fs.writeFileSync(f, 'one\ntwo\nthree\n');
  const before = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, before.replace('two', 'TWO'));
  const after = fs.readFileSync(f, 'utf8');
  if (!after.includes('TWO') || !after.includes('three')) throw new Error('edit did not apply cleanly');
  return { evidence: '3-line file written, patched and re-read' };
});

check('shell', 'run_shell executes and captures output', async () => {
  const out = execFileSync('/bin/sh', ['-c', 'echo hello && printf "%s" ok'], { encoding: 'utf8', timeout: 20000 });
  if (!out.includes('hello') || !out.includes('ok')) throw new Error('stdout not captured');
  return { evidence: 'stdout captured from a shell pipeline' };
});

check('file_tools', 'image op through the python belt', async () => {
  const py = pythonWith('PIL');
  if (!py) return { skip: 'no python on this machine can import PIL' };
  const src = path.join(TMP, 'in.png'), dst = path.join(TMP, 'out.png');
  execFileSync(py, ['-c', `from PIL import Image; Image.new("RGB",(400,300),(11,110,140)).save("${src}")`], { timeout: 60000 });
  execFileSync(py, ['-c', `from PIL import Image; im=Image.open("${src}"); im.resize((100,75)).save("${dst}")`], { timeout: 60000 });
  const sz = fs.statSync(dst).size;

  // AND THE TOOL MUST PICK THE SAME ONE. This check used to prove only that SOME interpreter on the
  // machine could do the work, then note in passing that lib/filetools.js asked for a bare `python3`
  // — which it flagged on every run for weeks without ever failing. Proving the tool resolves an
  // interpreter that can actually import PIL is the assertion that was missing.
  const ft = require(path.join(ROOT, 'lib', 'filetools'));
  const chosen = ft.pythonBin();
  if (!chosen.proven) throw new Error(`lib/filetools.js resolved ${chosen.bin}, which cannot import PIL (${chosen.why || 'unproven'})`);
  return { evidence: `400x300 → 100x75 (${sz}B) — filetools resolves ${path.basename(chosen.bin)}, PIL proven` };
});

// ── the container lane ────────────────────────────────────────────────────────────────────────────
check('container_run', 'docker daemon reachable and runs a container', async () => {
  const docker = require(path.join(ROOT, 'lib', 'integrations', 'docker'));
  const up = await docker.available(6000);
  if (!up) return { skip: 'no container runtime running (colima start)' };
  const r = await docker.run({ image: 'alpine:3', cmd: ['sh', '-c', 'echo contained'], timeoutMs: 180000 }).catch((e) => ({ code: -1, stderr: e.message }));
  const text = String((r && (r.stdout || r.out)) || '') + String((r && r.stderr) || '');
  if (!/contained/.test(text)) throw new Error('container ran but produced no output: ' + text.slice(0, 80));
  return { evidence: 'alpine container executed and returned stdout' };
});

// ── the browser stack ─────────────────────────────────────────────────────────────────────────────
check('browser', 'playwright chromium launches and renders', async () => {
  let chromium;
  try { ({ chromium } = require(path.join(ROOT, 'node_modules', 'playwright'))); }
  catch { return { skip: 'playwright not installed' }; }
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    await p.goto('data:text/html,<h1 id=t>rendered</h1>');   // setContent leaves the shell with no layout to capture
    const txt = await p.textContent('#t');
    const shot = await p.screenshot();
    if (txt !== 'rendered' || !shot.length) throw new Error('page did not render');
    return { evidence: `DOM read back + ${Math.round(shot.length / 1024)}KB screenshot` };
  } finally { await b.close(); }
});

// ── science ───────────────────────────────────────────────────────────────────────────────────────
check('simulate', 'scipy ODE in the sim venv', async () => {
  const sim = require(path.join(ROOT, 'lib', 'simulate'));
  if (!sim.isInstalled || !sim.isInstalled()) return { skip: 'sim venv not installed' };
  const r = await sim.run({ code: [
    'from scipy.integrate import solve_ivp',
    'import numpy as np',
    'sol = solve_ivp(lambda t,y: -0.5*y, [0,10], [2.0], t_eval=[0,5,10])',
    'print("decay", [round(float(v),4) for v in sol.y[0]])',
  ].join('\n') }, { timeoutMs: 180000 });
  const out = String(r.stdout || r.output || '');
  if (!/decay/.test(out)) throw new Error('no output: ' + (r.stderr || out).slice(0, 120));
  return { evidence: out.trim().split('\n').pop().slice(0, 70) };
});

check('sci_compute', 'numpy/pandas in the scicompute venv', async () => {
  const sc = require(path.join(ROOT, 'lib', 'scicompute'));
  if (!sc.isInstalled || !sc.isInstalled()) return { skip: 'scicompute venv not installed' };
  const r = await sc.run({ code: [
    'import numpy as np, pandas as pd',
    'df = pd.DataFrame({"x": np.arange(100), "y": np.arange(100)**2})',
    'print("corr", round(float(df.x.corr(df.y)), 4), "rows", len(df))',
  ].join('\n') }, { timeoutMs: 180000 });
  const out = String(r.stdout || r.output || '');
  if (!/corr/.test(out)) throw new Error('no output: ' + (r.stderr || out).slice(0, 120));
  return { evidence: out.trim().split('\n').pop().slice(0, 70) };
});

check('predict_function', 'FABLE endpoint answers with predictions', async () => {
  const pf = require(path.join(ROOT, 'lib', 'protfunc'))();
  const seq = 'MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQAPILSRVGDGTQDNLSGAEKAVQVKVKALPDAQFEVVHSLAKWKR';
  const r = await pf.predict({ sequence: seq });
  if (!r || typeof r.length !== 'number') throw new Error('unexpected response shape');
  return { evidence: `len ${r.length}, taxon ${r.taxonApplied || '—'}, ${(r.predictions || []).length} prediction(s)` };
});

// ── making ────────────────────────────────────────────────────────────────────────────────────────
check('make_model', 'Blender renders headless', async () => {
  const BIN = '/Applications/Blender.app/Contents/MacOS/Blender';
  if (!fs.existsSync(BIN)) return { skip: 'Blender not installed' };
  const py = path.join(TMP, 'b.py'), out = path.join(TMP, 'r.png');
  fs.writeFileSync(py, [
    'import bpy',
    'bpy.ops.wm.read_factory_settings(use_empty=True)',
    'bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0)',
    'bpy.ops.object.light_add(type="SUN", location=(4,4,6))',
    'cam = bpy.data.objects.new("c", bpy.data.cameras.new("c")); bpy.context.collection.objects.link(cam)',
    'cam.location=(0,-5,2); cam.rotation_euler=(1.2,0,0); bpy.context.scene.camera=cam',
    'bpy.context.scene.render.resolution_x=160; bpy.context.scene.render.resolution_y=120',
    'bpy.context.scene.render.filepath=r"' + out + '"',
    'bpy.ops.render.render(write_still=True)',
  ].join('\n'));
  execFileSync(BIN, ['-b', '--python', py], { timeout: 240000, stdio: 'ignore' });
  if (!fs.existsSync(out)) throw new Error('Blender produced no image');
  return { evidence: `rendered a sphere to ${Math.round(fs.statSync(out).size / 1024)}KB PNG` };
});

check('molecule', 'structure parses and a view is produced', async () => {
  const cif = path.join(ROOT, '1crn.cif');
  if (!fs.existsSync(cif)) return { skip: 'no 1crn.cif fixture' };
  const text = fs.readFileSync(cif, 'utf8');
  const atoms = (text.match(/^ATOM/gm) || []).length;
  if (atoms < 100) throw new Error('fixture does not parse as a structure');
  return { evidence: `1crn.cif parsed — ${atoms} ATOM records` };
});

// ── live information ──────────────────────────────────────────────────────────────────────────────
check('news', 'NYT feed returns headlines', async () => {
  const news = require(path.join(ROOT, 'lib', 'news'));
  const r = await news.skim({ section: 'world', limit: 3 });
  const items = (r && (r.items || r.articles || r)) || [];
  if (!Array.isArray(items) || !items.length) throw new Error('no headlines returned');
  return { evidence: `${items.length} headlines — "${String(items[0].title || items[0]).slice(0, 52)}…"` };
});

check('web_search', 'free provider returns ranked results', async () => {
  const ws = require(path.join(ROOT, 'lib', 'websearch'));
  const r = await ws.search({ query: 'protein binder design ipTM', limit: 3, config: {} });   // no keys → free provider
  const items = (r && (r.results || r.items)) || [];
  if (!items.length) throw new Error('no results');
  return { evidence: `${items.length} results via duckduckgo ($0) — "${String(items[0].title || '').slice(0, 44)}…"` };
});

check('fetch_url', 'HTTP GET returns text', async () => {
  const r = await fetch('https://example.com', { signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  if (!/Example Domain/i.test(t)) throw new Error('unexpected body');
  return { evidence: `HTTP ${r.status}, ${t.length}B` };
});

check('bioart', 'NIH BioArt search responds — and honours the term', async () => {
  const ba = require(path.join(ROOT, 'lib', 'bioart'));
  const r = await ba.search('mitochondria', { limit: 5 }).catch((e) => ({ error: e.message }));
  if (r && r.error) throw new Error(r.error);
  const items = (r && r.results) || [];
  if (!items.length) throw new Error('no assets returned');
  // "Did it answer?" is not the same question as "did it answer THIS?". Until 2026-09-21 the term
  // sat in a slot the server ignored, so every query returned the same generic first page and a
  // count-only assertion passed happily. Relevance is the assertion that would have caught it.
  const hit = items.some((x) => /mitochondri/i.test(x.title + ' ' + (x.description || '')));
  if (!hit) throw new Error(`returned ${items.length} assets but none mention the query — the term is being ignored ("${items[0].title}")`);
  return { evidence: `${items.length} public-domain assets, relevant — "${items[0].title}"` };
});

check('cloud', 'the always-on brain answers', async () => {
  const r = await fetch('https://bhatbot-cloud.fly.dev/health', { signal: AbortSignal.timeout(20000) });
  if (r.status !== 401 && r.status !== 200) throw new Error('unexpected status ' + r.status);
  return { evidence: `HTTP ${r.status} (401 = up and auth-gated, which is correct)` };
});

// ── report ────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  // checks were registered as promises above; wait for all of them
  await new Promise((r) => setTimeout(r, 0));
  while (results.length < (only ? 1 : 15)) { await new Promise((r) => setTimeout(r, 200)); if (Date.now() - t0 > 600000) break; }

  const pad = (s, n) => String(s).padEnd(n);
  const ICON = { ok: '✓', fail: '✗', skip: '–' };
  console.log('\n  BhatBot toolcheck — runtimes, not code. $0.00\n');
  for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${ICON[r.state]} ${pad(r.name, 17)} ${pad((r.ms / 1000).toFixed(1) + 's', 7)} ${r.why}`);
  }
  const bad = results.filter((r) => r.state === 'fail');
  const skipped = results.filter((r) => r.state === 'skip');
  console.log(`\n  ${results.filter((r) => r.state === 'ok').length} working · ${skipped.length} skipped · ${bad.length} broken\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(bad.length ? 1 : 0);
})();
