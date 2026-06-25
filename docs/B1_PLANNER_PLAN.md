# B1 — Planner (the Legion's brain) · PLAN ONLY

Goal: turn a single high-level goal into a **structured execution plan** that the already-built Fleet runs — decompose → assign → schedule (parallel where independent, ordered where dependent) → execute → reflect. This is the difference between "spawn 3 agents and hope" and "Jarvis dispatches the legion with intent." Not yet implemented; this is the design.

## What it produces
`plan(goal) → { steps: [{ id, role, task, tools, model, dependsOn:[ids] }], rationale }`
- A small **task DAG** (≤6 parallel width per layer): independent steps run concurrently via `fleet()`, dependent steps wait for upstream results (which are passed in as context).

## Components
1. **`lib/planner.js`** (pure logic, DI like orchestrator):
   - `plan(goal, deps, opts)` — one planning model call (Sonnet, later Opus) that returns the DAG as structured JSON. Validates: acyclic, width ≤6, every `dependsOn` resolves.
   - `layers(steps)` — topological sort → array of parallel layers.
   - `runPlan(goal, deps, opts)` — plan → for each layer, `orchestrator.fleet(layer)` (reusing the live Legion relay + feedback), feeding each step its upstream results as context. Returns the assembled deliverable.
2. **Extended thinking** (prerequisite, plumb once): add the Anthropic `thinking` param to `anthropicRequest`/`anthropicStream`, gated to the `deep` depth tier (A3) and to the planning call — so decomposition actually reasons before splitting. Capture thinking blocks but never voice them.
3. **Pre-flight skeptic** (reuse C ensemble): before executing an expensive plan, run a one-shot `skeptic` pass over the proposed DAG ("what will this split get wrong?") and adjust. Cheap insurance against bad decomposition.
4. **Replan / reflexion**: if a suit fails or returns blocking info, re-invoke `plan()` on the *remaining* goal with the failure as context, and continue. Cap replans (e.g. 2) to bound cost.
5. **Meta-controller (B2 overlap)**: planner assigns per-step **model** (haiku=simple, sonnet=coding/reasoning), **tool subset** (run `toolselect` per subtask), and **thinking budget**. One place chooses model+tools+thinking per suit.

## Tool surface
- `plan_and_run` tool (or `fleet` gains a `goal` mode): `{goal, dryRun?}`. `dryRun:true` returns the DAG + rationale **without executing** (always show the plan first for big goals). Live execution streams to the Legion panel.

## Coding / site-dev specialization (ties to your priority)
- A coding plan assigns each suit its own **git worktree** (isolated branch) so parallel file edits don't collide; a final **merge step** (dependsOn all coding suits) reconciles; the **tester suit** (already built) validates the merged result. → multiple features built at once, then integrated + QA'd.

## Verification
- Unit: `plan()` returns a valid acyclic DAG, width ≤6, deps resolve; `layers()` orders correctly; `dryRun` never calls executeTool.
- Integration: a 3-step goal (2 parallel + 1 dependent) runs in the right order, downstream sees upstream output, Legion panel shows all suits.

## Risks / guards
- **Cost**: a planned fleet can fan out a lot. Gate with the cost telemetry + a **confirm card** when projected calls/spend exceed a threshold. (Especially relevant given the account spend-cap issue.)
- **Decomposition quality**: bad splits waste work → the pre-flight skeptic + dryRun review.
- **Deadlocks**: validate DAG acyclic before running.
- **Context bloat**: only pass each downstream step the upstream results it actually needs (by `dependsOn`), not the whole transcript.

## Effort / sequencing (~2 days)
1. `lib/planner.js` `plan()` + DAG validation + `dryRun` (½d)
2. extended-thinking plumb + gate (½d)
3. `runPlan` layered execution wired to `fleet()` + context passing (½d)
4. skeptic pre-flight + replan + meta-controller per-step model/tools (½d)

Depends on: C-Fleet (done ✅), A3 depth tiers (done ✅, drives thinking budget). Feeds: B2 meta-controller, coding-legion worktrees.
