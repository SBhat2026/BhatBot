# Bhatbot — Full Context & Build History

> Single-file briefing on what Bhatbot is, how it's built, what it can do, its
> current state, and how it got here. Paste into Claude (or any LLM) for context,
> or read directly. Last updated: 2026-06-06.

---

## 1. What Bhatbot is

Bhatbot is a personal **Jarvis-style autonomous AI desktop agent** for the user, built as an **Electron app** on macOS (Apple M4, 16 GB RAM). It is powered
primarily by the **Claude API** and runs natively on the Mac with full access to
the filesystem, shell, a dedicated browser, voice, and the `claude` CLI. It is
independent of Claude Desktop / claude.ai.

Design language: dark "HUD" aesthetic, JetBrains Mono, cyan accent (`#00c8ff`),
scanlines, corner brackets, boot sequence, glitch title.

- **Install dir:** `~/bhatbot/`
- **State dir:** `~/.bhatbot/` (config, memory, audit log, studio canvas, vosk model)
- **Global hotkey:** ⌘⇧B toggles the chat window
- **Launch:** run **from Terminal** (`npm --prefix ~/bhatbot start`) so macOS grants
  the microphone. (See §7 — launchd auto-start was removed because it can't get mic.)

---

## 2. Architecture

### Processes & files (`~/bhatbot/`)
```
main.js                 Electron main process — the brain. Config/memory, context
                        loaders, secret redaction, model router, tool execution,
                        agent loop, all windows, pty, voice/wake IPC, lifecycle.
preload.js              contextBridge for the chat window (window.bhatbot.*)
preload-activity.js     contextBridge for the activity window (window.activity.*)
preload-terminal.js     contextBridge for the Claude Code terminal (window.term.*)
darkbloom.js            OpenAI-compatible client for Darkbloom (currently disabled)
taskClassifier.js       Pure-regex router: which model handles a given message
src/index.html          Chat window UI (HUD, voice, status bar, launcher tags)
src/activity.html       Activity window UI (tool log, browser view, controls,
                        confirm modal, steer/teach box, "learn this?" prompt)
src/terminal.html       Embedded Claude Code terminal (xterm.js)
scripts/listen.py       Vosk always-on wake-word listener (ACTIVE)
scripts/wakeword.py     openWakeWord listener (legacy, unused)
scripts/install-launch-agent.sh   macOS Launch Agent installer (now unloaded)
CHANGES.md              Running deviation/build log
ADAPTIVE_LEARNING_PLAN.md   Roadmap for preference learning + Jarvis features
BHATBOT_CONTEXT.md      This file
package.json            electron, playwright, node-pty, @xterm/*, electron-builder
```

### State (`~/.bhatbot/`)
```
config.json     API keys + settings (chmod 600). NEVER enters the model context.
memory.md       Long-term memory, injected into every system prompt (6 sections)
audit.log       Append-only JSON log of every tool call
studio/index.html   Live design canvas rendered by the Studio window
vosk-model/     ~40MB offline speech model for the wake word
```

### Windows
1. **Chat** (`index.html`) — main HUD, fullscreen, frameless. Boot sequence,
   project context badge, launcher tags (⚛ Nexus · ▦ Studio · ⌗ Code), chat with
   typewriter output + inline tool rows, voice mic, status bar (shows provider/model).
2. **Activity** (`activity.html`) — opens on first tool use. Live tool log with
   timings, Playwright screenshot pane, ⏸▶⏹ controls, confirmation modal for
   destructive commands, **steer/teach box** for live feedback, "learn this?" prompt.
3. **Nexus** (`nexusresearch.xyz`) — embedded research navigator for lit reviews.
4. **Studio** (`studio/index.html`) — live HTML preview; auto-reloads on file
   change. Bhatbot writes to it via the `studio_write` tool (design loop).
5. **Claude Code terminal** (`terminal.html`) — real pty (node-pty) running the
   `claude` CLI inside an xterm.js terminal, cwd = `BHATBOT_PROJECT`.

### Request flow
```
user/voice → chat window → IPC 'chat' → agentLoop (main)
  → callModel() routes via taskClassifier → Claude (or Darkbloom if enabled)
  → if tool_use: executeTool() runs it, streams updates to chat+activity windows
  → screenshots fed back as real vision image blocks (old ones evicted)
  → live guidance folded in between steps; loop continues (max 12 iterations)
  → final text returned to chat window (typewriter render)
  → if guidance was used, activity window offers to save it as a preference
```
System prompt on every call = static identity + `memory.md` + the project's
`CLAUDE.md` (walked up from `BHATBOT_PROJECT`/cwd), all passed through
`redactSecrets()` and prompt-cached.

---

## 3. Current capabilities

### Tools (13) — the model calls these autonomously
| Tool | What it does |
|------|--------------|
| `read_file` | Read a text file (≤100KB) |
| `write_file` | Write a file, mkdir -p parent |
| `list_directory` | List a directory |
| `run_shell` | Any shell command (60s). `rm`/`rmdir`/`trash` → confirm modal; `rm -rf /`-class hard-blocked. Homebrew + `claude` on PATH |
| `fetch_url` | HTTP GET text (15s, 50KB) |
| `open_in_browser` | Open URL in default browser |
| `browser` | Headless Playwright (navigate/click/type/screenshot/get_text/evaluate). **Claude sees the screenshots** as vision |
| `vision_local` | Second-opinion vision on the current page via local Ollama `gemma3:12b` (configurable) |
| `ask_ai` | Query another model for research/cross-check: **claude · openai · gemini · local(ollama)** |
| `write_agent_directive` | Generate a complete directive for another agent (Claude Code / n8n / second Bhatbot / generic) |
| `studio_write` | Write the live HTML design canvas + open the Studio window |
| `claude_code` | Delegate a headless one-shot task to the `claude` CLI (5min) |
| `save_memory` | Persist a fact to `memory.md` (refuses secrets) |

### Models & providers
- **Claude (primary):** Sonnet 4.6 (`claude-sonnet-4-6`) for reasoning; Haiku 4.5
  (`claude-haiku-4-5`) for simple/memory tasks. Routed per-message by
  `taskClassifier`. Prompt caching on; history summarized past 20 messages.
- **OpenAI:** working (`gpt-4o-mini` default) — used by `ask_ai` and STT.
- **Gemini:** wired (`gemini-2.0-flash`) but currently **429 / no credits** on the
  provided key — needs a non-prepaid AI-Studio key (`AIza…`).
- **Darkbloom:** real service, **disabled** (`darkbloomEnabled=false`). Only models
  are `gpt-oss-20b` (≥24GB) / `gemma-4-26b` (≥36GB) — neither fits 16GB locally;
  cloud needs wallet balance. Router falls back to Claude.
- **Local Ollama:** `gemma3:12b` (vision), `qwen3.5`, `gemma4:26b`, etc. (via `ask_ai`).

### Voice
- **STT:** OpenAI Whisper (`gpt-4o-mini-transcribe`, falls back to `whisper-1`).
  Recorded via MediaRecorder + WebAudio silence detection (auto-send 2s after you
  stop, or click mic). Optional fastest path: Groq `whisper-large-v3-turbo`
  (`config.groqKey` + `config.sttProvider="groq"`).
- **Wake word:** **Vosk** offline streaming ASR (`scripts/listen.py`, ~40MB,
  lightweight, always-on, no account). Say **"Bhatbot, do X"** → runs "do X" in the
  agent loop; bare **"hey Bhatbot"** → arms a Whisper capture for the next sentence.

### Memory & learning
- `memory.md` with 6 sections (Personal, Active Projects, Preferences & Patterns,
  Decisions Log, Recurring Tasks, Notes), injected every call.
- **Live-feedback steering:** type guidance in the activity window mid-task → it
  folds into the agent's next step → after the task, offers to save it as a
  preference. (See `ADAPTIVE_LEARNING_PLAN.md` for the bigger roadmap.)

### Security
- Keys live in `config.json` only — never in the model context, audit log, or memory.
- `redactSecrets()` scrubs key/app-password patterns from everything sent to the model.
- `save_memory` refuses secret-looking content.
- Destructive shell (`rm`/`rmdir`/`trash`) requires a confirmation modal; a hard-block
  list refuses `rm -rf /`, fork bombs, `mkfs`, `dd` to disk outright.
- Audit log records every tool call.

---

## 4. Config reference (`~/.bhatbot/config.json`)
```jsonc
{
  "apiKey":        "sk-ant-…",     // Anthropic (required)
  "openaiKey":     "sk-proj-…",    // OpenAI (working)
  "geminiKey":     "…",            // Gemini (429 — needs valid AI-Studio key)
  "groqKey":       "",             // optional — enables Groq turbo STT
  "darkbloomKey":  "…",            // = ~/.darkbloom/auth_token (no balance)
  "darkbloomEnabled": false,       // flip true only when funded
  "darkbloomBaseUrl": "https://api.darkbloom.dev/v1",
  "openaiModel":   "gpt-4o-mini",
  "geminiModel":   "gemini-2.0-flash",
  "localModel":    "qwen3.5:latest",
  "sttModel":      "gpt-4o-mini-transcribe",
  "sttProvider":   "",             // "groq" to use groqKey + whisper-large-v3-turbo
  "silenceMs":     2000,           // voice auto-send after this much silence
  "wakeWord":      "bhatbot",
  "visionModel":   "gemma3:12b"
}
```

---

## 5. How to run
```bash
# from Terminal (so macOS grants mic to Electron + the Python listener)
npm --prefix ~/bhatbot start
# first voice/wake use → allow "Electron"/"Python" the microphone in
# System Settings → Privacy & Security → Microphone
```
- ⌘⇧B toggles the window.
- Click ⚛ Nexus / ▦ Studio / ⌗ Code to open those windows.
- Say "Bhatbot, …" for voice; or click the 🎙 button.

---

## 6. Full build history (chronological)

1. **Initial scaffold.** Electron chat window that reads the project's `CLAUDE.md`
   as live context on every call; 6 tools (read/write/list/shell/fetch/open);
   ⌘⇧B hotkey; HUD UI with boot sequence; macOS Launch Agent for auto-start.
   Key from shell env / `config.json`.

2. **Megaprompt upgrade.** Added persistent `memory.md` + `save_memory` tool;
   audit log; **model routing** (Sonnet/Haiku); **prompt caching**; history
   summarization past 20 msgs; a second **Activity window** (tool log, screenshots,
   pause/resume/stop, confirmation modal); **Playwright browser** tool; shell safety
   gates (hard-block + confirm). Corrected stale model IDs to `claude-sonnet-4-6` /
   `claude-haiku-4-5`; dropped the obsolete prompt-caching beta header (GA).

3. **Vision + reliability.** Browser screenshots fed to Claude as **real vision
   image blocks** (so it actually sees pages), with old-image eviction to avoid a
   token blow-up. Added `vision_local` (local `gemma3:12b` second opinion). Fixed a
   **429** caused by base64 screenshots being returned as tool-result text. First
   mic fixes (continuous + silence handling).

4. **UX + learning.** Larger fonts. **Live-feedback steering (2a):** steer/teach
   box in the activity window injects guidance mid-task; after the task it offers to
   save the guidance as a preference. Configurable vision model.

5. **Multi-provider routing + research.** `darkbloom.js` + `taskClassifier.js` +
   unified `callModel`. **`ask_ai`** tool (claude/openai/gemini/local). 
   **`write_agent_directive`** tool. Status bar shows provider+model. Verified Darkbloom
   is real but unusable on 16GB (models too large; no wallet balance) → kept disabled.

6. **Reliable voice.** Replaced flaky browser STT with **OpenAI Whisper** via
   MediaRecorder. Discovered the **Web Speech API doesn't work in Electron**
   (Chromium ships without Google's speech key).

7. **Faster STT + security.** Default STT → `gpt-4o-mini-transcribe`; silence wait
   5s → 2s; optional Groq turbo. Added **secret guardrails** (`redactSecrets`,
   `save_memory` refusal). Found the **mic bug**: launchd can't trigger macOS mic
   permission, so the app never got mic → **unloaded the Launch Agent**, switched to
   Terminal launch.

8. **Windows.** Embedded **Nexus** (nexusresearch.xyz), **Studio** (live HTML
   preview + `studio_write`), and **Claude Code terminal** (node-pty + xterm.js,
   rebuilt for Electron) + `claude_code` tool. First wake-word engine: openWakeWord.

9. **Terminal fix + Vosk wake word.** Fixed the blank terminal (Electron `file://`
   CSP blocked the xterm scripts → added `file:`). Replaced openWakeWord with
   **Vosk** for a lightweight, always-on, offline, custom **"Bhatbot"** phrase that
   captures the whole command and feeds it into the agent loop. (Rejected Liquid AI:
   its models are LLMs / a 1.5B mobile speech model — not a wake-word engine.)

---

## 7. Known limitations & blockers
- **Run from Terminal for mic.** launchd auto-start was removed because it can't
  obtain the microphone TCC grant. Restoring login auto-start *with* mic needs the
  app packaged + code-signed as a real `.app` with `NSMicrophoneUsageDescription`
  (`npm run build` is configured; not yet done).
- **Gemini 429** — provided key is on a prepaid project with no credits; needs a
  standard AI-Studio key (`AIza…`).
- **Darkbloom disabled** — no local model fits 16GB; cloud needs wallet balance.
- **Voice = batch, not streaming** — records, then transcribes (snappy but not live).
- **No sandbox** — Bhatbot runs as the user; it can modify/delete files (rm gated).
  A malicious web page could attempt prompt-injection; secrets are kept out of
  context as mitigation, but treat browsing of untrusted pages with care.
- **Unverified without a live mic/GUI session:** the exact wake-word trigger accuracy,
  the pty terminal render, and the Python listener's mic grant — these need on-machine
  testing.

---

## 8. Queued / roadmap
- Package + code-sign a `.app` to restore login auto-start with mic.
- 👍/👎 feedback loop + async reflection pass (Phase 1 of `ADAPTIVE_LEARNING_PLAN.md`).
- Phrase → command shortcuts ("deploy fable" → runs the script).
- Three-tier memory + selective retrieval (Mem0 / Letta style) to prevent context bloat.
- Proactive loop: 8am briefing, deployment watchdog, paper monitor.
- Sub-agent delegation; optional local-model tier; MCP for external agents.

---

## 9. Owner context (for the assistant)
Siddhant Bhat — 18, incoming Princeton (fall 2026). Deep in GNN/ML, computational
biology, full-stack (Next.js/Supabase/Vercel), Unity/C#. Communication style:
direct, terse, technical, no filler. Active projects Bhatbot knows about: **Nexus**
(research navigator), **PRISM** (assembly-order GNN, paper), **FABLE** (GO-term
prediction), **Skipper** (Unity sled game), a comp-chem parser (revenue). Working
norm: delegates implementation to Claude Code; uses Bhatbot for architecture,
strategy, debugging, research, writing. Claude Code prompts always start with
"ask clarifying questions before making any changes."
```
