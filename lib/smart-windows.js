'use strict';
// Fit every window to the display work area, including negative-origin external displays.
function arrangeBounds(area, count) {
  const gap = 12, x = area.x || 0, y = area.y || 0;
  const usable = { width: Math.max(1, area.width - 2 * gap), height: Math.max(1, area.height - 2 * gap) };
  if (count < 2) return [{ x: x + gap, y: y + gap, ...usable }];
  const columns = count === 2 ? 2 : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const width = Math.floor((usable.width - gap * (columns - 1)) / columns);
  const height = Math.floor((usable.height - gap * (rows - 1)) / rows);
  return Array.from({length: count}, (_, i) => ({ x: x + gap + (i % columns) * (width + gap), y: y + gap + Math.floor(i / columns) * (height + gap), width, height }));
}
function createSmartWindows({ screen, getMainWindow, themeCSS = '' }) {
  const windows = new Set(); let timer;
  const live = () => [...windows].filter(w => !w.isDestroyed() && (!w.isVisible || w.isVisible()) && (!w.isMinimized || !w.isMinimized()));
  function arrange() {
    const all = live(); if (!all.length) return { count: 0 };
    const anchor = all.find(w => w.isFocused?.()) || getMainWindow() || all[0];
    const display = screen.getDisplayMatching?.(anchor.getBounds?.() || {}) || screen.getPrimaryDisplay();
    const area = display.workArea || { x: 0, y: 0, ...display.workAreaSize };
    // Wait for macOS to leave a full-screen Space before applying desktop bounds.
    let waiting = false;
    for (const w of all) if (w.isFullScreen?.()) { waiting=true; if (!w.__leavingSpace) { w.__leavingSpace=true; w.once('leave-full-screen', () => { w.__leavingSpace=false; schedule(); }); w.setFullScreen(false); } }
    if (waiting) return { count: 0, waiting: true };
    for (const w of all) if (w.isMaximized?.()) w.unmaximize();
    const fitted = all;
    const bounds = arrangeBounds(area, fitted.length);
    fitted.forEach((w,i) => { if (w.setBounds) { w.setMinimumSize?.(Math.min(420,bounds[i].width),Math.min(300,bounds[i].height)); w.setBounds(bounds[i]); } });
    return { count: fitted.length };
  }
  function schedule() { clearTimeout(timer); timer=setTimeout(() => { if (live().length > 1) arrange(); }, 180); }
  async function syncTheme(win) {
    if (win.isDestroyed() || win === getMainWindow()) return;
    // Only first-party local views receive the shared palette; external websites keep their own.
    if (!/^file:/.test(win.webContents.getURL())) return;
    try {
      const main = getMainWindow();
      const mode = main && !main.isDestroyed() ? await main.webContents.executeJavaScript('document.documentElement.dataset.theme || "day"') : 'day';
      if (win.isDestroyed()) return;
      if (!win.__bhatbotThemeCSS) { win.__bhatbotThemeCSS = await win.webContents.insertCSS(themeCSS + '\nhtml,body{background-color:var(--bg);color:var(--text)}button,input,select,textarea{font-family:var(--font-ui,system-ui)}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}'); }
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(mode)};document.documentElement.dispatchEvent(new CustomEvent('bhatbot-theme',{detail:{mode:${JSON.stringify(mode)}}}));`);
    } catch {}
  }
  function track(win) {
    windows.add(win); win.on('show',schedule); win.on('restore',schedule);
    win.on('closed',() => { windows.delete(win); schedule(); });
    win.webContents.on('did-finish-load',() => { win.__bhatbotThemeCSS=null; syncTheme(win); schedule(); });
  }
  return { track, arrange, syncThemes: () => { for (const w of windows) syncTheme(w); } };
}
module.exports = { arrangeBounds, createSmartWindows };
