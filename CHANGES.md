# CHANGES.md — Bhatbot build vs. megaprompt spec

What was built differently from `BHATBOT_MEGAPROMPT.md`, and why. For reference.

## Pass 25 — JARVIS personality + <speak> + acks + reflection; FIX app-open & browsing

- **FIX app opening (consistently broke in the packaged app):** root cause = `tell app to
  activate` sends an Apple event needing Automation TCC, which the Finder-launched .app
  isn't granted → silent fail. Now `open_app`/`activate_app` launch via `open -a` directly
  (LaunchServices, NO TCC needed). `quit_app` = AppleScript quit → pkill fallback if
  Automation isn't granted. `osa()` now runs with EXEC_PATH. Verified `open -a` live.
- **FIX web browsing:** `ensureBrowser` now launches with `--no-sandbox`
  `--disable-setuid-sandbox --disable-dev-shm-usage` (Chromium routinely fails to start from
  a packaged Electron app without these) + realistic UA/viewport/locale (less bot-blocking)
  + a concurrency guard (no double-launch race) + clear launch-failure message (run
  `npx playwright install chromium`). Page-action errors auto-reset a dead browser. Verified
  live: launched + navigated a real JS site (HN) in 669ms and extracted text.
- **Personality (biggest behavior change):** STATIC_PROMPT rewritten to JARVIS — default
  short, brief ack → execute silently → brief result, assume-and-act (≤1 clarifying question
  only when ambiguous AND costly), "want me to?" gate on large/irreversible actions, and
  reference past work (FABLE/PRISM) so it feels like it knows Siddhant. Plus explicit tool
  guidance: open_app for apps, browser tool for live sites.
- **<speak> tags:** model wraps the spoken part in <speak>…</speak>; a streaming parser
  (`makeSpeakStream`) feeds ONLY that to TTS while displaying tag-stripped text on screen —
  handles tags split across stream chunks. No tag + short reply → still spoken; no tag +
  long → silent. Unit-tested 4 cases.
- **Instant verbal acks:** action requests get an immediate spoken "On it."/"Right away."
  (from `ACKS`) the moment the task starts, before the model responds → perceived spoken
  latency ≈ 0. Config `instantAck` (def on).
- **Single voice:** removed the macOS `say` shortcut for short text — all speech now uses
  the one configured voice (was a second, different voice for <80-char replies).
- **Critique→memory reflection:** `reflectOnCorrection` fires only on correction signal
  words, async (never blocks), Haiku (~$0.00015), saves to 'Preferences & Patterns' only if
  actionable, and confirms with a delayed (3.5s) spoken "Noted." Config `reflection` (def on).
- DEFERRED (bigger lifts, noted for next): barge-in (interrupt TTS on speech), Resemblyzer
  speaker verification (enrollment + 0.72 threshold), single-window UI refactor (webview).

## Pass 24 — Full agent autonomy + token reduction + autonomous mode + vision loop

- **Agents now EXECUTE tools (full autonomy):** `lib/agents/exec.js` runs a provider-agnostic
  tool-use loop (model emits tool_use → run via `toolExec` → feed tool_result back → repeat).
  `base.js` uses it for any role with tools; `roles/ROLE_TOOLS` maps each role to a tool
  subset. main.js `orchestratorAdapters` now supplies `anthropicTools`/`ollamaTools`
  (Ollama tool-calling → Anthropic-shaped content)/`toolExec=executeTool`/`toolDefs=TOOLS`
  + `onEvent` (streams agent actions to the activity window). Verified: exec loop executes a
  write_file and returns a result envelope; **a local model (qwen3) drives tools end-to-end**.
  NOTE: `qwen2.5-coder:7b` can't emit Ollama tool_calls → router `local_code` switched to
  `qwen3:latest` (tool-capable).
- **Token reduction (memory reorg + query structure):** `buildSystemPrompt` split into a
  CACHED static block + a small RETRIEVED memory block. `memoryRetrieve(query,k)` scores
  memory.md entries by idf-weighted term overlap (stopword-filtered) and injects only the
  top-k instead of the whole file. Measured ~19% of full memory injected on a test corpus.
  Two-block `systemBlocks()` used by callClaude + callClaudeStream (query = last user text).
  Config: `memoryRetrieval` (def on), `memoryTopK` (14), `memoryRetrievalMinChars` (2500 —
  small files still inject whole).
- **Autonomous mode (`autonomousMode`, default ON):** `requestConfirm` auto-approves the
  destructive-shell confirm gate (audit-logged + shown in activity) so headless agents never
  block — HARD_BLOCKED catastrophic patterns + secret redaction remain the hard floor.
- **Visual / vision dev-loop:** `lib/inspect.js` → structured findings {pass, findings:
  [{severity,where,issue,fix_hint}]} from a local vision model (gemma3:12b, format:json).
  New `ui_inspect` tool (target browser page or whole screen via screencapture; attaches the
  image so Claude can see it too). Given to coding/browser/creative roles → code→launch→
  inspect→fix loop.

## Pass 23 — Streaming responses + streaming TTS + history guard + app control

- **Streaming responses (biggest latency win):** `anthropicStream()` SSE reader assembles
  the same message shape as the blocking call but emits text deltas live via `onText`.
  `callModel`/`agentLoop` thread `onText` (desktop chat path only; MCP/Telegram unchanged).
  Renderer renders tokens into a live bubble. **Verified live: first token ~1.08s** (was
  ~full-generation wait). Tool loop unchanged — text before a tool_use streams too.
- **Streaming TTS:** `ttsStream*` speaks each sentence the moment it completes while the
  model keeps generating → first audio ~sentence 1 (~2-3s), no summarize round-trip, no
  network TTS-1. Shares `ttsPlaySeq` so a new turn cancels in-flight speech. Renderer skips
  its own `speak()` when `_streamed` (no double audio).
- **Self-hallucination guard `validateHistory()`** (called at agentLoop start): drops a user
  msg that exactly echoes the previous assistant reply (the self-feedback loop), strips
  orphan `tool_result`s, and pops a trailing assistant turn with an unanswered `tool_use`.
  Logs each heal to console.
- **AppleScript open/quit ANY app:** `system_control` gains `open_app` (via `open -a` +
  activate — reliable cold launch) and `quit_app`. **Live-tested:** Photos, App Store, Notes,
  Messages (quit+reopen), Claude (quit+reopen) — 5/5 opened, all confirmed running. Spotify
  open verified.
- Tool enum updated; descriptions mention launching/quitting apps by name.

## Pass 22 — Orchestrator wired into app + memory layer + speed

- **Spotify Mac playback fixed (real bug):** play path required an already-`is_active`
  device; the Mac app reports `is_active:false` even when open → every play failed. Now
  `spotifyConnect` AUTO-TARGETS a device (explicit → active → Computer → first) and always
  passes `device_id`, which WAKES an inactive Mac. 404 → transfer-then-retry. Verified live:
  `play status: 204`. (Phone still must start playback once to register on Connect — no API
  to force-pin a backgrounded phone.)
- **Orchestrator wired into main.js:** new `delegate_project` tool routes big multi-step
  goals through the workspace multi-agent stack (flat context). `orchestratorAdapters()`
  reuses main.js `ollamaChat`/`anthropicRequest` (keeps rate-limit accounting + caching).
- **Semantic memory built (`lib/memory.js`):** per-workspace vector store, Ollama embeddings
  with deterministic lexical fallback (works with no embed model installed), cosine top-k,
  dedup>0.92, decay rollup. Verified: trellis query returns trellis chunks first.
