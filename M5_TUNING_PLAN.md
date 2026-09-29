# BhatBot on the M5 Pro — tuning plan

_**Status, 2026-09-29:** §2–3 (the tiers) and §7 (the 24 GB thresholds) are implemented in
`lib/tiers.js` and `lib/governor.js`. §5's local-model question is settled: `qwen3:latest` emits
native ollama `tool_calls` — verified directly against `/api/chat`, and then at scale by a soak that
logged 557 native calls and 0 content-scrapes. **gemma4's tool-calling is still unverified and nothing
points at it.** The measured facts below (local parallelism does not exist; the CPU is idle) are what
the two-lane scheduler in `lib/supervisor.js` is built on._
_Everything not named above is still planning only._
_Every number below was measured on this machine on 2026-09-20, not taken from a spec sheet._

The machine BhatBot was tuned for no longer exists. `lib/governor.js` still opens with
"TARGET HARDWARE … MacBook Air M4, **16GB**", `config.publicHost` still points at
`siddhants-macbook-air.tail816be0.ts.net`, and `scripts/finetune.sh` still drops to a 3B base
because a 7B OOMed the Metal allocator. The box underneath is now:

| | M4 Air | M5 Pro (Mac17,9) |
|---|---|---|
| CPU | 10-core | **15-core** (5 performance-class "Super" + 10 performance) |
| GPU | — | **16-core**, Metal 4 |
| Unified memory | 16 GB | **24 GB** (+50%) |
| Chassis | fanless | actively cooled |
| SSD | — | 7.4 GB/s sequential write measured |

---

## 1. What was measured

| Workload | M4 Air 16 GB | M5 Pro 24 GB | Δ |
|---|---|---|---|
| `nomic-embed-text`, 24-node batch | 16.5 ms/node<sup>1</sup> | **6.0 ms/node** warm | 2.7× |
| qwen3 8B Q4 (5.2 GB) decode | ~19 tok/s<sup>2</sup> | **48.8 tok/s** (prefill 94) | 2.5× |
| gemma3:12b (8.1 GB) decode | ~12 tok/s<sup>2</sup> | **34.4 tok/s** | 2.9× |
| gemma4:latest (9.6 GB) decode | n/a | **53.0 tok/s** (prefill 177) | — |
| gemma4:26b (17 GB) decode | will not fit | **40.1 tok/s**, but → 6% free + 8.3 GB swap | unsafe |
| Achieved memory bandwidth<sup>3</sup> | ~100 GB/s | **~255–280 GB/s** | 2.6× |
| Brain load (2,674 nodes + 73 MB vectors) | — | 390 ms, 365 MB RSS | — |
| Model cold load | — | 3.8 s (9.6 GB) / 4.7 s (8.1 GB) / 15.6 s (5.2 GB, first touch) | — |
| **Local agents in parallel (1 / 2 / 4)** | — | **49.3 / 53.1 / 53.2 tok/s aggregate** | **flat** |
| **`npm run verify:quick`** | — | **46.4 s at 96% of one core** | 14 cores idle |

<sup>1</sup> `BENCH_APP.md`, measured 2026-08-13 on the Air with the app running.
<sup>2</sup> Derived from the Air's 120 GB/s bandwidth against the same weights; not directly measured.
<sup>3</sup> tok/s × weight bytes per forward pass. Only valid for the dense models; see §2.

### The two results that change the plan

**Local parallelism does not exist.** Four concurrent local agents produce 53 tok/s in total —
exactly what one produces. Decode is memory-bandwidth bound, so N local agents share one stream's
throughput and each runs at 1/N speed. Embedding behaves the same way (flat at ~160 nodes/s from
1 to 8 concurrent batches). **No amount of RAM or core count changes this.** Parallel-agent gains
have to come from the API fan-out (network-bound, scales fine, already paced by
`lib/admission.js`) and from CPU-side work.

**The CPU side is entirely unused.** The verify suite is a sequential `&&` chain of ~100 node
processes: 46.4 s at 96% of a single core with fourteen cores idle. Same shape in the file index
and the test harnesses. This is where the 15-core jump is actually collectable.

### The 9.6 GB model beats the 17 GB one

`gemma4:latest` runs **faster** than `gemma4:26b` (53.0 vs 40.1 tok/s) at **56% of the footprint**,
with a 3.8 s cold load instead of 10.3 s. Both decode far faster than their weight size allows for
a dense model, so both are sparse/MoE builds — only a fraction of the parameters are active per
token. The practical consequence: **the 26B is dominated on every axis and should not be resident.**
It also drove free memory from 22% → 6% and forced 8.3 GB of swap, which is `critical` on the
governor's own ladder.

