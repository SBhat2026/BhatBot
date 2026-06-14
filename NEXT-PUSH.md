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
- ⬜ **Notion go-live** — token `ntn_…` valid but integration was connected to **0 pages**; user must add it to a page (••• → Connections), then run `notion-setup.js`. Then set cloud `NOTION_*` secrets.
- ⬜ **Cloud deploy** — `cloud/` ready; user deploys to Fly/Railway + sets secrets (their keys in cloud = their call).
- ⬜ **Stable tunnel** — Cloudflare named tunnel needs a domain on user's CF account.

## Candidate next-push work (not started)
- Desktop agent **auto-recall from Notion** (currently has tools but recalls manually) — make buildMemoryBlock pull from the shared bank passively. (User was offered this; pending.)
- Cloud: durable **conversation history** (currently in-process Map; Notion holds facts only).
- Cloud: wire **MAC_RELAY_URL** end-to-end + test desktop-tool relay when Mac awake.
- Notion: surface **Research/Project/Task** DBs into the phone UI (read views).
- TTS streaming latency tuning on cloud (optimize_streaming_latency already 3).

## Deploy cycle (desktop app)
`npm run build` → quit app → `rm -rf /Applications/Bhatbot.app && ditto dist/mac-arm64/Bhatbot.app /Applications/Bhatbot.app` → `xattr -dr com.apple.quarantine /Applications/Bhatbot.app` → `open -a Bhatbot`.

## Repo
`SBhat2026/BhatBot` main. Note: several lib/ files (agents, router, jobs, prompts, security) had uncommitted prior-session work — left untouched; review before bundling into a commit.
