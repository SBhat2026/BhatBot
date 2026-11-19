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
//
// The parameter list is walked FIRST, by paren depth, before any brace matching starts. The obvious
// version — jump to the first `{` after the name — silently truncates any function with an object
// default in its signature: `function requestConfirm(command, reason, opts = {})` returns fifty
// characters, the brace matcher closes on `{}` at depth zero, and every assertion about the body then
// passes or fails on an empty string. That cost three false failures before it was noticed, and the
// failures looked exactly like a missing feature.
function extract(src, name) {
  const sig = 'function ' + name + '(';
  let start = src.indexOf(sig);
  if (start < 0) throw new Error('not found: ' + name);
  // KEEP THE `async`. Matching on 'function NAME(' silently drops a preceding `async`, and the
  // extracted body then throws "await is only valid in async functions" from inside new Function —
  // an error that points at the helper under test rather than at the harness that mangled it.
  const sigStart = start;                                  // where the paren walk must begin
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = sigStart + sig.length, paren = 1;
  for (; i < src.length && paren > 0; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') paren--;
  }
  i = src.indexOf('{', i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const body = src.slice(start, i);
  // A body this short means the walk went wrong, not that the function is tiny — and a silent
  // truncation is the failure this whole comment is about.
  if (body.length < sig.length + 4) throw new Error(`extract(${name}) produced ${body.length} chars — the signature walk failed`);
  return body;
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

// ---- PERSIST / persistenceProfile (turn step-budget profiles) ----
// The table + its default live at module scope in main.js precisely so they're testable here (they
// used to be trapped inside the agentLoop closure). Slice from the declaration through the end of
// persistenceProfile and eval that fragment.
{
  const from = main.indexOf('const PERSIST = {');
  const end = main.indexOf('\n', main.indexOf('function persistenceProfile('));
  ok(from > 0 && end > from, 'PERSIST: table + persistenceProfile are at module scope in main.js');
  // eslint-disable-next-line no-new-func
  const scope = new Function(main.slice(from, end) + '\nreturn { PERSIST, PERSIST_DEFAULT, persistenceProfile };')();
  const { PERSIST, PERSIST_DEFAULT, persistenceProfile } = scope;

  for (const k of ['normal', 'high', 'relentless']) {
    const p = PERSIST[k];
    ok(p && Number.isFinite(p.base) && Number.isFinite(p.hard) && Number.isFinite(p.ext) && typeof p.secondWind === 'boolean',
      `PERSIST.${k}: numeric base/hard/ext + boolean secondWind`);
    ok(p.hard >= p.base, `PERSIST.${k}: hard ceiling is not below the base budget`);
  }
  ok(PERSIST.normal.hard < PERSIST.high.hard && PERSIST.high.hard < PERSIST.relentless.hard,
    'PERSIST: ceilings increase normal → high → relentless');

  // The default is what an UNCONFIGURED install gets, and it must grant a second wind: durable
  // missions assume a stuck turn gets one replan before it parks. This regressed silently before —
  // the live config had no `persistence` key, so everything ran at normal/60-steps/no-second-wind.
  ok(PERSIST_DEFAULT === 'high', 'PERSIST_DEFAULT is "high"');
  ok(persistenceProfile(undefined) === PERSIST.high, 'persistenceProfile: unset config → the high profile');
  ok(persistenceProfile(undefined).secondWind === true, 'persistenceProfile: unset config → second wind ON');
  ok(persistenceProfile('nonsense').secondWind === true, 'persistenceProfile: unknown value → falls back to the default');
  ok(persistenceProfile('normal') === PERSIST.normal, 'persistenceProfile: explicit "normal" is still honoured');
  ok(persistenceProfile('relentless').hard === 200, 'persistenceProfile: explicit "relentless" → 200-step ceiling');
}

// ---- detectLoop (the AutoGPT failure mode) ----
// The canonical autonomous-agent failure is not "runs too long", it's repeating ONE call that will
// never start working. Must fire on identical repeats and stay silent on legitimate retries.
{
  const { detectLoop, toolSig } = require('../lib/pure');
  const sig = (n, i) => toolSig(n, i);

  ok(detectLoop([]) === null, 'detectLoop: empty history → null');
  ok(detectLoop([sig('read_file', { p: 'a' }), sig('read_file', { p: 'b' }), sig('web_search', { q: 'x' })]) === null,
    'detectLoop: all-distinct calls → null');

  const spin = Array.from({ length: 3 }, () => sig('run_shell', { cmd: 'npm test' }));
  const hit = detectLoop(spin);
  ok(hit && hit.count === 3 && hit.name === 'run_shell', 'detectLoop: 3 identical calls → detected, with the tool name');

  ok(detectLoop([sig('run_shell', { cmd: 'x' }), sig('run_shell', { cmd: 'x' })]) === null,
    'detectLoop: 2 identical calls → below threshold, no false alarm');

  // A retry with CHANGED arguments is problem-solving, not thrashing — it must never trip.
  ok(detectLoop([sig('read_file', { p: 'a' }), sig('read_file', { p: 'b' }), sig('read_file', { p: 'c' })]) === null,
    'detectLoop: same tool, DIFFERENT args → not a loop (that is legitimate retrying)');

  // Only the recent window counts, so an early repeat that the agent has since moved past is forgiven.
  const old = [...spin, ...Array.from({ length: 8 }, (_, i) => sig('read_file', { p: i }))];
  ok(detectLoop(old) === null, 'detectLoop: repeats that fell out of the window are forgiven');

  // Interleaving must not hide a loop — the offender is still 3 of the last 8.
  const interleaved = [sig('a', 1), sig('run_shell', { cmd: 'x' }), sig('b', 2), sig('run_shell', { cmd: 'x' }), sig('c', 3), sig('run_shell', { cmd: 'x' })];
  const iHit = detectLoop(interleaved);
  ok(iHit && iHit.name === 'run_shell' && iHit.count === 3, 'detectLoop: catches an interleaved loop (3 of the last 8)');

  ok(detectLoop(spin, { threshold: 4 }) === null, 'detectLoop: threshold is tunable');
  ok(detectLoop([sig('x', 1), sig('x', 1)], { threshold: 2 }).count === 2, 'detectLoop: a lower threshold fires earlier');
  ok(detectLoop(Array.from({ length: 20 }, () => sig('x', 1))).window <= 8, 'detectLoop: only inspects the recent window');
}

// ---- mergeConfig — the "config edit during boot is silently reverted" fix -------------------------
// The bug was a top-level spread: a patch to one key inside a section replaced the whole section, so
// a sibling key another writer had just added vanished. Two writers touching config.selfHeal in the
// same boot is not hypothetical — it is what was observed.
{
  const mergeConfig = load('mergeConfig');

  const base = { selfHeal: { enabled: true, interval: 15 }, voice: { rate: 1.1 } };
  const out = mergeConfig(base, { selfHeal: { enabled: false } });
  ok(out.selfHeal.enabled === false, 'mergeConfig: the patched nested key wins');
  ok(out.selfHeal.interval === 15, 'mergeConfig: a SIBLING nested key survives — this is the whole bug');
  ok(out.voice.rate === 1.1, 'mergeConfig: an untouched section is left alone');

  // Arrays are complete lists in this config (triage.neverArchive, plugins, allow-lists). Merging
  // them index-wise would make removing an entry impossible, so they replace wholesale.
  const arr = mergeConfig({ triage: { neverArchive: ['a', 'b', 'c'] } }, { triage: { neverArchive: ['a'] } });
  ok(arr.triage.neverArchive.length === 1 && arr.triage.neverArchive[0] === 'a',
    'mergeConfig: an array REPLACES, so a pin can actually be removed');

  // Clearing a section on purpose must still work.
  ok(mergeConfig({ geo: { city: 'x' } }, { geo: null }).geo === null, 'mergeConfig: an explicit null clears a section');

  // A scalar over an object, and an object over a scalar, both replace — no crash, no half-merge.
  ok(mergeConfig({ a: { b: 1 } }, { a: 5 }).a === 5, 'mergeConfig: scalar over object replaces');
  ok(mergeConfig({ a: 5 }, { a: { b: 1 } }).a.b === 1, 'mergeConfig: object over scalar replaces');

  // Top-level keys still behave exactly as a spread did.
  ok(mergeConfig({ x: 1 }, { y: 2 }).x === 1, 'mergeConfig: unrelated top-level keys are preserved');

  // It must not mutate either input — saveConfig hands it a fresh read, but a future caller might not.
  const b2 = { s: { k: 1 } }; mergeConfig(b2, { s: { k: 2 } });
  ok(b2.s.k === 1, 'mergeConfig: does not mutate the base it was given');
}

// ---- requestConfirm's two "nobody is here" gates ------------------------------------------------
// autonomousMode is ON by default, which is right for a turn Siddhant is watching — he asked, he is
// here, a confirm card is a speed bump. It is the wrong default for work he started so he could go to
// bed: an `rm` at 4am gets auto-approved with nobody to see the card, and "nothing objected" is not
// "he approved it". remoteDepth already encodes exactly this condition for phone-driven turns; a
// supervised long run is the same condition arriving through a different door, and it runs LOCALLY, so
// isRemote() is false for it.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = extract(src, 'requestConfirm');

  ok(/isUnattended\(\)/.test(body),
    'requestConfirm checks isUnattended() — a long run is "nobody at the keyboard" even though it is local');
  // Order matters: the unattended denial has to come BEFORE the autonomousMode auto-approval, or it
  // never runs. This is the whole bug, and it is invisible in a diff that only shows the new block.
  ok(body.indexOf('isUnattended()') < body.indexOf('isAutonomous()'),
    'and it checks it BEFORE autonomousMode auto-approves — after would never run');
  ok(/unattendedAllowDestructive/.test(body), 'with an explicit opt-out, the way the remote gate has one');

  // The counter has to be incremented by the worker and decremented in a finally, or one throw leaves
  // the whole app permanently in unattended mode and every destructive confirm is denied forever.
  const worker = extract(src, 'supervisedWorker');
  ok(/unattendedDepth\+\+/.test(worker), 'the supervised worker raises the flag');
  ok(/finally \{ unattendedDepth--; \}/.test(worker),
    'and lowers it in a FINALLY — one throw without this leaves the app denying every destructive confirm forever');
  ok((worker.match(/unattendedDepth\+\+/g) || []).length === (worker.match(/unattendedDepth--/g) || []).length,
    'the increments and decrements balance');

  // It is a COUNTER, not a boolean, because `width` workers run at once and a boolean would be
  // cleared by whichever finished first while the others were still running.
  ok(/let unattendedDepth = 0/.test(src) && /function isUnattended\(\) \{ return unattendedDepth > 0; \}/.test(src),
    'it is a depth counter — width workers run concurrently, and a boolean would clear on the first to finish');
}

// ---- the autonomy lane must survive MODULE INIT -------------------------------------------------
// Three objects are constructed at main.js module scope: the escalation door, the tool forge and the
// supervisor. A throw in any of them does not break a feature — it stops BhatBot booting at all, and
// nothing else in this suite would notice, because every other test reaches into main.js for one
// function and never runs the top of the file.
//
// It cannot be checked by launching the app: that opens a window and starts the scheduler, the triage
// lane and the briefing, which at 1am is a way to wake Siddhant up to prove his assistant starts. So
// the block is extracted and evaluated against stubs, which is exactly what module init is.
//
// The stubs are deliberately HOSTILE. Everything main.js has not defined yet at that point in the
// file must be reached through a closure, never called; a stub that throws the moment it is invoked
// is what proves it. This is the actual failure mode — `loadConfig()` was being called eagerly here
// for the interruption ceiling, which worked only because loadConfig happens to be hoisted and
// tolerant of a missing file.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = src.indexOf("const designation = require('./lib/designation');");
  const end = src.indexOf('}, {});', start);
  ok(start > 0 && end > start, 'the autonomy lane block is where it was left');
  const block = src.slice(start, end + 7).replace(/require\('\.\/lib\//g, "require('" + path.join(__dirname, '..', 'lib') + "/");

  const tooEarly = (name) => () => { throw new Error(`${name}() was called during module init — it must be reached lazily, through a closure`); };
  let built = null;
  try {
    // eslint-disable-next-line no-new-func
    built = new Function('require', 'sandbox', 'missions', 'loadConfig', 'notifyUser', 'sendToActivity',
      'fullCatalog', 'requestConfirm', 'console', 'supervisedWorker', 'supervisedDecompose', 'supervisorEvent',
      block + '\nreturn { escalations, forge, supervisor };')(
      require,
      require('../lib/sandbox'),
      require('../lib/mission').createMissions({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'boot-')) }),
      tooEarly('loadConfig'), tooEarly('notifyUser'), tooEarly('sendToActivity'),
      tooEarly('fullCatalog'), tooEarly('requestConfirm'),
      { log() {}, warn() {}, error() {} },
      tooEarly('supervisedWorker'), tooEarly('supervisedDecompose'), tooEarly('supervisorEvent'),
    );
    ok(true, 'the autonomy lane constructs at module init without touching anything defined later');
  } catch (e) {
    ok(false, 'the autonomy lane throws during module init — THE APP WOULD NOT BOOT: ' + e.message);
  }

  if (built) {
    ok(typeof built.escalations.ask === 'function' && typeof built.escalations.answer === 'function', 'the escalation door is usable');
    ok(typeof built.forge.forge === 'function' && typeof built.forge.list === 'function', 'the forge is usable');
    ok(typeof built.supervisor.run === 'function' && typeof built.supervisor.roster === 'function', 'the supervisor is usable');
    // And the deps really are lazy: asking for the roster must not reach any of the hostile stubs.
    let threw = null;
    try { built.supervisor.roster(); } catch (e) { threw = e.message; }
    ok(!threw, 'and calling into it does not reach anything main.js defines later' + (threw ? ' — ' + threw : ''));
  }
}