---

## 2. Memory budget

Component costs, measured or estimated:

| Component | Cost | Source |
|---|---|---|
| macOS wired + baseline | ~4.5 GB | 205,937 wired pages × 16 KB = 3.37 GB, plus WindowServer |
| Electron BhatBot (main + renderers) | 1.5–2.5 GB | 174 MB RSS at boot, grows with renderers |
| Playwright Chromium when driving | +0.6–1.2 GB | browser tool active only |
| Headless worker + brain | ~0.6 GB | 365 MB measured for the graph alone |
| `nomic-embed-text` resident | ~0.4 GB | 274 MB weights |
| Local LLM weights | 5.2 / 9.6 / 17 GB | as installed |
| KV cache | ~160 KB/token<sup>4</sup> | 0.65 GB @ 4K · 1.3 GB @ 8K · 2.6 GB @ 16K |

<sup>4</sup> `2 × layers × kv_heads × head_dim × 2 bytes`, for a typical 40-layer GQA 14B. Estimate,
not measured — worth confirming per model before committing a ceiling.

### The three tiers

| | **Conservative** | **Balanced** | **Aggressive** |
|---|---|---|---|
| Local LLM | none | 8B Q4, 8K ctx | 14B-class MoE, 16K ctx |
| Weights + KV | 0 | 5.2 + 0.9 = 6.1 GB | 9.6 + 2.6 = 12.2 GB |
| Embedder | 0.4 | 0.4 | 0.4 |
| Electron | 2.0 | 2.5 | 2.5 |
| Worker | 0.6 | 0.6 | 0.6 |
| **BhatBot total** | **~3.0 GB** | **~9.6 GB** | **~15.7 GB** |
| Left for macOS + your work | ~21 GB | ~14 GB | ~8 GB |
| Local decode | — | 48.8 tok/s | 53.0 tok/s |

Aggressive leaves 8 GB after macOS's ~4.5 GB — enough for Chrome and an editor, **not** enough for
Xcode building or Blender rendering. That is the correct boundary for the tier switch.

**26B is not a tier.** 17 GB + KV + worker + Electron = >20 GB, which is the swap event measured
above. It only fits with Electron closed, and even then it is slower than the 9.6 GB model.

---

## 3. Choosing the tier automatically

The governor reads thermal, memory and battery. It has no notion of *whether you are there*, which
is the signal that separates balanced from aggressive. All of these are available without a new
dependency:

| Signal | Command | Meaning |
|---|---|---|
| User idle time | `ioreg -c IOHIDSystem \| grep HIDIdleTime` | ns since last keystroke/mouse |
| Power source + lid | `pmset -g batt` / `pmset -g ps` | AC vs battery |
| Display asleep | `pmset -g powerstate IODisplayWrangler` | screen off |
| Heavy app resident | `pgrep -x Xcode\|Blender\|Unity\|DaVinci Resolve` | your working set |
| Front app | `osascript` System Events frontmost | what you're in |
| Memory free % | `memory_pressure -Q` | already wired into the governor |

Proposed policy, as a fourth input folded into `createGovernor` rather than a separate system:

```
aggressive   ← HID idle > 10 min  AND  on AC  AND  no heavy app running
balanced     ← user active  AND  no heavy app running  AND  mem free ≥ 30%
conservative ← heavy app running  OR  on battery  OR  mem free < 30%
```

**Hysteresis runs opposite to the thermal ladder, and this matters.** The governor escalates
immediately and relaxes after a 90 s dwell, because heat is real now and coolness needs proof.
Tier selection is the reverse: *dropping* a tier must be immediate (you opened Xcode — evict the
model this second), while *raising* one needs a sustained dwell (10 min idle) so a coffee break
doesn't thrash a 9.6 GB load. Measured cost of getting this wrong: 3.8–15.6 s per reload.

Eviction is `OLLAMA_KEEP_ALIVE` per tier — `0` conservative, `30m` balanced, `-1` aggressive —
plus an explicit `ollama stop` on a downward transition.

New config: `tiers.enabled`, `tiers.idleMinutes` (10), `tiers.heavyApps` (list),
`tiers.models.{conservative,balanced,aggressive}`, `tiers.manual` (pin a tier by hand).

---

## 4. Latency first

Ordered by measured seconds returned, cheapest first.

