# BhatBot — Ambitious Roadmap (post W1–W8)

_Drafted 2026-06-23. The JARVIS-parity plan (W1–W8) is shipped, verified, and cloud-mirrored.
These are the larger, higher-ceiling efforts that come next — each is multi-day, touches several
subsystems, and changes what BhatBot fundamentally *is* (not just adds a tool)._

Status legend: ⬜ not started · 🔄 in progress · ✅ done · ⏸ deferred

---

## A. Close the continual-learning loop for real  🔄  ·  HIGHEST CEILING
The W5 toolchain works end-to-end (export → MLX LoRA → A/B → gated promote) but has **never
promoted** — it was starved of data. Root cause found + fixed 2026-06-23: only `agentLoop.finish()`
recorded episodes; `fastReply` and `pipeline-local` turns (the bulk of conversation) were dropped.
Now centralized in `_dispatchTurnInner` → every turn is captured.

_2026-06-23 run: trained a real 3B LoRA (Qwen2.5-3B-4bit, val loss → 1.49) and ran the gated A/B —
candidate 14% win-rate vs baseline qwen3 (gate HELD, config untouched), correct for an 8-example
over-fit adapter. Pipeline proven on a real 3B base. Notable: 3B-MLX candidate averaged 1.6s/turn
vs qwen3's 42.6s (26× faster) — the latency prize once a real adapter wins on accrued data._

- ⬜ **A1 — Data accrual to threshold.** Let episodes climb past ~200 SFT pairs + real preference
  pairs (corrections are now captured with error strings in audit too). Track via `npm run ft:export`
  `stats.json`. _Gate: don't do a "real" promote run until prefPairs ≥ 20 and sftPairs ≥ 150._
- 🔄 **A2 — Scheduled offline export+train+eval.** ✅ `npm run ft:cycle` (`scripts/ft-cycle.js`)
  does export → **threshold guard** → train → serve → gated A/B → stop server in one command; the
  guard cheaply no-ops until `sftPairs ≥ 150` (override `--force`/`--min-sft`). _Remaining: register
  a nightly `manage_schedule` job that calls it, gated on idle + no RAM pressure._
- ⬜ **A3 — DPO on preference pairs.** Today finetune.sh does SFT only. Add a DPO pass over
  `prefs.jsonl` once enough correction pairs exist — that's where the corrected-behavior signal lives.
- ⬜ **A4 — Promotion telemetry surfaced.** Show the active local model + last A/B win-rate in the
  cost/telemetry block and the settings UI so promotions are visible, not silent.
- **Acceptance:** one genuine gated promotion of an adapter that beats baseline qwen on the eval
  suite, with no regression, fully on-device.

