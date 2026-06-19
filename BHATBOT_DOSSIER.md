# BhatBot — Capability & Architecture Dossier

_Generated 2026-06-19. A structural breakdown of BhatBot for analysis._

BhatBot is a personal "Jarvis"-style AI agent for Siddhant Bhat. It runs as a
macOS desktop app, an always-on cloud brain, and a phone surface (voice calls +
PWA), all sharing one tool vocabulary and one long-term memory.

---

## 1. The three runtimes

| Runtime | Where | Role |
|--|--|--|
| **Desktop** (Electron) | `~/bhatbot` on the Mac | The full agent + all heavy tools (browser, vision, Mac control, creation, science). Has the screen, the GPU, the credentials. |
| **Cloud brain** | Fly.io — `bhatbot-cloud.fly.dev` (`cloud/`) | Always-on Claude agent. Answers when the Mac is asleep; relays heavier tasks to the Mac when it's awake. Owns Twilio voice/SMS + scheduler. |
| **Phone** | Twilio voice + PWA / native `.ipa` (`phone-app/`) | Reach BhatBot by calling it or via the PWA. No app strictly required — a phone call is enough. |

**Independence:** phone and computer work separately. The cloud is the
coordinator; the Mac is an *optional executor* reached over a WebSocket relay
(`/mac/:token`). If the Mac is offline, Mac-only tools degrade gracefully to
"computer offline" instead of failing the whole turn.

---

## 2. File / component map

```
bhatbot/
├── main.js              (~5.8k lines)  Electron main process: agent loop, ALL 40 tools,
│                                        window management, voice, MCP/PWA server boot
├── mcp-server.js        (~430 lines)   Express MCP + phone-PWA server (127.0.0.1:8788),
│                                        session-based StreamableHTTP transport, token guard
├── preload*.js                          Context-isolated bridges (main HUD, activity, terminal, viewer)
├── darkbloom.js / taskClassifier.js     Extra provider + router heuristics
├── assets/chess.html                    Playable chess (inline rules + Stockfish API) — shipped asset
├── src/                                 Renderer UIs: index.html (HUD), activity, terminal,
│                                        viewer, mobile.html (phone PWA)
├── cloud/src/
│   ├── server.js   index.js             HTTP/WS bootstrap
│   ├── agent.js                         cloud agent turn loop
│   ├── llm.js                           model calls
│   ├── tools.js                         15-tool registry (cloud-native + Mac-relay)
│   ├── relay.js                         Mac-executor WebSocket bridge
│   ├── twilio.js                        voice/SMS webhooks (inbound + outbound calling)
│   ├── voice.js                         ElevenLabs TTS (strict — EL voice ids only)
│   ├── db.js                            better-sqlite3 (memory, activity, calls)
│   └── scheduler.js                     proactive/recurring jobs
├── phone-app/                           SwiftUI WKWebView native iOS shell (unsigned .ipa / SideStore)
└── OmniParser/                          local screen-element parser (gitignored, py3.11 venv)
```

---

## 3. Model & provider routing

- **Primary brain:** Claude (Opus/Sonnet) via the Anthropic API. Sonnet for
  cheaper sub-tasks (directive writing, etc.).
- **Multi-provider router:** Claude / OpenAI / Gemini / local Ollama / Darkbloom.
  A local-first pipeline (Ollama router→planner→executor→critic) can handle
  cheap tasks and escalate to Claude.
- **Image generation (pluggable, new):** `generate_image` routes to
  - `openai` → GPT Image (default `gpt-image-2`, auto-falls back to `gpt-image-1`)
  - `flux` → FLUX Pro via Replicate (highest quality)
  - `flux-fast` → FLUX schnell via Replicate (cheap/fast drafts)
  - `auto` picks by quality (low→fast, high→flux, else openai).
- **Vision:** local Ollama vision model + OmniParser for screen-element parsing.
- _Note:_ Fable-class models are intentionally **not** wired in yet (held back
  for security); to be revisited when access reopens.

---

## 4. Tool catalog

### Desktop — 40 tools (`main.js`)

| Group | Tools |
|--|--|
| **Web & browser** | `browser`, `browser_observe`, `browser_workflow`, `smart_login`, `manage_logins`, `open_in_browser`, `fetch_url` |
| **Vision & screen** | `screen_parse`, `vision_click`, `vision_local`, `ui_inspect`, `screen_observe`, `request_permissions` |
| **Creation / visual** | `studio_write`, `generate_image`, `generate_3d`, `make_printable`, `make_figure` |
| **Science / compute** | `simulate` (scipy/sympy/rdkit/mujoco/openmm/pyscf), `math_reason` |
| **Games** | `play_chess` |
| **Mac / system** | `system_control`, `run_shell`, `read_file`, `write_file`, `list_directory`, `media_control` |
| **Memory / knowledge** | `save_memory`, `notion_log_activity`, `notion_search`, `notion_write` |
| **Credentials / auth** | `keychain_lookup`, `onepassword_lookup`, `generate_totp`, `manage_logins`, `smart_login` |
| **Comms / proactive** | `notify_user`, `manage_schedule` |
| **Delegation / AI** | `ask_ai`, `claude_code`, `delegate_project`, `write_agent_directive`, `manage_jobs` |

### Cloud — 15 tools (`cloud/src/tools.js`)

- **Cloud-native (always available):** `web_fetch`, `remember`, `recall`,
  `call_person`, `text_person`, `ask_owner`
