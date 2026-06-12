# BhatBot Cloud — always-on backend (Phase 2)

A tiny always-on service so the phone app works **even when the Mac is asleep** and with no
Tailscale. It speaks the same `/api/:token/{chat,tts,stt}` contract the app already uses, so
turning it on is just: deploy this → point the app (**Settings → Server host**) at its URL.

## What works where
| Capability | Cloud (this) | Needs the Mac awake |
|---|---|---|
| Chat / Q&A / reasoning (Anthropic) | ✅ | |
| Voice out — Jarvis (ElevenLabs) | ✅ | |
| Voice in (Whisper) | ✅ | |
| Desktop tools (files, shell, apps, screen) | relayed if `MAC_RELAY_URL` set & Mac up | ✅ |

Desktop control inherently needs the Mac. When it's asleep, the cloud answers chat/voice and
tells you it'll do the desktop bit once the Mac is back.

## Run it locally (test)
```bash
cd ~/bhatbot/cloud
npm install
cp .env.example .env   # fill in BHATBOT_TOKEN + ANTHROPIC_API_KEY + ELEVENLABS_API_KEY (+ OPENAI for STT)
npm start              # → http://localhost:8790
```
Then in the app: **Settings → Server host** = `http://localhost:8790` (or your machine's LAN IP).

## Deploy always-on (pick one)
All read config from env vars / secrets — **never commit real keys**.

- **Fly.io** (free-tier friendly, scales to zero, included `fly.toml` + `Dockerfile`):
  ```bash
  fly launch --no-deploy
  fly secrets set BHATBOT_TOKEN=… ANTHROPIC_API_KEY=… ELEVENLABS_API_KEY=… OPENAI_API_KEY=… \
                  ELEVENLABS_VOICE_ID=EzDG2x1uAnCqbzN9Q0wA
  fly deploy
  ```
  → `https://bhatbot-cloud.fly.dev`. Put that in the app's Server host.

- **Railway / Render**: new project from this dir, set the same env vars, deploy.
- **Any VPS**: `node server.js` behind a reverse proxy / the same Cloudflare tunnel.

Optionally set `MAC_RELAY_URL` to the Mac's tunnel so desktop tools relay through when it's up.

## Security note
This puts your Anthropic / ElevenLabs / OpenAI keys on the host as secrets, and the API is
gated only by the path token (same model as today). Use a host whose secret store you trust,
and rotate the token if it leaks. Memory/history is in-process for now (resets on restart) —
a durable store (Postgres/Redis) is the next increment.
