# Bhatbot — Adaptive Preference Learning Plan

Goal: Bhatbot learns from how Siddhant responds and adapts natively to his
preferences — without him having to spell them out — while staying corrigible
(never drifting into behavior he didn't sanction).

---

## Current state (shipped)
- Flat `~/.bhatbot/memory.md` injected on every call (`## Preferences & Patterns` section).
- `save_memory(section, content)` tool — model decides when to persist.
- System prompt instructs: capture corrections + preferences as they happen.

This already gives *explicit* memory. The gap: nothing **detects** preference
signals automatically, nothing **retrieves selectively** (whole file dumped),
and there's no **feedback channel** to reinforce/penalize behavior.

---

## What to learn from (signal taxonomy)
| Signal | Example | Inferred preference |
|--------|---------|---------------------|
| Direct correction | "no, don't ask — just do it" | autonomy ↑ |
| Restated request | rephrases after a bad answer | answer format/altitude |
| Style edits | shortens Bhatbot's verbosity | terser output |
| Tool acceptance | approves/denies confirm modal | trust level per command class |
| Repetition | asks same class of task weekly | recurring task → proactive candidate |
| Explicit 👍/👎 | new reaction buttons (Phase 1) | reward signal |
| Abandonment | closes window mid-answer | answer missed the mark |

---

## Mechanism — capture → store → retrieve → apply

### 1. Capture (the missing piece)
After each exchange, run a cheap **Haiku "reflection" pass** (async, off the
critical path) that reads the last user turn + Bhatbot turn and emits 0–2
structured preference deltas:
```json
{ "type":"preference|correction|recurring|fact",
  "scope":"global|project:nexus|tool:run_shell",
  "statement":"Wants shell commands run without narration",
  "confidence":0.0-1.0, "evidence":"<quoted user text>" }
```
Only deltas with confidence ≥ 0.6 are written. Reflection is the "do the work
at storage time, not retrieval time" principle (Mem0).

### 2. Store — three-tier memory (Letta/MemGPT pattern)
- **Core** (always injected, ~small): identity + active projects + top-N
  highest-confidence, most-reinforced preferences. Hard cap (~1.5k tokens) so
  context can't bloat to the 80–120k figure the research warns about.
- **Recall** (queried): full preference/decision history + recent sessions in a
  local vector store (sqlite-vec or Chroma, on-device, free). Retrieved by
  semantic + keyword + scope match.
- **Archival** (cold): completed work, old decisions. Pulled only on explicit ask.

`memory.md` stays as the **human-readable mirror** of Core (so Siddhant can edit
by hand), but the source of truth becomes the indexed store.

### 3. Retrieve (selective injection)
Replace "dump whole file" with: inject Core always + top-5 recall hits for the
current query (semantic similarity over the embedded preference statements).
Cuts repeated input tokens and keeps the model on-preference without noise.

### 4. Apply (reinforcement + decay)
Each preference carries `confidence`, `hit_count`, `last_seen`.
- Honoring a preference and *not* getting corrected → confidence ↑ (reinforce).
- Getting corrected against it → confidence ↓ or invert.
- Unused for N weeks → decay (so stale prefs fall out of Core).
This is a lightweight bandit: behaviors that keep working get promoted into Core;
ones that get corrected get demoted.

### 5. Corrigibility guardrails (important)
- **Propose, then auto-promote.** New preferences enter at `confidence 0.6` and
  only affect *style/altitude* immediately. Anything that changes **autonomy or
  tool-risk** (e.g. "stop asking before X") requires one confirmation the first
  time, then auto-applies — logged to `Decisions Log`.
- `## Preferences & Patterns` is always human-auditable + editable in `memory.md`.
- A `/forget <statement>` command and weekly digest ("here's what I learned about
  you this week — keep/drop?") prevent silent drift.

---

## Phased roadmap (folds in the Jarvis capability research)

### Phase 1 — Feedback loop (small, high value) — NEXT
- 👍/👎 buttons on bot messages → writes reward to the active preference(s).
- Async Haiku reflection pass after each turn (capture step above).
- Keep flat `memory.md`; just start *writing better deltas* to it.
- **Why first:** unblocks learning with zero new infra.

### Phase 2 — Three-tier memory + selective retrieval
- Add local vector store (sqlite-vec). Migrate `memory.md` → Core mirror + recall index.
- Top-5 retrieval injection; confidence/decay scoring.
- Directly fixes the context-bloat risk (Mem0 / Letta).

### Phase 3 — Proactive loop
- 8am Launch Agent cron → morning briefing: GitHub notifs, Supabase error logs,
  PRISM/FABLE/Nexus deploy + 500-rate status → macOS notification.
- **Deployment watchdog:** poll Cloudflare Workers (PRISM, FABLE) every 30 min;
  alert on 500 spike or saliency→0 (would've caught the FABLE detach() bug live).
- **Paper monitor:** nightly Semantic Scholar watch for new cites of PRISM
  competitors (Marsh 2013, Path-LZerD) → ping on relevant drops.

### Phase 4 — Sub-agent delegation
- LangGraph-style graph: long tasks ("draft a PRISM section") spawn
  research → writing → review sub-agents, Bhatbot synthesizes. Each sub-agent
  inherits Core memory but runs its own loop.

### Phase 5 — Local model + always-on voice
- OpenJarvis/Ollama backend: route trivial queries to a local model (MLX on
  Apple Silicon) → near-zero cost/latency; cloud fallback for reasoning. Extends
  the existing Haiku/Sonnet router with a third "local" tier.
- Wake word "Hey Bhatbot": Porcupine (offline) or local Whisper for always-listening,
  replacing push-to-talk. (Queued — wiring after you finish testing the agent.)

### Optional — n8n backbone
- Wire tool outputs into n8n for no-code chains (CC run → commit → Vercel deploy →
  Bhatbot notified) if custom orchestration gets heavy.

---

## Immediate next step
Phase 1 is ~1 file of changes (reflection pass + reward buttons). Say go and I
wire it alongside the Porcupine wake word.
