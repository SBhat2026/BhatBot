#!/usr/bin/env node
'use strict';
// Tests for window-manager.js (SPLIT_PLAN step 8 — the secondary BrowserWindow openers lifted out
// of main.js). Electron can't run in plain node + a 2nd dev instance can't boot alongside the live
// app (no single-instance lock), so this MOCKS BrowserWindow/screen/webContents and INVOKES every
// opener. That catches the runtime-only failure class that static `node -c` misses: a moved function
// referencing a main-scope variable not threaded through ctx → ReferenceError at call time (exactly
// the classifyMode regression). Also asserts idempotent re-open (show existing, don't re-create),
// state ownership (getStudioWindow), the maps snapshot promise, and the pending* IPC delegates.
// Temp $HOME + temp studio dir isolate fs writes. Wired into `npm run verify`.
//   node scripts/test-window-manager.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-wm-'));
process.env.HOME = TMP;
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- mock electron surface ----
const created = [];                       // every BrowserWindow constructed
function makeWin(opts) {
  const win = {
    _opts: opts, _destroyed: false, _closed: null,
    show() {}, focus() {}, hide() {},
    isDestroyed() { return this._destroyed; },
    isVisible() { return true; }, isFocused() { return true; },
    isFullScreen() { return true; }, setFullScreen() {},
    loadURL() {}, loadFile() {}, reload() {},
    on(ev, cb) { if (ev === 'closed') this._closed = cb; },
    close() { this._destroyed = true; if (this._closed) this._closed(); },
    webContents: {
      id: 99, send() {}, isLoading() { return false; }, once() {}, getURL() { return 'about:blank'; },
      hostWebContents: null,
      executeJavaScript() { return Promise.resolve(); },
      async capturePage() {
        return { isEmpty() { return false; }, resize() { return { toJPEG() { return { toString() { return 'BASE64IMG'; } }; } }; } };
      },
    },
  };
  return win;
}
function BrowserWindow(opts) { const w = makeWin(opts); created.push(w); return w; }   // `new` returns the object
const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, size: { width: 1920, height: 1080 } }) };
const webContents = { getAllWebContents: () => [] };

let createWindowCalls = 0;
const mainWin = makeWin({});
const ctx = {
  BrowserWindow, screen, webContents,
  getMainWindow: () => mainWin,
  createWindow: () => { createWindowCalls++; },
  paths: {
    STUDIO_DIR: path.join(TMP, 'studio'),
    STUDIO_INDEX: path.join(TMP, 'studio', 'index.html'),
    CHESS_HTML: path.join(TMP, 'studio', 'chess.html'),
    NEXUS_URL: 'https://nexusresearch.xyz',
  },
};

const wm = require(path.join(ROOT, 'window-manager'))(ctx);

// ---- factory shape ----
const EXPECTED = ['toggleWindow', 'studioWebContents', 'getStudioWindow', 'openNexusWindow', 'ensureStudio',
  'openStudioWindow', 'openChessWindow', 'openChessApplet', 'openWorldCupWindow', 'openInteractive3D',
  'sendPendingModel', 'openMoleculeWindow', 'sendPendingMol', 'openMapsWindow', 'openMapsWindowSnapshot',
  'sendPendingMap', 'fireMapRendered'];
for (const n of EXPECTED) ok(typeof wm[n] === 'function', `exports "${n}"`);

(async () => {
  // ---- every opener invokes without throwing (the ReferenceError net) ----
  const before = created.length;
  ok((() => { try { wm.openNexusWindow(); return true; } catch (e) { console.error(e); return false; } })(), 'openNexusWindow() runs');
  ok(created.length === before + 1, 'openNexusWindow created exactly one window');
  wm.openNexusWindow();
  ok(created.length === before + 1, 'openNexusWindow is idempotent (shows existing, no 2nd window)');

  ok((() => { try { wm.openStudioWindow(); return true; } catch (e) { console.error(e); return false; } })(), 'openStudioWindow() runs (fs.watch on temp studio dir)');
  ok(fs.existsSync(ctx.paths.STUDIO_INDEX), 'ensureStudio wrote the studio placeholder');
  ok(wm.getStudioWindow() && !wm.getStudioWindow().isDestroyed(), 'getStudioWindow exposes the owned studio window');

  ok((() => { try { return !!wm.openChessWindow('hard'); } catch (e) { console.error(e); return false; } })(), 'openChessWindow("hard") returns a result (difficulty path runs)');
  ok(typeof wm.openChessApplet('atomic') === 'object', 'openChessApplet("atomic") returns a result');
  ok(typeof wm.openWorldCupWindow() === 'object', 'openWorldCupWindow() returns a result');

  // 3D viewer needs a real file to read+stat
  const modelFile = path.join(TMP, 'model.stl'); fs.writeFileSync(modelFile, 'solid x\nendsolid x\n');
  ok((() => { try { wm.openInteractive3D(modelFile); return true; } catch (e) { console.error(e); return false; } })(), 'openInteractive3D(file) runs');
  ok((() => { try { wm.openInteractive3D('/no/such/file'); return true; } catch { return false; } })(), 'openInteractive3D(missing) is a graceful no-op');

  ok((() => { try { wm.openMoleculeWindow({ pdb: 'X' }); return true; } catch (e) { console.error(e); return false; } })(), 'openMoleculeWindow(payload) runs');
  ok((() => { try { wm.openMapsWindow({ lat: 1, lng: 2 }); return true; } catch (e) { console.error(e); return false; } })(), 'openMapsWindow(payload) runs');

  // ---- pending* IPC delegates: deliver the stored payload to a (mock) sender ----
  let molSent = null; wm.sendPendingMol({ sender: { send: (ch, p) => { molSent = { ch, p }; } } });
  ok(molSent && molSent.ch === 'molecule' && molSent.p.pdb === 'X', 'sendPendingMol replays the pending molecule payload');
  let modelSent = null; wm.sendPendingModel({ sender: { send: (ch, p) => { modelSent = { ch, p }; } } });
  ok(modelSent && modelSent.ch === 'model' && modelSent.p.ext === 'stl', 'sendPendingModel replays the pending 3D model');

  // ---- maps snapshot promise: resolves via fireMapRendered (no 7s wait) ----
  const snapP = wm.openMapsWindowSnapshot({ lat: 1, lng: 2 });
  wm.fireMapRendered();
  const snap = await snapP;
  ok(snap === 'BASE64IMG', 'openMapsWindowSnapshot resolves a base64 JPEG when the renderer signals');

  // ---- toggleWindow falls back to createWindow when there's no main window ----
  const wm2 = require(path.join(ROOT, 'window-manager'))(Object.assign({}, ctx, { getMainWindow: () => null }));
  wm2.toggleWindow();
  ok(createWindowCalls === 1, 'toggleWindow() with no main window calls createWindow()');
  ok((() => { try { wm.toggleWindow(); return true; } catch (e) { console.error(e); return false; } })(), 'toggleWindow() with a main window runs (show/hide path)');

  // ---- studioWebContents degrades to null (no matching guest) ----
  ok(wm.studioWebContents() === null, 'studioWebContents() returns null when no studio <webview> guest exists');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