## B. Decompose main.js (the 6.7k-line monolith)  🔄  (#11)
Single biggest maintainability + Claude-Code-classifier risk. The audit module split (#22) proved the
factory-injection pattern works.

- ⬜ **B1 — Extract the agent loop** (`agentLoop`/`runPipeline`/`fastReply`/`dispatchTurn`) into
  `lib/agent-core.js` via dependency injection (same factory style as `lib/audit.js`).
- ⬜ **B2 — Extract the tool registry + `executeTool`** into `lib/tools/` (one file per tool group;
  `executeTool` becomes a dispatcher over a registry).
- ⬜ **B3 — Extract the Express/MCP server + IPC wiring** into `lib/server.js`.
- ⬜ **B4 — Extract voice/TTS** (`speakDesktop`, speak-stream, `maybeAdjustSpeed`) into `lib/voice.js`.
- **Acceptance:** main.js < 2k lines (orchestration only); smoke + eval + test:upgrade all green
  after each extraction; no behavior change.
- **Risk:** high blast radius — do one extraction per commit, restart+smoke between each.

## C. Proactive / anticipatory layer  ⬜
Today BhatBot is reactive (and the morning brief is the one proactive surface). A real JARVIS
initiates.

- ⬜ **C1 — Initiative engine**: a periodic (idle-time) pass that scans calendar, unread important
  mail, open projects, and pending follow-ups, then decides whether anything is worth surfacing —
  gated by a confidence threshold and a "don't nag" rate limit.
- ⬜ **C2 — Notification budget + quiet hours**: never more than N proactive pings/day; respect a
  configurable quiet window; everything opt-in per category.
- ⬜ **C3 — Outcome learning**: track whether a proactive ping was acted on / dismissed; feed that
  back so low-value categories self-suppress.
- **Acceptance:** BhatBot surfaces a genuinely useful unprompted item (e.g. "two meetings overlap
  at 2pm") without being asked, and stays quiet when there's nothing worth saying.
- **Risk:** annoyance / trust erosion — the rate limit + outcome learning are not optional.

## D. Unified retrieval planner  ⬜
Three memory tiers (embeddings/episodic, knowledge graph W4, Notion) are queried independently. A
planner should reason over all three and pick a strategy per question.

- ⬜ **D1 — One `recall()` entry** that classifies the query (factual / relational / temporal /
  project) and dispatches to embeddings, graph BFS, or Notion accordingly — or fuses them.
- ⬜ **D2 — Multi-hop fusion**: combine graph traversal with embedding rerank so "what does the
  project I started last Tuesday use" resolves across temporal + relational + semantic tiers.
- ⬜ **D3 — Provenance in answers**: cite which tier/edge produced a recalled fact.
- **Acceptance:** a 2-hop temporal+relational question that flat embedding search misses today
  returns the correct chained answer.

## E. Desktop ↔ cloud core convergence  ⬜
Two agent loops (`main.js` desktop, `cloud/src/agent.js`) have drifted; every feature is built twice
(W1/W4 parity took a second pass). Painful and bug-prone.

- ⬜ **E1 — Extract a shared `agent-core` module** both runtimes import (depends on B1), with
  runtime-specific adapters for storage (JSON files vs better-sqlite3) and tools.
- ⬜ **E2 — Single tool-schema source of truth** consumed by both, so a new tool lands in both
  planes at once.
- **Acceptance:** add a trivial new tool once and have it appear on desktop + cloud with no second
  implementation.
- **Risk:** large; only attempt after B (decomposition) lands.

## F. Eval-as-CI regression gate  ✅ (core) / 🔄 (F3 refinement)
The verification suite (verify-syntax + smoke + eval + test:upgrade) was run by hand. Now gated.

- ✅ **F1 — `npm run verify`** (verify-syntax + test:upgrade, no app needed) + `npm run verify:full`
  (adds smoke + eval, needs running app). Both exit non-zero on any failure.
- ✅ **F2 — pre-push hook** at `scripts/git-hooks/pre-push` (tracked; `core.hooksPath` set) runs
  `npm run verify` and blocks the push on red. Bypass: `git push --no-verify`.
- 🔄 **F3 — Eval trend log**: pass-rate already appended to `EVAL_LOG.md` per run; smoke to
  `SMOKE_LOG.md`. _Remaining: also record token-cost/turn per run for quality-drift visibility._
- **Acceptance:** ✅ a deliberately-broken edit fails `npm run verify` → push blocked.

## G. Vision-driven UI automation loop  ⬜
OmniParser is set up locally but only used ad hoc. Close the loop: observe screen → plan → act →
verify visually → retry.

- ⬜ **G1 — Perceive→act→verify cycle** using existing `screen_observe` + vision verification (#14)
  + OmniParser element detection.
- ⬜ **G2 — Self-correcting clicks**: if the post-action screenshot doesn't match the expected state,
  re-plan instead of blindly proceeding.
- **Acceptance:** completes a multi-step GUI task (e.g. change a System Setting) end-to-end with
  visual confirmation at each step.
- **Risk:** OmniParser caption step is slow on this hardware; needs a latency budget.

## H. Multi-sport generalization  ⬜
`world_cup` is bespoke. Generalize to a sports engine (NBA/NFL/F1) sharing the Elo + Monte-Carlo +
ESPN-no-key core. _(Calendar reminder already set for 2026-06-28.)_

---

## ⏸ Deferred (out of current software scope — tracked in BHATBOT_RESEARCH_IDEAS.md)
- Hardware tier: Mac Mini M4 always-on node, ESP32 wake-word satellites, Home Assistant bridge,
  Apple Watch glance app, smart glasses.

---

## Recommended sequence
1. **A1** (passive — just let data accrue; check weekly) runs in the background of everything else.
2. **F** (eval-as-CI) — cheap, makes every later change safer. Do first.
3. **B** (decompose main.js) — unblocks E and reduces classifier risk. Do incrementally.
4. **C** (proactive layer) — highest user-visible value once the foundation is safe.
5. **D** (unified recall), then **A2/A3** (scheduled real fine-tune) once data threshold hit.
6. **E** (convergence) after B. **G**, **H** opportunistic.

Order rationale: lock in a safety net (F) before the big refactor (B); refactor before convergence
(E) depends on it; ship the headline capability (C) on solid ground; the learning loop (A) matures
passively the whole time and only needs a scheduled trigger (A2) once data is there.
