# BhatBot — Always-On / Full-App Architecture (Hybrid)

Goal: BhatBot as a **standalone full app** — memory maintained at all times, running in the
background with live updates even when the window is closed, with no dependency on a terminal or a
paired external site.

Chosen design: **Hybrid** = a local macOS daemon (Mac-side actions + memory upkeep, runs while the Mac
is on) **plus** the cloud brain (24/7 presence for when the Mac is off). Built incrementally.

## Status (2026-07-27)

> ### ⚠️ Read this first — "always-on" is not yet true locally
>
> `scripts/install-daemon.js` sets `ProgramArguments = [node_modules/.bin/electron, REPO]`. **The
> "daemon" is the Electron GUI app**, not a headless brain. There is no headless entrypoint in this
> repo today. Consequences, all verified 2026-07-27:
>
> - Memory maintenance, the 30s scheduler tick, and the SYNAPSE worker all live in the Electron main
>   process and **die when the window closes**. The claim below that memory upkeep "runs 24/7" is only
>   true while the app is open.
> - `com.bhatbot.agent` was **never installed**. The two LaunchAgents that were actually loaded were
>   both failing (`com.siddhant.bhatbot` exit 127 — `npm` under launchd's minimal PATH;
>   `com.siddhant.bhatbot.briefing` exit 1). Both have been removed; the briefing is now a
>   `lib/scheduler.js` entry instead of a parallel script.
> - Proof of the gap: `~/.bhatbot/brain/` **does not exist**. The SYNAPSE worker shipped in `d2b035e`
>   has never produced a graph, because it has never had a process to run in.
>
> The fix is a real headless worker (`scripts/synapse-worker.js` + a `com.bhatbot.synapse`
> LaunchAgent). Until that lands, treat everything below as "runs while the app is open."

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
- Effect *intended*: the process is always up (starts at login, self-heals on crash) → memory
  maintenance and schedules run while the Mac is on.
- Effect *actual* (2026-07-27): **not installed**, and it launches the GUI rather than a headless
  process — see the warning at the top.

### ✅ Landed — the cloud brain is DEPLOYED
- `cloud/` is **live at `https://bhatbot-cloud.fly.dev`** — `GET /health` answers `401
  {"error":"unauthorized"}` in ~0.5s (up, auth-gated). Earlier revisions of this file said "built +
  verified but never deployed"; that was stale.
- `config.cloudUrl` is set and `config.cloudToken` is a vaulted `CRED_REF_*` handle.
- Caveat: `cloud/src/graph.js` is a port of the **old** `lib/graph.js`, not of `lib/brain.js` — there
  is no SYNAPSE in the cloud yet.

### ⏭️ Next steps (not yet built)
1. **A real headless worker** — `scripts/synapse-worker.js` (plain node, no electron in its require
   graph) running the SYNAPSE tick + `memmaint` + the scheduler tick, installed as
   `com.bhatbot.synapse` via `install-daemon.js --worker`. Absolute `process.execPath`, never `npm`
   (that is exactly what made the old agent exit 127). **This is what makes "always-on" true.**
2. **Background/tray mode** — a menubar tray + a `--background` launch flag so the app runs hidden
   (no window) and the window becomes just one view you summon. Needs: `Tray`, `window-all-closed`
   → hide-not-quit, `app.dock.hide()` under the flag. (GUI-lifecycle change; verify interactively.)
3. **Memory sync across halves** — push a pruned SYNAPSE graph view (no embeddings, no file bodies)
   to the deployed cloud brain after each local pass, so the phone can read the brain when the Mac is
   off. Reconcile with the Notion SoT.

## How the pieces map
- Local upkeep + Mac actions → the LaunchAgent daemon (this repo). **Today: GUI-bound, see the warning above.**
- 24/7 presence + live updates when Mac is off → cloud brain (`cloud/`), reachable by phone/PWA. **Deployed.**
- Single memory → semantic store (local) ↔ Notion (SoT) ↔ cloud, kept clean by `memmaint`.

## Checking whether any of this is actually running
Do not trust this document — check the machine:
```sh
launchctl list | grep bhat                       # loaded agents + their last exit code
launchctl print gui/$UID/com.bhatbot.synapse     # state = running, last exit code = 0
ls -la ~/.bhatbot/brain/graph.json               # must EXIST and its mtime must advance
curl -s -o /dev/null -w '%{http_code}\n' https://bhatbot-cloud.fly.dev/health   # 401 = up
```
`bhatctl doctor` rolls all of these into one command.
