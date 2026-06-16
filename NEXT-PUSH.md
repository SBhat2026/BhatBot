# BhatBot — Next Big Push (handoff)
_Updated 2026-06-16_

Compact starting point for the next session. State of the world + what's open.

## Sim + agents + eval (DONE 2026-06-15/16)
- **simulate tool** (`lib/simulate.js` + `scripts/sim-setup.sh`): sandbox venv `~/.bhatbot/sim-venv` (py3.11). 16 libs: numpy scipy sympy networkx pandas matplotlib pint mendeleev numba pymunk rdkit ase **mujoco openmm pyscf smolagents**. action run/capabilities; emit()+auto-figure. Verified: scipy ODE, rdkit aspirin, pyscf H2 −1.1168 Ha.
- **pybullet DROPPED** (macOS SDK build fail) → MuJoCo is the 3D engine (user pref: faster/higher-fidelity).
- **math_reason tool** (`scripts/smol_agent.py`): smolagents CodeAgent, computed math answers. Verified Σroots²=14.
- **Figure recipe cache self-prunes** (`figures.pruneRecipes`, every write): dedupe identical specs + drop stale/unused + cap 24.
- **PERF EVAL** (`scripts/perf-eval.js` + `lib/eval.js`): in-process Node harness + Claude G-Eval judge (chose this over DeepEval/LangSmith/Phoenix — see PERF-EVAL.md). Routing 9/9, args 3/3, healing 3/3 (100%); judge: honest align 0.95/concise 0.9/halluc 0, catches hallucinated+noisy. Fixed inferAgent render/STL mis-route → creative. Traces → ~/.bhatbot/eval/. NEXT fidelity: live end-to-end agentLoop eval (harness ready).

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

