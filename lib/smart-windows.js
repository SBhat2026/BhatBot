'use strict';
// ── SHARED LOOK FOR BHATBOT'S OWN VIEWS ──────────────────────────────────────────────────────────
//
// Window PLACEMENT now happens inside the app (lib/panes.js — 2026-11-17: "windowing should take
// place inside the electron app, not on my desktop"). BhatBot no longer moves or resizes windows on
// his desktop. What remains here is the other half of a consistent workspace: every first-party
// view — a pane or a remaining standalone window — gets the same palette as the main window and
// follows it between day and night.

function createSmartWindows({ getMainWindow, themeCSS = '' }) {
  const views = new Set();
  async function syncTheme(win) {
    if (!win || win.isDestroyed() || win === getMainWindow()) return;
    const wc = win.webContents;
    // Only first-party local views receive the shared palette; external websites keep their own.
    try { if (!wc || wc.isDestroyed() || !/^file:/.test(wc.getURL())) return; } catch { return; }
    try {
      const main = getMainWindow();
      const mode = main && !main.isDestroyed() ? await main.webContents.executeJavaScript('document.documentElement.dataset.theme || "day"') : 'day';
      if (win.isDestroyed()) return;
      if (!win.__bhatbotThemeCSS) { win.__bhatbotThemeCSS = await wc.insertCSS(themeCSS + '\nhtml,body{background-color:var(--bg);color:var(--text)}button,input,select,textarea{font-family:var(--font-ui,system-ui)}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}'); }
      await wc.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(mode)};document.documentElement.dispatchEvent(new CustomEvent('bhatbot-theme',{detail:{mode:${JSON.stringify(mode)}}}));`);
    } catch {}
  }
  function track(win) {
    views.add(win);
    win.on('closed', () => views.delete(win));
    win.webContents.on('did-finish-load', () => { win.__bhatbotThemeCSS = null; syncTheme(win); });
  }
  return { track, syncThemes: () => { for (const w of views) syncTheme(w); } };
}

module.exports = { createSmartWindows };
