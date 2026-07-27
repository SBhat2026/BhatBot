# BhatBot — Always-On / Full-App Architecture (Hybrid)

Goal: BhatBot as a **standalone full app** — memory maintained at all times, running in the
background with live updates even when the window is closed, with no dependency on a terminal or a
paired external site.

Chosen design: **Hybrid** = a local macOS daemon (Mac-side actions + memory upkeep, runs while the Mac
is on) **plus** the cloud brain (24/7 presence for when the Mac is off). Built incrementally.

## Status (2026-07-27)

> ### ✅ The second brain now has a real always-on host
>
> **What was wrong (verified 2026-07-27):** `scripts/install-daemon.js`'s `install()` sets
> `ProgramArguments = [node_modules/.bin/electron, REPO]` — the "daemon" was the **GUI app**. So
> memory maintenance, the scheduler tick, and the SYNAPSE worker all lived in the Electron main
> process and died with the window. `com.bhatbot.agent` was never installed, and the two LaunchAgents
> that *were* loaded had both been failing for weeks (`com.siddhant.bhatbot` exit 127 — `npm` under
> launchd's minimal PATH; `com.siddhant.bhatbot.briefing` exit 1). The proof was unambiguous:
> `~/.bhatbot/brain/` did not exist. The SYNAPSE worker shipped in `d2b035e` had never produced a
> single node, because it had never had a process to run in.
>
> **What fixed it:** `scripts/synapse-worker.js` — a plain node process with **no electron anywhere in
> its require graph** (`scripts/test-synapse-worker.js` spawns it and asserts this, so it stays true).
> Installed as `com.bhatbot.synapse` via `npm run worker:install`. It runs the SYNAPSE cycle *and*
> memory maintenance, holds a pidfile lock so the GUI stands down rather than double-spending the same
> $1 budget, and survives the window closing.
>
> **Credentials caveat:** `config.json` holds `CRED_REF_*` vault handles that only Electron's
> `safeStorage` can decrypt, so a headless process usually cannot get an API key. This is fine by
> design — the **free** hydrate pass (projects + memories + repos + Notion) needs no key and is the
> bulk of the value. To enable the paid pass (embeddings + link rationales), put the keys in the login
> Keychain, which `lib/llm.js` reads via the `security` CLI:
> ```sh
> security add-generic-password -s bhatbot-anthropic -a bhatbot -w "sk-ant-…"
> security add-generic-password -s bhatbot-openai    -a bhatbot -w "sk-…"
> ```
> The worker says loudly at startup when it is degraded — a worker that quietly does half its job is
> the exact failure mode this whole exercise was about.

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

### ✅ Landed — the headless SYNAPSE worker
- `scripts/synapse-worker.js` — plain node, no electron in its require graph. Runs the SYNAPSE cycle
  (free hydrate every `hydrateMin`, budget-capped paid pass every `connectHours`) plus `memmaint`.
- `lib/synapse.js` — the engine, extracted from `main.js` and fully DI'd so it runs in both hosts.
- `lib/pidlock.js` — single-instance lock. The GUI checks it per tick and stands down while the
  daemon holds it, so the two never double-import or double-charge the shared $1 ledger. Liveness is
  verified with `kill(pid, 0)`, so a stale pidfile from a SIGKILL is reclaimed rather than deadlocking
  the worker out forever.
- Install: `npm run worker:install` · status: `npm run worker:status` · one cycle: `npm run worker:once`.
- Verified live: `launchctl print gui/$UID/com.bhatbot.synapse` → `state = running`, and
  `~/.bhatbot/brain/graph.json` exists for the first time (195 nodes / 30 edges, $0 spent).

### ⏭️ Next steps (not yet built)
1. **Schedules in the worker** — the worker currently *reports* overdue schedules but cannot run them
   (no tools, no vault), so a daily job still needs the app to open. Either give the worker a
   restricted execution path or have it wake the app.
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