- **Adapters/CLI:** `lib/adapters.js` (standalone bridge), `scripts/orchestrate.js`
  (run a goal end-to-end, no Electron), `scripts/resume.js` (print resume token).
- **Trellis integration (`lib/integrations/trellis.js`):** PiAPI submit/poll/download →
  artifacts/, tracked as state facts. Needs `trellisApiKey`.
- **Schemas completed:** goals/workspace/decision/creative/inspect added (envelope/state/
  tasks already done). Router defaults set to installed models (qwen3, qwen2.5-coder:7b, gemma3:12b).
- **Speed:**
  - TTS → ElevenLabs `eleven_flash_v2_5` (~75ms vs turbo ~250-400ms) +
    `optimize_streaming_latency=3`. Config switched to flash.
  - Speech summarize threshold 300→500 chars → most replies skip the extra LLM round-trip
    before speaking → audio starts sooner.

## Pass 21 — Architecture v2 (workspace multi-agent) + Spotify device permanence

- **Spotify "permanent" devices:** `spotifyDevices()` now caches every device ever seen
  to `config.spotifyDevices` (Spotify drops idle phones from the live list). `pickDevice`
  falls back to cached/offline devices (`_live` flag); `list_devices` shows online +
  `[offline — open Spotify on it]`; `transfer` refuses offline with a clear message.
  Root cause of "phone not listed" = phone backgrounded → drops off Connect; foreground
  Spotify on the phone once and it's cached thereafter. No API to force-pin.
- **`ARCHITECTURE.md`** — full v2 redesign: workspaces, structured state vs. semantic
  memory, 6-agent protocol (typed envelopes, context firewall), context manager (flat
  ~7k/step regardless of project age), local-first router + cost governor (<$10/mo),
  autonomous browser dev-loop, 6-phase roadmap.
- **Scaffolded (real, tested):** `lib/workspace.js`, `lib/state.js`, `lib/context.js`,
  `lib/router.js`, `lib/agents/{protocol,base,orchestrator}.js`, `lib/agents/roles/`,
  `lib/schemas/{envelope,state,tasks}.json`, `scripts/ws.js` CLI. Smoke test passes
  (state set/transition/snapshot, result-envelope apply, checkpoint/resume).
- Nothing existing removed; current single-agent `agentLoop` + voice/TTS untouched.


## Model IDs (changed)
- Spec used `claude-sonnet-4-20250514` and `claude-haiku-4-5-20251001`.
- **Changed to** `claude-sonnet-4-6` (Sonnet 4.6) and `claude-haiku-4-5` (Haiku 4.5) — the current IDs. The dated strings are stale and would 404 or pin an old model.

## Prompt caching (changed)
- Spec added header `anthropic-beta: prompt-caching-2024-07-31`.
- **Dropped the beta header** — prompt caching is GA. Kept the `system` block as `[{type:'text', text, cache_control:{type:'ephemeral'}}]`, which is the supported GA form. Functionally identical caching, no deprecated beta flag.

## API key source (context)
- Spec assumed `ANTHROPIC_API_KEY` in shell / Launch Agent env.
- Key lives in `~/.bhatbot/config.json` (chmod 600). `getApiKey()` reads `process.env.ANTHROPIC_API_KEY || config.apiKey`. The Launch Agent plist's empty `ANTHROPIC_API_KEY` is falsy, so it falls through to config cleanly.

## Browser tool (kept as single tool)
- Implemented as one `browser(action, ...)` tool (spec offered this as the explicit alternative to 6 sub-tools). Actions: navigate, click, type, screenshot, get_text, evaluate. Headless `chromium`, `slowMo:200`. Screenshots streamed to the activity window via `screenshot` IPC + 1s polling fallback.

## Playwright visibility
- **Headless** (spec default). Screenshots render in the activity window. Flip `chromium.launch({ headless:false })` in `ensureBrowser()` to see a real window.

## Confirmation gating
- `rm` / `rmdir` / `trash` route through the activity-window modal (`requestConfirm` → Promise resolved by `confirm-response` IPC). `HARD_BLOCKED` patterns (`rm -rf /`, fork bomb, mkfs, dd to disk) are refused outright, no override. Agent loop suspends on the Promise — not mid-execution.

## Wake word
- **Not in this build.** Stub remains in `index.html` (`WAKE_WORD_ENABLED=false`). Planned next pass: Picovoice Porcupine (offline) or local Whisper. See `ADAPTIVE_LEARNING_PLAN.md` §Roadmap.

## Build verification
- All 10 spec checks exercisable. Live end-to-end (key → API → list_directory → reply) passed headless. Window/activity/browser paths share the same `executeTool`/`agentLoop` code the test drove.

## Darkbloom integration (2026-06-06) — reality vs. spec
- Darkbloom is a **real** service (Eigen Labs, signed installer, OpenAI-compatible API). CLI installed to `~/.darkbloom`, Secure Enclave key provisioned, MDM profile offered, `doctor` passes (M4/16GB).
- **Spec model names are mostly fabricated.** Actual catalog: only `gpt-oss-20b` (≥24GB RAM) and `gemma-4-26b` (≥36GB RAM). The spec's `qwen3.5-27b-claude-opus-8bit`, `qwen3.5-122b-moe-8bit`, and `CohereLabs/cohere-transcribe` are **not in the catalog**.
- **16GB RAM can't serve either chat model locally** → Darkbloom *local* direct-mode chat is not viable on this machine.
- ⇒ Darkbloom chat deferred to **cloud** (needs `darkbloom login` + console API key). When wired it will use the REAL models (`gpt-oss-20b` / `gemma-4-26b`), key-gated, Claude-fallback. `darkbloom.js` / `taskClassifier.js` / `callModel` NOT yet written — waiting on a cloud key + the OpenAI/Gemini keys (user is wiring all research providers at once).
- **Voice stays Web Speech** — Cohere transcribe model doesn't exist in Darkbloom.

## Pass 4 (2026-06-06) — shipped without keys
- **Larger font** across chat + activity windows (16px / 14px base, scaled UI).
- **Live-feedback steering (option 2a):** activity window has a steer/teach box → `agent-guidance` IPC → `agentLoop` folds guidance into the next user turn so the model course-corrects mid-task; after the task it offers "Learn this for next time?" → `save-guidance-pref` writes to memory `Preferences & Patterns`.
- **Configurable vision model:** `config.visionModel` overrides `gemma3:12b`. Nemotron NOT available (no Nemotron vision model on Ollama; would need `ollama pull` of a vision model or a paid hosted NIM endpoint — not worth the cost over gemma3 unless explicitly wanted).