| # | Change | Now | After | Basis |
|---|---|---|---|---|
| L1 | Parallelize the verify suite across cores | 46.4 s | **~9 s** | 96% single-core today; 10 workers, longest suite sets the floor |
| L2 | Per-tier `keep_alive` so the local model stays resident | 3.8–15.6 s stall on every cold call | **0** | measured cold-load times |
| L3 | Parallelize the file index (2,242 files, 53 projects) | sequential in the worker | **~4–6×** | pure I/O + hashing, embarrassingly parallel |
| L4 | Warm the embedder at worker boot | 856 ms first-call penalty | **0** | measured warm-up delta (12.3 → 6.0 ms/node) |
| L5 | Re-measure and re-tune `screen_parse` semantics | "~60 s slower" (Air figure) | unknown, likely ~2× | GPU-bound; 16-core GPU + Metal 4 |

L1 is a dev-loop change, not a runtime one, but it is the single largest measured number on the
machine and it gates every other change in this plan — you run `verify` between each extraction.

Already done, no action: cache keep-alive default-on, pre-rendered acks, ws TTS transport,
the 790 ms → 209 ms pre-work cut, incremental conversation caching.

**Not fixable by hardware:** first-token latency from the API, and the rate-limit pacing on
multi-tool turns. Those are account-tier problems.

---

## 5. What the local tier takes over

The hybrid split you picked: local 14B for routine background work, API for anything hard. The
work below is *currently failing* on an empty balance and costs nothing once local.

| Job | Today | Local? | Note |
|---|---|---|---|
| Weaver EXPLAIN — link rationales | 27 of 660 edges explained (4.8%), rest blocked on budget | **yes** | 633 links × ~40 tokens at 53 tok/s ≈ **11 minutes, $0** to explain the entire graph |
| SYNAPSE suggest | fails every 6 h on the billing error | **yes** | one call per cycle |
| Mail triage residue | rules only; `ambiguous` means "surface it, touch nothing" | **yes** | invariant I7 holds — the model may only *promote*, never demote a rules match |
| Morning brief drafting | failing 15–28×/day | **partly** | needs tool-calling; `qwen3` is tool-capable, gemma4 must be verified |
| Subagent simple/memory/research | `ollama` is already first in the chain | already | upgrade the model behind `local_simple` |
| Embeddings | local already | already | 6.0 ms/node |
| Router, depth, spoken-length, endpointing | local heuristics | already | no model call |

**Model selection.** `lib/agents/select.js` currently points `local_simple` and `local_code` at
`qwen3:latest` (8B). The candidate replacement is the 9.6 GB MoE at 53 tok/s — **but it must be
verified tool-capable first**, because `qwen2.5-coder:7b` was already demoted for exactly this
(it cannot emit ollama `tool_calls`). If it can't, the tier splits: MoE for text work
(triage, explain, suggest, summarize), qwen3 for anything that must call a tool.

**Cost.** Background loops ran roughly $1–2/day at the August peak ($3.67 on 21 Aug, $3.81 on
22 Aug, $5.08 on 30 Aug including foreground work). Moving the loops local saves on the order of
$30–50/month — but the real point is that **they keep running at a $0 balance**, which is the
failure this plan exists to end.

Your $15–20 top-up is enough to A/B this properly: run the same 20 triage decisions and 20 link
rationales through both the local model and Sonnet, and keep local wherever the gap is invisible.

---

## 6. Splitting the loops by capability

Four loops are down solely because their host is a window. The dividing line is the vault:
`config.json` holds `CRED_REF_*` handles that only Electron's `safeStorage` can decrypt, so a
headless process cannot reach them — unless the key is also in the login Keychain, which
`lib/llm.js` already reads via the `security` CLI.

| Loop | Needs | Move to headless? |
|---|---|---|
| synapse hydrate, memmaint | nothing | already there ✅ |
| scheduler (read-only miniagent) | Anthropic key (Keychain path exists) | already there ✅ |
| **weaver** | embedder (local) + one LLM call per rationale | **yes** — fully local after §5 |
| **triage classification** | nothing (pure rules + local model) | **yes** |
| triage *actions* (archive/label) | Gmail OAuth from the vault | no — stays GUI, or needs a Keychain path |
| **patrol** | Telegram/Twilio creds | **yes, if** those move to Keychain |
| backlog worker | `claude_code`, write access, git | no — step-up tool, stays GUI |
| self-heal | git, verify, code modification | no — stays GUI |
| missions | full tool loop + vault | no — stays GUI |

Net effect: the second brain keeps growing, connecting and explaining itself whether or not the
window is open, and mail still gets classified — but nothing that can *act* on your accounts runs
without the vault, which is the right boundary.

