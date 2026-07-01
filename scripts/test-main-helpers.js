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

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