// ---- the supervised worker prices in DOLLARS ----------------------------------------------------
// `spendUsd` drives the $2 run wall and the $0.35 per-item wallet, and it was computed by a hand-rolled
// `(in/1e6)*3 + (out/1e6)*15`. claude-sonnet-5 bills $2/$10, so an uncached turn was over-counted by
// half; and the formula ignored cache_read/cache_creation entirely, so a CACHED turn — where
// input_tokens is only the delta — was under-counted by about as much the other way. The walls were
// enforcing a currency that was not dollars. lib/pricing.js already exists to prevent exactly this.
{
  const pricing = require('../lib/pricing');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  const worker = extract(src, 'supervisedWorker');
  ok(/pricing\.usd\(MODEL_SONNET/.test(worker), 'the supervised worker prices through lib/pricing');
  ok(!/\/ 1e6\) \* 3 \+/.test(worker), 'and carries no hand-rolled rate of its own');

  const drone = extract(src, 'droneAgentRun');
  ok(/pricing\.usd\(model/.test(drone), 'the drone loop prices through lib/pricing too');
  ok(!/\/ 1e6\) \* 3 \+/.test(drone), 'and carries no hand-rolled rate either');

  // The number the walls would now see, for a realistic cached turn.
  const cached = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 3000 };
  const real = pricing.usd('claude-sonnet-5', cached);
  const handRolled = (1000 / 1e6) * 3 + (500 / 1e6) * 15;
  ok(real > handRolled * 1.5,
    `a cached turn really costs $${real.toFixed(4)} and the old formula said $${handRolled.toFixed(4)} — it under-counted exactly when caching worked`);
  ok(pricing.usd('claude-sonnet-5', { input_tokens: 1000, output_tokens: 500 }) < handRolled,
    'and it over-counted when caching did not');

  // Tokens must reach the journal, or nothing can ever predict what a run will cost.
  ok(/tokensIn \+=/.test(worker) && /tokensOut \+=/.test(worker), 'the worker accumulates token counts');
  ok((worker.match(/tokensIn, tokensOut/g) || []).length >= 3,
    'and every return path carries them out — a path that drops them is a hole in the cost history');
}

