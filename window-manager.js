'use strict';
// window-manager.js — SPLIT_PLAN step 8. The secondary BrowserWindow openers (Nexus, Studio,
// Chess, World Cup, Molecule, Maps, 3D viewer) + the hotkey toggle, lifted out of main.js. Each
// window's state (the window handle + any pending payload) is OWNED here; main keeps thin const
// wrappers (`const openNexusWindow = wm.openNexusWindow`) so every existing call site is unchanged.
//
// DI factory (the project's standard pattern). main builds one ctx and passes it. Electron classes
// (BrowserWindow/screen/webContents) ride in via ctx because the module must not `require('electron')`
// at a different point in the lifecycle. The module lives at the repo ROOT so __dirname matches
// main.js — asset/preload paths (assets/*.html, src/preload-*.js) resolve identically.
//
// Stays in main BY DESIGN (too coupled to lift cleanly): createWindow + mainWindow (the 42-site
// hub), openTerminalWindow (node-pty lifecycle + pty IPC), openAgentWindow (fleet/mainWindow).
const fs = require('fs');
const path = require('path');

module.exports = function makeWindowManager(ctx) {
  const { BrowserWindow, screen, webContents, getMainWindow, createWindow } = ctx;
  const { STUDIO_DIR, STUDIO_INDEX, CHESS_HTML, NEXUS_URL } = ctx.paths;

  // --- owned window state (single source of truth for the secondary windows) ---
  let nexusWindow = null, studioWindow = null, chessWindow = null, worldCupWindow = null;
  let chessAppletWindow = null, studioWatcher = null;
  let viewerWindow = null, pendingModel = null;
  let molWindow = null, pendingMol = null;
  let mapsWindow = null, pendingMap = null, mapRenderedCb = null;

  function toggleWindow() {
    const mainWindow = getMainWindow();
    if (!mainWindow) return createWindow();
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else { if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true); mainWindow.show(); mainWindow.focus(); }
  }

  // The <webview> guest hosting Studio lives inside mainWindow; find its WebContents so we can
  // capturePage() it for the design vision-feedback loop.
  function studioWebContents() {
    try {
      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      return webContents.getAllWebContents().find((wc) => {
        try { return wc.hostWebContents && wc.hostWebContents.id === mainWindow.webContents.id && /studio/.test(wc.getURL()); } catch { return false; }
      }) || null;
    } catch { return null; }
  }

  // --- Nexus (embedded research navigator) ---
  function openNexusWindow() {
    if (nexusWindow && !nexusWindow.isDestroyed()) { nexusWindow.show(); nexusWindow.focus(); return; }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    nexusWindow = new BrowserWindow({
      width: Math.min(1400, width - 80), height: Math.min(900, height - 80),
      resizable: true, maximizable: true, minWidth: 480, minHeight: 360,
      title: 'Nexus — Research Navigator', backgroundColor: '#090d13',
      webPreferences: { contextIsolation: true }
    });
    nexusWindow.loadURL(NEXUS_URL);
    nexusWindow.on('closed', () => { nexusWindow = null; });
  }

  // --- Studio (live HTML preview; auto-reloads when files change) ---
  function ensureStudio() {
    if (!fs.existsSync(STUDIO_INDEX)) {
      fs.mkdirSync(STUDIO_DIR, { recursive: true });
      fs.writeFileSync(STUDIO_INDEX, `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:'JetBrains Mono',monospace;background:#090d13;color:#5b708a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
        div{max-width:520px;line-height:1.7}b{color:#00c8ff}</style></head><body>
        <div><b>BHATBOT STUDIO</b><br>Live preview canvas.<br>Ask Bhatbot to design something (it writes <code>~/.bhatbot/studio/index.html</code>) and it renders here instantly.</div>
        </body></html>`);
    }
  }
  function openStudioWindow() {
    ensureStudio();
    if (studioWindow && !studioWindow.isDestroyed()) { studioWindow.show(); studioWindow.focus(); return; }
    const { width } = screen.getPrimaryDisplay().workAreaSize;
    studioWindow = new BrowserWindow({
      width: 940, height: 720, x: Math.max(20, Math.floor(width / 2) - 470), y: 50,
      resizable: true, maximizable: true, minWidth: 420, minHeight: 320,
      title: 'Bhatbot Studio', backgroundColor: '#090d13', webPreferences: { contextIsolation: true }
    });
    studioWindow.loadFile(STUDIO_INDEX);
    try { if (studioWatcher) studioWatcher.close(); } catch {}
    let deb = null;
    studioWatcher = fs.watch(STUDIO_DIR, () => {
      clearTimeout(deb);
      deb = setTimeout(() => { try { if (studioWindow && !studioWindow.isDestroyed()) studioWindow.reload(); } catch {} }, 200);
    });
    studioWindow.on('closed', () => { try { studioWatcher && studioWatcher.close(); } catch {} studioWatcher = null; });
  }
  function getStudioWindow() { return studioWindow; }

  // --- Chess (playable game window; rules engine inline, Stockfish online API for the AI) ---
  function openChessWindow(difficulty) {
    try {
      fs.mkdirSync(STUDIO_DIR, { recursive: true });
      const asset = path.join(__dirname, 'assets', 'chess.html');
      if (fs.existsSync(asset)) fs.copyFileSync(asset, CHESS_HTML);   // keep the playable copy fresh
    } catch {}
    if (!fs.existsSync(CHESS_HTML)) return { success: false, error: 'chess.html asset is missing.' };
    if (chessWindow && !chessWindow.isDestroyed()) { chessWindow.show(); chessWindow.focus(); }
    else {
      chessWindow = new BrowserWindow({
        width: 720, height: 840, resizable: true, maximizable: true, minWidth: 380, minHeight: 480,
        title: 'BhatBot Chess', backgroundColor: '#0a0f17', webPreferences: { contextIsolation: true }
      });
      chessWindow.loadFile(CHESS_HTML);
      chessWindow.on('closed', () => { chessWindow = null; });
    }
    const diff = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : null;
    if (diff) {
      const wc = chessWindow.webContents;
      const apply = () => wc.executeJavaScript(`(()=>{const s=document.getElementById('diff'); if(s){s.value=${JSON.stringify(diff)}; s.dispatchEvent(new Event('change'));}})()`).catch(() => {});
      if (wc.isLoading()) wc.once('did-finish-load', apply); else apply();
    }
    return { success: true };
  }

  // Offline chess applet (standard + atomic), full legal-move enforcement (chess.js + lib/chessatomic).
  // Loaded straight from assets/ so its ./vendor/ deps resolve; variant passed via query string.
  function openChessApplet(variant) {
    const asset = path.join(__dirname, 'assets', 'chessapplet.html');
    if (!fs.existsSync(asset)) return { success: false, error: 'chessapplet.html asset is missing.' };
    const v = variant === 'atomic' ? 'atomic' : 'standard';
    if (chessAppletWindow && !chessAppletWindow.isDestroyed()) { chessAppletWindow.show(); chessAppletWindow.focus(); chessAppletWindow.loadFile(asset, { query: { variant: v } }); return { success: true }; }
    chessAppletWindow = new BrowserWindow({
      width: 600, height: 760, resizable: true, minWidth: 420, minHeight: 560,
      title: 'BhatBot Chess — ' + v, backgroundColor: '#0a0f17', webPreferences: { contextIsolation: true },
    });
    chessAppletWindow.loadFile(asset, { query: { variant: v } });
    chessAppletWindow.on('closed', () => { chessAppletWindow = null; });
    return { success: true };
  }

  // --- Live World Cup 2026 viewer (auto-refreshing bracket + odds) ---
  function openWorldCupWindow() {
    const asset = path.join(__dirname, 'assets', 'worldcup.html');
    if (!fs.existsSync(asset)) return { success: false, error: 'worldcup.html asset missing' };
    if (worldCupWindow && !worldCupWindow.isDestroyed()) { worldCupWindow.show(); worldCupWindow.focus(); return { success: true }; }
    worldCupWindow = new BrowserWindow({
      width: 1040, height: 860, resizable: true, minWidth: 520, minHeight: 480,
      title: 'World Cup 2026', backgroundColor: '#090d13',
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload-worldcup.js') }
    });
    worldCupWindow.loadFile(asset);
    worldCupWindow.on('closed', () => { worldCupWindow = null; });
    return { success: true };
  }

  // --- Interactive 3D model viewer (image→3D / printable STL output) ---
  function openInteractive3D(p) {
    try {
      if (!p || !fs.existsSync(p)) return;
      const ext = path.extname(p).slice(1).toLowerCase();
      const data = fs.readFileSync(p).toString('base64');
      const info = (fs.statSync(p).size / 1048576).toFixed(2) + ' MB';
      pendingModel = { data, ext, name: path.basename(p), info };
      if (viewerWindow && !viewerWindow.isDestroyed()) {
        viewerWindow.show(); viewerWindow.focus();
        viewerWindow.webContents.send('model', pendingModel);
        return;
      }
      viewerWindow = new BrowserWindow({
        width: 920, height: 740, x: 180, y: 100, title: 'Bhatbot 3D Viewer',
        backgroundColor: '#0a0f17', fullscreen: false, alwaysOnTop: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'src', 'preload-viewer.js') },
      });
      viewerWindow.loadFile(path.join(__dirname, 'src', 'viewer.html'));
      viewerWindow.on('closed', () => { viewerWindow = null; });
    } catch (e) { console.warn('[viewer]', e.message); }
  }
  function sendPendingModel(e) { try { if (pendingModel) e.sender.send('model', pendingModel); } catch {} }

  // --- Molecule / protein 3D viewer (3Dmol.js interactive + RDKit + PyMOL stills) ---
  function openMoleculeWindow(payload) {
    pendingMol = payload;
    if (molWindow && !molWindow.isDestroyed()) { molWindow.show(); molWindow.focus(); try { molWindow.webContents.send('molecule', pendingMol); } catch {} return; }
    molWindow = new BrowserWindow({
      width: 960, height: 760, x: 160, y: 90, title: 'Bhatbot Molecule Viewer',
      backgroundColor: '#0a0f17', webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'src', 'preload-molecule.js') },
    });
    molWindow.loadFile(path.join(__dirname, 'src', 'molecule.html'));
    molWindow.on('closed', () => { molWindow = null; });
  }
  function sendPendingMol(e) { try { if (pendingMol) e.sender.send('molecule', pendingMol); } catch {} }

  // --- Maps (Leaflet + OSM by default; Google geocoding when keyed) ---
  function openMapsWindow(payload) {
    pendingMap = payload;
    if (mapsWindow && !mapsWindow.isDestroyed()) { mapsWindow.show(); mapsWindow.focus(); try { mapsWindow.webContents.send('map', pendingMap); } catch {} return; }
    mapsWindow = new BrowserWindow({
      width: 1000, height: 760, x: 150, y: 80, title: 'Bhatbot Maps',
      backgroundColor: '#0a0f17', webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'src', 'preload-maps.js') },
    });
    mapsWindow.loadFile(path.join(__dirname, 'src', 'maps.html'));
    mapsWindow.on('closed', () => { mapsWindow = null; });
  }
  function sendPendingMap(e) { try { if (pendingMap) e.sender.send('map', pendingMap); } catch {} }
  function fireMapRendered() { if (mapRenderedCb) { const cb = mapRenderedCb; mapRenderedCb = null; cb(); } }

  // Open the map AND capture a PNG snapshot once it's fully drawn → inline "visualization" the agent
  // can return as an image (chat/phone), not just the desktop window. Resolves base64 JPEG or null.
  function openMapsWindowSnapshot(payload) {
    openMapsWindow(payload);
    return new Promise((resolve) => {
      let done = false;
      const finish = async () => {
        if (done) return; done = true; mapRenderedCb = null;
        try {
          await new Promise((r) => setTimeout(r, 350));   // let the final paint settle
          const img = await mapsWindow.webContents.capturePage();
          if (img.isEmpty()) return resolve(null);
          // Downscale + JPEG so the inline vision block stays well under model image limits
          // (a raw 1000×760 PNG is ~6MB; this is ~100-200KB).
          resolve(img.resize({ width: 900 }).toJPEG(78).toString('base64'));
        } catch { resolve(null); }
      };
      mapRenderedCb = finish;
      setTimeout(finish, 7000);   // hard fallback if the renderer never signals
    });
  }

  return {
    toggleWindow, studioWebContents, getStudioWindow,
    openNexusWindow, ensureStudio, openStudioWindow,
    openChessWindow, openChessApplet, openWorldCupWindow,
    openInteractive3D, sendPendingModel,
    openMoleculeWindow, sendPendingMol,
    openMapsWindow, openMapsWindowSnapshot, sendPendingMap, fireMapRendered,
  };
};
