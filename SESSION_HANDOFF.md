# BhatBot — Session Handoff (last 3 working sessions)

_Written 2026-07-02. All work below is on `main`, pushed to `github.com/SBhat2026/BhatBot`, verify-green (29 test suites). **Restart the desktop app to load** — every change here is in `main.js` / `lib/*` / `src/index.html` / `preload.js`._

---

## Session 1 — FORGE foundations + first-wave integrations + visual/design
Commits: `41d0297`, `532affc`, `64d1d80`, `08cc88a`, `f2048ca`, `8ec5702`, `f77f23a`

- **Drone fleet runtime**: `lib/drone.js` + `lib/fleet.js` (admission-gated launch, envelope wallet, stall reaping) + `lib/blackboard.js` (shared cross-agent state). `deploy_drones` tool wired into the agent loop.
- **Untrusted-code wall**: `lib/sandboxexec.js` (allow-list env scrub, throwaway HOME, macOS sandbox-exec network-deny). Non-negotiable: cloned/generated code never runs with BhatBot's env/secrets.
- **First-wave external integrations** (`lib/integrations/`): `docker.js` (daemon probe + containerized run), `simctl.js` (native iOS — Xcode present), `scholar.js` (arXiv keyless + Semantic Scholar + dedupe). `find_papers` tool.
- **Proactive visual aids** directive + **UI/UX Pro Max skill** installed globally (`~/.claude/skills/`) + distilled `docs/DESIGN_TASTE.md` into the UI-gen prompt.
- Explained the **ORACLE/ECHO** stage (plan + adversarial review, step 3 of self-drive) to the user.

## Session 2 — scientific-compute pack + docker lane + UX check
Commit: `f48532e`

- **`lib/scicompute.js` + `sci_compute` tool**: quant/numerics/stats/MPS-torch compute pack in its OWN venv (`~/.bhatbot/scicompute-venv`, separate from sim-venv). Preloaded quant helpers (`returns/sharpe/black_scholes/mc_gbm/var_cvar`), `mpmath` precision, `solve_ode`, `DEVICE=mps`. Setup: `scripts/scicompute-setup.sh` (tiered, continue-on-failure). **Install was kicked off in the background** — check `~/.bhatbot/scicompute-setup.log`; until it finishes `sci_compute` returns a graceful install hint.
- **`container_run` tool**: Docker isolation lane over the wall (no inherited env/secrets; network OFF by default for generated code).
- Verified the **speech pipeline** (`lib/speech.js` + `normalizeForSpeech`) strips markdown/code/URLs/paths, expands symbols/currency/decimals, humanizes cadence.

## Session 3 — agent-loop bug fix → Opus tier → Opus gate + adaptive voice
Commits: `645b239`, `eec924e`, `5a350ef`

### 3a. Fixed the "task never started" wedge (`645b239`)
Root-caused from a screenshot where a DNA-sim request died with `× simulate {}` loops then an **API 400 (`tool_use ids without tool_result`)**:
- **Folded `validateHistory` into `capTokens`** — the single trim chokepoint — so every wire path (fast-reply stream, tool-less stream, pipeline `anthropicTools`, pacing re-entry) is pairing-safe. Root fix for the recurring 400 that wedged a new turn after an interrupted/"Stopped" one.
- **Complex-tool → Sonnet routing** (`looksComplexTool` gate in `callModel`): a plain-worded but genuinely hard tool task no longer falls to Haiku (which fumbled empty `simulate {}` calls).
- **Empty code-tool guard** in `runOneTool`: `simulate`/`sci_compute` called with no `code` → crisp corrective result, no wasted spawn.

### 3b. Opus tier + auto-fleet for heavy tasks (`eec924e`)
- **Three routing tiers** in `callModel`: Haiku (trivial) → Sonnet (`looksComplexTool`) → **Opus (`looksHeavyTool`** — scientific sims / deep coding+interpretation; strict subset of complex).
- **Heavy → parallel fleet**: `HEAVY_FLEET_DIRECTIVE` injected (stateless, keyed off the user ask) in `systemBlocks` + a static-prompt rule → decompose into RESEARCH + DESIGN + CODE + TEST lanes via `plan_and_run`/`deploy_drones`, drones on Sonnet, Opus plans + interprets.
- Config: `allowOpusHeavy`, `heavyToolModel`, `complexToolModel`.

### 3c. Opus permission gate + adaptive endpointing (`5a350ef`)
- **Opus permission gate** (per user request — ask before switching, keep Opus enabled): dispatch layer detects a heavy task, ASKS ("use opus" / "stay on sonnet"), parks the turn in `_pendingOpusTask`; approval sets session flag `_opusApproved` + re-runs on Opus, decline re-runs on Sonnet. `callModel` only upgrades when approved (or `opusRequiresApproval=false`, default true).
- **Adaptive, learned voice endpointing**: `lib/endpoint.js` (pure engine, 15 tests) learns the user's mid-utterance pause distribution and holds the mic a margin past their p90 pause (floor 1200 / ceil 6000ms) so a thinking-pause never sends early. Persisted `~/.bhatbot/endpoint.json`; IPC `endpoint-threshold`/`endpoint-observe`; renderer (`src/index.html`) replaced the fixed 2000ms with the learned value + pause-learning + 45s safety cap. `shouldEnd()` is a cocktail-party gate keyed to the user's own speech.

---

## Open threads / next steps for Claude to pick up

1. **Cocktail-party gate is only scaffolded.** `lib/endpoint.js shouldEnd({userSpeaking})` supports speaker-gated endpointing, but the renderer has no real-time speaker-ID signal yet (Web Speech API exposes no audio stream; `lib/voiceid.js` is a slow python venv). **Next:** add a parallel Web Audio `AnalyserNode` for a near-field energy signal, and/or a `voiceid`-based post-capture filter (config-gated) that discards a finalized clip if it isn't the enrolled user. Feed `userSpeaking`/user-attributed silence into `shouldEnd`.
2. **Phone endpointing not wired to the engine.** `lib/voicestream.js` still uses a fixed `SILENCE_END_MS=700`. Wire it to `createEndpointer().threshold()` for parity (it's pure Node — easy + testable).
3. **scicompute-venv install** — confirm `~/.bhatbot/scicompute-setup.log` finished cleanly and `sci_compute action:"capabilities"` lists torch (MPS true) + QuantLib/statsmodels/arch. QuantLib can fail to build on some macs (continue-on-failure by design).
4. **Opus gate UX** — user said "later I'll find a way to get that working better." Currently session-level approval + a natural-language ask. Candidate upgrades: a per-task confirm card (like the self-drive step-up gate), an "always use Opus for sims" preference, or a cost-estimate line in the ask.
5. **Second/third integration waves (deferred by decision).** Next after sci-compute: native-iOS swarm consuming `simctl`, then **Blender + design-taste loop** last (with the user's 📸 visual-aid handoffs). See `docs/EXTERNAL_INTEGRATIONS_PLAN.md §DECISIONS`.
6. **Verify discipline**: `npm run verify` runs 29 suites. Every new module gets its own `scripts/test-*.js` wired into the `verify` chain. Never push red (there's a pre-push verify hook).

## Guardrails to respect (unchanged, do not weaken)
- Frozen zone / `lib/risk.js` / verify-or-revert / the untrusted-code wall are untouchable.
- Self-drive never pushes; runs on an isolated local branch; auto-reverts self-degrading changes.
- ElevenLabs is the only voice; all speech via `speakDesktop`.
