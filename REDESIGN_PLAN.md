# BhatBot — the redesign

_Supersedes the scope of `M5_TUNING_PLAN.md`; see §12 for what changed and why._
_Written 2026-09-20 against measurements taken the same day. Nothing below is shipped unless §13 says so._

`M5_TUNING_PLAN.md` asked one question: what does the new hardware let us raise? This document
answers a larger one — what the system should be. The hardware plan stays valid as the
*performance* half and is folded in, but four of its conclusions are now downstream of
architectural decisions rather than driving them.

---

## 1. The ten notes, as decisions

| # | Note | Decision |
|---|---|---|
| 1 | Turn routing isn't optimized; regex carries too much; drop Haiku, group local models | §2 Router · §3 Cascade |
| 2 | Wire ChatGPT as a real provider | §4 Providers |
| 3 | 12-of-85 tool retrieval is a poor design; want a tree | §5 Tool catalog |
| 4 | Phone is parked | Out of scope. Desktop + cloud only. |
| 5 | Voice should work like ChatGPT voice mode | §6 Voice sessions |
| 6 | No Fable; Opus or the OpenAI line | §4 Providers |
| 7 | A 5th agent shape that checks work and asks when confused | §7 Custodian |
| 8 | Making tools on hiatus — they break the context window | §5 solves the cause; §13 schedules the return |
| 9 | Memory wired directly into agents and tools; a free model maintains the brain | §8 Memory |
| 10 | Loops should retain more; add anti-escape safeguards | §9 Loops · §10 Safety |

---

## 2. The router (note 1)

### What is actually there

`chooseModel()` is **already degenerate**. Every branch assigns `MODEL_SONNET`; the regex list only
sets a telemetry label. Haiku was retired months ago (`main.js:197` — "RETIRED from routing"), and
`models.haiku` resolves to Sonnet. **Note 1's "remove Haiku" is already done.** What is left of
Haiku is vestigial naming in six files (`lib/health.js`, `lib/eval.js`, `lib/planner.js`,
`lib/subagents.js`, `lib/agents/select.js`, `lib/pricing.js`) — dead references that read as live
routing and should be cleaned so the next reader isn't misled the way this one was.

The regexes that actually decide cost are three, all in `main.js`:

| Regex | Decides | Failure cost |
|---|---|---|
| `quickRoute` | chat vs action vs unsure | `chat` on an action = nothing happens; `action` on chat = a full tool loop for "hey" |
| `looksLikeToolTask` | forces the agent loop | a miss means the tool-less path answers live questions from stale training |
| `looksComplexTool` / `looksHeavyTool` | Sonnet vs Opus vs fleet | a false positive is expensive; a false negative is a bad answer |

`BENCH_APP.md` already measured `quickRoute` at **93.8% on 16 cases** — one miss, `"who won the
2022 world cup"` classified `action` when it should be `chat`. That is the only measured data
point on the whole router.

### The problem with perfecting the regex

A regex cannot be perfected into a classifier, and the evidence is in the code: `looksLikeToolTask`
has grown to a 40-branch alternation with hand-patched cases for World Cup fixtures and weather.
Each patch fixes one utterance and widens the false-positive surface. That is the shape of a
rule set that has outgrown rules.

### Decision

**Keep the regex as a fast path, put a measured gate behind it, and build the corpus first.**

1. **Instrument before changing.** Every `quickRoute` decision already flows through
   `_dispatchTurnInner`; log `(text, verdict, whether tools were actually used)`. The ground truth
   is free — a turn routed `chat` that the user immediately rephrased, or routed `action` that
   called zero tools, is a labelled mistake. Two weeks of real traffic beats any amount of regex
   staring.
2. **Expand the eval from 16 cases to ~200**, drawn from that log. This is the gate for every
   subsequent router change.
3. **Then** add a local-model tiebreaker for the `unsure` verdict only — the regex keeps the
   clear cases at zero cost and zero latency, and the model resolves the residue. Same shape as
   `lib/triage.js`, which already proves the pattern (deterministic rules first, model only on
   the ambiguous remainder, and the model may only promote).

