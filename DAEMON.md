# BhatBot — Always-On / Full-App Architecture (Hybrid)

Goal: BhatBot as a **standalone full app** — memory maintained at all times, running in the
background with live updates even when the window is closed, with no dependency on a terminal or a
paired external site.

Chosen design: **Hybrid** = a local macOS daemon (Mac-side actions + memory upkeep, runs while the Mac
is on) **plus** the cloud brain (24/7 presence for when the Mac is off). Built incrementally.

## Status (2026-07-10)

### ✅ Landed — always-on memory maintenance
- `lib/memmaint.js` — pure `planMaintenance` (decay stale episodics, merge near-duplicates) + a
  scheduler (`start/stop/status`) that runs a pass on a timer, independent of the window.
- `lib/semantic.js` `maintain()` — thin I/O wrapper that applies the plan to the embedding store.
- Wired at boot in `main.js` (`startMemoryMaintenance()`), default every 30 min. Also bounds runaway
  **operational** logs (router.jsonl, app.log) — never the training datasets.
- Config: `config.memoryMaintenance = { enabled, intervalMinutes, maxEpisodicAgeDays, maxLogLines }`.
- Tested: `npm run test:memmaint`.

### ✅ Landed — local daemon (persistence layer)
- `scripts/install-daemon.js` → `npm run daemon:install` / `daemon:uninstall`.
- Installs a LaunchAgent (`com.bhatbot.agent`): **RunAtLoad** (starts at login) + **KeepAlive
  crash-only** (auto-restarts if it dies, but NOT when you quit on purpose). Logs → `~/.bhatbot/logs/daemon.log`.
- Effect today: the process is always up (starts at login, self-heals on crash) → memory maintenance
  and schedules run 24/7 while the Mac is on.

### ⏭️ Next steps (not yet built)
1. **Background/tray mode** — a menubar tray + a `--background` launch flag so the daemon runs hidden
   (no window) and the window becomes just one view you summon. Needs: `Tray`, `window-all-closed`
   → hide-not-quit, `app.dock.hide()` under the flag. (GUI-lifecycle change; verify interactively.)
2. **Deploy the cloud brain** — `cloud/` already has an always-on Claude-agent brain (SQLite/Fly) built
   + verified but never deployed. Deploy it as the 24/7 half; the Mac app + phone become clients via the
   existing cloud bridge (`startCloudBridge()` / lib/cloud-bridge.js). Gives presence when the Mac is off.
3. **Memory sync across halves** — reconcile the local semantic store with the cloud brain + Notion SoT
   so memory is one coherent thing regardless of which half is awake.

## How the pieces map
- Local upkeep + Mac actions → the LaunchAgent daemon (this repo).
- 24/7 presence + live updates when Mac is off → cloud brain (`cloud/`), reachable by phone/PWA.
- Single memory → semantic store (local) ↔ Notion (SoT) ↔ cloud, kept clean by `memmaint`.
