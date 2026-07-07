# BhatBot — Functional Issues Dossier
_Compiled 2026-06-30. Grounded in the codebase + issues observed live this session. Ordered by the areas you asked about (context, tokens, parallelism, multi-agent) then everything else, however minor._

> **STATUS UPDATE — 2026-07-07 (voice/complex-task/UI pass).** Most of the systemic limiters below
> are now FIXED. Re-audited against current `main.js` (the code moved a lot since 2026-06-30, so
> several items were already resolved by intervening sprints). Item-by-item:
>
> - **§1 Context management → ✅ RESOLVED.** Trim is token-budgeted (`estimateTokens`) AND runs
>   mid-loop (`agentLoop` re-trims past `contextTrimBudget()`), and the working-memory clamp was
>   raised from ~32K to **~150K** (`wireCapTokens`, `CONTEXT_TRIM_BUDGET` 120K / `CONTEXT_KEEP_TAIL`
>   80K) so long autonomous tasks actually use the 200K window. A second prompt-cache breakpoint on
>   the conversation prefix (`tagLastBlockForCache`) makes the bigger context affordable. **This was
>   the #1 thing capping complex tasks.** (commits `0536e2d`, `21bc9d2`)
> - **§3 Parallelism / Opus OTPM → ✅ MITIGATED.** Heavy-tier routing is now "auto by shape": fan-out
>   fleet builds go to **Fable 5** (roomier OTPM, so drones aren't throttled to ~3 by Opus's 16K),
>   solo deep-reasoning stays on Opus (`heavyModel(text)`). Live rate headers already self-correct the
>   per-model budgets. (commit `0536e2d`)
> - **§5.1 STT hallucination injection → ✅ RESOLVED** (already, pre-this-pass): `sanitizeSteering`
>   guards the cloud path, local path, AND guidance injection; guidance is deduped + capped
>   (`MAX_GUIDANCE_CHARS`). **§5.2 barge-in TTS-tail → ✅ adequately covered** (`stopSpeaking()` before
>   mic open + echo cancellation + main-side `bargeInInterrupt()` kill). Plus TTS now defaults to the
>   low-latency **ws transport** when usable (`auto`). (commit `808eb97`)
> - **§2 Token/caching → ✅ IMPROVED** (see §1: conversation-prefix caching). **§4 local pipeline →
>   ⚠️ STILL OPEN** (unchanged — tool tasks still escalate to cloud). **§5.4 secret-file read →
>   ⚠️ open. Phone strict-EL silence → ⚠️ open** (desktop has Kokoro fallback; phone doesn't).
>
> The remaining open items are §4 (local pipeline tool-mangling) and the minor §5.4 / phone-EL
> resilience. Detail preserved below for history.

---

## 0. Executive summary
BhatBot is functional and the agent loop works (the Anthropic-key desync that had it fully dark is fixed this session). The biggest *systemic* limiters are, in order:
1. ✅ **Context management is message-count-based, not token-based, and doesn't run mid-loop** → **RESOLVED 2026-07-07** (token-budgeted + mid-loop + 150K working memory). Was → long autonomous tasks could silently approach the 200K window and lose fidelity to a 200-word summary.
2. ✅ **Effective parallelism is OTPM-bound (~19 Sonnet), well below the nominal 24-agent cap** → **MITIGATED 2026-07-07** (auto-shape routing puts fleets on Fable 5's roomier OTPM; live headers self-correct budgets).
3. ⚠️ **Local multi-agent pipeline mangles tool tasks**, so the system leans on cloud (Claude) for anything tool-heavy, which reconcentrates cost + rate-limit pressure. **STILL OPEN.**
4. ✅ **Voice/STT injects hallucinated transcriptions as live steering** → **RESOLVED** (`sanitizeSteering` on all paths + capped/deduped guidance).

---

## 1. Context limits & window management

**1.1 Trim is count-based, not token-based.** `trimHistory()` (`main.js:1532`) only fires when `history.length > 20` *messages*. A single message can be 500 tokens or 150K tokens (a big `read_file`, a directory dump, a vision frame). So:
- 15 huge tool results (< 20 messages) will **not** trigger a trim and can overflow the 200K window → hard 400 from the API.
- 25 tiny messages **will** trigger a trim that wasn't needed.
Fix direction: budget by estimated tokens (chars/4 heuristic or the API `usage` you already log), not message count.

**1.2 Trim only runs at the START of a turn** (`main.js:3681`), never *inside* the agentic loop. A single user turn that fans out into 40–60 tool calls appends all of them to `history` with no re-trim until the next user message. Long autonomous / self-drive / plan-and-run tasks are exactly where the window blows, and that's the one place trimming is absent.

**1.3 Summary is lossy + fixed-size.** The trim replaces everything-but-last-4 with a single `<200 word` Haiku summary. For a long technical session this drops file paths, exact diffs, and tool outputs — the model then re-derives or hallucinates them. The recent-window of 4 is also very short.

**1.4 No persistence of the pre-trim transcript** for the model to page back into. Once summarized, detail is gone for that turn.

**Recommendations:** token-budgeted trimming; a mid-loop guard (e.g. re-summarize oldest tool results when running estimate crosses ~120K); keep last N *by tokens* not count; consider tool-result elision (keep the call, drop the bulky body) before full summarization.

---

## 2. Token usage & cost

**2.1 Prompt caching is implemented — good — but fragile.** `cache_control:{type:'ephemeral'}` wraps the static prompt + tools (`main.js:690`, `:2512`) and there's a `[CACHE MISS]` warn at `main.js:1269`. Caveats:
- **Ephemeral cache TTL is ~5 min.** Any idle gap > 5 min re-bills the full static prompt + all tool schemas at full input price on the next turn. For an ambient always-listening assistant with sparse bursts, this is a frequent silent tax.
- Cache hits depend on the mode block staying **after** the cached block (`main.js:659`); any reordering silently kills the hit.

**2.2 All ~58 tool schemas are shipped on cache-miss turns.** `toolselect` filters, but CORE tools are always included and the full schema set is what gets cached. On every cache miss that's a large fixed input cost. Consider a smaller always-on CORE and lazy tool-schema loading.

**2.3 Vision is expensive and only partially bounded.** Screenshots/frames are normalized to ≤1568px (`VISION_MAX_DIM`) and old images are evicted (`lib/history.evictOldImages`), but each live vision turn is still a large image-token spend, and screen-recording sampling multiplies it. No downscale-further / frame-cap policy under cost pressure.

**2.4 Retries re-send full context.** 429/transient retries resend the whole (possibly large) message array. With tier pacing this compounds both cost and latency.

**2.5 No per-turn token budget / ceiling.** There's cost telemetry (`costs.json`, router.jsonl) but no hard "this turn may not exceed X input tokens" backstop, so a runaway tool loop is unbilled-until-it-hurts.

---

## 3. Parallel processing & rate limits

**3.1 The real ceiling is OTPM, not the agent cap.** Admission (`lib/admission.js`) paces on output-tokens-per-minute. With the current tier that's roughly **~19 Sonnet / ~3 Opus / ~10 Haiku** concurrent agents — the nominal `cap 24` and the raised `fleetWidth max 24 / ensemble 8 / fleet 12` are aspirational above that. Raising caps further does nothing until OTPM rises.

**3.2 Tier rate-limit pacing is the dominant latency cost.** Per the live-test findings, sequential pacing against ITPM/OTPM (Sonnet 450K/90K, Haiku 100K/50K, Opus 100K/16K) is the throughput bottleneck, not model speed. Opus's 16K OTPM makes wide Opus fan-out effectively impossible (~3 agents).

**3.3 Admission is per-process, not fleet-global in a hard sense.** Parallel agents each estimate width; bursty simultaneous starts can still transiently over-commit before pacing catches up (admission smooths, doesn't hard-gate at the token level).

**3.4 No cross-model load-balancing of a fan-out.** A wide task pinned to one model can't spill overflow agents onto a cheaper/roomier model automatically; the tier headroom of Haiku often sits unused while Sonnet is saturated.

**Recommendations:** publish the *effective* width (OTPM-derived) in the Manage panel so the ceiling is visible; auto-shard fan-outs across models by remaining OTPM headroom; treat the cap as `min(cap, OTPM-derived)` everywhere so the UI never implies 24 when 19 is real.

---

## 4. Multi-agent workflows

**4.1 The local Ollama pipeline mangles tool tasks.** The local router/planner/executor/critic pipeline (`config.pipeline`) is fine for pure text but corrupts tasks that require tool calls, so tool-heavy work escalates to Claude. Net effect: the "local-first" cost story doesn't hold for the agentic workloads that matter most.

**4.2 Escalation reconcentrates pressure.** Because 4.1 pushes tool work to cloud, the rate-limit/cost pressure from §3 lands on exactly the multi-agent runs that were supposed to be distributed.

**4.3 Steering/guidance injection is unsanitized (see also §5).** `agent-guidance` (`main.js:6571`) pushes *any* non-empty string into `pendingGuidance`; it's folded into each step (`main.js:3838`) with no dedup, no length cap, no echo/rejection filter. A garbled STT burst becomes repeated mid-task instructions.

**4.4 A2A / plugin sandbox are thin.** The A2A envelope + plugin sandbox exist but are minimal; no capability negotiation, ret/timeout policy, or structured failure propagation between agents.

**4.5 Self-drive / self-heal are correctly gated** (frozen-zone + verify + human gate) — noted as a *non*-issue, but their conservatism means they rarely act autonomously, which is the intended trade-off, not a bug.

---

## 5. Voice / STT pipeline (observed live this session)

**5.1 STT hallucinations injected as steering — the "Talaser Talaser…" loop.** Whisper-family models emit **repeated-token hallucinations on near-silent / non-speech audio**. This session, such a burst was captured mid-task and injected as guidance twice (`steering (mid-task): Talaser Talaser…`). Needs: a repeated-token/again low-entropy filter + a min-confidence/min-distinct-words gate before any transcription is submitted or injected as guidance.

**5.2 Barge-in can capture the TTS tail.** Re-arming the mic during/just-after speech risks transcribing BhatBot's own voice as a command. There's a mute-grace window in `listen.py`, but the browser-side MediaRecorder path doesn't coordinate with it.

**5.3 STT reliability was fully cloud-dependent** until this session's offline mlx-whisper fallback landed; if the vaulted key desyncs (as it did), voice silently dies. Now mitigated but worth a health indicator.

**5.4 `read_file ~/.bhatbot/config.json` fails** (seen in the transcript, `✗`), forcing a `run_shell find` fallback. If this is the secret-file guard it should return a *graceful, explained* refusal, not a raw tool failure that makes the model improvise shell.

---

## 6. Other / minor issues

- **6.1 Vault↔config desync (root-caused + fixed this session):** `config.json` had been rewritten down to 5 keys, dropping every `CRED_REF` pointer while the encrypted vault kept the secrets → "No ANTHROPIC_API_KEY" despite the key existing. Fixed by restoring refs + a boot-time `reconcileVaultRefs()`. Residual risk: if the vault itself was ever encrypted under a *different* app identity (dev `electron .` vs packaged `.app`), `safeStorage` can't decrypt and you'd get a `CRED_REF…` string used as a key → 401. A one-time re-enter in settings re-vaults under the current identity.
- **6.2 Status-bar state leakage (fixed this session):** raw Web-Speech error codes ("network") were rendered as status; now only ambient/listening/transcribing.
- **6.3 Listening hang (fixed this session):** silence detection used `requestAnimationFrame`, throttled to ~0 Hz when the window is hidden (ambient mode) → mic never closed. Now `setInterval` + hard 15 s cap.
- **6.4 Config drift across the 3 phone copies:** `src/mobile.html` (served), `phone-app/Web`, `cloud/public` diverge (the latter two lack the Health feature). Voice fixes were synced, but there's no build step keeping them in lockstep → future features can silently miss two surfaces.
- **6.5 `main.js` is monolithic (~400KB+).** Split reached pure/shell/vision/system/media/browser/window-manager/history but the executeTool/agentLoop core and lots of feature wiring still live inline; the <150KB goal is stalled (needs GUI-boot, keychain-blocked). Slows edits + raises regression risk.
- **6.6 Sleep data was raw Garmin** (fixed this session: +1h correction, configurable).
- **6.7 No token-cost surfaced per agent in the fleet UI** (cost telemetry exists in files; not all of it is glanceable in Manage).
- **6.8 Run GPS routes not yet in Maps.** Recent-run route overlay in the maps section is still pending (the biometric *graphs* landed this session; the map polyline overlay did not).

---

## 7. Prioritized recommendations
1. **Token-budgeted, mid-loop context trimming** (biggest reliability + cost win). §1.1–1.2.
2. **Repeated-token/low-confidence STT guard before guidance injection.** §5.1, §4.3. (Cheap, stops a visible failure.)
3. **Surface the OTPM-effective parallel width** and gate `cap = min(cap, OTPM-width)`. §3.1.
4. **Cache-miss mitigation:** keep a warm keep-alive or accept a smaller cached CORE toolset so idle bursts don't re-bill the full tool schema. §2.1–2.2.
5. **Fix the local pipeline's tool handling** or formally scope it to text-only and route tool tasks to cloud by policy (stop pretending it's local-first for agentic work). §4.1.
6. **Graceful secret-file refusal** for `read_file` on config/vault paths. §5.4.
7. **A phone-copy sync step** so features don't miss `phone-app`/`cloud`. §6.4.

_Items fixed during this session: 6.1, 6.2, 6.3, 6.6, and the offline-STT fallback (5.3). Remaining headline work: context/token management (§1–2), STT guard (§5.1), and the run-map overlay (§6.8)._
