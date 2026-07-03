# BhatBot

A personal, Jarvis-style desktop agent. An Electron app on the Mac plus an optional
always-on cloud brain and a phone PWA — one assistant you can reach by voice, text, or
phone call. BhatBot reads your live context (`CLAUDE.md`), sees your screen, runs tools,
drives a fleet of sub-agents, and learns from how you interrupt it.

> Personal project. Not a product — no support guarantees.

## What it does

- **Voice + text + phone.** Talk to it on the desktop (ElevenLabs voice, real acoustic
  endpointing), or call it (Twilio two-way voice), or chat from the phone PWA.
- **Sees and acts.** Screen vision (OmniParser), file/app control, browser automation,
  AppleScript, credential vault for logins/TOTP.
- **Multi-model router.** Cheap work runs **local + free** (Ollama: qwen/gemma); everything
  else routes to Claude Sonnet, with **Opus** or **Fable 5** reserved for heavy / highly
  autonomous tasks. Paces against **live Anthropic rate-limit headers**.
- **Agent fleet.** Plan → parallel sub-agents (research/design/code/test) → critic, with a
  budget-driven width and an interrupted-turn-safe history.
- **Learns your style.** A learned spoken-length model shortens replies in the shape you
  actually tolerate (trained on your barge-ins and "tell me more"s).
- **Science + making.** Simulations (scipy/sympy/rdkit/mujoco/openmm/pyscf), molecule and
  map rendering, image→STL 3D-print pipeline.
- **Reach.** Telegram bridge, morning brief (news / important email / an interesting find),
  Notion, Google (Drive/Calendar/Gmail), Garmin health.

## Architecture

| Piece | Where | Role |
|-------|-------|------|
| Desktop app | `main.js`, `src/` (Electron) | Primary brain, tools, voice, vision |
| Libraries | `lib/*.js` | Router, rate pacing, fleet/orchestrator, speech, memory, sims |
| Cloud brain | `cloud/` (Fly.io) | Always-on Claude agent + Mac-executor relay |
| Phone | `src/mobile.html` → `phone-app/`, `cloud/public/` | PWA (Chat / Activity / Nexus) |

`src/mobile.html` is the source of truth for the phone UI; the copies under `phone-app/Web`
and `cloud/public` are generated from it.

## Model tiers

| Tier | Model | Used for |
|------|-------|----------|
| Cheap (free) | Ollama `gemma3:12b` (local, default) | summaries, notes, fast replies, simple turns |
| Default cloud | Claude **Sonnet** | tool use, reasoning, the fleet floor |
| Heavy | Claude **Opus 4.8** (default) or **Fable 5** (`config.useFable`) | sims, heavy coding, high-autonomy runs |

Haiku is retired — the cheap tier is local-first, with Sonnet as the cloud fallback.

## Running it

```bash
npm install
npm start            # launch the desktop app
npm run verify       # full test suite (pure-logic suites, no GUI)
```

Ollama is optional but recommended for the free cheap tier:

```bash
ollama pull gemma3:12b   # cheap-tier default (fast, ~1s warm); qwen3 also supported
```

Cloud brain (optional, Fly.io):

```bash
cd cloud && fly deploy
```

## Configuration

Config lives in the app's user-data `config.json` (secrets go through the encrypted vault as
`CRED_REF` handles — raw secrets never reach the model). Notable keys:

| Key | Default | Meaning |
|-----|---------|---------|
| `useLocalCheap` | `true` | run the cheap tier on local Ollama |
| `cheapModel` / `localModel` | `gemma3:12b` | which local model is the cheap tier (fast, non-reasoning) |
| `useFable` | `false` | use **Fable 5** instead of Opus for the heavy tier |
| `heavyToolModel` | Opus | override the heavy model |
| `rateLimitLiveFrac` | `0.95` | fraction of live remaining budget to spend |
| `vad.floorMargin` | `1.8` | mic noise-floor margin for speech endpointing |
| `voice.verifyUser` | `false` | speaker-verify the mic clip (discard other voices) |
| `spokenLambda` | `1.0` | λ in the learned-speech metric `L = interrupt + λ·underinform` |
| `spokenModelMinRows` | `200` | rows before the learned spoken-length model activates |

## Tests

`npm run verify` runs the pure-logic suites (`scripts/test-*.js`) — routing, rate pacing,
history pairing, attachments, endpointing, the spoken-length model, and its feedback loop —
with no GUI required. Every new module ships with a matching suite.

## Layout

```
main.js            desktop brain + tool registry + IPC
lib/               pure/scoped modules (router, rate, fleet, speech, memory, sims, …)
src/               Electron renderer (index.html) + phone PWA source (mobile.html)
cloud/             always-on cloud brain + Mac-executor relay (Fly.io)
phone-app/         generated phone build
scripts/           test suites + ops tooling
```

---

Built with [Claude Code](https://claude.com/claude-code).