## Pass 5 (2026-06-06) — multi-provider routing + research
- **`darkbloom.js`** — OpenAI-compatible client (real models `gpt-oss-20b`/`gemma-4-26b`), 20s timeout, configurable base URL/key.
- **`taskClassifier.js`** — `classify()` → sonnet | haiku | db_speech | db_workflow | db_directive (verified).
- **`callModel()`** — unified router. Darkbloom only when `config.darkbloomEnabled` AND key present AND first turn (single-shot, no tool loop); `db_workflow` stays on Claude (needs tools); everything else / failures fall back to Claude. Emits `provider_used` → status bar shows `anthropic · sonnet` / `darkbloom · gpt-oss-20b`.
- **`ask_ai` tool** — cross-provider research: claude · openai · gemini · local(ollama). OpenAI verified working; local verified; Gemini key 429 (no quota/billing); models configurable via `config.{openai,gemini,local}Model`.
- **`write_agent_directive` tool** — Darkbloom `gemma-4-26b` when funded, else Claude Sonnet. Targets: claude_code / bhatbot_instance / n8n_workflow / generic_llm_agent.
- **Darkbloom status:** cloud auth_token works as consumer key BUT wallet balance $0 → `insufficient_funds`. `config.darkbloomEnabled=false` until funded (run `darkbloom start` to earn, or add funds). Flip to `true` to activate. `gpt-oss-20b` supports function-calling → future: real Darkbloom tool loop.
- **Deviations from Darkbloom megaprompt:** stale Claude IDs fixed; fabricated model names replaced with real catalog (`gpt-oss-20b`/`gemma-4-26b`); Cohere transcribe doesn't exist → voice stays Web Speech; db_workflow kept on Claude (Darkbloom text path has no tools yet); no setup-screen (keys via `config.json`).

## Pass 6 (2026-06-06) — reliable voice + wake word
- **STT upgraded to OpenAI Whisper** (`whisper-1`, configurable `config.sttModel`). Renderer records via MediaRecorder + WebAudio RMS silence detection (auto-stop 5s after you stop talking, or click mic), sends audio over IPC → `transcribe-audio` → OpenAI. Reliable + server-side; works even when the window's hidden. Falls back to Web Speech only if no `openaiKey`.
- **Wake word ENABLED** via always-on Web Speech listening for `hey bhatbot` / `bhatbot` / `jarvis` (or `config.wakeWord`). On match → starts a Whisper capture turn.
- **Porcupine NOT wired** — it cannot init without a free Picovoice AccessKey (`console.picovoice.ai`); a custom "Hey Bhatbot" also needs a keyword train (built-in "Jarvis" works instantly). Add `config.picovoiceKey` and ask to swap the wake listener to offline Porcupine. Until then the Web-Speech wake word is the active path.
- **Gemini:** still 429 — that project's key (`AQ.…`) is on a prepaid plan with depleted credits. Use a standard AI-Studio key (`AIza…`) from aistudio.google.com/apikey on a non-prepay project. Wired; activates when key/credits work.
- **Darkbloom:** confirmed unusable locally (`No supported models fit in 16 GB RAM`); stays `darkbloomEnabled=false`.

## Pass 7 (2026-06-06) — faster STT + secret guardrails
- **STT default → `gpt-4o-mini-transcribe`** (faster/better than whisper-1; auto-falls back to whisper-1 if unavailable on the account). Optional fastest path: Groq `whisper-large-v3-turbo` via `config.groqKey` + `config.sttProvider="groq"`.
- **Silence wait 5s → 2s** (`config.silenceMs`) — big perceived-latency win.
- **Mic fix:** Launch Agent unloaded — launchd can't trigger macOS mic TCC, so the app never got mic. Run from **Terminal** (`npm --prefix ~/bhatbot start`) so Electron inherits Terminal's mic grant; first 🎙 click prompts to allow "Electron". Auto-start on login now requires a signed packaged `.app` (deferred).
- **Security guardrails:** `redactSecrets()` strips API-key/app-password patterns from the system prompt (memory.md + CLAUDE.md) before it reaches any model; `save_memory` refuses secret-looking content. Keys stay in `config.json` only — never in model context, audit log, or memory.

## Pass 8 (2026-06-06) — windows: Nexus, Studio, Claude Code terminal, openWakeWord
- **Nexus window** — `⚛ Nexus` tag (or `open-nexus` IPC) opens a BrowserWindow on `https://nexusresearch.xyz` for lit reviews.
- **Studio window** — `▦ Studio` tag opens a live-preview BrowserWindow on `~/.bhatbot/studio/index.html`; `fs.watch` auto-reloads on change. New `studio_write(html)` tool writes the canvas + opens it (design loop).
- **Embedded Claude Code terminal** — `⌗ Code` tag opens `terminal.html` (xterm.js) wired to a real `node-pty` running `claude` in `BHATBOT_PROJECT`. node-pty rebuilt for Electron via `@electron/rebuild`. Plus `claude_code(prompt,cwd)` tool for headless one-shot delegation (5min). `runShell` now takes a timeout arg.
- **Wake word = openWakeWord** (offline, free, no account). `scripts/wakeword.py` listens for **"hey jarvis"** (onnx, models auto-downloaded ✓), prints WAKE → main process shows window + `wake-detected` IPC → renderer arms Whisper capture. Web-Speech wake disabled (unreliable in Electron). Config: `BHATBOT_WAKE_MODEL`, `BHATBOT_WAKE_THRESH`.
- **Verified:** JS syntax, Electron boot clean, openWakeWord import+model-load. **Unverified (needs mic + your terminal):** live wake trigger, embedded pty render, mic for the python helper.
- New deps: `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `@electron/rebuild`; python: `openwakeword`, `sounddevice`, `numpy`.

## Pass 9 (2026-06-06) — terminal fix + Vosk wake word
- **Claude Code terminal blank → fixed.** Cause: under Electron's `file://` origin, CSP `script-src 'self'` blocked the xterm `<script src="../node_modules/…">` files (null origin). Added `file:` to the terminal.html CSP; added a visible error guard if xterm fails to load.
- **Wake word → Vosk** (replaces openWakeWord). `scripts/listen.py`: offline streaming ASR (~40MB model at `~/.bhatbot/vosk-model`), always-on, lightweight, no account. Hears **"bhatbot <command>"** → prints `CMD <command>` → main shows window + `wake-command` IPC → renderer feeds it into the agent loop. Bare "hey bhatbot" → arms Whisper capture. Custom phrase via `BHATBOT_WAKE`.
  - **Why not Liquid AI:** LFM2 are small *LLMs* / LFM2-Audio is a 1.5B mobile speech model — neither is a lightweight always-on wake-word engine; running them continuously is heavy. Vosk is purpose-built for this.
  - openWakeWord (`wakeword.py`) left in repo but unused.
- New deps: python `vosk` + `vosk-model-small-en-us-0.15`.
- Verified: JS syntax, Electron boot clean, Vosk import + model load. Unverified (needs mic): live trigger, terminal pty render.

## Files
```
~/bhatbot/
├── main.js              # rewritten — memory, routing, caching, trimming, browser, activity, gates
├── preload.js           # + getMemoryPath
├── preload-activity.js  # NEW — activity window bridge
├── package.json         # + playwright
├── src/index.html       # boot+memory line, project tags, thinking rows
├── src/activity.html    # NEW — log, browser pane, controls, confirm modal
├── scripts/install-launch-agent.sh
├── CHANGES.md           # this file
└── ADAPTIVE_LEARNING_PLAN.md  # NEW — preference learning + roadmap
~/.bhatbot/{config.json, memory.md, audit.log}
```

## Pass 10 (2026-06-06) — voice OUTPUT (Jarvis TTS, streaming)
- **Multi-provider TTS** (`synthesize-speech` IPC, `main.js`): openai (default), elevenlabs (real JARVIS voice), piper (offline). Returns base64 audio → renderer.
  - **openai** (works now, existing key): `gpt-4o-mini-tts`, voice `onyx`, `instructions` steer toward a calm British-butler J.A.R.V.I.S. tone. Verified 200 + audible.
  - **elevenlabs** (opt-in, the *actual* Jarvis voice): set `ttsProvider:"elevenlabs"` + `elevenLabsKey` + `ttsVoice`=a JARVIS voice id from the Voice Library. `eleven_turbo_v2_5`, mp3_44100_128.
  - **piper** (offline/free): `ttsProvider:"piper"` + `piperBin` + `piperModel` (jarvis.onnx from rhasspy/piper-voices). Spawns piper, returns wav.
