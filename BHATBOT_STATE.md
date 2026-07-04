# BhatBot — State of the Project (authoritative briefing)

> Single-file, current-state briefing for any Claude/LLM session to get fully up to speed.
> **Last updated: 2026-06-22** (commit `28040fc`). Supersedes the older `BHATBOT_CONTEXT.md`
> (Jun 9) and `NEXT-PUSH.md` (Jun 16) for "what's true now." Read those for deeper history.

---

## 1. What BhatBot is
Siddhant's personal JARVIS-style AI assistant. Not Claude Desktop — a standalone agent with full
access to his Mac (filesystem, terminal, browser, apps) plus an always-on cloud brain he reaches
from his phone. Voice-first (ElevenLabs "Jarvis" clone), dry-witted British-butler persona,
multi-provider model routing, and a growing autonomy stack (scheduler, ambient awareness, self-healing).

**Owner:** Siddhant Bhat, 18, incoming Princeton (fall 2026). Comp-bio / GNN-ML / full-stack
(Next.js/Supabase/Vercel) / Unity / Blender. Don't dumb things down.

## 2. Architecture — three planes
- **Desktop (primary):** `main.js` (~6.6k lines, Electron main) + `src/` renderer (index.html =
  desktop UI, mobile.html = phone PWA, worldcup/chess/viewer/activity/terminal). The full agent
  loop, all tools, voice I/O, wake word live here. Exposes an HTTP/MCP server (`mcp-server.js`,
  express, port 8788) at `/api/:token/{chat,tts,stt,activity,...}` + `/mcp/:token` + `/app/:token`
  (phone PWA). Auth = bearer/path `mcpToken` (the whole security boundary).
- **Cloud (always-on brain):** `cloud/` — standalone express on **Fly.io** (`bhatbot-cloud.fly.dev`),
  SQLite persistence, same `/api/:token/*` contract. Cloud-native tools run there; **computer tools
  relay to the Mac** over a WebSocket (`lib/cloud-bridge.js` ↔ `cloud/src/relay.js`) when the Mac is
  online. So phone works with the Mac asleep for cloud things, and wakes/uses the Mac when needed.
- **Phone:** PWA served at `/app/:token` (`src/mobile.html`) OR native `.ipa` (`phone-app/`,
  WKWebView, SideStore). Tabs: Chat / Activity / Control / Nexus. Telegram bridge + Twilio two-way
  voice calls also reach the agent.

**One agent entry point:** every surface → `dispatchTurn()` in main.js (and `runTurn` in
`cloud/src/agent.js`).

## 3. Tech stack
Node/Electron, Anthropic + OpenAI + Gemini + local Ollama + Darkbloom (router fallbacks),
ElevenLabs TTS + Kokoro (local) + OpenAI TTS, OpenAI Whisper STT, Vosk wake word, Playwright
(browser automation), OmniParser (local UI vision), Three.js (3D viewer), Notion SDK (shared
memory bank, **pinned classic 2.x**), Twilio (calls/SMS), node-telegram-bot-api, Fly.io + Docker
(cloud), SQLite (cloud). Key deps: `@modelcontextprotocol/sdk @notionhq/client playwright three
twilio ws zod node-pty otpauth express`.

## 4. Capability catalog (tools)
**Desktop tools** (~50, in `main.js` TOOLS array): run_shell, read_file, write_file,
list_directory, open_in_browser, system_control (AppleScript/any app), media_control (Spotify/
volume), browser / browser_observe / browser_workflow (Playwright), screen_observe / screen_parse
(OmniParser) / ui_inspect / vision_click / vision_local (screen vision), smart_login /
manage_logins / keychain_lookup / onepassword_lookup / generate_totp (credentials + 2FA),
generate_image / make_figure / make_printable (image→STL) / studio_write (3D), simulate
(scipy/sympy/rdkit/mujoco/openmm/pyscf) / math_reason (smolagents), world_cup, news, play_chess,
manage_schedule (proactive/recurring), ambient (Calendar/Mail), project / delegate_project /
save_memory / notion_* (memory), subagent (persistent specialists), claude_code, self_improve /
self_fix / **self_heal** (self-modification), ask_ai, fetch_url, request_permissions, notify_user,
manage_jobs, write_agent_directive.
**Cloud tools** (`cloud/src/tools.js`): web_fetch, remember/recall, world_cup, news, ambient
(relay), media_control, system_control, run_shell/read_file/write_file/list_directory (relay),
call_person / text_person / brief_owner / ask_owner / contacts (Twilio), wake_mac, screen_observe,
project, play_chess, subagent.

