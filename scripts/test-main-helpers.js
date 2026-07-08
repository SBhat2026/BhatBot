#!/usr/bin/env node
'use strict';
// Regression tests for two inline main.js helpers added during the 2026-06-30 optimization pass:
//   • sanitizeSteering — STT hallucination guard (drops the "Talaser Talaser…" repeated-token loop
//     before it enters chat or gets injected as live steering).
//   • expandPath — expands ~ and $HOME in tool-supplied file paths so read_file/write_file/etc.
//     "just work" on home-relative paths instead of ENOENT → run_shell fallback.
// These live inline in main.js (which can't be required outside Electron), so we extract each
// function's source by brace-matching and eval it in a minimal scope. Wired into `npm run verify`.
//   node scripts/test-main-helpers.js
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// Pull `function NAME(...) { ... }` out of main.js by matching balanced braces from the signature.
function extract(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig);
  if (start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
// eslint-disable-next-line no-new-func
const load = (name) => new Function('path', 'os', 'fs', extract(main, name) + '\nreturn ' + name + ';')(path, os, fs);

const sanitizeSteering = load('sanitizeSteering');
const expandPath = load('expandPath');
const isSecretPath = load('isSecretPath');

// ---- sanitizeSteering ----
ok(sanitizeSteering('Talaser Talaser') === null, 'STT: single token repeated → dropped');
ok(sanitizeSteering('Talaser Talaser Talaser Talaser') === null, 'STT: 4x consecutive repeat → dropped');
ok(sanitizeSteering('') === null, 'STT: empty → dropped');
ok(sanitizeSteering('   ') === null, 'STT: whitespace only → dropped');
ok(sanitizeSteering('the the the the the the the') === null, 'STT: low-diversity long burst → dropped');
ok(sanitizeSteering('open the browser and go to gmail') === 'open the browser and go to gmail', 'STT: real command → kept');
ok(sanitizeSteering('  focus on the tests instead  ') === 'focus on the tests instead', 'STT: trims + keeps real steering');
ok((sanitizeSteering('x '.repeat(3000)) || '').length <= 2000, 'STT: caps runaway length at 2000');

// ---- expandPath ----
ok(expandPath('~/.bhatbot/config.json') === path.join(os.homedir(), '.bhatbot', 'config.json'), 'path: ~ expands to home');
ok(expandPath('~') === os.homedir(), 'path: bare ~ → home');
ok(expandPath('$HOME/notes.md') === path.join(os.homedir(), 'notes.md'), 'path: $HOME expands');
ok(expandPath('${HOME}/notes.md') === path.join(os.homedir(), 'notes.md'), 'path: ${HOME} expands');
ok(expandPath('/abs/path') === '/abs/path', 'path: absolute path unchanged');
ok(expandPath('relative/path') === 'relative/path', 'path: relative path unchanged');
ok(expandPath('~notuser/x') === '~notuser/x', 'path: ~user form left alone (no false expand)');

// ---- expandPath: foreign-home remap (wrong /Users/<name>/ segment → real home) ----
const home = os.homedir();
const root = path.dirname(home);       // /Users
const self = path.basename(home);      // e.g. siddhantbhat
const testDir = fs.mkdtempSync(path.join(home, '.bhatbot-exptest-'));
try {
  const realFile = path.join(testDir, 'package.json');
  fs.writeFileSync(realFile, '{}');
  const rel = realFile.slice(root.length + 1 + self.length + 1); // .bhatbot-exptest-XXX/package.json
  const foreign = path.join(root, 'wronguser', rel);             // /Users/wronguser/.bhatbot-.../package.json
  ok(expandPath(foreign) === realFile, 'path: foreign /Users/<name> remapped to real home when target exists');
  const foreignMissing = path.join(root, 'wronguser', 'no-such-dir-xyz', 'nope.txt');
  ok(expandPath(foreignMissing) === foreignMissing, 'path: foreign home left alone when remap target absent');
  ok(expandPath(realFile) === realFile, 'path: correct home path unchanged');
} finally {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
}

// ---- isSecretPath ----
const bb = path.join(os.homedir(), '.bhatbot');
ok(isSecretPath(path.join(bb, 'credentials.json')) === true, 'secret: credentials vault guarded');
ok(isSecretPath(path.join(bb, 'browser-profile.json')) === true, 'secret: browser session profile guarded');
ok(isSecretPath(path.join(bb, 'browser-profile-dir', 'Cookies')) === true, 'secret: browser profile dir guarded');
ok(isSecretPath(path.join(bb, 'config.json')) === false, 'secret: config.json NOT guarded (only CRED_REF handles)');
ok(isSecretPath(path.join(bb, 'memory.md')) === false, 'secret: normal .bhatbot file readable');
ok(isSecretPath('/etc/hosts') === false, 'secret: unrelated path readable');

// ---- looksComplexTool (model-routing complexity gate: complex tool tasks → Sonnet, not Haiku) ----
const looksComplexTool = load('looksComplexTool');
ok(looksComplexTool('can you make a simulation of DNA replication?') === true, 'route: "make a simulation of…" → complex (Sonnet)');
ok(looksComplexTool('build a dashboard for my health metrics') === true, 'route: build a dashboard → complex');
ok(looksComplexTool('write a python script to backtest this strategy') === true, 'route: write a script → complex');
ok(looksComplexTool('analyze the returns and plot a chart') === true, 'route: analyze + plot → complex');
ok(looksComplexTool('research GNN papers on protein folding') === true, 'route: research → complex');
ok(looksComplexTool('refactor the auth module') === true, 'route: refactor → complex');
ok(looksComplexTool('compute a Monte Carlo forecast') === true, 'route: compute a forecast → complex');
ok(looksComplexTool('open spotify') === false, 'route: trivial "open spotify" → stays Haiku');
ok(looksComplexTool('play the next song') === false, 'route: "play next song" → stays Haiku');
ok(looksComplexTool('take a screenshot') === false, 'route: screenshot → stays Haiku');
ok(looksComplexTool('make a call to mom') === false, 'route: "make a call" not upgraded (not substantive)');
ok(looksComplexTool('turn up the volume') === false, 'route: volume → stays Haiku');

// ---- looksHeavyTool (heaviest tier: scientific sims / heavy coding+interp → Opus + parallel fleet) ----
const looksHeavyTool = load('looksHeavyTool');
ok(looksHeavyTool('can you make a simulation of DNA replication?') === true, 'heavy: DNA replication simulation → Opus + fleet');
ok(looksHeavyTool('implement a protein folding model') === true, 'heavy: protein folding model → heavy');
ok(looksHeavyTool('build a realistic fluid dynamics simulation') === true, 'heavy: realistic fluid dynamics sim → heavy');
ok(looksHeavyTool('simulate molecular dynamics of a water box') === true, 'heavy: molecular dynamics sim → heavy');
ok(looksHeavyTool('design a comprehensive climate model') === true, 'heavy: comprehensive climate model → heavy');
ok(looksHeavyTool('build a dashboard for my health metrics') === false, 'heavy: dashboard → NOT heavy (stays Sonnet)');
ok(looksHeavyTool('refactor the auth module') === false, 'heavy: refactor → NOT heavy');
ok(looksHeavyTool('write a python script to sort a list') === false, 'heavy: trivial script → NOT heavy');
ok(looksHeavyTool('open spotify') === false, 'heavy: open spotify → NOT heavy');
// heavy tasks should also register as complex, so the Sonnet-then-Opus routing chain is coherent
ok(looksComplexTool('make a simulation of DNA replication') && looksHeavyTool('make a simulation of DNA replication'), 'heavy ⊂ complex: DNA sim is both (Sonnet gate then Opus override)');

// ---- heavy-tier SHAPE routing (auto: fan-out → Fable 5, solo deep-reasoning → Opus) ----
const looksFanOut = load('looksFanOut');
const looksSoloDeep = load('looksSoloDeep');
ok(looksFanOut('build a realistic fluid dynamics simulation') === true, 'shape: build a simulation → fan-out (Fable)');
ok(looksFanOut('research protein folding papers and implement a model') === true, 'shape: research + implement → fan-out (Fable)');
ok(looksFanOut('build a dashboard, analyze the data and render charts') === true, 'shape: chained build/analyze/render → fan-out (Fable)');
ok(looksFanOut('design a comprehensive climate model') === true, 'shape: design a model → fan-out (Fable)');
ok(looksSoloDeep('prove that this series converges') === true, 'shape: prove → solo deep (Opus)');
ok(looksSoloDeep('derive the closed-form solution for this ODE') === true, 'shape: derive closed-form → solo deep (Opus)');
ok(looksSoloDeep('explain the mechanism rigorously from first principles') === true, 'shape: explain mechanism rigorously → solo deep (Opus)');
// routing rule: solo-deep AND NOT fan-out ⇒ Opus, else Fable
const routesTo = (t) => (looksSoloDeep(t) && !looksFanOut(t)) ? 'opus' : 'fable';
ok(routesTo('prove that this series converges') === 'opus', 'route: pure proof → Opus');
ok(routesTo('build a realistic fluid dynamics simulation') === 'fable', 'route: sim build → Fable');
ok(routesTo('derive the equations then build a solver and test it') === 'fable', 'route: derive+build+test → Fable (fan-out wins)');

// ---- tagLastBlockForCache (incremental conversation prompt-caching breakpoint) ----
const tagCache = load('tagLastBlockForCache');
{
  // string content → wrapped into a tagged text block, earlier messages untouched
  const inp = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello there' }];
  const out = tagCache(inp);
  ok(Array.isArray(out[1].content) && out[1].content[0].cache_control && out[1].content[0].cache_control.type === 'ephemeral', 'cache: string last message → tagged text block');
  ok(out[0] === inp[0], 'cache: earlier messages are the same objects (only last cloned)');
  ok(inp[1].content === 'hello there', 'cache: original message NOT mutated');
}
{
  // array content → last block tagged, prior blocks untouched
  const inp = [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }];
  const out = tagCache(inp);
  ok(out[0].content[1].cache_control && !out[0].content[0].cache_control, 'cache: array content → only LAST block tagged');
}
{
  // already tagged → returns input unchanged (idempotent, no double breakpoint)
  const inp = [{ role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] }];
  ok(tagCache(inp) === inp, 'cache: already-tagged last block → unchanged (idempotent)');
}
ok(tagCache([]) .length === 0, 'cache: empty messages → empty');
ok(Array.isArray(tagCache('nope')) === false, 'cache: non-array → returned as-is');

