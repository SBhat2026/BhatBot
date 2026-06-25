# BhatBot — JARVIS v2 Roadmap (2026-06-24)

User's 8 asks, mapped to concrete workstreams, grounded in current code. Ordered by leverage/dependency, not by the list order. Forks + user-owned actions flagged.

Legend: ⬜ todo · 🔒 user action (mine = noted) · ⚡ quick win · 🏗 big build

---

## Cluster A — Quick wins (ship first, ~1 day total)

### A1 ⚡ Voice → closer to JARVIS  (item 1, 8) — ~15 min + iterate
- Tune ElevenLabs params in `synthesizeUlaw` / `speakDesktop` toward Bettany/JARVIS cadence. Memory [[project_bhatbot_voice]] has A/B: stability .40 / similarity .90 / style .20. Push toward drier, more clipped delivery; test speed (`config.ttsSpeed`).
- Real tuning is interactive — I set improved defaults, you A/B live.
- **Files:** main.js (`synthesizeUlaw`, `speakDesktop` voice_settings), config defaults.

### A2 ⚡ HUD improvement  (item 1, 6) — ~half day
- `.hud-ring` arc-reactor exists (src/index.html:60). Make it a STATE-REACTIVE reactor: idle pulse / listening waveform / speaking ripple / thinking spin — driven by existing voice+agent IPC states.
- Ambient status glyphs in `#statusbar`; richer `#activity-list` stream (tool icons, timing, cost from W2 telemetry).
- Feeds from A5 style doc (AoU phrasing/visual language).
- **Files:** src/index.html (CSS + state hooks), main.js IPC (already emits state).

### A3 ⚡ Response-length categorization  (item 3) — ~half day
- `max_tokens` is hardcoded **4096** (main.js:1221, 1305). No depth control.
- Add `classifyDepth(userText)` → {ack | conversational | detailed | deep} → maps to dynamic `max_tokens` (256 / 1024 / 4096 / 8192) + a brevity directive injected into system. Cheap: heuristic first (length, question words, "explain/why/plan" triggers), Haiku fallback only when ambiguous.
- Reinforces existing "spoken brief / screen detail" prompt rule (main.js:424).
- **Files:** new `lib/depth.js`; main.js (`callClaude`/`callClaudeStream` max_tokens + system suffix, turn-scoped).

---

## Cluster B — Planning / model+tool meta-layer (clusters items 2,4,5)

### B1 🏗 Thinking capability + planning  (item 4) — ~2 days
- Enable Claude **extended thinking** (thinking blocks) for `deep` turns from A3; budget tied to depth class.
- Build a real **planner pass**: complex turn → explicit plan → execute → reflect. Reuse existing brief-on-screen-plan rule.
- **Read papers (mine):** WebSearch + distill 2–3 recent LLM planning/reasoning papers (ReAct, Reflexion/self-refine, Tree/Graph-of-Thought, plan-and-solve) → concrete prompt+arch changes. Deliver a short distilled note, not a lit review.
- **Files:** main.js (thinking param plumb, planner step in `agentLoop`); note → `docs/`.

### B2 🏗 Better model + tool handling  (item 5) — ~1.5 days
- Unify into a per-turn **meta-controller**: choose model (router.js) + tool subset (toolselect.js, already shipped) + thinking budget (B1) + max_tokens (A3) together, once per turn.
- Improve `lib/router.js` model selection per task class; surface why a model/tool set was chosen (telemetry).
- **Files:** main.js (agentLoop turn setup), lib/router.js, lib/toolselect.js.

### B3 Context-limit handling  (item 2)
- 🔒 **Reaching Anthropic Tier 2 = your billing action** (not mine).
- Mine: research how big-context models handle it (Gemini ~2M, GPT context) → **auto-escalate to a large-context model when near limit** via router; plus tighten compaction. A3 (output) + toolselect (input, done) already cut token pressure.
- **Files:** main.js (context-pressure guard → router big-context branch), short research note.

---

## Cluster C — Multi-agent (item 7) — ~3 days 🏗 HIGHEST CEILING

### C1 Parallel same-task, dynamic roles
- Today `lib/subagents.js` = 3 FIXED roles, run sequentially. Build a **fan-out orchestrator**: one task → N sub-agents with DYNAMICALLY-assigned roles (e.g. "skeptic", "implementer", "reviewer"), run **concurrently** (Promise.all), then merge/vote/synthesize.
- Reuse `lib/a2a.js` envelope (already built) for each handoff; persist to a2a.jsonl.
- **Files:** new `lib/orchestrator.js`; extend lib/subagents.js (dynamic role spec); main.js subagent tool gains `mode:"parallel"` + role list.

### C2 Independent app/site tester agent
- A QA sub-agent that drives a site/app **independently** like a real user — reuse `tools/vision.js` (`screen_parse`/`vision_click`) + `browser` to navigate, probe, and report bugs without scripted steps.
- New `tester` role in subagents allowlist (browser + vision + read/notify).
- **Files:** lib/subagents.js (tester role), wire C1 orchestrator to spawn it.

---

## Cluster D — Voice customizability (item 8) — ~1 day

### D1 Voice param UI + sample import
- Config + small settings flow: live-tune stability/similarity/style/speed; **import audio samples** → ElevenLabs voice add / IVC to build-improve the JARVIS (Bettany) clone. Memory [[project_bhatbot_voice]] has the real-clone path.
- 🔒 **Fork:** you may prefer to keep fine-tuning the clone directly in ElevenLabs — so I build the param customizability + a sample-push helper, and leave the actual clone iteration to you in EL if you choose.
- **Files:** src/index.html (voice settings panel), main.js (EL voice-add helper), config.

---

## User-owned / supporting

- 🔒 **Tier 2 spend** (item 2) — your billing decision.
- 🔒 **Rewatch Age of Ultron** (item 6) — yours. Mine: **A5 — draft `docs/JARVIS_STYLE.md`** now (phrasing, dry wit, visual gimmicks, voice register) from knowledge; you refine after rewatch. Feeds A1/A2/D1.
- 🔒 **ElevenLabs manual clone tuning** (item 8 alt) — yours if you pick that fork.

---

## Suggested execution order
1. A5 style doc (cheap, informs A1/A2/D1)
2. A1 voice tune → A3 response-length → A2 HUD  (Cluster A quick wins)
3. B1 thinking+papers → B2 meta-controller → B3 context guard
4. C1 parallel orchestrator → C2 tester agent
5. D1 voice customizability

Standing rails: ElevenLabs-only voice · secrets only in config.json/Fly · commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` · push + restart app + `npm run smoke` each pass · one risky extraction per commit.