---

## 7. Ceilings worth raising (exploratory)

| Knob | Now | Proposed | Justification |
|---|---|---|---|
| Governor `memWarnPct` / `memHotPct` / `memCriticalPct` | 25 / 15 / 8 (16 GB-tuned) | **18 / 11 / 6** | Same *absolute* headroom on 24 GB: 25% of 16 GB = 4 GB ≈ 18% of 24 GB |
| `shedLocalModel` at `warm` | fires early by design | tier-aware | At aggressive the local model is the point; shed vision first instead |
| `MLX_BASE` finetune base | `Qwen2.5-3B-4bit` (7B OOMed on 16 GB) | **7B-4bit** | ~4.5 GB peak vs the 2.6 GB that 3B needed; comfortable at 24 GB |
| Weaver `embedPerTick` | 24 | **64** | 6.0 ms/node → 64 nodes is still a ~0.4 s tick |
| Fleet width clamp | `[2, 12]` | leave | Budget-derived, API-bound, not machine-bound. Raising it buys nothing. |
| `wireCapTokens` 150K | 150K | leave | Token cost and rate limit, not RAM. Hardware does not move this. |
| SYNAPSE 3D graph in the UI | limited by the old machine | 2,674 nodes | 16-core GPU, and the brain is finally big enough to be worth looking at |
| `screen_parse` semantics | default off (~60 s) | default on at aggressive | re-measure first (L5) |

Two entries say "leave" on purpose. Working memory and fleet width are the two knobs that *look*
like they should scale with the machine and don't — both are bounded by the API account, and
raising them here would spend money without buying speed.

---

## 8. Stop the bleeding (do these first, they are not tuning)

1. **Scheduler permanent-error backoff.** `scripts/synapse-worker.js:210` only calls `markRan` on
   success, so a permanent error retries forever: 680 result files, 15–28 failures/day since
   ~4 Sep, every one flagged unread. Transient → retry (correct today). Permanent
   (`invalid_request_error`, billing, auth) → park the schedule and notify **once**. The backlog
   worker already makes this distinction (`a984ad2`); port it.
2. **Prune `~/.bhatbot/schedule-results/`.** 365 files older than 30 days, nothing prunes them.
   `memmaint` already bounds operational logs — add this directory.
3. **Fix `config.publicHost`** — still the Air's tailnet name.
4. **Update the docs.** `BHATBOT_STATE.md` was last true on 7 July (25 commits ago, missing the
   FLEET office, connectors, Opus 5 pricing, context editing, the backlog worker, Blender, weaver).
   `DAEMON.md` understates the worker, which *does* run schedules now.

---

## 9. Sequence

| Phase | Work | Gate |
|---|---|---|
| **0** | §8 — backoff, prune, config, docs | `npm run verify` |
| **1** | L1 parallel verify → then L2/L4 residency + warm-up | verify wall time < 12 s |
| **2** | Tier detector + governor thresholds (§2, §3) | `test-governor.js` extended; no swap under any tier |
| **3** | Local tier: confirm tool-calling, repoint `local_simple`, A/B against Sonnet (§5) | quality gap invisible on 20 triage + 20 rationale cases |
| **4** | Capability split: weaver + triage-classify headless; patrol if creds move (§6) | loops survive quitting the window |
| **5** | Ceilings: L3 file index, `MLX_BASE` 7B, weaver tick, UI/3D pass (§7) | re-run `BENCH_APP.md` and commit new baselines |

Phase 0 is independent of everything else and should land today. Phases 1–2 are the "runs
extremely smoothly" half; 3–5 are the "far higher than the Air" half.

---

## 10. Honest limits

- **Local parallel agents will not get faster.** Measured flat at 53 tok/s aggregate. If the
  expectation is "more agents thinking at once", that has to be bought from the API, where
  `lib/admission.js` already paces it correctly.
- **"General thinking" does not improve from hardware.** It improves from the model tier. The
  local jump is real (19 → 53 tok/s, and a class of model the Air could not hold at all), but a
  14B-class local model is not Sonnet. The hybrid split is what buys this, not the M5.
- **KV cache figures in §2 are estimates**, not measurements. Confirm per model before pinning
  the aggressive ceiling.
- **The Air comparison rows marked <sup>2</sup> are derived**, not measured — that machine is gone.
  The embedding row is a genuine before/after from `BENCH_APP.md`.
- **UI gains are unmeasured.** The Electron app has not run since 2 Sep, so there is no current
  renderer baseline. Phase 5 should start by taking one.