**Explicitly not doing:** replacing the regex with a model on every turn. It would add 200–400 ms
to the fast path — the exact latency this plan is trying to remove.

---

## 3. The local cascade (notes 1, 2)

**Your call: cascade, escalating to an ensemble on low confidence, with a spoken warning that the
task will take longer.**

```
tier 0   deterministic     regex / rules                     0 ms      $0
tier 1   local small       8B Q4, 48.8 tok/s                 ~1 s      $0
           └─ confidence ≥ threshold → done
tier 2   local ensemble    2–3 local models + judge          ~3–4 s    $0
           └─ speak "this one needs a moment longer" on entry
           └─ agreement → done
tier 3   cloud             Sonnet 5 / Opus 5 / OpenAI        ~2–8 s    $
```

### The measurement that constrains this

Local throughput is **flat at ~53 tok/s aggregate regardless of concurrency** (measured 1/2/4
concurrent: 49.3 / 53.1 / 53.2). An ensemble of three does not cost 1× wall-clock — it costs 3×.
That is precisely why the spoken warning you asked for is not a nicety but a requirement: tier 2
is a genuine latency cliff, and the user has to be told they are on it.

### Confidence, concretely

There is no calibrated confidence from a local model, and self-reported confidence is worthless.
Three signals that are actually available:

- **Structural** — did it emit valid JSON against the required schema? `lib/pure.js` already
  strips `<think>` leakage and the repo already learned that weak models emit malformed output.
  A schema failure is the single strongest signal and costs nothing.
- **Self-consistency** — same prompt, temperature 0.6, twice. Agreement is a real confidence
  proxy. Costs 2× local, still $0.
- **Task-shaped** — for classification (triage, routing) the margin between top-1 and top-2
  logprob. Ollama exposes this; for free-form generation it does not apply.

Start with structural (free, unambiguous), add self-consistency for the tasks where a wrong
answer is expensive.

### The prior failure this must not repeat