- **Mac-relay (need the Mac awake):** `run_shell`, `read_file`, `write_file`,
  `list_directory`, `open_in_browser`, `system_control`, `media_control`,
  `play_chess`, `screen_observe`

Relay tool names match the desktop's `executeTool` names exactly, so the cloud
can dispatch them to the Mac with no translation.

---

## 5. Signature capabilities

- **Agentic browser** — dedicated visible Playwright window; sees its own
  screenshots; auto-accepts cookie/location prompts; resizable + position-remembering.
- **Watch-and-learn** — `browser_observe` (browser) and `screen_observe` (whole
  screen, any app) learn Siddhant's habits *with consent*, then save approved
  patterns to memory.
- **Vision-driven control of native apps** — `screen_parse` (OmniParser) →
  `vision_click` for GUIs with no DOM.
- **Creation suite** — HTML studio, raster image gen (multi-provider), 3D models
  (TRELLIS→GLB), 3D-printable STL, data-accurate matplotlib figures.
- **Science sandbox** — `simulate` / `math_reason` run real physics/chem/math in
  a sandboxed scientific Python env.
- **Credential vault** — `CRED_REF_` handles; secrets resolved in-process and
  never sent to the model; silent TOTP 2FA; phone-relayed 2FA fallback.
- **Proactive scheduling** — recurring/one-off jobs that run the full agent and
  report by voice + Telegram.
- **Two-way phone** — see §7.
- **Built-in Claude Code** — embedded terminal + headless `claude_code` tool,
  wired to BhatBot's own MCP server.

---

## 6. Memory (3-tier)

1. **`config.json`** (`~/.bhatbot/`) — the ONLY place secrets live. Never sent to
   the model.
2. **Local `memory.md`** — durable facts in sections; `save_memory` **refuses**
   anything matching API-key / app-password patterns.
3. **Notion + workspace memory** — `notion_*` tools mirror facts/activity for
   cross-device recall.

---

## 7. Phone calling & the caller-identity boundary

**Who can command BhatBot by phone is gated strictly by phone number.**

- **Owner (Siddhant) calls in →** `c.peer === OWNER_PHONE` → **COMMAND MODE**:
  his speech is run through the full agent (tools + Mac relay), results spoken back.
- **Owner calls out (`ask_owner` / `notify_user` urgency:"call") →** BhatBot calls
  Siddhant when blocked mid-task, captures his spoken reply, continues.
- **Anyone else calls in →** **SCREENING MODE** (the answer to "what if a friend
  calls?"):
  1. BhatBot does **not** execute any commands. It asks, in one question, *who is
     calling and why*.
  2. It texts **the owner**: `📞 Call from <number>: "<reason>" — reply TAKE /
     HANDLE / VM`.
  3. Caller is put on hold while it waits ~50s for the owner's SMS choice:
     - **TAKE** → bridges/dials the owner in.
     - **HANDLE** → lets BhatBot converse to deal with it (still owner-authorized,
       not command mode — the caller cannot drive tools/Mac).
     - **VM** → takes a message, texts it to the owner, hangs up.

**Net:** a friend doing playtesting (calling from their own number) lands in
screening — they can leave a message or be connected to you, but **cannot issue
commands, run tools, or touch the Mac**. Command mode is reachable only from the
owner number.

> ⚠ **One real caveat for the audit:** the gate is caller-ID equality. Caller-ID
> can be spoofed, so a determined attacker spoofing the owner number would reach
> command mode. Hardening options (not yet implemented): a spoken passphrase
> before command mode, or a one-time code texted to the real owner number to
> confirm. Recommended before exposing the number widely.

---

## 8. Security & privacy posture (from the 2026-06-19 audit)

- ✅ **No raw secret logging** anywhere in `main.js` / `mcp-server.js` / `cloud/`.
- ✅ **MCP/PWA access** gated by a secret token; constant-time compare; prefers the
  `Authorization: Bearer` header to keep the token out of URLs. Tailnet-only Serve.
- ✅ **Memory secret-guard** refuses to persist API-key/app-password-shaped strings.
- ✅ **Browse-learning redaction** — `password/otp/cvv/card/secret/token/pin`
  fields are never captured; values masked as `«secret»`; secret inputs skipped in
  replayable workflows.
- ✅ **`screen_observe` is privacy-first** — user-triggered only, time-boxed, **no
  raw screenshots persisted** (only short local-vision text notes), describer told
  to skip passwords/codes/cards, nothing saved to memory without explicit approval.
- ✅ **No screenshots/`_image` cross the relay to the cloud** — visual data stays
  local on the Mac.
- ⚠ **Caller-ID spoofing** (see §7) is the one open boundary worth closing.

---

## 9. Recent additions (this session)

- `play_chess` tool + shipped `assets/chess.html` (rules engine + Stockfish AI).
- `screen_observe` tool — "watch my screen" on command, privacy-locked.
- Pluggable `generate_image` (GPT Image + FLUX Pro/schnell via Replicate).
- Cloud relay parity for `play_chess` + `screen_observe`.
- Owner two-way phone calling (inbound command mode + `ask_owner` outbound).

---

## 10. Notes / artifacts

- `./~/hello_world.py` — stray untracked file from an earlier remote-agent test
  (literal `~` path bug). Harmless; safe to delete.
- Twilio is on a **trial** account — clean calling voice needs the $20 upgrade
  (trial preamble otherwise garbles speech capture).
- New desktop tools require a **BhatBot restart** to load (`main.js` changed).
