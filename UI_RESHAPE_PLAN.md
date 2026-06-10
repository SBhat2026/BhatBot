# BhatBot UI Reshape — Single-Window HUD (Phase 5)

## Goal
One main window is the whole HUD. Chat is the default output region. Nexus, Studio,
Code, Activity, and Notes become **tab-swapped panels in that same region** (the
pattern already shipped for Notes). The **agent browser is the one exception** — it
keeps its own dedicated, desktop-visible, *non-fullscreen* window.

## Current state (what exists today)
- `mainWindow`: `frame:false, fullscreen:true`, loads `src/index.html`. The HUD.
- Separate `BrowserWindow`s, each opened from `#ctxbar` tags via IPC:
  - `nexusWindow` → `loadURL(NEXUS_URL)` (external Next.js app)
  - `studioWindow` → local `STUDIO_INDEX`; live-reload watcher; `capturePage()` feeds
    the vision-feedback loop after `studio_write`
  - `terminalWindow` → `terminal.html` + node-pty
  - `activityWindow` → `activity.html`, receives `tool-update`/log IPC
- Agent browser = Playwright **headless** Chromium (no visible window).
- `#ctxbar` tabs: ⚛ Nexus · ▦ Studio · ⌗ Code · 📝 Notes · ⬡ context.
- Notes ✅ already converted to an in-place tab swap (`toggleNotes`), default = chat.

## Target layout
```
┌───────────────────────────── mainWindow (fullscreen HUD) ─────────────────────────────┐
│ titlebar: ◉ BHATBOT                                                    — ×            │
│ ctxbar/tabs:  [Chat] [Nexus] [Studio] [Code] [Activity] [Notes]   ⬡ctx   🌐 Browser↗ │
│ ┌──────────────────────────── #stage (single output region) ──────────────────────┐ │
│ │  exactly one panel visible at a time:                                            │ │
│ │   #chat (default) | #nexus-panel | #studio-panel | #code-panel |                 │ │
│ │   #activity-panel | #notes-panel                                                 │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│ chips · input bar (📎 🎙 🔊 ▶) · statusbar (cost/mem/calls/ollama health strip)       │
└────────────────────────────────────────────────────────────────────────────────────────┘

   Agent browser = SEPARATE Chromium window on the desktop, ~1280×800, NOT fullscreen.
```

## Implementation steps

### Step 0 — IPC inventory (do first)
Map every `ipcMain.on` / `ipcMain.handle` / `webContents.send` / contextBridge entry.
The four secondary windows currently receive IPC directly; after the merge those
channels must target `mainWindow.webContents` and be demuxed by panel in the renderer.
Key channels to re-home: `tool-update`, activity log events (`sendActivity`), studio
reload, pty (`pty-data`/`pty-input` — already exposed via the `term` bridge in preload).

### Step 1 — Generalize the tab system (renderer)
- Replace the ad-hoc `toggleNotes` with a generic `showPanel(id)` that hides all
  `.stage-panel` and shows one, sets the active tab style, and lazy-inits that panel.
- Wrap `#chat` + every panel in a `#stage` flex container (`flex:1; min-height:0`).
- Tabs in `#ctxbar`: `Chat` (default), `Nexus`, `Studio`, `Code`, `Activity`, `Notes`.
- `Esc` / clicking the active tab → back to Chat.

### Step 2 — Embed the secondary surfaces
- **Nexus** → `<webview src=NEXUS_URL partition="persist:nexus">` inside `#nexus-panel`.
  (webview keeps it sandboxed; survives the external app being remote.)
- **Studio** → `<webview src=file://STUDIO_INDEX>`. Vision feedback: replace
  `studioWindow.webContents.capturePage()` with capture of the webview's
  `webContents` (via `getWebContentsId` → `webContents.fromId`). Keep the file watcher;
  on change call `webview.reload()`.
- **Code** → host xterm.js in `#code-panel`, driven by the existing `term` bridge
  (`term.start/input/resize/onData`). node-pty already wired in preload; no new IPC.
- **Activity** → port `activity.html`'s log list + health strip into `#activity-panel`;
  point `sendActivity`/`tool-update` at `mainWindow`. This also satisfies the earlier
  HUD-density ask (persistent health strip already lives in the statusbar).

### Step 3 — Browser as its own desktop window (the exception)
- Flip Playwright to **`headless:false`** in `ensureBrowser()` so the Chromium window
  is visible on the desktop. Give it a fixed, non-fullscreen size via context
  `viewport:{width:1280,height:800}` and launch args `--window-size=1280,800
  --window-position=120,120`.
- Add a `🌐 Browser` tab that just **focuses/raises** that Chromium window (it is NOT a
  panel in `#stage`). When no browser is live, the tab triggers `ensureBrowser()`.
- Keep `mainWindow` fullscreen; only the browser window is windowed. (Resolves the
  "not full screen … appear in my desktop" instruction.)

### Step 4 — Retire the secondary BrowserWindows
- `openNexusWindow/openStudioWindow/openTerminalWindow/activityWindow` creation removed;
  their IPC handlers (`open-nexus` etc.) now post a `show-panel` message to `mainWindow`.
- Delete now-dead `nexus`/`studio`/`terminal`/`activity` standalone HTML loads (keep the
  files until the panels are verified, then prune).

### Step 5 — Verify
- Each tab swaps in place; only one panel visible; default is Chat.
- Studio vision-feedback screenshot still returns after `studio_write` (capture path).
- Code terminal accepts input and streams output.
- Activity log + health strip update live during an agent run.
- Browser opens as a separate ~1280×800 desktop window, navigates, raises on tab click.
- Regression: voice, TTS, notes notes still work.

## Risks / decisions
- **webview vs iframe**: use `<webview>` (process isolation + `capturePage` for Studio).
  Requires `webviewTag:true` in the mainWindow `webPreferences`.
- **Studio capture**: the one non-trivial rewire — must capture the webview's
  webContents, not the host window.
- **Nexus remote**: if NEXUS_URL is a dev server that's down, panel shows a connection
  error; add a small "retry / open externally" affordance.
- Order: Step 1 (generic tabs) and Step 3 (browser window) are independent and low-risk —
  ship them first. Steps 2/4 (webview embeds + capture rewire) are the heavier lift.
