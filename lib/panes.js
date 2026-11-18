'use strict';
// ── PANES — tool windows that live INSIDE the BhatBot window ─────────────────────────────────────
//
// 2026-11-17: "windowing should take place inside the electron app, not on my desktop." Brain, Maps,
// Molecule, the 3D viewer, Studio, Nexus, Chess, World Cup, Blender, the agent monitors, the live
// action view and the terminal each used to open as their own macOS window — scattered over his
// desktop, behind other apps, each on its own Space when the main window was full screen.
//
// Now each is a PANE: a WebContentsView attached to the main window, laid out by the renderer in
// the side column (stacked, newest on top, each expandable to the whole window and closable). The
// page inside is unchanged — same HTML, same preload, same IPC — because PaneWindow speaks the
// slice of the BrowserWindow API those openers actually use (audited: loadFile/loadURL, show, focus,
// isDestroyed, webContents, and the 'closed' event). So `new PaneWindow(opts)` is a drop-in for
// `new BrowserWindow(opts)` at each tool-window call site, and nothing else had to change.
//
// The renderer owns placement: it draws each pane's card (title, expand, close) and reports where
// the card's body is on screen; main puts the native view exactly there. Native views paint above
// HTML, so the renderer hides them (reports no rect) whenever HTML must be on top — the ⌘K palette,
// an expanded card, another panel.

const { EventEmitter } = require('events');

function createPaneHost({ WebContentsView, getMainWindow, log = () => {} }) {
  const panes = new Map();
  let seq = 0;

  function announce() {
    const main = getMainWindow();
    if (!main || main.isDestroyed()) return;
    const list = [...panes.values()].filter((p) => p._visible).map((p) => ({ id: p.paneId, title: p._title, at: p._shownAt }))
      .sort((a, b) => b.at - a.at);
    try { main.webContents.send('panes', list); } catch {}
  }

  function attach(p) {
    const main = getMainWindow();
    if (!main || main.isDestroyed() || p._attached) return;
    try { main.contentView.addChildView(p.view); p._attached = true; p.view.setVisible(false); } catch (e) { log('[panes] attach failed: ' + e.message); }
  }

  class PaneWindow extends EventEmitter {
    constructor(opts = {}) {
      super();
      this.paneId = 'pane' + (++seq);
      this._title = String(opts.title || 'Tool');
      this._visible = opts.show !== false;
      this._shownAt = Date.now();
      this._destroyed = false;
      this._rect = null;
      this.view = new WebContentsView({ webPreferences: opts.webPreferences || {} });
      this.webContents = this.view.webContents;
      if (opts.backgroundColor) { try { this.view.setBackgroundColor(opts.backgroundColor); } catch {} }
      // A page that closes itself (window.close()) closes its pane.
      this.webContents.on('destroyed', () => { if (!this._destroyed) this.destroy(); });
      this.webContents.on('did-finish-load', () => this.emit('ready-to-show'));
      panes.set(this.paneId, this);
      attach(this);
      announce();
    }
    loadFile(f, o) { return this.webContents.loadFile(f, o); }
    loadURL(u, o) { return this.webContents.loadURL(u, o); }
    reload() { this.webContents.reload(); }
    show() { if (this._destroyed) return; if (!this._visible) { this._visible = true; } this._shownAt = Date.now(); attach(this); announce(); }
    focus() { this.show(); try { this.webContents.focus(); } catch {} }
    restore() { this.show(); }
    hide() { this._visible = false; try { this.view.setVisible(false); } catch {} announce(); }
    minimize() { this.hide(); }
    close() { this.destroy(); }
    destroy() {
      if (this._destroyed) return;
      this.emit('close', { preventDefault() {} });
      this._destroyed = true;
      const main = getMainWindow();
      try { if (main && !main.isDestroyed()) main.contentView.removeChildView(this.view); } catch {}
      try { if (!this.webContents.isDestroyed()) this.webContents.close(); } catch {}
      panes.delete(this.paneId);
      this.emit('closed');
      announce();
    }
    isDestroyed() { return this._destroyed; }
    isVisible() { return !this._destroyed && this._visible; }
    isMinimized() { return !this._visible; }
    isFocused() { try { return this.webContents.isFocused(); } catch { return false; } }
    isFullScreen() { return false; }
    setTitle(t) { this._title = String(t || this._title); announce(); }
    getTitle() { return this._title; }
    getBounds() { return this._rect || { x: 0, y: 0, width: 0, height: 0 }; }
    // Desktop-window calls that have no meaning for a pane: accepted and ignored, so no caller breaks.
    setBounds() {} setSize() {} setPosition() {} center() {} setAlwaysOnTop() {} setMenuBarVisibility() {}
    moveTop() {} maximize() {} unmaximize() {} setFullScreen() {} setMinimumSize() {} setResizable() {}
  }

  /** The renderer reports where each pane's card body is; null = hide it (HTML must be on top). */
  function place(rects) {
    for (const p of panes.values()) {
      const r = rects && rects[p.paneId];
      if (r && r.width > 4 && r.height > 4 && p._visible) {
        const b = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        p._rect = b;
        try { p.view.setBounds(b); p.view.setVisible(true); } catch {}
      } else { try { p.view.setVisible(false); } catch {} }
    }
  }

  function close(id) { const p = panes.get(id); if (p) p.destroy(); }
  function list() { return [...panes.values()].filter((p) => p._visible).map((p) => ({ id: p.paneId, title: p._title })); }
  // The main window was recreated (or its renderer reloaded): re-attach and re-announce.
  function reattach() { for (const p of panes.values()) { p._attached = false; attach(p); } announce(); }

  return { PaneWindow, place, close, list, announce, reattach };
}

module.exports = { createPaneHost };