## 5. Key subsystems (with file pointers)
- **Routing / agent loop** (`main.js`): `quickRoute` (zero-cost regex pre-router chat/action/unsure)
  → `fastReply` (tool-less streaming Haiku) | `runPipeline` (local Ollama, config.pipeline.enabled)
  | `agentLoop` (full Claude tool loop, streaming + per-task "mode"). `looksLikeToolTask` +
  `chooseModel` (Sonnet vs Haiku) gate routing. `validateHistory(capTokens(...))` repairs orphan
  tool_use/tool_result before every Claude call (prevents API 400). `lib/router.js` = learned
  telemetry-driven routing.
- **Voice / TTS** (`main.js` synthesizeSpeech/normalizeForSpeech/humanizeCadence + mirror in
  `cloud/src/voice.js`): ElevenLabs voice `nuIFNGEZkRGoYBg8iBYe`, strict (no rogue macOS `say`).
  `normalizeForSpeech` = audio-only text normalization (decimals→"point", abbreviations pts/GD/xG,
  emails/domains→"dot", currency, ranges→"to", symbols→words). Streaming TTS via `ttsStream*` +
  `makeSpeakStream` (speaks each sentence as it generates); **`tts-idle` MUST fire every turn or
  hands-free conversation wedges** (see [[invariant]] in code). `<speak>` tag = brevity override.
  Wake word + barge-in + 30s-silence session notes. Persona: JARVIS dry wit (STATIC_PROMPT IDENTITY).
- **Memory (3-tier):** (1) `lib/memory.js` markdown + `lib/semantic.js` embeddings (episodic vs
  semantic); (2) `lib/notion.js`/`cloud/notion.js` shared Notion bank (cross-surface, dedup,
  appendMemory/recall); (3) `lib/projects.js` per-project living auto-summary injected each turn.
  `reflectOnCorrection` learns preferences from user corrections.
- **Self-healing** (`lib/selfheal.js` + self_heal tool): **DISABLED by default**. When on, detects
  mistakes (repeated tool failures via audit clustering, user-flagged bugs, failing smoke/eval,
  runtime crashes) → fixes via `self_fix` (Claude Code, verify-gated, auto-revert), commits locally,
  **never pushes**. Rails: ≤3/day, 45m cooldown, clean-tree, frozen zones, idle-only, notified.
  `scripts/verify-syntax.js` = universal gate. See [[project_bhatbot_selfheal]].
- **World Cup 2026** (`lib/worldcup.js` + world_cup tool + viewer): live ESPN feed (no key),
  Elo+Poisson+Monte-Carlo. Actions: `open` (browser standings, ~0 tokens, default), `watch`
  (recommended match + insights + Google-News buzz), predict/group/odds. Token-cheap by design.
- **News** (`lib/news.js`): NYT RSS skim (no key) → `news` tool + the morning brief.
- **Morning brief** (cloud `BRIEF_PROMPT` + desktop `runBriefing`): reduced to 3 essentials —
  world news, important unread emails (native Mail via `ambient read`), one interesting overnight find.
- **Ambient awareness** (`lib/ambient.js`): on-demand `read` (mail/calendar, native Mail.app, no
  Gmail login) + opt-in background monitoring. Returns explicit "NOTHING TO REPORT" so the model
  can't fabricate. Privacy-redacted.
- **Scheduler** (`lib/scheduler.js`): proactive recurring/one-off tasks through the full agent.
- **Security / credentials** (`lib/security.js`, `lib/credentials.js`, `lib/logins.js`): safeStorage
  vault, CRED_REF handles (secret never reaches the model), TOTP, injection sanitizer, audit log
  (`lib/audit.js`), remote-destructive guard, autonomousMode auto-approve gates.
- **Testing/ops:** `scripts/bhatctl.js` (`npm run ctl` — drive the live agent from terminal),
  `scripts/smoke.js` (`npm run smoke` — single-tool e2e), `scripts/complex-eval.js` (`npm run eval`
  — multi-step/judgment, 6/6 green), `scripts/speak-punct-test.js` (audible TTS check),
  `scripts/verify-syntax.js`, console tee → `~/.bhatbot/logs/app.log` (`npm run logs`).

## 6. Recent updates

