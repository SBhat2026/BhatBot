# Phase 3 — Neural Depth: Implementation Notes & Judgment Calls

> Built 2026-06-26 against `BHATBOT_PHASE3_PROMPT.md`. Branch `phase3-neural-depth`, local commits only.
> Goal: cheaper long conversations by learning per-turn depth from data, tapering long threads, and
> recalling episodic memory by meaning instead of dumping the whole list.

**Environment note:** `~/.bhatbot/depth.jsonl` was **empty (0 rows)** at build time. So all three
deliverables run in their **graceful-degradation** mode right now (heuristic depth, no taper data yet
beyond the explicit multiplier, lexical-fallback embeddings). They activate automatically as data
accumulates and as Ollama embeddings come online — verified with synthetic data (see bottom).

---

## Deliverable 1 — Learned Depth Model (`lib/depthmodel.js`)

**Architecture: ridge linear regression (closed-form, pure JS) + residual-quantile margin.**
- Predicts **output tokens needed** from cheap per-turn features, then sets the ceiling at
  `predicted_mean + Z90·residualStd` (Z90 = 1.2816 → targets ~p90 of need). This is the same *intent*
  as the heuristic's p90+30%, but learned per feature-pattern instead of per-tier average.
- **Why ridge, not a torch MLP / sklearn:** must run locally, no API, <50 ms in the hot path, no new
  deps in an Electron app. A ~12-feature ridge solve is a tiny `(XᵀX+λI)⁻¹Xᵀy` (Gaussian elimination,
  λ=1.0); inference is a 12-dim dot product (microseconds). An MLP buys nothing at this feature count
  and this data scale, and adds a runtime + artifact-format burden. Quantile margin gives the
  "uncertainty" the spec asked for without a heavier quantile-regression fit.
- **Features** (`FEATURES`, persisted in the artifact): query length in tokens, intent flags
  (`f_ack/f_detail/f_deep`), conversation position, prior-output rolling mean, tier one-hot, correction
  flag. *Judgment call:* the intent flags are derived from the heuristic tier (the tier **is** the
  regex-hit outcome in `lib/depth`), rather than duplicating the regexes — defensible and avoids drift,
  documented here. Ridge's λ absorbs the resulting collinearity with the tier one-hot.
- **Fallback (silent, automatic):** `predict()` returns `null` when <200 rows **or** fit `r² < 0.10`
  **or** sample-scaled confidence is low → the caller (`sizeTurn`) keeps the `classifyDepth`+`depthCal`
  heuristic. The heuristic is **not** deleted; it is the fallback, exactly as required. No error is ever
  surfaced.
- **Retrain:** manual via `depthmodel.trainFromLog()`; automatic via `maybeRetrain()` (called from
  `logDepthOutcome`) once the log has grown by **500 rows** since the artifact's last train.
- **Artifact:** `~/.bhatbot/depth-model.json` — added to `.gitignore`, never committed.
- **Log enrichment:** `logDepthOutcome` now records the full feature row (the old schema only had
  `depth/alloc/out/clipped/surface`, which is insufficient to train the spec's feature set). Legacy
  rows still parse; `featurize()` tolerates missing fields.

---

## Deliverable 2 — Conversation-Position Taper (`lib/taper.js`)

- **Decay function:** identity through turn **15** (`START`); past it, **geometric decay**
  `factor = (1 − 0.04)^(position − 15)`, floored at **0.45** (`FLOOR`). So turn 30 ≈ 0.54×, turn 45 ≈
  0.30→floored 0.45×. *Why geometric + floored:* a long thread's ceilings should **ease** down (a
  status check at turn 30 rarely needs 8k tokens) without ever cliff-cutting a turn that legitimately
  needs room — the floor guarantees ≥45% of the sized ceiling always survives.
- **Dual use, as specified:** `position` is *also* a model feature (the model learns the same effect
  from data) **and** an explicit multiplier (works on day one with zero data).
