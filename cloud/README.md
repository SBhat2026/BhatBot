# BhatBot Cloud — the always-on brain

A private, always-on backend so your **phone and computer work independently of each other**.
The cloud holds the keys and runs the agent (Claude tool-use loop) 24/7; your Mac is an
**optional executor** that plugs in for computer-only tools when it's awake.

```
 phone ─┐                          ┌─ cloud-native tools (web, memory)  ← always work
 Mac  ──┼─→  CLOUD (this service) ─┤
 browser┘     • Claude agent loop  └─ computer tools ──(WebSocket relay)──→ your Mac
              • SQLite (memory, conversations, costs, schedules, activity)      (when awake)
              • voice in/out, proactive scheduler
```

## What works where
| Capability | Cloud (always) | Needs Mac awake |
|---|---|---|
| Chat / reasoning / tool-use agent (Claude) | ✅ | |
| Long-term memory + conversation history (SQLite, durable) | ✅ | |
| Web fetch, remember/recall | ✅ | |
| Voice out (ElevenLabs Jarvis) + in (Whisper) | ✅ | |
| Proactive scheduler (reminders, recurring tasks) | ✅ | |
| Shell, AppleScript, local browser, screen, native apps | relayed → Mac | ✅ |

When the Mac is asleep the cloud still chats, remembers, does web/voice, and tells you it'll
run the computer bits the moment the Mac reconnects.

## Run locally
```bash
cd ~/bhatbot/cloud
npm install
npm run sync-ui                      # copy the phone UI from ../src into public/
cp .env.example .env                 # fill BHATBOT_TOKEN + ANTHROPIC_API_KEY (+ ELEVENLABS/OPENAI for voice)
npm start                            # → http://localhost:8790
```

## Deploy always-on (Fly.io)
```bash
cd ~/bhatbot/cloud
npm run sync-ui                      # ensure public/ is fresh (it's gitignored / not in the image otherwise)
fly launch --no-deploy               # creates the app (keep the included fly.toml)
fly volumes create bhatbot_data --region ewr --size 1     # durable SQLite
fly secrets set \
  BHATBOT_TOKEN=$(node -e "console.log(require(require('os').homedir()+'/.bhatbot/config.json').mcpToken)") \
  ANTHROPIC_API_KEY=… ELEVENLABS_API_KEY=… OPENAI_API_KEY=… \
  ELEVENLABS_VOICE_ID=EzDG2x1uAnCqbzN9Q0wA
fly deploy
```
→ `https://bhatbot-cloud.fly.dev`. One machine stays up (the Mac relay + scheduler need it).

> Use the **same token** as the Mac (`mcpToken`) so the phone app/native app point at either
> backend without re-entering anything. Or pick a fresh one and set it in both places.

## Connect your Mac as the executor
On the Mac, set two keys in `~/.bhatbot/config.json`, then restart BhatBot:
```json
{ "cloudUrl": "https://bhatbot-cloud.fly.dev", "cloudToken": "<BHATBOT_TOKEN>" }
```
The desktop app dials out to the cloud over a WebSocket (works even tailnet-only — no public
inbound needed) and registers as the executor. `/health` then shows `"mac":{"online":true}`.

## Point the phone/app at the cloud
- **PWA / native app:** long-press the screen → set **Host** = `https://bhatbot-cloud.fly.dev`,
  **Token** = your `BHATBOT_TOKEN`. Now it works with the Mac asleep and without Tailscale.
- The cloud serves the same UI at `/app/<token>`, so you can also just open that in Safari.

## API (same contract as the desktop server)
`POST /api/:token/chat` · `/tts` · `/stt` · `/summarize` · `GET /api/:token/activity` ·
`/config` · `/schedules` · `GET /app/:token` (PWA) · `GET /health` · `WS /mac/:token` (executor).

## Datastore
SQLite (`better-sqlite3`) at `$DATA_DIR/bhatbot.db` (the Fly volume). Tables: conversations,
messages, memory, costs, schedules, activity. Back up by copying the volume / the `.db` file.
Optional shared **Notion** bank (`NOTION_TOKEN` + ids) is also recalled/written, same as the Mac.

## Security
- Token-gated (constant-time compare; accepts `Authorization: Bearer` or path token).
- Keys live as host **secrets**, never in git. `.env`, `data/`, `public/` are gitignored.
- Destructive shell relayed to the Mac is blocked by the Mac's remote-exec guard.
- Rotate `BHATBOT_TOKEN` (`fly secrets set`) if it ever leaks.