- **Streaming playback** (`src/index.html`): reply split into sentences (`splitSentences`, strips code/markdown), all synthesized in parallel but played in-order via an Audio queue → first sentence speaks ~immediately while the rest render. `ttsSeq` cancels stale playback.
- **🔊 toggle** next to mic. Auto-on when a TTS provider is configured (`ttsEnabled`). Mutes/cancels on click; `startVoice()` calls `stopSpeaking()` so it never talks over you. Full loop: wake/mic → STT → agent → **spoken reply**.
- Config: `ttsEnabled, ttsProvider, ttsVoice, ttsModel, ttsInstructions` (+ `elevenLabsKey`, `piperBin/piperModel` when used). `get-voice-config` now returns `{ttsEnabled, ttsProvider, hasTTS}`.
- Verified: JS syntax (main/preload), OpenAI TTS live (200, played). Unverified (needs GUI): in-app playback + toggle.

## Pass 11 (2026-06-06) — Jarvis voice (ElevenLabs) + Visual Studio / image / 3D
### Voice OUT → ElevenLabs (free) with OpenAI fallback
- ElevenLabs key wired. **Finding:** the literal library "Jarvis" voice and ALL shared-library voices are blocked on the free tier via API (`payment_required` / "Free users cannot use library voices via the API"). Adding them to the account also 402s.
- **Premade voices DO work on free API.** Default Jarvis voice = **Daniel — Steady Broadcaster** (British male, `onwK4e9ZLuTAKqWW03F9`). Alts: George `JBFqnCBsd6RMkjVDRZzb`, Brian `nPczCjzI2devNBz1zQrb`.
- Free tier cap = **10k chars/month** → `synthesize-speech` now **auto-falls back to OpenAI `onyx`** on 401/402/429 so voice never dies mid-session. Config split: `ttsVoice`/`ttsModel` (EL) vs `openaiTtsVoice`/`openaiTtsModel`.

### Visual creation (deviations from spec noted)
- **`studio_write` now sees itself:** after write+open, waits (1200ms cold / 700ms warm) then `studioWindow.webContents.capturePage()` → resized JPEG. Returned via the **existing `_image` mechanism** (NOT a new `image_b64` field — the codebase already injects `_image` as a vision block in `agentLoop`). Generalized that injection to honor `_imageMime` (so PNG from image-gen is labeled correctly). `evictOldImages(KEEP_IMAGES=2)` already caps screenshot/image bloat → covers studio shots too.
- **`generate_image`** (GPT Image 1): saves PNG to `~/.bhatbot/generated/`, returns `_image`(b64 PNG)+`_imageMime` so Claude critiques + iterates. `imageAutoStudio:true` → also writes an `<img>` page to Studio and opens it. **Spec deviations:** dropped `response_format:'b64_json'` (gpt-image-1 always returns b64, rejects the param); size enum corrected to gpt-image-1's real set `1024x1024 / 1536x1024 / 1024x1536` (spec's `1792x1024` is DALL·E-3 only). Verified live (200, image rendered).
- **`generate_3d`** (Replicate `firtoz/trellis`): gated on `replicateKey` (now set; auth verified, user `sbhat2026`). **Deviation:** TRELLIS input is `images:[dataUrl]` (array), not `image`. Polls with `Prefer: wait` + fallback loop; downloads GLB → `~/.bhatbot/generated/`.
- **System prompt:** added VISUAL CREATION block (you can see your output; prefer SVG via studio_write; iterate ≤3×; generate_image for raster; generate_3d for GLB).
- `get-voice-config` now also returns `hasReplicateKey`, `hasImageGen` for UI gating. **Spec Step 7 setup-screen field skipped** — Bhatbot has no in-app key UI (keys live in `config.json`); the boolean flags are the useful part.

### Loading screen (replaces the logo step per user)
- Logo/sharp/tray step **dropped at user request**; instead built a **particle-cloud hero animation** for the boot/loading screen: cyan particle disc swirling + breathing around a pulsing core, constellation links, parallax by depth, twinkle. `<canvas id="hero">` behind the boot log; `heroStop()` cancels rAF on dismiss. Cyan (#00c8ff) on navy radial.

- Verified: JS syntax (main + inline), ElevenLabs premade synth (played), OpenAI TTS fallback (played), gpt-image-1 live, Replicate auth. Unverified (needs GUI): in-app studio capturePage, hero render, 3D end-to-end run.

## Pass 12 (2026-06-06) — wake-word diagnostic + fix ("hey jarvis" / "hey bhatbot")
### Diagnosis (why "hey jarvis" never worked)
- Active helper was Vosk `listen.py` matching ONLY the literal word **"bhatbot"** — "jarvis" was never in the match set, so "hey jarvis" could not fire by design.
- **"bhatbot" is not in the Vosk vocabulary** (`Ignoring word missing in vocabulary: 'bhatbot'`) → "hey bhatbot" couldn't work either; the small model drops the unknown proper noun.
- `startWakeHelper` **swallowed stderr** (`stderr.on('data', ()=>{})`) → every python/mic/model failure was invisible.
- Stack itself is healthy: python 3.13, vosk+sounddevice import, model present, mic enumerated (MacBook Air Mic default), stream opens without permission error in-context.
### Fix — hybrid listener (`scripts/listen.py` rewritten)
- **openWakeWord `hey_jarvis_v0.1.onnx`** (installed, purpose-built, low false-positive: 0.0 on silence) → reliable **"hey jarvis"**.
- **Vosk grammar** restricted to in-vocab homophones for **"hey bhatbot"** (`hey bot / bot bot / but bot / bought bot / bat bot / hey buddy / bot / buddy`) + jarvis + `[unk]`. Grammar-biasing makes keyword spotting far more reliable than free-form.
- Both detectors share ONE 16k mic stream (1280-sample/80ms frames). Either hit (debounced 2.5s) → prints bare **`WAKE`** → main arms **Whisper** for the command (Whisper handles arbitrary commands accurately; Vosk command-parsing dropped).
- `BHATBOT_WAKE_DEBUG=1` prints oWW scores + Vosk heard-text to stderr for tuning; `BHATBOT_WAKE_THRESH` (def 0.5), `BHATBOT_WAKE_ENGINES` (def `oww,vosk`).
- `startWakeHelper`: spawns `python3 -u`, handles `WAKE`/`CMD`/`READY`, and **surfaces stderr** (`WAKE_ERR`/`STREAM_ERR` → console + activity window; Vosk `LOG (` noise dropped).
- "hey bhatbot" parity (a true custom model) would need training an openWakeWord model — deferred; homophone grammar covers it for now.
- Verified: both engines init + load; bare-WAKE→Whisper path wired. Unverified (needs you to speak): live trigger — test with `BHATBOT_WAKE_DEBUG=1 python3 ~/bhatbot/scripts/listen.py` from Terminal.

## Pass 13 (2026-06-06) — wake homophones locked + phone access via MCP connector
### Wake word finalized
- Confirmed live: "hey jarvis" → openWakeWord 0.93–1.0; "hey bhatbot" → Vosk lands as `hey bought bot` / `hey but bot`.
- `listen.py` grammar tightened to the reliable set: `["hey bought bot","hey but bot","bought bot","but bot"]` + jarvis; bare `bot`/`buddy`/`bat bot` dropped to kill false triggers. `MATCH_PHRASES` requires ≥2-word match.

### Phone access — remote MCP server (Claude app connector)
- **`mcp-server.js`** (new): MCP server over **Streamable HTTP** (SDK `@modelcontextprotocol/sdk` 1.29.0, `express` 5, `zod` 4). Stateless transport per request. Tools: `run_task{instruction,new_conversation?}` and `status`. Secret token in URL path (`/mcp/<token>`) gates access; bad token → 401.
- **`main.js`**: `runAgentHeadless(instruction,{reset})` keeps a rolling 40-msg remote history and drives the SAME `agentLoop` with a no-op event — so phone-issued tasks still stream to the activity window. `initMcpServer()` auto-generates `mcpToken` (crypto, persisted to config), binds `127.0.0.1:mcpPort` (default 8788), starts on app-ready, stops on quit. Config: `mcpEnabled`(def true), `mcpPort`, `mcpToken`.
- **Transport = Tailscale (user choice)**. Nuance handled: the Claude *mobile* app connects to connectors from Anthropic's side → endpoint must be public → use **`tailscale funnel 8788`** (Tailscale's public-HTTPS mode, stable `*.ts.net` + auto-TLS) rather than private `serve`. Token-in-path is the auth (set connector auth = none).
- Verified headless: server boot, MCP `initialize`, `tools/list` → [run_task,status], `tools/call run_task` returns text, 401 on bad token.
- **Pending (user actions):** install Tailscale + enable Funnel; run `tailscale funnel 8788`; add `https://<machine>.<tailnet>.ts.net/mcp/<token>` as a custom connector in the Claude app (needs Pro/Max). Mac must be awake + app running.
- New deps: `@modelcontextprotocol/sdk`, `express`, `zod`.

