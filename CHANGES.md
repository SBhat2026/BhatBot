# CHANGES.md — Bhatbot build vs. megaprompt spec

What was built differently from `BHATBOT_MEGAPROMPT.md`, and why. For reference.

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