`main.js` carries an explicit warning: the local tier was pulled back to trivial acknowledgements
only, because "the local gemma tier was emitting Python scripts, leaked JSON and invented
personas for ordinary chat (Siddhant's call: quality over the free tier)." That model was
`gemma3:12b` at ~12 tok/s on a 16 GB Air. The candidate now is a 9.6 GB MoE at **53 tok/s** —
faster than the 17 GB build and a different quality class. But the decision that retired the local
tier was a *quality* judgement, not a speed one, so:

**Gate: the local tier ships only behind an A/B that you sign off on.** 20 chat turns, 20 triage
decisions, 20 link rationales, local vs Sonnet, blind. Local wins the slot only where the gap is
invisible.

---

## 4. Providers (notes 2, 6)

### What is already wired

OpenAI is **not absent** — it is present in five places and crippled in the one that matters:

| Use | Where | Tool-calling? |
|---|---|---|
| Embeddings | `lib/semantic.js`, `cloud/src/toolselect.js` | n/a |
| Text offload rung | `main.js:2039` `offloadText` | **no** |
| `ask_ai` cross-provider | `main.js:2223` | **no** |
| DAG agent offload | `main.js:3465` `openaiChat` | **no** |
| TTS / STT | `main.js:9543`, `main.js:10233` | n/a |

Every chat path flattens messages to plain strings and drops tool definitions. OpenAI is a
text-completion side-channel, not a peer provider. `lib/agents/select.js` says so outright:
"tool-loop work stays anthropic/ollama because only those have tool-capable callers".

### Decision

Build `lib/providers.js` — one interface, three implementations:

```
provider.chat({ messages, system, tools, schema, stream }) → { text, toolCalls[], usage }
```

- **anthropic** — wraps the existing `anthropicRequest`/`anthropicStream` (unchanged behaviour).
- **openai** — real `/v1/chat/completions` with `tools:[{type:'function',…}]`, translating
  Anthropic tool blocks ↔ OpenAI tool calls in one place instead of five.
- **ollama** — `ollamaToolChat` already exists at `main.js:3406` and already emits Anthropic-shaped
  content. Lift it out; it is the proof the translation layer is the right shape.

**Fable is removed** from `heavyModel()` and `heavyRouting`. The fan-out tier it existed to serve
(roomier OTPM so drones aren't throttled) is now served by spreading drones across **providers**
instead of models — which is strictly better, because two providers' rate windows are genuinely
independent where two Anthropic models' are not.

**Blocker:** "terra/astra" — you said OpenAI line, but I need the exact API model IDs. They are not
in my knowledge and not in the repo. `lib/providers.js` reads model IDs from config
(`providers.openai.models.{fast,heavy}`), so the code lands without them and they drop in when you
have them.

---

## 5. The tool catalog (notes 3, 8)

### The measurement that changes the design

| | tokens |
|---|---|
| Full catalog, 85 tools | **25,531** |
| Selected mode today (CORE 12 + top-12) | **4,778** |
| **CORE alone — 12 tools, on every single turn** | **3,289** |
| All 85 names + one-line summaries | 2,176 |
| All 85 names only | 278 |
| Heaviest single tools | `make_model` 769 · `build_project` 654 · `make_asset` 634 · `smart_login` 632 |

**CORE is 69% of a selected turn.** The retrieval is not the problem — the always-on set is. And
note 8 is explained by the same number: `make_model` (769) + `make_asset` (634) + `make_figure`
(540) + `visual_build` + `studio_write` is over 2,500 tokens of schema for a workflow that then has
no room left to work. The making tools didn't break the context window by being used; they broke
it by being *present*.

### Design — a resolver tree, not a search tree

A pure tree the model walks costs round trips, and a round trip is 2–8 s. So the tree is walked
**deterministically before the model is called**, and the model gets an escape hatch.

**Stage 1 — categories.** The 85 tools partition into 14 categories: `files shell web screen comms
media make science memory agents self creds info meta`. Each is a name plus one line (~200 tokens
for all fourteen).

**Stage 2 — deterministic resolution.** A keyword/prefix trie maps the query to 1–3 categories at
zero cost and zero latency. This is where "tree-based search" actually pays: `"resize these
screenshots"` → `files`; `"render this molecule"` → `science, make`. The corpus already exists —
`BENCH_APP.md`'s toolselect misses are ten labelled examples, and every one of them resolves
correctly under a trie.

**Stage 3 — embeddings as a tiebreaker inside the resolved categories**, not across all 85. Cosine
over 8 candidates is far more reliable than cosine over 85, and the dimension-mismatch failure that
`lib/toolselect.js` documents twice stops mattering, because a miss now falls back to a category,
not to the whole catalog.

**Stage 4 — a `toolbox` meta-tool** in CORE. `toolbox({category})` returns names + summaries for a
category the resolver didn't pick. This replaces the "return null → send all 85" fallback with
"send 250 tokens and let the model ask". **The 25,531-token worst case stops existing.**

### Projected cost

| | today | after |
|---|---|---|
| CORE | 3,289 (12 tools) | **~350** (`toolbox` + `notify_user`) |
| Task tools | ~1,489 (top-12) | ~2,000 (one full category, ~7 tools) |
| **Typical turn** | **4,778** | **~2,350** (−51%) |
| Worst case | **25,531** | ~350 + one round trip |
| Tools a local model must choose between | 24 | **~8** |

That last row is note 3's real payoff. A local model cannot tool-call across 24 schemas reliably;
across 8 well-named ones in a named category, it can. **This is what unlocks tools for the free
tier** — not a change to the models.

### Novelty-gating

Note 3 asks to eliminate latency from novelty-gating. Worth separating two things that share a
name: the `agentLoop` novelty gate (`shouldExtendBudget` — stops a repeating agent, ~0 cost, keep
it) and the *catalog* novelty churn (a connector coming online flips 85 → 90 tools and used to
re-embed everything). The second was already fixed — vectors are now per-tool and keyed by
signature. The tree removes what remained, because a new tool joins a category rather than
perturbing a global ranking.

---

## 6. Voice sessions (note 5)

### The target, stated precisely

ChatGPT voice mode, as a mechanism: **tap once to open a session**, then continuous open-mic with
server-side turn detection — no wake word per utterance, barge-in cuts playback instantly, context
carries across turns, and a visible waveform shows which of four states it is in
(idle / listening / thinking / speaking). The session ends when you close it, not when the model
decides you are finished.

### What BhatBot already has

More than you'd expect. Every mechanism exists; the **session model** is what's missing.

| Piece | State |
|---|---|
| Continuous "open session" listening | shipped (`97cf27a`) |
| Barge-in + TTS-tail kill | shipped |
| Adaptive + learned endpointing | shipped (`lib/endpoint.js`) |
| Web-Audio VAD gate | shipped |
| Streaming TTS over one ws | shipped (`lib/ttsws.js`) |
| Voice-ID cocktail-party filter | shipped |
| `tts-idle` → mic re-arm invariant | shipped, load-bearing |
| Wake-word self-mute while it speaks | shipped |
| **Explicit session object with a state machine** | **missing** |
| **Session-scoped context distinct from chat history** | **missing** |
| **Four-state UI affordance** | partial (12px status word) |

The gap is that today a "conversation" is an emergent property of timers, a 30-second silence
note, and stop-phrase matching ("I'm satisfied / done with the project"). There is no object that
owns it.

### Decision

`lib/voicesession.js` — an explicit state machine, pure and DI'd, owning exactly one thing: what
state the session is in and what may legally happen next.

```
closed → (tap / wake word) → listening
listening → (endpoint fires) → thinking
thinking → (first audio) → speaking
speaking → (user speech over threshold) → listening        [barge-in]
speaking → (tts-idle) → listening                           [normal re-arm]
any → (tap / stop phrase / timeout) → closed
```

Rules that fall out of having the object at all:
- **The wake word is only needed to enter `closed → listening`.** Inside a session it is off,
  which is the single biggest felt difference from ChatGPT voice mode.
- `tts-idle` stays the re-arm trigger; the state machine makes the invariant checkable in a test
  instead of a comment.
- Session context is its own window, so a long voice conversation doesn't get trimmed by the same
  `capTokens` pass that governs typed history.
- The UI gets a real four-state waveform driven by the machine, not by inference from events.

---

## 7. The Custodian (note 7)

**The fifth agent shape.** The existing four are escalations of *capability* — specialist,
ensemble, fleet, durable mission. The fifth is orthogonal: it is the one that decides whether the
work is done and whether to ask you.

`lib/custodian.js`:

1. **Acceptance check.** Given `(original prompt, deliverable, trace)`, does the deliverable answer
   what was actually asked? This is a genuinely different question from `verifyActionDone` (which
   asks only "did a tool run?"). A fleet can produce a polished artifact that answers a question
   nobody asked; nothing currently catches that.
2. **Send-back.** One bounded retry with the mismatch stated explicitly, reusing the
   `actionVerify` redo mechanism already in `agentLoop`.
3. **Ask, and park.** On confusion: **speak the question and post a UI card, then park the mission
   until you answer.** `lib/mission.js` already has `parkedAt` and resume — the missing piece is a
   park reason of `needs_input` that is *surfaced* rather than silently waited on. The DAG
   orchestrator already treats `needs_input` as the one status that pauses a run; this extends it
   to the top level.
4. **Autonomy is opt-in, per task.** Default is ask. `autonomous: true` on a mission, or the
   existing `autonomousMode` config, suppresses the pause — this inverts today's default, which is
   to guess and continue.

**Triggers for a pause**, deliberately narrow so it doesn't become noise:
- the deliverable does not address the original prompt (acceptance check fails twice)
- a required fact is missing and cannot be derived (a path, a name, a choice between two readings)
- a step-up-tier action is implied that was not authorized (`lib/risk.js` already classifies these)
- two sub-agents returned contradictory results on an `overlaps` task

---

## 8. Memory into the loop (note 9)

### Today

Memory reaches the model through exactly one door: `buildMemoryBlock(query)`, folded into the
system prompt by `buildSystemPrompt()`. It is a **read-only, query-time lookup**. Tools do not see
it, sub-agents get only the task context the orchestrator assembles (roles are explicitly
stateless), and — the substantive gap — **what BhatBot did is not written back as structure.**
Episodes are recorded, but the SYNAPSE graph is built from projects, files, memories and Notion.
Actions are not nodes.

### Decisions

1. **Actions become first-class graph nodes.** Every completed tool call and every finished mission
   writes an `action` node: what was attempted, on what, with what outcome. This is the change that
   makes note 9 real — "prior knowledge as a major part of how actions are done" requires that
   prior *actions* be part of the knowledge. `lib/audit.js` already records all of it; it just
   terminates in a log instead of the graph.
2. **Tools read memory.** A `memory` handle passed into tool execution, so `run_shell` can know the
   last three commands in this project and `make_model` can know the last build. The plumbing is
   the easy half; the hard half is keeping it bounded — a per-tool budget of ~200 tokens of
   relevant prior, not a dump.
3. **Sub-agents get a memory slice.** Roles stay stateless by design (correctly — it's what makes
   them testable), so this is an *injected* slice in the assembled task context, not a shared
   mutable store.
4. **A free model maintains the brain continuously.** The gardener already decays, prunes and
   merges (measured this morning: 292 decayed, 1 pruned). What it cannot do without a key is
   *reorganize* — propose merges, write link rationales, promote clusters to projects. At 53 tok/s
   local this becomes free and continuous instead of budget-gated and stalled: **633 unexplained
   links × ~40 tokens ≈ 11 minutes to explain the entire graph, at $0.**

---

## 9. Standing loops retain more (note 10)

Each loop currently writes a terminal log line and drops its working state. Concretely:

- **Weaver** emits a feed of 60 items kept in RAM, lost on restart.
- **Patrol** reports; nothing accumulates, so "is this getting worse?" is unanswerable.
- **Triage** records verdicts in `actionlog`, but not the *features* that drove them, so a
  mis-classification can't be replayed.
- **Synapse** logs `2023 nodes / 661 edges` each cycle; the deltas are not kept, so growth and
  stall look identical in the log.

Decision: one append-only `loopstate` per loop — bounded JSONL with the same shape everywhere
(`ts, loop, delta, evidence, cost`), read by the Health panel. `lib/memmaint.js` already knows how
to bound operational logs without touching training data, so the retention policy exists.

---

## 10. Safety — anti-escape (note 10)

Existing controls are good and stay: risk tiers, frozen zones, `isSelfDegrading`, verify-or-revert,
`sandboxexec` with network denied by default, never-pushes.

The gap you're pointing at is **scope escape** — not "can it do something dangerous" but "can it
widen its own reach." Four additions:

1. **Egress allowlist for agents.** `sandboxexec` denies network to generated code, but a
   *drone* with `fetch_url` and `run_shell` has unrestricted outbound. Per-drone domain allowlists,
   default-deny for anything not named in the task.
2. **No self-granting.** A drone's tool subset is fixed at spawn (`scopeTools` already does this).
   Add the assertion that it cannot call `subagent`/`fleet`/`deploy_drones` to spawn a child with a
   *wider* grant than its own. Today that path is open, and it is the cleanest escape available.
3. **Budget is a hard wall, not a target.** `envelopeUsd`/`hardCap` exist; a timeout currently
   admits anyway (`lib/admission.js` — "after timeoutMs it admits anyway"), which is right for a
   convoy stall and wrong for a spend ceiling. Separate the two.
4. **Config is a frozen zone.** `~/.bhatbot/config.json` holds every capability toggle. It is
   writable by `write_file` today. Any write to it should be step-up, no exceptions — an agent that
   can flip `autonomousMode` can flip everything else.

---

## 11. UI (your call: light default, dark at night; full redesign later with a preview)

`src/index.html` is 4,361 lines built on ~14 CSS custom properties (`--bg #090d13`,
`--accent #00c8ff`, …) with `voicefirst` layered additively. Two obstacles: values hardcoded
outside the token set (`rgba(0,200,255,.10)` appears throughout), and the app has not run since
2 Sep, so nothing can be verified live.

**Now:** a light palette becomes the default identity, with an automatic switch to the existing
dark HUD at night (sunset/sunrise from `config.geo`, which is already set to Atco NJ, with a manual
override). Delivered as a token-layer change plus a sweep of the hardcoded values — the DOM and JS
are untouched.

**Later:** a full redesign, as a rendered preview before anything is applied.

---

## 12. What changed from `M5_TUNING_PLAN.md`

| Item | Then | Now |
|---|---|---|
| Local tier's job | offload background loops | **tier 1 of a cascade** with ensemble escalation, incl. foreground chat |
| Local tool access | not considered | **the point** — §5 makes 8-tool categories tool-callable |
| Fable | kept for fan-out (roomier OTPM) | **removed**; fan-out spreads across providers instead |
| OpenAI | not in scope | **first-class tool-calling provider** |
| Voice | "latency" only | **explicit session model** — the ChatGPT-voice target |
| Tool retrieval | left alone | **redesigned**; the 25,531-token fallback is deleted |
| Making tools | ceiling to raise later | **cause identified** — 2,500 tokens of always-on schema |
| Agent shapes | four | **five** — the Custodian, and ask-by-default |
| Memory | a store to keep fast | **wired into tools and agents**; actions become nodes |

**Still valid, unchanged:** every measurement in §1 of that document; the three RAM tiers and
presence detection; parallel verify (46.4 s → ~9 s); per-tier model residency; the scheduler
permanent-error backoff; `MLX_BASE` back to 7B; the governor thresholds rescaled for 24 GB.

**Now wrong:** "leave `wireCapTokens` alone — hardware doesn't move it." Still true that RAM
doesn't move it, but §5 frees ~2,400 tokens on every turn, which is working memory returned for
free. The knob doesn't move; the headroom does.

---

## 13. Sequence

| Phase | Work | Gate | State |
|---|---|---|---|
| **0** | Scheduler permanent-error backoff · prune 365 stale results · `publicHost` · doc drift | `npm run verify` | **started** |
| **1** | `lib/toolcatalog.js` — tree, resolver, `toolbox`, shrunken CORE | new test suite green; token cost measured, not estimated | **started** |
| **2** | `lib/providers.js` — anthropic/openai/ollama with real tool-calling; Fable removed | round-trips a tool call on all three | |
| **3** | `lib/voicesession.js` — the state machine; wake word only at session entry | every transition asserted, `tts-idle` invariant included | |
| **4** | `lib/custodian.js` — acceptance, send-back, park-and-ask; ask by default | a deliverable that ignores the prompt gets caught | |
| **5** | UI: light default + night switch | screenshot once the app can run | |
| **6** | `lib/cascade.js` — confidence, ensemble escalation, spoken warning | blind A/B you sign off on | |
| **7** | Memory: action nodes, tool-side reads, local gardener | graph contains actions; links explained at $0 | |
| **8** | Loop retention · anti-escape controls | a drone cannot spawn a wider child | |
| **9** | Performance: parallel verify, tier residency, presence detection (`M5_TUNING_PLAN.md` §3–4) | no swap under any tier | |
| **10** | Making tools return · full UI redesign preview | | |

Order is by *dependency*, not by value. §5 comes first because the context budget it frees is what
makes the local tier viable (§6), what lets the making tools come back (§10), and what the
Custodian needs room to run inside (§4).

---

## 14. Open

- **Exact OpenAI model IDs for "terra/astra."** Config-driven, so code lands without them.
- **Ensemble membership.** Which local models vote at tier 2 — needs the A/B data first.
- **Whether the light theme keeps the HUD identity at all.** Deferred to the redesign preview.
- **Cloud parity.** Everything here is desktop-side. `cloud/src/` has its own `toolselect`, `graph`
  and `agent` — each change in §2–§8 has a cloud twin that is currently out of scope but will drift
  if left unnamed.