## Pass 13.1 (2026-06-06) — MCP connector debug (the "couldn't register" error)
- **Cause:** Bhatbot app wasn't running → nothing on :8788 → funnel returned **502** for everything, including the OAuth-discovery probe → Claude couldn't detect "no-auth", fell back to OAuth Dynamic Client Registration, which failed ("Couldn't register with BhatBot's sign-in service").
- **Fix:** just run the app. Verified live through the public funnel (`siddhants-macbook-air.tail816be0.ts.net`): `/health` 200, `/.well-known/oauth-*` → **404** (Claude now treats as no-auth), `initialize` 200 SSE, and a real `run_task` round-trip returned "pong from the Mac". No code change needed — the server was correct, it was down.
- **`scripts/serve-remote.sh`** (new): one command to keep the Mac awake (`caffeinate`), start the app if its MCP isn't already up, print the connector URL, and run `tailscale funnel`. Ctrl-C stops funnel/caffeinate, leaves the app running.
- Connector URL = `https://<tailscale-host>/mcp/<mcpToken>`, auth = None (token-in-path).

## Pass 14 (2026-06-06) — Phone PWA: direct mic + chat (no Claude middleman)
- **Goal:** a tap-open phone app that talks straight to Bhatbot on the Mac — no Claude app as middleman. Solution = a PWA ("Add to Home Screen") served by the SAME express app + SAME Tailscale funnel that already powers the MCP connector. Zero new infra.
- **`main.js`:** extracted the TTS + STT logic out of their IPC handlers into reusable plain functions `synthesizeSpeech(text)` and `transcribeAudio(buffer, mimeType)` (handlers now just call them — no desktop behavior change). `transcribeAudio` now derives the upload filename ext from mimeType (iOS MediaRecorder emits `audio/mp4`, not webm → Whisper needs `.m4a`). `initMcpServer()` passes `transcribe`/`synthesize` into `startMcpServer` and logs the `/app/<token>` URL.
- **`mcp-server.js`:** added token-gated routes on the same app — `GET /app/:token` (mobile.html), `/app/:token/manifest.webmanifest`, `/app/:token/sw.js`, `/app/:token/icon-{192,512}.png`; `POST /api/:token/chat` (→ same `runAgentHeadless`/`agentLoop`), `/api/:token/stt` (raw audio body + `?mime=`), `/api/:token/tts`. MCP `/mcp/:token` + `/health` untouched.
- **`src/mobile.html`** (new): self-contained mobile-first PWA UI (dark/cyan, matches HUD). Chat bubbles + textarea; 🎙 tap-to-talk (MediaRecorder + 2s-silence auto-stop, picks `audio/mp4` on iOS) → `/api/.../stt` → auto-send; 🔊 sentence-streamed Jarvis TTS via `/api/.../tts` (reuses splitSentences/playBlob queue) with an iOS audio-unlock on first gesture; reads its token from `location.pathname`; registers a minimal service worker; full PWA `<head>` (manifest, apple-touch-icon, standalone, viewport-fit=cover). NO wake word on phone (PWA can't background-listen) — tap-to-talk only.
- **`scripts/gen-icons.js`** (new): dependency-free PNG generator (built-in `zlib`, hand-rolled CRC32 + IHDR/IDAT/IEND) → `src/mobile/icon-192.png` + `icon-512.png` (cyan particle-disc, matches boot hero). No sharp/canvas needed.
- **`scripts/serve-remote.sh`:** now prints both the 📱 Phone app URL and the 🔌 Connector URL.
- **Verified end-to-end** (local :8788 AND public funnel): app page 200 / bad token 401, manifest, sw, icon (36340b); `chat` → real agentLoop returned "phone pipe works"; `tts` → elevenlabs audio; `stt` round-trip ("testing one two three" → "Testing 1, 2, 3."). Public: `https://<host>/app/<token>` 200, icon 200, tts OK.
- **User action:** Safari → `https://<tailscale-host>/app/<mcpToken>` → Share → Add to Home Screen. Mac must be awake + `serve-remote.sh` running.

## Pass 14.1 (2026-06-06) — phone voice fixes (iOS audio + hands-free convo)
- **Root cause of "speaking not working" = iOS audio, not the STT provider.** Mobile Safari's `MediaRecorder` is flaky and iOS blocks `new Audio().play()` after an async fetch (TTS stayed silent). Switching to Azure/Google wouldn't fix it — Whisper was fine server-side (WAV verified: "Checking the WAV transcription path.").
- **`src/mobile.html` audio layer rewritten on Web Audio:**
  - One `AudioContext`, resumed on first tap (`ensureCtx`, also on send/keydown) → TTS now plays on iOS via `decodeAudioData` + `BufferSource` (was silent `<audio>`).
  - Mic capture now records raw PCM via `ScriptProcessorNode` → downsample to 16k → client-side **WAV** → `POST /stt?mime=audio/wav`. Bypasses iOS MediaRecorder entirely.
  - **Hands-free conversation loop:** mic tap starts a conversation (listen→send→speak→listen) that **keeps waiting until you actually speak** — silence only ends a turn AFTER speech was detected (`heardSpeech` gate), so it never drops you mid-thought. Tap ⏹ to end. No more re-waking per turn.
- Verified: app 200 (local + funnel), WAV STT round-trip, TTS audio. Whisper kept (cheap, reliable); no new provider added.

## Pass 14.2 (2026-06-06) — desktop TTS fix, spoken summaries, embedded Claude Code, resizable windows
- **Desktop TTS analysis + fix.** Backend was fine (British Daniel EL, quota 2957/10000, `/api/tts` verified). Root cause: Electron/Chromium blocked `Audio().play()` after the async synth call → silent, no error (`.catch` swallowed it). Fix: `app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required')` in main.js. Phone already worked (Web Audio).
- **Spoken summaries (>250 chars).** New `summarizeForSpeech(text)` in main.js (Haiku, butler-tone, 1–2 sentences) → IPC `summarize-for-speech` + `POST /api/:token/summarize`. `speak()` (HUD + phone) now: store `lastFullReply`, if >250 chars speak the summary, else verbatim. **"read full reply"** chip appears under long bot bubbles; saying/typing "read the whole/entire/full response" re-reads verbatim (`{full:true}`, regex-matched before hitting the agent).
- **British Jarvis voice** confirmed canonical (Daniel `onwK4e9ZLuTAKqWW03F9`, accent=british); OpenAI fallback instructions already British-butler.
- **Embedded Claude Code in the HUD.** `⌗ Code` now toggles a docked terminal **panel inside the main window** (xterm + addon-fit, app theme: #0a0f17/cyan/JetBrains Mono) instead of a separate window. `preload.js` exposes `window.term` (pty IPC); `startPty` routes `pty-data`/`pty-exit` to mainWindow (and the old window if open). Panel: drag-grip resize, ⟳ restart, ✕ close; pty starts lazily on first open. CSP widened with `file:` for node_modules xterm assets.
- **Resizable windows.** Main HUD was locked `fullscreen:true` → switched to `fullscreen:false` + `maximize()` (big but freely resizable). Added explicit `resizable/maximizable` + sane `minWidth/minHeight` to Nexus, Studio, Claude Code, Activity windows.
- Verified: app boots clean (no renderer/CSP errors), summarize 200 (local + funnel) returns condensed butler line, app page 200, chat/tts/stt intact.

## Pass 14.3 (2026-06-06) — phone PWA auto-update + URL helper
- **Problem:** installed home-screen PWA showed stale content after deploys (iOS/WebKit caching); the funnel URL itself is stable, the *content* wasn't refreshing.
- **Fix (true autoupdate, no reinstall):**
  - `mcp-server.js`: build id = `mobile.html` mtime; `GET /app/:token/version` returns it; `/app/:token` now injects it (`__BUILD__`→id) and serves with `Cache-Control: no-store, no-cache, must-revalidate`.
  - `src/mobile.html`: boots with the injected `BUILD`; **unregisters any old service worker** (was a cache liability on iOS); polls `/version` on launch, on app-foreground (`visibilitychange`), and every 60s → `location.reload()` when the id differs. A stale cached shell carries the old id, detects the mismatch, and reloads into the fresh no-store document. Result: edit `mobile.html` → phone app updates itself within ~1 min or on next open, no Safari re-add.
- **`scripts/app-url.sh`** (new): prints the phone-app URL, ensures the funnel is up, and `pbcopy`s it for pasting into Safari.
- Verified: `/version` returns mtime id; `__BUILD__` replaced in served HTML; `no-store` header present; id bumps on `mobile.html` edit (1780792543541 → …567624).

## Pass 15 (2026-06-06) — Tier 1/2 sprint (deviations from the megaprompt)
User decisions: TTS=add `say` for tiny replies (kept advanced TTS); BUILD=media control + Telegram + briefing/health (skipped Tavily); briefing time=ask & save.
- **Feature 1 (TTS) — NOT replaced (would regress).** Kept the streaming multi-provider British-Jarvis TTS + summaries + read-full. Added only the requested optimization: desktop HUD routes ultra-short replies (<80 chars) through free macOS `say -v Daniel` (British) via `sayLocal()` + IPC `say-local`. Phone unchanged (say runs on the Mac, not the phone). No `ttsMute` added — HUD already has the 🔊 toggle.
- **Feature 2 — media_control** tool added (TOOLS + switch case + `mediaControl()`/`osa()` helpers). Spotify play/pause/next/prev/now-playing/volume + system volume via `osascript` (spawn, arg-escaped — not the spec's string-interpolated `exec`). search_and_play falls back to opening Spotify search if direct URI play fails. **Verified live** (returned the actual current track).
- **Feature 3 — Telegram bridge** (`startTelegramBridge`, dormant until `telegramToken` set). Fixed spec bug: voice notes use the real `transcribeAudio(buf,'audio/ogg')` (not the nonexistent `require('./darkbloom').transcribeAudio`). First message auto-authorizes the chat; per-chat rolling history; 4096-char split; markdown fallback. `telegramNotify()` reused by the briefing. Dep `node-telegram-bot-api@0.67`.
- **Feature 4 — Tavily deep_research: SKIPPED** per user.
- **Feature 5 — daily briefing** (`scheduleBriefing`/`runBriefing`): reads `config.briefingHour` (null=unscheduled, per "ask me & save"), `briefingChecks` (configurable URLs, spec defaults). Runs agentLoop → macOS notification + `sayLocal` intro + `telegramNotify` + activity feed. IPC `set-briefing-hour` persists+reschedules. Worker URLs from spec are placeholders pending confirmation.
- **Feature 6 — health dashboard:** IPC `get-health` (today's audit entries+~cost, memory.md entries/kb, Ollama ping, agentState, telegram/briefing) → `preload-activity.getHealth` → bottom strip in activity.html (30s poll, themed).
- **System prompt:** appended VOICE / MEDIA / PHONE / PROACTIVE blocks to STATIC_PROMPT.
- **Config:** + ttsLocalVoice="Daniel", telegramToken, telegramChatId, briefingEnabled, briefingChecks.
- Verified: main.js syntax OK; clean boot ([telegram] dormant, [briefing] unscheduled); media_control live; Daniel en_GB present.

## Pass 16 (2026-06-07) — media import (screenshots / photos / screen recordings → vision)
- **Goal:** import screenshots, screen recordings, and photo-library images into Claude vision, from both HUD and phone.
- **main.js media helpers:** `VISION_MAX_DIM=1568`, `imgBlock()`, `sipsToJpeg()` (HEIC/resize via `sips -Z 1568 -s format jpeg`), `videoFrames()` (ffmpeg `fps=1/2,scale=1568` → up to 6 b64 jpg frames), `mediaFileToBlocks(path)`, `mimeToExt()`, `mediaBytesToBlocks(buf,mime)`.
- **IPC `pick-media`** → native dialog (multiSelect, images+video) → `{blocks,names}`. **`runAgentHeadless`** now accepts `opts.blocks` and prepends them to the user turn as a content array.
- **mcp-server `POST /api/:token/attach`** (`express.raw` 120mb) → `media(req.body, ?mime)` → `{blocks}`; **`/chat`** now accepts `blocks`.
- **HUD (index.html):** 📎 attach button + chip bar; `send()` builds an image content array. **Phone (mobile.html):** 📎 + hidden `<input type=file accept="image/*,video/*" multiple>` (iOS exposes Photo Library / Camera / Files) → POST `/attach` → `pendingBlocks` → `/chat` with blocks.
- **preload.js** `pickMedia`. **Verified:** `/attach` returned an image block; `/chat` with it → agent described the image ("Glowing cyan sphere with concentric rings and particles.").

## Pass 17 (2026-06-07) — local Kokoro neural TTS (free, offline, British Jarvis)
- **Why:** eliminate per-reply TTS API cost + latency; run high-quality voice locally on the M4 (user request: try Kokoro/Piper/local-first).
- **Install:** `pip install kokoro-onnx soundfile`; models in `~/.bhatbot/kokoro/` (`kokoro-v1.0.onnx` 310MB + `voices-v1.0.bin` 27MB, from thewh1teagle/kokoro-onnx release `model-files-v1.0`).
- **Warm worker:** `scripts/kokoro_worker.py` loads the model ONCE then serves one JSON request/line on stdin → temp wav path on stdout (avoids the ~0.8s reload per reply). main.js manages it as a singleton (`kokoroStart`/`kokoroSynth`, line-buffered stdout, pending-id map, 30s timeout, auto-respawn on exit). Pre-warmed in `whenReady`; killed in `will-quit`.
- **synthesizeSpeech:** provider now defaults to **kokoro** when the model is present (`kokoroAvailable()`), else elevenlabs/openai/piper as before. On any kokoro failure it **falls back to elevenLabs → openai** so the voice never goes silent. Extracted `elevenLabsSynth()`/`openaiSynth()` helpers (were inline) for reuse as fallbacks. `get-voice-config` reports kokoro.
- **Voice:** British `bm_george` (`kokoroVoice`/`kokoroSpeed`/`kokoroLang` configurable; `en-gb`). Returns `audio/wav` — phone decodes via Web Audio `decodeAudioData`, HUD via typed Blob; no client change needed.
- **Config:** `ttsProvider="kokoro"`, `kokoroVoice="bm_george"`, `kokoroLang="en-gb"` (elevenLabs key retained as fallback).
- **Verified:** warm worker (ready 821ms; warm synth ~1.3s/sentence); clean boot logs `[tts] kokoro warm (local)`; `POST /api/<token>/tts` → `via=kokoro`, `audio/wav`, 196KB real audio.

### Pass 17.1 — desktop voice actually audible (afplay)
- **Symptom:** "I didn't hear it say anything" on the Mac (phone fine). Root cause: the renderer `<Audio>` element is unreliable in Electron (autoplay/codec quirks) — the autoplay-policy switch wasn't enough. OS audio itself was fine (`say`, `afplay`, vol all worked).
- **Fix:** desktop voice now synthesizes AND plays in the **main process**. New `speakDesktop(text,{full})` + `stopDesktopTTS()` (IPC `play-tts`/`stop-tts`): short→`say -v Daniel`, long→`summarizeForSpeech`, else kokoro synth → temp file → **`afplay`**. HUD `speak()`/`stopSpeaking()` rewired to call these (dropped renderer `Audio`/`playBlob`/`curAudio`). Phone path (Web Audio) unchanged. `ttsEnabled:false` honored.

## Pass 18 (2026-06-07) — packaged .app bundle (unlocks Accessibility + autostart)
- **Why:** AppleScript/System Events automation needs Accessibility permission, which requires a stable .app bundle (also fixes mic-on-autostart — was Terminal-launched for TCC).
- **electron-builder** (`npm run build` → `--mac dir`; `build:dmg` for a dmg). Config in package.json `build`: `asar:false` (sidesteps spawning python from inside an archive + native-module unpack), icon `build/icon.png` (from mobile 512), `identity:null` (unsigned/ad-hoc — local use), `hardenedRuntime:false`, `gatekeeperAssess:false`. Moved `electron` to devDependencies (builder requirement).
- **Info.plist** `extendInfo`: NSMicrophoneUsageDescription, NSAppleEventsUsageDescription (AppleScript/Spotify/window control), NSCameraUsageDescription.
- **Bundle-safe spawns:** added `unpacked(p)` helper (rewrites app.asar→app.asar.unpacked when packaged; no-op with asar:false) applied to `listen.py` + `kokoro_worker.py` paths. Kokoro models/config stay external in `~/.bhatbot/` (read via os.homedir).
- Built `Bhatbot.app` (285M), installed to **/Applications**, cleared quarantine. Verified: boots clean (kokoro warm, MCP bound `/health` 200, telegram+briefing active), bundle contains scripts + node-pty `pty.node` + src.

### Pass 18.1 — natural cadence + voice customization (phone-focused)
- **Less robotic:** the main robotic factor was per-sentence chunking (Kokoro resets intonation each chunk). Now **short spoken text (≤350 chars) is synthesized in ONE call** for continuous prosody; only long full-reads stream sentence chunks (fast start). Applied on both desktop (`speakDesktop`) and phone (`speak`).
- **Customizable voice/speed:** `synthesizeSpeech(text, opts)` → `kokoroSynth(text, opts)` honors `{voice, speed}`; `KOKORO_VOICES` allow-list (junk → config default), speed clamped 0.6–1.4. `/api/:token/tts` accepts `{voice, speed}`.
- **Phone ⚙ settings sheet:** voice picker (British male/female + US) + speed slider + "Test voice" button; persisted in localStorage (`bb_voice`/`bb_speed`), sent with every `/tts`. Desktop voice configurable via `kokoroVoice`/`kokoroSpeed` in config.json.
- Verified live: bm_george/bm_lewis@0.9/bf_emma@1.1 all return distinct kokoro audio; junk voice+speed=9 clamped and fell back without error.

### Pass 18.2 — DIAGNOSTIC: wake words + speaking dead in the packaged .app (python PATH)
- **Reported:** wake keywords and speaking bugged on phone and in the .app.
- **Root cause:** a Finder/launchd-launched .app inherits a minimal `PATH` (`/usr/bin:/bin`), so the bundled spawns of `python3` resolved to **/usr/bin/python3**, which has none of our deps (`kokoro_onnx`, `vosk`, `openwakeword`). Result: the **wake listener died on import** (no wake words) and the **Kokoro worker died** (TTS error `No module named 'kokoro_onnx'`). TTS also failed to fall back because `kokoroSynth` let `kokoroStart()`'s rejection throw past the elevenlabs/openai fallback. (Worked when I launched from Terminal because Terminal's PATH includes the framework python — masking the bug.)
- **Fix:**
  - `resolvePython()` — probes config.pythonBin then known absolute paths, picking the first python that can `import kokoro_onnx`; used by BOTH `startWakeHelper` and the Kokoro worker spawn. Set `config.pythonBin=/Library/Frameworks/Python.framework/Versions/3.13/bin/python3`.
  - `EXEC_PATH` now also includes the Python.framework `Current`+`3.13` bin dirs.
  - `kokoroSynth` wraps `kokoroStart()` in try/catch → returns `{error}` so the cloud fallback actually runs if the worker ever dies.
- **Verified under simulated Finder launch** (`env -i HOME=… PATH=/usr/bin:/bin …` → the exact broken condition): `[tts] kokoro warm`, `[wake] listener ready`, both python children running under the **framework** python, `/tts via=kokoro` (120KB), `/summarize` ok. Rebuilt + reinstalled /Applications.
- **Still required from user:** grant **Microphone** to Bhatbot.app (System Settings→Privacy→Microphone) for the wake listener to actually hear — imports now succeed, mic is the remaining gate.

### Pass 18.3 — 429 rate-limit handling + context cap (the "API 429 keeps cropping up" bug)
- **Reported (phone screenshot):** `API 429 ... rate_limit_error ... 50,000 input tokens per minute ... claude-haiku-4-5`. Not mic/accessibility — an Anthropic **tier-1 rate limit**, surfacing because `callClaude` threw on the first 429 with **no retry**, and the agent re-sent ever-growing context each turn.
- **Fix:**
  - `anthropicRequest(body, apiKey)` — centralized call with **exponential backoff + jitter on 429/529/5xx**, honoring the `Retry-After` header (cap 30s, 5 retries); also retries network blips. callClaude + summarizeForSpeech route through it. Exhausted 429/529 → friendly message (no raw JSON dumped to the phone).
  - `capTokens(messages, 20000)` — hard token budget; trims oldest turns before each call, pairing-safe (never starts on an orphan tool_result), so a single call can't blow the 50k/min cap. Applied inside callClaude (also protects the existing summarizing `trimHistory`'s own API call). summary input capped to 8k chars.
- **Gotcha hit during the fix:** my new helper was first named `trimHistory`, which **collided** with the pre-existing async summarizing `trimHistory` (line ~431) — function hoisting made the later def win, so callClaude sent a Promise as `messages` → `API 400 messages: Input should be a valid array`. Renamed to `capTokens`. Also: `pkill -f "...bhatbot"` does NOT match the dev `electron .` process; kill dev by port (`lsof -ti tcp:8788 | xargs kill -9`) — a stale instance held 8788 and masked the fix.
- Verified on the installed /Applications build: chat→pong, follow-up→ping, tts via=kokoro, workers on framework python.

### Pass 18.4 — proactive rate-limit avoidance: local-model fallback OR notify+reset
- **Request:** before sending, decide if a prompt will exceed the token limit; if so use a local (Ollama) model, or else just say so and reset the budget for the next task.
- **Rolling ITPM tracker:** `recordTokens()` logs real `usage` (input + cache read/creation) from every Anthropic response into a 60s window; `tokensUsedLastMin()` / `rateBudget()` → `{limit, safe (=limit*0.9), used, free}`. Config: `rateLimitTokens` (default 50000 — raise if account tier is higher), `rateLimitSafetyFrac` (0.9).
- **Preflight in `callModel`:** `requestTokenEstimate(messages)` (system + tools + capped messages). If it exceeds `free`:
  - `rateLimitMode:'local'` (default) + Ollama up → run the turn on `localModel` (default `qwen3:latest`) via `ollamaChat()` (blocks flattened to text, no tools); response tagged `_provider:'ollama' _rateFallback:true` (shown via the existing provider_used event).
  - else (Ollama down or `rateLimitMode:'notify'`) → throw a `rateBudget` error; `agentLoop` catches it → returns a friendly "would exceed… context reset" message and **clears history** so the next task starts fresh.
- **Voice summaries:** `summarizeForSpeech` now Haiku-first ONLY when there's budget (it's tiny/fast), else local-model fallback — so voice never dies under rate limit and doesn't itself trip the cap. (Tried local-first; qwen3 cold-load was too slow for voice, so reverted to Haiku-first.)
- **Verified:** normal chat → Claude (`pong`); forced `rateLimitTokens=200` → local model answered ("…Paris."); `rateLimitMode='notify'` → "⚠ would exceed… context reset" + reset. Rebuilt/reinstalled /Applications.

## Pass 19 (2026-06-07) — AppleScript automation, browser workflow recording, Spotify fix
- **Spotify fix (root cause = AppleScript, not permissions; basic control already worked exit 0):**
  - `play track "<name>"` silently fails — Spotify's AppleScript `play track` needs a **URI**, not a name. Now name→URI via the **Spotify Web API** (client-credentials: only `spotifyClientId`+`spotifyClientSecret`, no user OAuth) → `play track "<uri>"` locally; URIs/URLs play directly; no creds → opens `spotify:search:` and says so.
  - `get_now_playing` errored (`-1728`) when stopped → now checks `player state` first and reports "nothing playing"/paused.
  - Launches Spotify if not running; `osaErr()` detects `-1743` (Automation not authorized) → tells user to grant Automation→Spotify.
- **`system_control` tool (NEW)** — generalizes AppleScript/System Events to any app: `activate_app`, `keystroke`, `shortcut` (key+modifiers, e.g. ⌘S), `menu` (app+menuPath ["File","Save"]), `clipboard_get/set`, `notification`, `applescript` (raw). Needs Accessibility (keystroke/menu) + Automation (per-app). Verified clipboard_get → returned set value.
- **`browser_workflow` tool (NEW)** — record/replay browser macros. `start_recording` → browser actions are captured (navigate/click/type/evaluate) → `save_workflow{name}` → `~/.bhatbot/workflows/<name>.json`; `replay_workflow`, `list/show/delete_workflow`, `cancel_recording`. Empirical traces > re-derived selectors. Verified record→save→replay (example.com → title "Example Domain").
- **Rate-limit fallback fix:** the local-model fallback (18.4) was hijacking tool-requiring turns (Ollama can't call tools → empty). Now gated to first turn only, and empty local output falls through to notify+reset instead of returning nothing.
- STATIC_PROMPT += MEDIA(name→URI note) / SYSTEM CONTROL / BROWSER WORKFLOWS. Tools now 16. Rebuilt + reinstalled /Applications.

### Pass 19.1 — voice upgrade: ElevenLabs default (Kokoro too synthetic)
- User found Kokoro `bm_george` too robotic ("Stephen Hawking"). Switched default `ttsProvider=elevenlabs`, voice=Daniel British (`onwK4e9ZLuTAKqWW03F9`), model `eleven_turbo_v2_5` (low latency). Verified `/tts via=elevenlabs` (mp3, 90KB).
- Fallback chain hardened: ElevenLabs → (on quota/auth/rate/network) free local **Kokoro** → OpenAI, so voice never dies when the EL free tier (10k chars/mo) is exhausted.
- Phone ⚙ voice/speed picker is Kokoro-specific → inert while provider=elevenlabs (harmless).
- Spotify redirect URI guidance: use loopback IP `http://127.0.0.1:8888/callback` (Spotify deprecated `localhost`); future-proof for standalone-app OAuth.

## Pass 20 (2026-06-07) — Spotify Connect (control phone/any device via Web API)
- **Goal:** play/control Spotify ON the phone (or any device), not just the Mac's app.
- **Why it needs more than client-credentials:** AppleScript only controls the local Mac app. Controlling another device = Spotify **Connect** Web API, which needs **user OAuth** (Authorization Code flow) + **Premium**.
- **`scripts/spotify-auth.js`** (NEW, run once): opens Spotify login, catches redirect on `http://127.0.0.1:8888/callback` (the loopback URI in the dashboard), exchanges code → saves `spotifyRefreshToken` + sets `spotifyUseConnect:true` in config. Scopes: user-modify/read-playback-state, user-read-currently-playing.
- **main.js Connect layer:** `spotifyUserToken` (refresh-token → cached access token), `spotifyApi`, `spotifyDevices`, `pickDevice` (name/"phone"/"mac" matching), `spotifyConnect` (play/pause/next/prev/volume/now-playing/list_devices/transfer via `/v1/me/player`, optional `?device_id=`). `connErr` maps 404→"open Spotify on device", 403→"needs Premium".
- **mediaControl routing:** uses Connect when `spotifyRefreshToken` set AND (`device` given / list_devices / transfer / `spotifyUseConnect`); else AppleScript (Mac). `media_control` tool gained `device` param + `list_devices`/`transfer` actions. Works identically whether the request comes from the phone PWA or the Mac.
- **Verified:** not-linked path graceful; local Mac control intact (now-playing returned real track). Phone playback pending user running spotify-auth.js + Premium. Rebuilt/reinstalled /Applications.
