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
1. **Real W5 LoRA run once traces accrue** — exporter shows only ~6 SFT pairs today; the pipeline is
   proven (toolchain ran end-to-end) but needs ~200+ pairs for a promotable adapter. Re-run
   `ft:export → ft:train → ft:eval` after more usage; the gate auto-holds until it wins.
2. **Enable + shake down `self_heal`** (built, off) with `maxPerDay:1`; now safer behind the W6
   sandbox + W3 stepup gate. Watch Telegram for a week, then loosen.
3. **Raise Anthropic tier / pacing** — still the #1 felt-latency cost on multi-tool turns.
4. **Finish the `main.js` split** (#11, `SPLIT_PLAN.md`) — extract the tool-dispatch cluster + voice;
   reduces the monolith risk (now ~6.7k lines + the new W1–W7 hooks).
5. **Tune W1 retrieval `k`/minScore from data** — log shows 8–13 tools/turn; derive the optimal cap
   empirically (see research doc §3) rather than the hand-set 12/0.18.
6. **Multi-sport generalization** (calendar reminder 2026-06-28): world_cup → sport+league registry.
7. **Hardware tier** (research doc Part 2, deferred): Mac Mini M4 always-on node is the highest-
   leverage purchase once the software foundation is exercised in daily use.

_For deeper history: `ARCHITECTURE.md`, `BHATBOT_DOSSIER.md`, `SPLIT_PLAN.md`, `PERF-EVAL.md`,
`WORLDCUP_ITERATION_LOG.md`, and the dated commit log._
