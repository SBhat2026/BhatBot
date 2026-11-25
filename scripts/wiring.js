#!/usr/bin/env node
'use strict';
// ── THE WIRING MAP ─────────────────────────────────────────────────────────────────────────────────
//
// 2026-11-25: "Go through all the levels of the project, build a visualizer which checks for the
// internal wiring of the project."
//
// BhatBot is five layers that only talk to each other through NAMES — a renderer calls
// window.bhatbot.foo(), the preload turns that into ipcRenderer.invoke('foo'), main.js answers
// ipcMain.handle('foo'), and the handler calls into lib/. A tool the model is offered by name has to
// have a `case 'name':` in executeTool. A name that is spelt on one side and not the other is a wire
// to nowhere, and nothing at runtime says so: the button does nothing, the tool returns "unknown".
//
// This reads the source (no app, no network), resolves every name on both ends, and writes:
//   docs/wiring/wiring.json   — the graph and every finding
//   docs/wiring/index.html    — the visualizer (self-contained; open it in a browser)
//
//   node scripts/wiring.js            → write both, print a summary
//   node scripts/wiring.js --check    → also exit 1 if any BROKEN wire exists (dead ones only warn)
//
// Findings are graded: BROKEN = a caller with no callee (it will fail when used); DEAD = a callee no
// caller reaches (harmless, but weight); UNTESTED = a runtime module no test mentions.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p);
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const list = (d, re) => { try { return fs.readdirSync(path.join(ROOT, d)).filter((f) => re.test(f)).map((f) => path.join(ROOT, d, f)); } catch { return []; } };
// Strip // and /* */ comments so a name mentioned in prose is not mistaken for a wire. Crude (it
// ignores strings containing comment markers) but this codebase's comments are the long kind.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

// ── 1. MODULES ─────────────────────────────────────────────────────────────────────────────────────
const topJs = list('.', /\.js$/);
const libJs = [...list('lib', /\.js$/), ...list('lib/agents', /\.js$/)];
const cloudJs = list('cloud/src', /\.js$/);
const srcJs = [...list('src', /^preload-.*\.js$/), ...list('src', /\.(js|mjs)$/).filter((f) => !/preload-/.test(f))];
const scriptJs = list('scripts', /\.js$/);
const modules = [...new Set([...topJs, ...libJs, ...cloudJs, ...srcJs, ...scriptJs])];

function requiresOf(file) {
  const src = code(read(file)), out = new Set(), dir = path.dirname(file);
  const add = (spec, base = dir) => {
    for (const cand of [spec, spec + '.js', spec + '.mjs', path.join(spec, 'index.js')]) {
      const abs = path.resolve(base, cand);
      if (exists(abs)) { out.add(abs); return; }
    }
  };
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) add(m[1]);
  for (const m of src.matchAll(/import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/g)) add(m[1]);
  for (const m of src.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) add(m[1]);
  // require(path.join(__dirname, '..', 'lib', 'x')) and friends
  for (const m of src.matchAll(/require\(\s*path\.join\(\s*__dirname\s*,([^)]*)\)\s*\)/g)) {
    const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    if (parts.length) add(path.join(...parts));
  }
  return [...out].filter((f) => modules.includes(f));
}
const reqGraph = new Map(modules.map((m) => [m, requiresOf(m)]));