### 6a. JARVIS-parity upgrade — W1–W8 + cloud parity (→ `1110385`, 2026-06-22)
Plan: `.claude/plans/quirky-strolling-planet.md`. All on `main`, pushed. Verified live (smoke 4/4, complex-eval 8/8) + a 20-case deterministic suite (`npm run test:upgrade`).
- **W1 context-rot tool retrieval** (`lib/toolselect.js`): per-turn embedding top-k + CORE set; injects ~8–12 of 50 tools (confirmed live); full-catalog fallback. Cloud parity in `cloud/src/toolselect.js`.
- **W2 cost/energy telemetry**: every audit entry now carries `model/tin/tout/llmUsd`; costBlock shows per-model/per-tool split.
- **W3 key-risk gate** (`lib/risk.js`): per-tool auto|confirm|stepup; stepup forces a human for code-mod (self_fix/heal/improve, claude_code) + remote credential tools.
- **W4 knowledge graph** (`lib/graph.js`): entity/typed-edge JSON store, Haiku triple extraction on save_memory, 2-hop recall fold-in, `save_memory action:"query"`. Cloud parity in `cloud/src/graph.js`.
- **W5 fine-tune loop**: `npm run ft:export|ft:train|ft:eval` — trace→SFT/pref pairs → MLX LoRA on Qwen → A/B with GATED promote. Ran end-to-end on-device (val loss 4.32→1.22); gate correctly held a toy adapter.
- **W6 plugin sandbox** (`lib/sandbox.js`): worker_threads isolation (require allowlist, hard timeout, no ambient authority) + `plugin` tool for `config.plugins`.
- **W7 A2A envelope** (`lib/a2a.js`): Google-A2A-shaped subagent handoff (`subagent action:"handoff"/"a2a_log"`), local runner now + drop-in remote branch.
- **W8 research doc**: `BHATBOT_RESEARCH_IDEAS.md`/`.pdf` (Manus/Claude directions + retained hardware roadmap).
- **Voice speed**: defaults lowered (config 1.12→1.05, cloud TTS_SPEED→1.03); live "speak slower/faster" command; settings slider (`#spd` + `set-tts-speed` IPC).
- Cloud already had W2 (cost ledger) + a W3-equivalent (capability tiers). Cloud deployed to Fly.

### 6a-bis. Continual-learning unblock + eval-as-CI (2026-06-23)
- **Episodic capture fixed (root cause of W5 starvation).** Only `agentLoop.finish()` recorded
  episodes; `fastReply` (chat) + `pipeline-local` turns were dropped — 11 episodes in 2 days vs 609
  tool calls. Centralized in `_dispatchTurnInner` (`recordEpisode()`) so every reply path — desktop,
  remote/MCP, pipeline — records once. Verified live (chat turn now persists). This unblocks the
  whole fine-tune loop.
- **Real LoRA run on 3B.** `finetune.sh` default base lowered `Qwen2.5-7B-4bit → 3B-4bit`: the 7B
  build OOMed the Metal allocator on this 16 GB Mac (crashed at iter 80 when the app competed). 3B
  trains cleanly at ~2.6 GB peak (val loss → 1.49). `MLX_BASE` overrides for 32 GB+ boxes.
- **Eval-as-CI gate (roadmap §F).** `npm run verify` (verify-syntax + test:upgrade, no app) +
  `npm run verify:full` (adds smoke + eval). Tracked pre-push hook at `scripts/git-hooks/pre-push`
  (`core.hooksPath` set) blocks pushes on red; bypass `--no-verify`.
- **`AMBITIOUS_ROADMAP.md`** added: prioritized larger efforts (A close learning loop, B decompose
  main.js, C proactive layer, D unified recall, E desktop↔cloud convergence, F done, G vision loop,
  H multi-sport).

### 6b. Prior session (757dabc → 28040fc)
1. **Hands-free voice/re-arm fix** (`757dabc`): `tts-idle` now guaranteed every turn → mic always
   re-arms; renderer speaks if main produced no audio; conversation stays open until an explicit
   stop phrase ("I'm satisfied / done with the project").
2. **Voice clone + concise prompt + faithful email + World Cup watch + NYT brief** (`e9a0f66`):
   voice `nuIFNGEZkRGoYBg8iBYe`; brevity directive; `world_cup watch`; native-Mail email read
   (fixed a real AppleScript bug + a hallucination where it invented a fake inbox); `npm run eval`.
3. **self_heal** (`a500f95`): autonomous verify-gated self-fixing loop, disabled by default.
4. **JARVIS persona + speech-punctuation/cadence** (`28040fc`): explicit dry-wit character;
   decimals→"point", pts/GD/xG expanded, ranges→"to"; removed double sentence-pause; speed
   1.06→1.10/1.12, style→0.40. Verified aloud + live ("A bold choice, sir. We'll see how it goes.").

