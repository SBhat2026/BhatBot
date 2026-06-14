# BhatBot — Next Big Push (handoff)
_Updated 2026-06-14_

Compact starting point for the next session. State of the world + what's open.

## Where things stand (DONE + pushed)
- **Fast chat**: quickRoute + fastReply (streaming Haiku, server-cached system, ~0.6s first token); dispatchTurn unified entry. Config `fastChat`.
- **Agentic robustness**: STATIC_PROMPT execution/persistence section; maxIters 20; executeTool transient retry (idempotent reads).
- **Speech**: normalizeForSpeech (audio-only), human cadence, ttsSpeed 1.08; ElevenLabs Jarvis voice (`elevenLabsVoiceId=EzDG2x1uAnCqbzN9Q0wA`).
- **Wake word**: BhatBot saying its own name no longer self-triggers (content-aware MUTE).
- **Credentials**: vault (safeStorage), CRED_REF handles, two-step browser login.
- **Phone app (native)**: `phone-app/` WKWebView shell, remote-first load + bundled fallback, long-press settings. `build-ipa.sh` (unsigned, 1.3M, verified). `install-device.sh` (signed Xcode path). Honest install guide `INSTALL.md` + `SIDESTORE-AND-NOTION-SETUP.txt`.
- **Independence Phase 1**: configurable host/token, CORS, Cloudflare tunnel scripts.
- **Phase 2 cloud backend** (`cloud/`): standalone express, same `/api/:token/{chat,tts,stt}` contract; chat=Anthropic, voice=ElevenLabs, STT=Whisper; desktop tools relay via `MAC_RELAY_URL`; Dockerfile + fly.toml. Verified standalone.
- **Shared Notion memory** (`lib/notion.js`, `cloud/notion.js`, `scripts/notion-setup.js`): 5 DBs, cloud recalls+persists from same bank; `/health` reports memory state. Verified incl. graceful degrade.

## Open / user-action items
- ⬜ **SideStore install** — user doing it (instructions in `SIDESTORE-AND-NOTION-SETUP.txt`).
- ✅ **Notion go-live (2026-06-14)** — bootstrapped. 5 DBs created under "Try AI Meeting Notes" page; ids in `~/.bhatbot/config.json` notion.*. **SDK pinned to classic 2.x** (5.x forces data-source model + strips top-level `properties` → broke create/query; 2.3.0 fixes all classic calls). Verified live: cloud recall+persist round-trip across fresh conversations works. Remaining: set cloud `NOTION_TOKEN`/`NOTION_MEMORY_DB`/`NOTION_DAILYLOG_DB` secrets when deploying; restart desktop app to pick up config.
- ⬜ **Cloud deploy** — `cloud/` ready; user deploys to Fly/Railway + sets secrets (their keys in cloud = their call).
- ⬜ **Stable tunnel** — Cloudflare named tunnel needs a domain on user's CF account.

## Figures + logins push (DONE 2026-06-14)
- **`make_figure`** (`lib/figures.js`): data-accurate matplotlib/seaborn from .csv/.tsv/.json/.xlsx. action:analyze (profile + suggest figures = "which stats matter") / render (spec OR custom code; df+plt preloaded). Saves PNG+PDF+SVG, returns PNG as vision block (in showImage list). Verified: analyze, bar/scatter/heatmap/code paths render. ⚠ Deps: installed seaborn+openpyxl into config.pythonBin (3.13 env, had pandas3.0.3+mpl3.10.9). Fixed null→None py-literal bug.
- **Browser session persists**: storageState save/restore `~/.bhatbot/browser-profile.json` (shipped earlier this session, commit 04f1267).
- **`smart_login`** + **`manage_logins`** (`lib/logins.js`): domain-keyed profiles (`~/.bhatbot/logins.json`, CRED_REF handles only — manage_logins set uses auditInput so the HANDLE is stored not the resolved secret). smart_login fills first factor → TOTP silent if on file → else **calls + texts** Siddhant and BLOCKS on `awaitTwoFactorCode` (150s) for his phone reply (code or "approved"). 2FA reply routed via `deliverTwoFactorCode` hooked into BOTH Telegram on('message') and SMS runAgentHeadless (before agent). OTP field autodetect + submit.
- ⚠ "across ALL apps/browsers": smart_login is Playwright-window only (solid). Real Chrome/Safari + native apps = system_control (AppleScript/keystroke) fallback, not yet auto-wired — next step if wanted.
- ⬜ Takes effect after desktop app rebuild (deploy cycle below).

## Build fix (DONE 2026-06-14)
- `npm run build` was bundling **3.5GB OmniParser** (files:[**/*]+asar:false) → 3.4GB app + apparent hang. Excluded OmniParser/phone-app/cloud/~/*.md/etc → **347MB app, ~6s build**. Added author. OmniParser is NOT referenced by main.js (ui_inspect uses Ollama).

## Watch-my-mouse + Notion auto-recall (DONE 2026-06-14)
- **`browser_observe`** (watch-my-mouse, Playwright window): `OBSERVER_SCRIPT` init-script + `exposeBinding('__bhatbotUserEvent')` capture Siddhant's click/input/Enter with GENERALIZED selectors (id>data-testid>name>aria-label>text>nth path). `__bhatbotAgentActing` page flag (set via `agentActing()` around mutating browserActions) makes the observer ignore the agent's own events. browserAction auto-`waitForUserIdle()` before navigate/click/type/login/evaluate (config browserYield/browserYieldMs) so it never fights his cursor. User events also append to an active workflow recording. Tool actions: status/wait/learn{name}/clear → learn converts the buffer to replayable steps + saves a workflow + Notion note. **Passwords/OTP NEVER captured** (secret flag, value omitted). Verified E2E with real Playwright nav (capture, selector gen, secret-safety, agent-suppression all ✅). ⚠ init scripts only re-run on real navigations (page.goto), not setContent — fine for real use.
- **Notion auto-recall**: `refreshNotionRecall(query)` (async, 4s-bounded, dedup by query key) runs at agentLoop entry; `buildMemoryBlock` folds the hits in as a 4th tier "SHARED BANK (Notion)". Config notionRecallK (5). Degrades to no-op if Notion unconfigured.

## Candidate next-push work (not started)
- **Real-browser/native-app login** (Chrome/Safari/desktop apps) via system_control keystroke+clipboard, extending smart_login beyond the Playwright window.
- 5 power/utility options proposed to user 2026-06-14 (await pick).
- Cloud: durable **conversation history** (currently in-process Map; Notion holds facts only).
- Cloud: wire **MAC_RELAY_URL** end-to-end + test desktop-tool relay when Mac awake.
- Notion: surface **Research/Project/Task** DBs into the phone UI (read views).
- TTS streaming latency tuning on cloud (optimize_streaming_latency already 3).

## Deploy cycle (desktop app)
`npm run build` → quit app → `rm -rf /Applications/Bhatbot.app && ditto dist/mac-arm64/Bhatbot.app /Applications/Bhatbot.app` → `xattr -dr com.apple.quarantine /Applications/Bhatbot.app` → `open -a Bhatbot`.

## Repo
`SBhat2026/BhatBot` main. Note: several lib/ files (agents, router, jobs, prompts, security) had uncommitted prior-session work — left untouched; review before bundling into a commit.