## Voice cadence (DONE 2026-06-15) — 3 most-useful human-likeness aspects
- **Request stitching**: ttsStreamDrain passes previous_text/next_text per streamed sentence → prosody flows across chunks (no per-sentence intonation reset). Biggest cadence win for streaming.
- **humanizeCadence()** (main.js + cloud/server.js): ElevenLabs `<break>` tags on flash/turbo v2.5 (gated — v3 doesn't support; capped at 6 to avoid documented instability) + ellipsis/em-dash micro-pauses + opening discourse-marker beat ("Right, …"). Punctuation-only variant for kokoro. Config `ttsCadence`.
- **Tuned voice_settings**: stability 0.38 (was 0.4), style 0.35 (was 0.2), use_speaker_boost true (was false), speed 1.06. Config: ttsStability/ttsStyle/ttsSimilarity/ttsSpeakerBoost.

## Items 4 / 3 / 5 (DONE 2026-06-15)
- **Item 4 cloud durable history**: cloud/server.js disk-backed transcript (DATA_DIR, default ./data), restored on boot, debounced save each turn. fly.toml mounts volume `bhatbot_data`→/data + DATA_DIR env. `fly volumes create bhatbot_data --region ewr --size 1`. (Deploy itself = user action: their keys/account. MAC_RELAY_URL relay already wired, needs Mac tunnel up to test.)
- **Item 3 one-shot figures**: figures.oneShot({data,goal,n}) = analyze→pick best specs (goal-steered: distrib→hist/box, correl→scatter/heatmap, compare→bar/box, trend→line)→render all in one call. Recipe cache ~/.bhatbot/figure-recipes.json keyed by col-name/dtype+goal signature; recurring shapes instant; mirrored to Notion (tag figure-recipe). make_figure action:"oneshot" (default). Verified: 3 figs + 2nd-call recipeHit.
- **Item 5 proactive scheduler**: lib/scheduler.js (daily/weekly/interval/once, persisted ~/.bhatbot/schedules.json) + 30s tick (startScheduler, started at app ready). runScheduledTask runs prompt through agentLoop headless → sayLocal + telegramNotify + notion.logActivity, then markRan advances/disables. Tool manage_schedule (add/list/remove/enable/disable/run) + inMinutes/inHours/everyMinutes/everyHours shortcuts. Verified logic.
- ⬜ All take effect after desktop app reinstall (deploy cycle below). Scheduler/cadence need the running app to exercise live.

## Item 1 (DONE 2026-06-15) — login across ALL apps + real browsers
- **`nativeLogin()`** (main.js): smart_login now drives native Mac apps + real browsers (Chrome/Safari/Edge/Arc/Firefox/Brave), not just the Playwright window. Opens target (`open -a <Browser> <url>` or system_control open_app), vision-focuses the username field via screen_parse→vision_click when OmniParser is up, else universal username→Tab→password→Enter. Secrets typed via **clipboard (Cmd+V) then wiped** — reliable for any char (escaping roundtrip verified: quotes/backslash/$/@). Same 2FA: silent TOTP (otpauth) OR vision-OCR 2FA detection → phone call+text+awaitTwoFactorCode → type code. smart_login routes to nativeLogin when `target` in app|native|chrome|safari|edge|arc|firefox|brave (default = Playwright, unchanged). Schema + STATIC_PROMPT updated (target/app/browser/vision). Needs Accessibility (+Screen Recording for vision); falls back to window on perm failure. Commit d62d32c.
- **⬜ ENTIRE roadmap 2→1→4→3→5 COMPLETE.** All need app reinstall to go live; native login + vision + scheduler exercised only in the running app w/ permissions granted.

## Roadmap order (user 2026-06-15): 2 → 1 → 4 → 3 → 5  + planning improvement — ✅ ALL DONE
- **Planning preamble (DONE)**: agentLoop drafts a quick plan (Haiku), SPEAKS a 1-line summary, shows checklist, injects as exec context, runs WITHOUT waiting. Live steering via existing guidance box. needsPlan() gate, config planPreamble. Commit a26cb93.
- **Item 2 vision control (DONE, needs in-app perms test)**: `scripts/omniparser_worker.py` persistent worker (warm YOLO; fast OCR+detect ~5s/parse, semantics:true adds Florence captions ~60s). Stdout kept pure-JSON (libs→stderr). Tools `screen_parse{target:screen|browser,query,semantics}` → element map w/ click coords (screen=points via electron screen size; browser=CSS px) + screenshot; `vision_click{x,y,target,double}` → CGEvent (Quartz, in omni venv) for screen / page.mouse for browser. Worker uses OmniParser's OWN .venv (external, not bundled). OmniParser RE-TESTED working. ⬜ Live screen_parse/vision_click need Screen-Recording + Accessibility grants + on-machine click calibration.
- **Twilio voice (DONE this session)**: auth verified (Trial, $14.26, myPhone verified), number voice-enabled; set INBOUND voiceUrl → /voice/<token>/incoming (calling the number now reaches the Jarvis agent). Outbound twilioCall already inline-url. ⬜ NEEDS USER: (1) keep app + Tailscale funnel up (serve-remote.sh) — webhook was down/unreachable at check; (2) upgrade Twilio from Trial to drop the press-a-key preamble + call any number. Texted user (Telegram + Twilio SMS both delivered).

## Candidate next-push work (not started)
- **Item 1**: real-browser/native-app login via vision control (screen_parse→type→vision_click) + system_control keystroke, extending smart_login beyond Playwright.
- **Items 4, 3, 5** per the order.
- Speed: skip-caption fast path is default; consider OCR-only confidence + caching parses.
- Cloud: durable **conversation history** (currently in-process Map; Notion holds facts only).
- Cloud: wire **MAC_RELAY_URL** end-to-end + test desktop-tool relay when Mac awake.
- Notion: surface **Research/Project/Task** DBs into the phone UI (read views).
- TTS streaming latency tuning on cloud (optimize_streaming_latency already 3).

## Deploy cycle (desktop app)
`npm run build` → quit app → `rm -rf /Applications/Bhatbot.app && ditto dist/mac-arm64/Bhatbot.app /Applications/Bhatbot.app` → `xattr -dr com.apple.quarantine /Applications/Bhatbot.app` → `open -a Bhatbot`.

## Repo
`SBhat2026/BhatBot` main. Note: several lib/ files (agents, router, jobs, prompts, security) had uncommitted prior-session work — left untouched; review before bundling into a commit.