// ---- the cache gate counts the whole billable prefix ---------------------------------------------
// It counted `messages` alone. A supervised worker's first turn is ~30 tokens of goal beside ~5,500 of
// tool schema, so the gate looked at a 9,000-token prefix, saw 30, and declined to cache it. Turn one
// therefore never wrote a cache entry and the schema was billed at full rate at least twice per item.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const i = src.indexOf('const cacheable = estimateTokens(body.messages)');
  ok(i > 0, 'the gate computes a `cacheable` prefix size');
  const block = src.slice(i, i + 420);
  ok(/body\.tools/.test(block), 'including the tools array');
  ok(/body\.system/.test(block), 'and the system prompt');
  ok(/cacheable >= 2000/.test(block), 'and that total is what the 2000-token threshold tests');
  ok(!/estimateTokens\(body\.messages\) >= 2000/.test(src), 'the messages-only test is gone');
}

(async () => {

// ── the browser context reaper ───────────────────────────────────────────────────────────────────
//
// The RAM death spiral starts here: `browserContext.on('page')` accumulates every popup and
// target=_blank tab as a live renderer and nothing ever closed them. The reaper has to be TIMID,
// because this is a visible window Siddhant shares with the agents — a reaped tab he was reading is a
// far worse bug than the leak — so the interesting assertions are all about what it REFUSES to close.
{
  // The reaper closes over `browserContext`, `page`, `pageSeen`, `touchPage` and `console`, so the
  // harness supplies them and drives real (fake) page objects through it.
  const mk = (id) => ({ id, closed: false, isClosed() { return this.closed; }, async close() { this.closed = true; } });
  const build = () => {
    const pages = [];
    const ctx = { pages: () => pages };
    const fn = new Function('deps', `
      const { ctxRef, pageRef, pageSeen, touchPage, console } = deps;
      let browserContext = ctxRef.v, page = pageRef.v;
      ${extract(main, 'reapBrowserPages')}
      return (opts) => { browserContext = ctxRef.v; page = pageRef.v; return reapBrowserPages(opts); };
    `);
    const pageSeen = new WeakMap();
    const touchPage = (p, byUser) => { const prev = pageSeen.get(p) || {}; pageSeen.set(p, { at: Date.now(), user: prev.user || !!byUser }); };
    const ctxRef = { v: ctx }, pageRef = { v: null };
    const reap = fn({ ctxRef, pageRef, pageSeen, touchPage, console: { log() {} } });
    return { pages, ctx, ctxRef, pageRef, pageSeen, touchPage, reap };
  };

  // 1. The page being driven is never closed, however stale it looks.
  {
    const h = build();
    const active = mk('active'), idle = mk('idle');
    h.pages.push(active, idle);
    h.pageSeen.set(active, { at: 0, user: false });
    h.pageSeen.set(idle, { at: 0, user: false });
    h.pageRef.v = active;
    await h.reap({ idleMs: 1000, maxPages: 6 });
    ok(!active.closed, 'the page an agent is driving is never reaped, however stale its timestamp');
    ok(idle.closed, 'while a genuinely idle sibling is');
  }

  // 2. A page HE touched is his, permanently. One click exempts it.
  {
    const h = build();
    const his = mk('his'), theirs = mk('theirs'), keep = mk('keep');
    h.pages.push(keep, his, theirs);
    h.pageRef.v = keep;
    h.pageSeen.set(his, { at: 0, user: true });
    h.pageSeen.set(theirs, { at: 0, user: false });
    await h.reap({ idleMs: 1000, maxPages: 6, force: true });
    ok(!his.closed, 'a tab Siddhant clicked in is exempt even under force — he cannot know a background process has opinions about it');
    ok(theirs.closed, 'an untouched one is not');
  }

  // 3. A fresh page is left alone: the window is about idleness, not tidiness.
  {
    const h = build();
    const keep = mk('keep'), fresh = mk('fresh');
    h.pages.push(keep, fresh);
    h.pageRef.v = keep;
    h.touchPage(fresh, false);
    await h.reap({ idleMs: 60000, maxPages: 6 });
    ok(!fresh.closed, 'a page touched moments ago is not reaped — the threshold is idleness, not housekeeping');
  }

  // 4. The hard cap overrides the idle window, because past it the alternative is the spiral.
  {
    const h = build();
    const keep = mk('keep');
    h.pages.push(keep); h.pageRef.v = keep; h.touchPage(keep, false);
    const extra = [];
    for (let i = 0; i < 5; i++) { const p = mk('x' + i); extra.push(p); h.pages.push(p); h.touchPage(p, false); }
    const r = await h.reap({ idleMs: 10 * 60000, maxPages: 3 });
    ok(r.closed === 3, `past the cap the oldest untouched pages go regardless of age (closed ${r.closed} to get 6 down to 3)`);
    ok(!keep.closed, 'and never the active one');
  }

  // 5. It never empties the context. A browser with no pages is a broken browser, not a tidy one.
  {
    const h = build();
    const only = mk('only');
    h.pages.push(only);
    h.pageRef.v = null;                       // nothing marked active — the dangerous case
    h.pageSeen.set(only, { at: 0, user: false });
    await h.reap({ idleMs: 0, maxPages: 1, force: true });
    ok(!only.closed, 'the last remaining page is never closed, even with nothing marked active');
  }

  // 6. A page that throws on close does not stop the sweep.
  {
    const h = build();
    const keep = mk('keep'), bad = mk('bad'), good = mk('good');
    bad.close = async () => { throw new Error('Target closed'); };
    h.pages.push(keep, bad, good);
    h.pageRef.v = keep;
    h.pageSeen.set(bad, { at: 0, user: false });
    h.pageSeen.set(good, { at: 0, user: false });
    await h.reap({ idleMs: 1000, maxPages: 6 });
    ok(good.closed, 'one page throwing on close does not abort the sweep');
  }

  // 7. No context at all is not an error.
  {
    const h = build();
    h.ctxRef.v = null;
    const r = await h.reap({});
    ok(r && r.closed === 0, 'with no browser open it does nothing and says so');
  }
}

  // ── A FUNCTION NOBODY CALLS IS NOT A FEATURE ───────────────────────────────────────────────────
  //
  // The browser page reaper was written, unit-tested and committed in September, and never ran: the
  // edit that added its timer failed an unrelated assertion and saved nothing, while the tests above
  // call reapBrowserPages directly and so stayed green. A test that calls the function for you cannot
  // tell whether anything else does. This is the missing half: every `start…` in main.js — the
  // convention for "begin a background loop" — must be CALLED somewhere other than its own definition.
  {
    const starts = [...main.matchAll(/^(?:async\s+)?function\s+(start[A-Z]\w*)\s*\(/gm)].map((m) => m[1]);
    ok(starts.length >= 5, `found the background-loop starters (${starts.length})`);
    const orphans = starts.filter((name) => {
      const calls = [...main.matchAll(new RegExp('(?<![\\w$.])' + name + '\\s*\\(', 'g'))].length;
      return calls < 2;                                   // one match is the definition itself
    });
    ok(orphans.length === 0, `every start…() is actually called (orphans: ${orphans.join(', ') || 'none'})`);
    ok(starts.includes('startBrowserReaper'), 'the browser reaper has a starter at all');
    ok(/startBrowserReaper\(\);\s*\/\/ stops the browser role/.test(main), 'and it is started on the app-ready path');
  }

  // ── NO CALL LEG IS EXEMPT FROM THE PREFLIGHT ───────────────────────────────────────────────────
  //
  // The cloud leg used to be: `viaCloud || (reach.ok && pre.ok)`. Seven September calls reached their
  // webhook and still played "an application error", so reachability was never the question, and the
  // cloud handler has never carried a real call. An exempt leg means the first sign of a fault is
  // his phone ringing with an error.
  {
    const body = extract(main, 'twilioCall');
    ok(/voicepreflight\.check\(\{[^}]*c\.cloudToken[^}]*path:\s*'outgoing'[^}]*param:\s*'purpose'/.test(body),
      'the cloud leg runs a signed preflight shaped like the request Twilio will make');
    ok(/if \(pre\.ok\) leg = \{ kind: 'cloud'/.test(body) && /if \(p2\.ok\) \{ leg = \{ kind: 'mac'/.test(body) && /if \(leg\) \{/.test(body),
      'and BOTH legs require it to pass before a two-way call is placed (the Mac leg is tried when the cloud fails)');
    ok(/avail\.authDead/.test(body) && /downgrade:\s*'telegram'/.test(body), 'a disconnected calendar texts instead of ringing blind');
    ok(/calendarEventsOrThrow/.test(body), 'and a failed calendar read can no longer arrive as an empty calendar');
  }

  // ── A DECLINE IS NOT AN EMPTY ANSWER ───────────────────────────────────────────────────────────
  //
  // Current models can refuse with HTTP 200 and stop_reason "refusal". Every caller reads a reply by
  // filtering for text blocks, so a refusal arrived as "" — which already means "found nothing".
  {
    const noteRefusal = load('noteRefusal');
    const quiet = console.warn; console.warn = () => {};
    const plain = { content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' };
    ok(noteRefusal(plain, 'm') === plain, 'an ordinary reply passes through untouched — same object');
    const r = noteRefusal({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms' } }, 'claude-sonnet-5-5');
    const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    ok(text.length > 20 && /declined/.test(text), `a refusal with no text gets one that says what happened ("${text.slice(0, 60)}…")`);
    ok(/general harms/.test(text), 'and names the category in plain words');
    ok(r.refused && r.refused.category === 'general_harms', 'the response is marked refused, so a caller can branch on it');
    const withThinking = noteRefusal({ content: [{ type: 'thinking', thinking: '', signature: 's' }], stop_reason: 'refusal' }, 'm');
    ok(withThinking.content[0].type === 'thinking' && withThinking.content.length === 2, 'existing blocks are kept — the note is appended, not substituted');
    const partial = noteRefusal({ content: [{ type: 'text', text: 'Here is part of it' }], stop_reason: 'refusal' }, 'm');
    ok(partial.content.length === 1 && partial.refused, 'a refusal that already carries text keeps its own words and is only marked');
    ok(noteRefusal(null, 'm') === null, 'and a missing response does not throw');
    console.warn = quiet;
    ok(/noteRefusal\(await res\.json\(\), body\.model\)/.test(main) && /return noteRefusal\(\{ content, stop_reason/.test(main),
      'both the request and the stream path run every response through it');
  }

  // ── A STREAMED THINKING BLOCK COMES BACK AS A THINKING BLOCK ───────────────────────────────────
  //
  // The stream's return mapped anything that was not a tool_use to { type:'text', text: b.text }. A
  // thinking block has no `text`, so it came back as a text block with text undefined — the reasoning
  // was dropped from every streamed turn and a malformed block went into history in its place.
  {
    const body = extract(main, 'anthropicStream');
    ok(!/:\s*\{ type: 'text', text: b\.text \}\)/.test(body), 'the stream no longer flattens every non-tool block to text');
    ok(/if \(b\.type === 'thinking'\) return \{ type: 'thinking', thinking: b\.thinking \|\| '', signature: b\.signature \|\| '' \}/.test(body),
      'a thinking block is returned with its thinking and its signature');
    ok(/const \{ _json, \.\.\.rest \} = b;/.test(body), 'and anything it does not recognise goes back as received rather than coerced');
    ok(/stop_details = ev\.delta\.stop_details/.test(body), 'the refusal category is read off the stream');
  }

  // ── THE AUTONOMY POLICY SITS IN FRONT OF EVERY TOOL ────────────────────────────────────────────
  {
    const body = extract(main, 'executeTool');
    const iDecide = body.indexOf('autonomy.decide('), iTier = body.indexOf('riskOf('), iRun = body.indexOf('READ_CACHEABLE');
    ok(iDecide > 0 && iDecide < iTier && iDecide < iRun, 'it is consulted before the tier gate and before anything runs or is served from cache');
    ok(/verdict\.verdict === 'forbid'[\s\S]{0,900}return result;/.test(body), 'a forbidden target returns before the tool executes');
    ok(!/forbid[\s\S]{0,400}requestConfirm/.test(body.slice(iDecide, iDecide + 1400)), 'and is never offered for approval — there is no way to say yes to it');
    ok(/autonomy\.decide\(name, auditInput,/.test(body), 'it judges the input with credential handles intact, so a secret is never part of a reason');
    ok(/if \(approved !== null\) \{ try \{ autonomy\.learn\(verdict, approved\)/.test(body), 'an answer is learned from; silence is not');
    ok(/opts\.hermetic \? null/.test(body), 'a drone, which has nobody to ask, is treated as unanswered rather than approved');
    const ask = extract(main, 'askAboutAction');
    ok(/isRemote\(\) \|\| isUnattended\(\)\) return Promise\.resolve\(null\)/.test(ask), 'with nobody at the desk it does not pretend to have asked');
    ok(/notifyUser\(/.test(ask) && /60 \* 1000/.test(ask), 'an unanswered card becomes a Telegram line after a minute');
    ok(/res\(null\), 10 \* 60 \* 1000/.test(ask), 'and it gives up after ten minutes instead of hanging the turn forever');
    ok(/brain', 'standard-actions\.json'/.test(main), 'what it learns is stored in the brain directory, as a file he can read and edit');
  }

  // ── EVERY ROUTED MODEL HAS A RATE-LIMIT ROW ────────────────────────────────────────────────────
  // Found by LAUNCHING the packaged app after the 5.5 switch: the first scheduled task died on
  // `Cannot read properties of undefined (reading 'itpm')`. No unit test had loaded the table with
  // the new ids, because nothing tested the table at all.
  {
    const rl = main.slice(main.indexOf('const RATE_LIMITS = {'), main.indexOf('function rateLimitsFor('));
    const rows = new Set([...rl.matchAll(/'(claude-[a-z0-9-]+)':/g)].map((m) => m[1]));
    const routed = [];
    for (const m of main.matchAll(/^const MODEL_(SONNET|OPUS|HAIKU) = ([^;]+);/gm)) for (const id of m[2].matchAll(/'(claude-[^']+)'/g)) routed.push(id[1]);
    const missing = routed.filter((id) => !rows.has(id));
    ok(routed.length >= 6 && missing.length === 0, `every routed model, both generations, has a rate-limit row (missing: ${missing.join(', ') || 'none'})`);
    ok(/RATE_LIMITS\[MODEL_HAIKU\] \|\| \{ itpm: \d+, otpm: \d+ \}/.test(main), 'and the fallback for an unknown model is a literal, so it cannot itself be missing');
  }

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

})();