// ---- looksHeavyTool (routes to the build engine / heavy tier) ----
{
  const looksHeavyTool = load('looksHeavyTool');
  ok(looksHeavyTool('design and simulate a whole iron man suit that I might wear') === true, 'heavy: "design and simulate an iron man suit" → heavy build');
  ok(looksHeavyTool('Generate a simulation of an ironman suit') === true, 'heavy: "generate a simulation of an ironman suit" → heavy build');
  ok(looksHeavyTool('build a robot arm and simulate its motion') === true, 'heavy: physical build (robot) → heavy');
  ok(looksHeavyTool('simulate protein folding from scratch') === true, 'heavy: sci-domain simulation → heavy');
  ok(looksHeavyTool('what is the weather in Tokyo') === false, 'heavy: a plain question → not heavy');
  ok(looksHeavyTool('reply to that email') === false, 'heavy: a routine action → not heavy');
}

// ---- esc / laneNotes (multi-part artifact assembly helpers) ----
{
  const esc = load('esc');
  ok(esc('<b>"a"&b</b>') === '&lt;b&gt;&quot;a&quot;&amp;b&lt;/b&gt;', 'esc: escapes HTML metacharacters');
  const laneNotes = load('laneNotes');
  const notes = '### exterior-geometry\nblue plates, 1.8m tall\n\n### power-systems\narc reactor 2.4MW';
  ok(laneNotes(notes, 'power-systems').includes('arc reactor'), 'laneNotes: slices the matching lane section');
  ok(laneNotes(notes, 'exterior-geometry').includes('blue plates'), 'laneNotes: matches hyphenated role names');
  ok(laneNotes('no headings here', 'anything').includes('no headings'), 'laneNotes: no section → returns the notes');
}

// ---- extractCode (build_project artifact/code extraction) ----
{
  const extractCode = load('extractCode');
  ok(extractCode('```python\nprint(1)\n```', 'python') === 'print(1)', 'extractCode: unwraps a fenced python block');
  ok(extractCode('```\nx=1\n```') === 'x=1', 'extractCode: unwraps an unlabelled fence');
  ok(extractCode('no fences here just text').includes('no fences'), 'extractCode: no fence → returns trimmed text');
  const html = extractCode('Here you go:\n```html\n<!doctype html><html><body>hi</body></html>\n```', 'html');
  ok(html.startsWith('<!doctype html>') && html.endsWith('</html>'), 'extractCode: html mode → slices the full document');
  const embedded = extractCode('intro prose <html><body>x</body></html> trailing', 'html');
  ok(embedded === '<html><body>x</body></html>', 'extractCode: html embedded in prose → sliced to the doc');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