// Runtime roots: what actually starts when BhatBot runs, plus the headless workers it launches.
const preloads = [...list('.', /^preload.*\.js$/), ...list('src', /^preload-.*\.js$/)];
const spawnedScripts = new Set();
for (const f of [path.join(ROOT, 'main.js'), ...libJs]) {
  const src = code(read(f));
  for (const m of src.matchAll(/['"]scripts['"]\s*,\s*['"]([\w.-]+\.(?:js|py|sh))['"]/g)) spawnedScripts.add(path.join(ROOT, 'scripts', m[1]));
  for (const m of src.matchAll(/['"`][^'"`]*?\bscripts\/([\w.-]+\.(?:js|py|sh))['"`]/g)) spawnedScripts.add(path.join(ROOT, 'scripts', m[1]));
}
for (const f of scriptJs) if (/-worker\.js$/.test(f)) spawnedScripts.add(f);
const runtimeRoots = [path.join(ROOT, 'main.js'), ...preloads, path.join(ROOT, 'cloud/src/index.js'), path.join(ROOT, 'cloud/src/server.js'),
  ...[...spawnedScripts].filter((f) => f.endsWith('.js') && exists(f))].filter(exists);
const reach = (roots) => { const seen = new Set(); const st = [...roots]; while (st.length) { const f = st.pop(); if (seen.has(f)) continue; seen.add(f); for (const d of reqGraph.get(f) || []) st.push(d); } return seen; };
const live = reach(runtimeRoots);
const tests = scriptJs.filter((f) => /^test-|^soak-|^bench-/.test(path.basename(f)));
const testText = tests.map((t) => read(t)).join('\n');
const byTests = reach(tests);

// ── 2. THE BRIDGE: renderer → preload → IPC → main ────────────────────────────────────────────────
const mainSrc = code(read(path.join(ROOT, 'main.js')));
const mainSide = [path.join(ROOT, 'main.js'), path.join(ROOT, 'window-manager.js'), ...libJs].map((f) => code(read(f))).join('\n');
const handlers = new Map();          // channel → 'handle' | 'on'
for (const m of mainSide.matchAll(/ipcMain\.(handle|on|once)\(\s*['"`]([\w:.-]+)['"`]/g)) handlers.set(m[2], m[1]);
const sentToRenderer = new Set();    // channels main pushes
for (const m of mainSide.matchAll(/(?:webContents|contents|wc|win|mainWindow|[\w.]+)\.send\(\s*['"`]([\w:.-]+)['"`]/g)) sentToRenderer.add(m[1]);
for (const m of mainSide.matchAll(/\b\w*[sS]end\w*\(\s*(?:[\w.]+\s*,\s*)?['"`]([\w:.-]+)['"`]/g)) sentToRenderer.add(m[1]);

const loadedPreloads = new Set([...mainSide.matchAll(/preload:\s*path\.join\(\s*__dirname\s*,([^)]*)\)/g)]
  .map((m) => path.join(ROOT, ...[...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]))));
const bridges = [];                  // { file, global, api: Map(key → {invoke:[ch], on:[ch]}) }
for (const f of preloads) {
  const src = code(read(f));
  for (const m of src.matchAll(/exposeInMainWorld\(\s*['"](\w+)['"]\s*,\s*\{/g)) {
    // Walk to the matching brace of the exposed object.
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth--; }
    const body = src.slice(m.index + m[0].length, i - 1);
    const api = new Map();
    // A key is `name:` or `name(` at the object's top level; take each top-level segment.
    let d = 0, start = 0; const segs = [];
    for (let k = 0; k < body.length; k++) { const c = body[k]; if ('({['.includes(c)) d++; else if (')}]'.includes(c)) d--; else if (c === ',' && d === 0) { segs.push(body.slice(start, k)); start = k + 1; } }
    segs.push(body.slice(start));
    for (const seg of segs) {
      const km = /^\s*(\w+)\s*[:(]/.exec(seg); if (!km) continue;
      api.set(km[1], {
        invoke: [...seg.matchAll(/ipcRenderer\.(?:invoke|send|sendSync)\(\s*['"`]([\w:.-]+)['"`]/g)].map((x) => x[1]),
        on: [...seg.matchAll(/ipcRenderer\.(?:on|once)\(\s*['"`]([\w:.-]+)['"`]/g)].map((x) => x[1]),
      });
    }
    bridges.push({ file: rel(f), global: m[1], api, loaded: loadedPreloads.has(f) });
  }
}
// Which page loads which preload, so a bridge's callers are looked for in the right pages.
const pages = list('src', /\.html$/);
// Script only, comments gone, string CONTENTS blanked — "presence.html" in a string or "brain.stats"
// in prose is not a call. Template literals keep their ${…} code.
const scriptOf = (html) => [...String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
const unstring = (src) => code(src).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
const pageText = new Map(pages.map((p) => [p, unstring(scriptOf(read(p))) + '\n' + (/index\.html$/.test(p) ? unstring(read(path.join(ROOT, 'src/theme.js'))) : '')]));
const rendererText = [...pageText.values(), ...srcJs.filter((f) => !/preload-/.test(f)).map((f) => unstring(read(f)))].join('\n');
// A page that declares its own `term` / `viewer` / `brain` (an xterm, a 3Dmol viewer) is not calling
// the bridge of that name when it writes term.write(); only window.<name>.x counts there.
const shadows = (txt, g) => new RegExp(`\\b(?:const|let|var|function)\\s+${g}\\b|[,(]\\s*${g}\\s*[,)]\\s*=>|\\b${g}\\s*=(?!=)`).test(txt);
for (const b of bridges) {
  b.used = new Map();
  for (const [k] of b.api) {
    const re = new RegExp(`\\b${b.global}\\s*(?:\\?\\.|\\.)\\s*${k}\\b|\\b${b.global}\\s*\\[\\s*['"]${k}['"]\\s*\\]`);
    b.used.set(k, re.test(rendererText));
  }
  b.calledMissing = [];
  const seen = new Set();
  for (const [, txt] of pageText) {
    const re = shadows(txt, b.global) ? new RegExp(`\\bwindow\\.${b.global}\\s*(?:\\?\\.|\\.)\\s*(\\w+)`, 'g')
      : new RegExp(`(?<![\\w.])(?:window\\.)?${b.global}\\s*(?:\\?\\.|\\.)\\s*(\\w+)`, 'g');
    for (const m of txt.matchAll(re)) {
      const k = m[1];
      if (b.api.has(k) || seen.has(k) || ['then', 'catch'].includes(k)) continue;
      if (new RegExp(`window\\.${b.global}\\s*&&\\s*window\\.${b.global}\\.${k}\\b|window\\.${b.global}\\?\\.${k}\\?\\.`).test(txt)) continue;
      seen.add(k); b.calledMissing.push(k);
    }
  }
}

// ── 3. TOOLS: schema ↔ executeTool ↔ catalog ──────────────────────────────────────────────────────
let schema = [];
try { schema = require(path.join(ROOT, 'lib/tools-schema'))({}); } catch (e) { schema = []; }
const exStart = mainSrc.indexOf('async function executeTool(');
const exEnd = exStart >= 0 ? mainSrc.indexOf('\n}\n', exStart) : -1;
const exBody = exStart >= 0 ? mainSrc.slice(exStart, exEnd > 0 ? exEnd : undefined) : '';
const toolCases = new Set([...exBody.matchAll(/case\s+'([\w-]+)'\s*:/g)].map((m) => m[1]));
let unsorted = [];
try { unsorted = (require(path.join(ROOT, 'lib/toolcatalog')).groupTools(schema).unsorted || []).map((t) => t.name || t); } catch {}

// ── 4. VOICE ROUTES: every TwiML action URL has a route ───────────────────────────────────────────
const mcpSrc = code(read(path.join(ROOT, 'mcp-server.js')));
const cloudTw = code(read(path.join(ROOT, 'cloud/src/twilio.js')));
const voiceRoutes = new Set([...(mcpSrc + '\n' + cloudTw).matchAll(/app\.(?:get|post|ws)\(\s*['"`]\/voice\/:token\/([\w-]+)/g)].map((m) => m[1]));
for (const m of mcpSrc.matchAll(/\/voice\/\$\{token\}\/([\w-]+)`;\s*\n[^\n]*pathname/g)) voiceRoutes.add(m[1]);
if (/streamPath\s*=\s*`\/voice\/\$\{token\}\/stream`/.test(mcpSrc)) voiceRoutes.add('stream');
const voiceRefs = new Set([...mcpSrc.matchAll(/\/voice\/\$\{token\}\/([\w-]+)/g)].map((m) => m[1]));
for (const m of mainSrc.matchAll(/\/voice\/\$\{[^}]+\}\/([\w-]+)/g)) voiceRefs.add(m[1]);

// ── FINDINGS ──────────────────────────────────────────────────────────────────────────────────────
const findings = [];
const F = (grade, layer, what, detail) => findings.push({ grade, layer, what, detail });

for (const b of bridges) {
  if (!b.loaded) { F('DEAD', 'bridge', b.file, `no window loads this preload — window.${b.global} never exists`); continue; }
  for (const [k, w] of b.api) {
    for (const ch of w.invoke) if (!handlers.has(ch)) F('BROKEN', 'bridge→main', `${b.global}.${k} → '${ch}'`, `${b.file} invokes '${ch}', which no ipcMain handler answers`);
    for (const ch of w.on) if (!sentToRenderer.has(ch)) F('DEAD', 'main→bridge', `${b.global}.${k} ← '${ch}'`, `${b.file} listens for '${ch}', which main never sends`);
    if (!b.used.get(k)) F('DEAD', 'renderer→bridge', `${b.global}.${k}`, `exposed by ${b.file}, called by no page`);
  }
  for (const k of b.calledMissing) F('BROKEN', 'renderer→bridge', `${b.global}.${k}`, `a page calls ${b.global}.${k}(), which ${b.file} does not expose`);
}
const invoked = new Set(bridges.flatMap((b) => [...b.api.values()].flatMap((w) => w.invoke)));
for (const [ch] of handlers) if (!invoked.has(ch)) F('DEAD', 'main', `ipcMain '${ch}'`, 'handled in main, invoked by no preload');
for (const t of schema) if (!toolCases.has(t.name)) F('BROKEN', 'tools', `tool ${t.name}`, 'offered to the model, but executeTool has no case for it');
for (const t of unsorted) F('DEAD', 'tools', `tool ${t}`, 'in no catalog category — only reachable by toolbox name lookup');
for (const r of voiceRefs) if (!voiceRoutes.has(r)) F('BROKEN', 'voice', `/voice/…/${r}`, 'a TwiML URL points at a route that does not exist');
for (const m of libJs) {
  const name = rel(m);
  if (!live.has(m)) F(byTests.has(m) ? 'DEAD' : 'DEAD', 'modules', name, byTests.has(m) ? 'only loaded by tests — nothing in the running app requires it' : 'loaded by nothing — not the app, not a test');
  else if (!byTests.has(m) && !testText.includes(path.basename(m, '.js'))) F('UNTESTED', 'modules', name, 'runs in the app; no test loads or names it');
}

// ── THE GRAPH FOR THE VISUALIZER ──────────────────────────────────────────────────────────────────
const nodes = [], edges = [];
const nid = (layer, name) => layer + ':' + name;
const addNode = (layer, name, extra = {}) => { const id = nid(layer, name); if (!nodes.some((n) => n.id === id)) nodes.push({ id, layer, name, ...extra }); return id; };
for (const p of pages) addNode('page', rel(p));
const dupGlobal = (g) => bridges.filter((x) => x.global === g).length > 1;
const edgeSeen = new Set();
const addEdge = (e) => { const k = e.from + '>' + e.to; if (edgeSeen.has(k)) return; edgeSeen.add(k); edges.push(e); };
for (const b of bridges) {
  const g = addNode('bridge', dupGlobal(b.global) ? `${b.global} (${path.basename(b.file)})` : b.global, { global: b.global, file: b.file, keys: b.api.size, loaded: b.loaded });
  for (const p of pages) {
    const txt = pageText.get(p);
    const re = shadows(txt, b.global) ? new RegExp(`\\bwindow\\.${b.global}\\s*(?:\\?\\.|\\.)`) : new RegExp(`(?<![\\w.])(?:window\\.)?${b.global}\\s*(?:\\?\\.|\\.)`);
    if (b.loaded && re.test(txt)) addEdge({ from: nid('page', rel(p)), to: g });
  }
  for (const [, w] of b.api) for (const ch of w.invoke) { addNode('ipc', ch, { handled: handlers.has(ch) }); addEdge({ from: g, to: nid('ipc', ch), broken: !handlers.has(ch) }); }
}
for (const [ch] of handlers) { addNode('ipc', ch, { handled: true }); edges.push({ from: nid('ipc', ch), to: nid('main', 'main.js') }); }
addNode('main', 'main.js');
addNode('main', 'mcp-server.js');
for (const m of [...live].filter((f) => libJs.includes(f) || f.endsWith('mcp-server.js') || f.endsWith('window-manager.js'))) addNode('lib', rel(m), { tested: byTests.has(m) || testText.includes(path.basename(m, '.js')) });
for (const m of libJs.filter((f) => !live.has(f))) addNode('lib', rel(m), { orphan: true, tested: byTests.has(m) });
for (const [from, deps] of reqGraph) {
  const fl = from.endsWith('main.js') && path.dirname(from) === ROOT ? nid('main', 'main.js') : nodes.find((n) => n.layer === 'lib' && n.name === rel(from)) ? nid('lib', rel(from)) : null;
  if (!fl) continue;
  for (const d of deps) { const tl = nodes.find((n) => n.layer === 'lib' && n.name === rel(d)); if (tl) edges.push({ from: fl, to: tl.id }); }
}
for (const f of cloudJs) addNode('cloud', rel(f));
for (const [from, deps] of reqGraph) if (cloudJs.includes(from)) for (const d of deps) if (cloudJs.includes(d)) edges.push({ from: nid('cloud', rel(from)), to: nid('cloud', rel(d)) });
for (const s of spawnedScripts) if (exists(s)) { addNode('worker', rel(s)); edges.push({ from: nid('main', 'main.js'), to: nid('worker', rel(s)) }); }
addNode('tools', `${schema.length} tools`, { cases: toolCases.size });
edges.push({ from: nid('main', 'main.js'), to: nid('tools', `${schema.length} tools`) });

const summary = {
  generatedAt: new Date().toISOString(),
  counts: {
    pages: pages.length, bridges: bridges.length, bridgeKeys: bridges.reduce((n, b) => n + b.api.size, 0),
    ipcHandlers: handlers.size, mainToRendererEvents: sentToRenderer.size,
    modules: modules.length, libModules: libJs.length, liveLib: libJs.filter((f) => live.has(f)).length,
    tools: schema.length, toolCases: toolCases.size, voiceRoutes: voiceRoutes.size, workers: [...spawnedScripts].filter(exists).length,
  },
  grades: findings.reduce((o, f) => ((o[f.grade] = (o[f.grade] || 0) + 1), o), {}),
};
const out = { summary, findings, nodes, edges };
const dir = path.join(ROOT, 'docs', 'wiring');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'wiring.json'), JSON.stringify(out, null, 1));
const tpl = read(path.join(__dirname, 'wiring-template.html'));
if (tpl) fs.writeFileSync(path.join(dir, 'index.html'), tpl.replace('/*__WIRING_DATA__*/null', JSON.stringify(out).replace(/</g, '\\u003c')));

console.log(`wiring: ${summary.counts.pages} pages · ${summary.counts.bridgeKeys} bridge calls · ${summary.counts.ipcHandlers} IPC handlers · ${summary.counts.liveLib}/${summary.counts.libModules} lib modules live · ${summary.counts.tools} tools`);
for (const g of ['BROKEN', 'DEAD', 'UNTESTED']) {
  const fs_ = findings.filter((f) => f.grade === g);
  console.log(`${g === 'BROKEN' ? '❌' : g === 'DEAD' ? '⚠️ ' : '·'} ${g}: ${fs_.length}`);
  if (g === 'BROKEN') for (const f of fs_) console.log(`   ${f.layer.padEnd(16)} ${f.what} — ${f.detail}`);
}
console.log(`→ ${rel(path.join(dir, 'index.html'))}`);
if (process.argv.includes('--check') && findings.some((f) => f.grade === 'BROKEN')) process.exit(1);