- **Reset (suspend taper) — conservative by design:** resets to factor 1 only on a genuinely-new-task
  signal: explicit restart phrases (`new project`, `start over`, `from scratch`, `switch to`, …), a
  long fresh query (≥220 tokens), or a `deep`-tier ask >320 chars. Ordinary follow-ups ("ok", "and
  then?", "fix that") deliberately do **not** reset.
- **Transparency:** every allocation logs tier, position, source, base/sized/taper factor, and whether
  a reset fired (`depthDebug` config flag). `sizeTurn` also emits a `depth-update` IPC to the renderer
  for the VANGUARD HUD (best-effort; ignored if no panel), carrying `{depth, taperFactor, source,
  position, reset}`.

---

## Deliverable 3 — Episodic Vector Recall (`lib/episodic.js`)

- **Read-path only.** Touches neither `memory.md` nor the episodic note **write** path nor any schema —
  it reads `~/.bhatbot/notes/*.md` and a sidecar embedding cache. Confirmed: no write path changed.
- **Embedding approach:** reuses `lib/memory.js` `embed()` / `cosine()` — **Ollama `nomic-embed-text`
  locally** when available, **deterministic hashed-lexical vector fallback** offline. *Why:* it's the
  existing, dependency-free vector primitive already used by the semantic tier; no new model to ship.
- **Determinism:** per-note embeddings are cached by **content hash** (`.episodic-vec.json` sidecar,
  gitignored) so a note is embedded once and reused until its text changes; the query embed + cosine
  ranking are deterministic for the same query. No randomness in the production path.
- **Top-k:** `recall()` returns **≤10** entries (default k=8), replacing the lexical idf set in
  `buildMemoryBlock`. Falls back to the old `recallEpisodic` (lexical) when vector recall is empty/off.
  Pre-warmed via `refreshEpisodicVec` alongside the existing Notion/semantic async-cache pattern.
- **"Seen before?" short-circuit:** if the top-1 cosine ≥ **0.86** (`SEEN_THRESHOLD`, configurable via
  `episodicSeenThreshold`), a `## POSSIBLY ANSWERED BEFORE` block is injected **before generation**, so
  the agent confirms/extends/corrects rather than regenerating. *Why 0.86:* on `nomic-embed-text`,
  paraphrases of the **same** question typically land ~0.88–0.95 while merely **related** questions sit
  ~0.6–0.8; 0.86 captures near-duplicates without false "I answered this" hits on adjacent topics. It's
  a tunable starting point, logged on every hit so it can be calibrated against real data.

---

## Hard constraints — all honored

- Depth-model fallback to heuristic is automatic + silent (no user-facing error). ✓
- Episodic recall is read-path only; `memory.md` write path + schema untouched. ✓
- Every allocation logs taper factor + reset state (`depthDebug`). ✓
- Trained artifact gitignored, lives only in `~/.bhatbot/`. ✓
- <200 depth rows ⇒ all three degrade to prior behavior, no crash, no user-visible error (verified). ✓
- No remote push; commits on `phase3-neural-depth` only. ✓

---

## Verification (2026-06-26)

- `node scripts/verify-syntax.js` → ✓ 531 JS files parse (528 + depthmodel/taper/episodic)
- `node scripts/test-upgrade.js` → ✅ 48 passed, 0 failed (incl. the existing depth suite)
- Module unit checks (synthetic data):
  - depth: <200 rows → `predict`/`train` fall back (null/ok=false); 320 rows → r²≈0.999, deep+long
    ceiling **5376** > conversational+short **256**.
  - taper: pos5 = 1.00; pos30 = 0.54 (no reset); "start a new project from scratch" → 1.00 + reset;
    floor holds at 0.45 for very long threads.
  - episodic: photosynthesis query ranks the photosynthesis note #1; `seenBefore` fires; missing notes
    dir → `[]` (graceful). (Cosines shown were the lexical fallback — Ollama embeddings score higher.)