## 7. Known issues / constraints
- **Tier-1 Anthropic rate limit (50k tok/min)** is the dominant latency cost — multi-tool turns
  pace ~2 min each. Raising to tier 2 is the single biggest UX win (user is on it).
- **`main.js` is ~6.6k lines** — split in progress (`SPLIT_PLAN.md`, task #11); pure/audit/shell
  already extracted. Big monolith = the main maintainability risk.
- **Self-edits to `main.js` only load on restart**; self_heal's verify always includes syntax check.
- One **silent app exit** observed 2026-06-22 right after ElevenLabs 500s + rapid restarts; treated
  as an EL transient (app stable since on same code) — watch for recurrence.
- Email-in-brief needs the Mac awake (relay). Cloud TTS strict-EL: if EL quota/5xx, phone can go
  silent (desktop has Kokoro fallback).

## 8. Config / capability toggles (`~/.bhatbot/config.json`)
`pipeline.enabled` (local Ollama), `fastChat`, `autonomousMode`, `selfHeal.enabled` (+ triggers,
maxPerDay, frozen), `ambient.enabled/sources`, `ttsSpeed/ttsStyle/ttsVoice`, `briefingHour`,
`reflection`, `remoteAllowDestructive`. Secrets (keys, mcpToken, notion ids) live ONLY here / Fly
secrets — never in memory files or prompts.

## 9. Next steps (proposed, prioritized)
_The larger arc lives in `AMBITIOUS_ROADMAP.md` (A–H). Near-term:_
1. **Let episodic data accrue → real W5 promote** (roadmap §A). Capture is now fixed, so every turn
   feeds the loop; re-run `ft:export → ft:train → ft:eval` once `stats.json` shows sftPairs ≥ 150 /
   prefPairs ≥ 20. Add a scheduled idle-time train/eval (A2) and DPO over prefs (A3). The 3B
   toolchain is proven end-to-end (val loss → 1.49); the gate auto-holds until an adapter wins.
2. **Decompose `main.js`** (roadmap §B, task #11, ~6.7k lines) — extract agent-core, tool registry,
   server, voice. Do one extraction per commit; `npm run verify` between each. Unblocks §E.
3. **Proactive layer** (roadmap §C) — idle-time initiative engine, rate-limited + outcome-learning.
4. **Enable + shake down `self_heal`** (built, off) with `maxPerDay:1`; safer behind W6 sandbox + W3
   stepup. Watch Telegram a week, then loosen.
5. **Raise Anthropic tier / pacing** — still the #1 felt-latency cost on multi-tool turns.
6. **W1 retrieval validated** (2026-06-23): 40 turns, median 9 tools, **0 fallback misses** — k is
   well-tuned; no change needed (revisit only if misses appear).
7. **Multi-sport generalization** (calendar reminder 2026-06-28): world_cup → sport+league registry.
8. **Hardware tier** (research doc Part 2, deferred): Mac Mini M4 always-on node.

_For deeper history: `ARCHITECTURE.md`, `BHATBOT_DOSSIER.md`, `SPLIT_PLAN.md`, `PERF-EVAL.md`,
`WORLDCUP_ITERATION_LOG.md`, and the dated commit log._

---

## 10. Autonomy model update (2026-07-01, branch `jarvis-sprint`)

Siddhant's revised self-improvement permission model — **"approve when it starts, then run free on
what it actually affects, except ban self-degradation and report it to me."** Implemented in the pure
governor (`lib/selfdrive.js`) + firewall (`lib/risk.js`), verify-tested (`scripts/test-selfdrive.js`,
39 assertions).

- **Approve at start (universal).** Every session — manual, reflection-sanctioned, or capability-gap
  — now needs an explicit go-ahead. Manual `self_drive start` carries approval (it's a step-up tool;
  the confirm card *is* the approval). Auto-triggers no longer auto-start: they stage a proposal and
  ask; a plain **"go ahead"** launches it (`_pendingSelfDrive` in `main.js`). Reflection-implies-
  consent auto-start was removed.
- **Run free once approved.** `selfDrive.freeRun` (default **true**) swaps the tight caps
  (`maxCyclesPerSession 5`, combined `dailyCap 3`) for `freeRunMaxCycles 25` / `freeRunDailyCap 25`
  via `effectiveCaps()`, and shortens the inter-cycle cooldown, so an approved session works through
  the whole actionable backlog instead of a token number of cycles.
- **Self-degradation banned (the one hard block that survives approval).** Unified in
  `risk.isSelfDegrading(files, text)` = frozen-zone edit **or** guardrail-weakening intent. The
  behavioral half is the existing verify-or-revert: a change that breaks the suite is degradation and
  gets reverted. Frozen zone unchanged (its own governor, risk.js, selfheal, security, credentials,
  admission, verify scripts). Never automated, any channel.
- **Reported.** Every block/revert is tagged (`self_degradation` | `verify_fail` | `frozen_breach`),
  collected into `session.degradation_attempts`, surfaced in the end-of-session notify and in
  `selfdrive.status().lastSession`.

**New config keys:** `selfDrive.requireStartApproval` (default true), `selfDrive.freeRun` (default
true), `selfDrive.freeRunMaxCycles` (25), `selfDrive.freeRunDailyCap` (25). Still **never pushes**;
still commits to a local `self-drive-*` branch for human merge.

_NOT done from the sprint prompt (deferred): T1–T4 voice ws transport/planner/ack library, T5–T7
blackboard/DAG/fan-out, T8–T9 goal queue + Manage cards, T10 zen UI._

---

## 11. Drone fleet & FORGE foundations (2026-07-02, branch `forge-sprint`, NOT pushed)

Foundational layer for the FORGE sprint (drones, repo autopilot, swarms). Feature phases
(repoauto, swarm, visual, sim, research, style, voice/UI) are DEFERRED — see
`FORGE_SPRINT_REPORT.md`. All verify-gated (49 new assertions).

- **Shared blackboard** (`lib/blackboard.js`, T5) — per-workspace append-only JSONL + tail
  cache: `post/read/fleetStatusBlock/claim/isClaimed/heartbeat`. `lib/agents/base.js` injects
  `fleetStatusBlock()` into every agent (optional `adapters.board`) and posts results as
  findings so live siblings see them. Test: `scripts/test-blackboard.js`.
- **DAG orchestrator** (`lib/agents/orchestrator.js`, T6) — tasks gain `needs:[]`; ready-set
  scheduling; a dead dependency blocks dependents with a reason (independent branches keep
  running; only `needs_input` pauses the run); dependency summaries injected into the
  dependent's context. Planner prompt (`lib/agents/roles/index.js`) emits ids+needs. New DI
  seams `planFn`/`runAgentFn` on `orchestrator.run` for headless tests.
  Test: `scripts/test-orchestrator-dag.js`.
- **Untrusted-code wall** (`lib/sandboxexec.js`) — THE safety floor: `scrubEnv` allow-lists
  PATH+locale+throwaway HOME only (secrets excluded by construction, no keychain/dotfiles);
  `run()` execs under it, layering macOS `sandbox-exec` network-deny when network isn't
  allowed. Canary test proves a real parent-env secret is invisible inside. Phase 2/3
  install/test/run lanes MUST route through this. Test: `scripts/test-sandboxexec.js`.
- **Drone runtime + fleet** (`lib/drone.js`, `lib/fleet.js`, D1) — `createDrone(spec,deps)`:
  scoped BhatBot instance (persona, strict tool subset via `scopeTools`, own wsDir, budget,
  board handle, identity prompt). `runFleet(specs,deps,opts)`: admission-gated launch
  (budget-derived width), envelope wallet (`envelopeUsd`), hard cap (`hardCap`), cooperative
  stall reaping (silent drone → one board nudge → `partial` reaped envelope). In-process
  DI-driven; hermetic/generated code routes through the untrusted-code wall.
  Test: `scripts/test-fleet.js`.

**New npm test scripts:** `test:blackboard`, `test:dag`, `test:sandbox`, `test:fleet` (all
in `verify`). **No new external deps required** for the foundation (Docker/Blender/idb come
with the deferred feature phases). **Still never pushes; branch `forge-sprint` off
`jarvis-sprint`.**

## 12. UX Sprint (2026-07-02, merged to `main`, pushed, cloud deployed)
Voice turn-taking, rate stability, learned spoken length, file transfer, phone redesign.
- **Rate:** live `anthropic-ratelimit-*` headers drive `rateBudget` (`lib/rate.js`); drones forced to
  Sonnet (never Opus OTPM); `sealDanglingToolUse` un-orphans interrupted tool_use at the source.
- **Voice:** adaptive+learned endpointing (`lib/endpoint.js`) + Web-Audio user-speech VAD gate + phone
  parity (`lib/voicestream`); voiceid cocktail-party post-filter (`config.voice.verifyUser`).
- **Learned spoken length:** `lib/spokenmodel.js` (density→word-count, barge-in censored) + the
  `spoken.jsonl` feedback loop; metric `L = interrupt_rate + λ·underinform_rate`.
- **Files:** drag ANY file anywhere → persists in view (thumbnails by the orb), voice+text, PDF/CSV
  ingested (`lib/attach.js`).
- **Phone:** clean-geometry CSS redesign across all 3 `mobile.html` copies.
- **New config keys:** `rateLimitLiveFrac` (0.95), `vad.floorMargin` (1.8), `voice.verifyUser` (false),
  `spokenLambda` (1.0). **New artifacts (gitignored):** `spoken.jsonl`, `spoken-model.json`,
  `endpoint.json`.
- **New tests in `verify`:** `test:ratelive`, `test:abort-pairing`, `test:attach`, `test:endpoint`,
  `test:endpointint`, `test:spoken`, `test:spokenfb` (38 suites total).
- **Deferred:** T4 streaming-digest mode. **Pending user:** phone token/key sync (`BHATBOT_TOKEN` /
  `ANTHROPIC_API_KEY` Fly secrets — raw values are vaulted).

## 13. JARVIS upgrade — voice/latency + zen UI + fleet coordination (2026-07-04, branch `jarvis-upgrade-20260704`)
Speech quality + latency, JARVIS-minimalist UI, and parallel-agent coordination. Verify-green
(40 suites). **Restart the desktop app to load.**
- **T2 speech planner** (`lib/pure.classifySpeech`): `makeSpeakStream` now decides READ-verbatim
  (short prose) vs SUMMARIZE (long / code / list / table / headers / multi-paragraph / URL-dense).
  Digest mode calls `summarizeForSpeech(fullText)` and speaks the digest; screen still shows all.
  Reserves the drain→`tts-idle` contract synchronously (hands-free never wedges); floors to the
  first sentence if summarize fails. `<speak>` prompt rule strengthened.
- **T3 cadence**: `humanizeCadence` ellipsis→plain comma (was a dragging pause), dropped the
  discourse double-beat, `<break>` cap 6→3. `jarvisVoiceSettings` defaults stability 0.45→0.38,
  speed 1.0→1.04. Stream-safe `createSpeechNormalizer` (never splits a URL/decimal token).
- **T1 ws streaming TTS** (`lib/ttsws.js`): ONE ElevenLabs `stream-input` websocket per turn →
  ONE persistent `ffplay`/`sox` PCM player via stdin — no per-sentence REST POST / tmp-file /
  afplay respawn (the inter-sentence latency). **Config-gated `ttsTransport: 'rest'|'ws'` (default
  `rest`)**; flip to `ws` to enable (needs `ffmpeg`/ffplay — present on this Mac). Barge-in kills
  ws+player; `tts-idle` preserved; acks stream through ws.
- **T10 zen UI** (`src/index.html`): **`config.uiTheme: 'zen'(default) | 'hud'`**. Zen = additive
  `body.zen` theme (hud stays pixel-identical): no scanlines/corner-brackets/glitch, near-black flat,
  ONE desaturated accent, hairline borders, system type, calmer orb. Voice stage is home: reactive
  orb + 12px status word + ephemeral fading captions + quiet `now: <tool>` line. Summonable input
  (any key / ⌘K reveals #ta, Esc/send hides). ⌘⇧U toggles theme. Screenshot-verified via Playwright.
  Also fixed a duplicate `const MAX_UTTER_MS` (renamed the Web-Speech one) — a real parse error.
- **T7 fleet coordination**: dynamic-role parallel fan-out (`agent_team` ensemble) + independent app
  tester (`agent_team test_app`, SENTINEL) already shipped in `lib/orchestrator.js` — now they share
  a **blackboard** per batch (`runRole` folds `fleetStatusBlock()` into each turn + posts status/
  findings), so siblings coordinate DURING the run. Fixed a latent `haiku`-role → `model:undefined`
  bug in `subagentDeps` (Haiku retired → maps to Sonnet).
- **New config keys:** `ttsTransport` ('rest'), `uiTheme` ('zen'). Surfaced in `get-voice-config`.
- **New tests in `verify`:** `test:speechplanner`, `test:ttsws`, `test:orchboard` (40 suites total).
