# BhatBot Architecture v2 — Workspace-Based Multi-Agent System

Lead-architect redesign. Goal: turn BhatBot from a single-agent chat loop into a
**workspace-scoped, multi-agent orchestrator** that runs large projects indefinitely
without context blowup, staying under **$10/mo** by routing most work to local Ollama
models and calling Claude only when it earns its cost.

Status legend: ✅ exists · ⬜ to build · ⚠️ partial/refactor

---

## Build status (as of Pass 22)

| Piece | Status | Notes |
|---|---|---|
| Workspace mgr `lib/workspace.js` + `scripts/ws.js` | ✅ built, tested | create/load/active; cold-load = working set only |
| Structured state `lib/state.js` + schemas | ✅ built, tested | enum transitions, applyUpdates, snapshot, digest |
| Semantic memory `lib/memory.js` | ✅ built, tested | Ollama embed + lexical fallback, cosine top-k, dedup, rollup |
| Protocol `lib/agents/protocol.js` | ✅ built, tested | task/result envelopes, applyResult, decisions log |
| Router `lib/router.js` | ✅ built | local-first chains, escalation, cost governor; installed-model defaults |
| Base + orchestrator + roles | ✅ built | plan→dispatch→integrate; **agent tool-execution not yet wired (see gap)** |
| Context mgr `lib/context.js` | ✅ built, tested | checkpoint/resume/prune/summarize |
| Wiring into `main.js` | ✅ `delegate_project` tool + `orchestratorAdapters()` | reuses app's model callers |
| CLI `scripts/orchestrate.js` / `resume.js` | ✅ built | run/resume a goal without Electron |
| Trellis `lib/integrations/trellis.js` | ✅ built (needs key) | PiAPI submit/poll/download |
| **Gaps / next** | ⬜ | (1) give agents real tool execution in `base.js` (fs/shell/playwright per role) — today agents emit result envelopes but don't run tools; (2) `lib/inspect.js` vision dev-loop (P6); (3) `scripts/migrate-memory.js` flat memory.md → workspace; (4) parallel task dispatch; (5) image local pipeline |

The plumbing (plan → typed dispatch → structured integrate → persist → checkpoint) is
end-to-end working. The remaining lift is wiring each role's *tools* into `base.js` so a
Coding Agent actually edits files and a Browser Agent actually drives Playwright (the tool
implementations already exist in `main.js` `executeTool` — they just need exposing per-role).

---

## 0. Design principles (the whole thing in five lines)

1. **State, not transcript.** The durable record is structured JSON, never chat history.
2. **Context is rented, not owned.** Each agent gets a freshly-assembled, minimal prompt and is destroyed after the task. No agent accumulates history.
3. **Local-first.** Claude is the escalation path, not the default. Every task starts on the cheapest model that can plausibly do it.
4. **Workspaces are isolated.** A project loads its own state; global memory is never pulled in wholesale.
5. **Communication is typed.** Agents exchange JSON envelopes that validate against a schema, not free text.

---

## 1. Workspace System ⬜

### Layout

```
~/.bhatbot/workspaces/<slug>/
├── workspace.json        # id, name, slug, created, model_prefs, integrations
├── goals.json            # north-star + sub-goals, acceptance criteria
├── state.json            # structured component state (the "facts") — see §2
├── decisions.json        # append-only decision log (ADR-lite)
├── tasks.json            # task queue/graph (orchestrator's working set)
├── checkpoints/          # rolling session checkpoints (§4)
│   └── 2026-06-07T11-30.json
├── memories/             # semantic memory (embeddings + chunks), sharded
│   ├── index.sqlite      # sqlite-vec: vector(chunk_id) + metadata
│   └── chunks/           # raw chunk text, content-addressed by hash
├── artifacts/            # generated outputs: meshes, images, reports, builds
└── source/               # the actual project code (git repo, optional symlink)
```

### Rules

- **One workspace per project.** `WorkspaceManager.create(name)` → slug, scaffolds all files.
- **Active workspace** is a pointer in `~/.bhatbot/config.json` (`activeWorkspace: slug`).
- **Loading a workspace never reads global `memory.md`.** It loads `goals.json` +
  `state.json` + open `tasks.json` rows only. Total cold-load budget: **< 4k tokens**.
- **Millions of tokens of history** live in `memories/` (vectors on disk) and
  `decisions.json` (append-only). They are *retrieved*, never *loaded whole*.
- **State persists between sessions** because it's all on disk; a session is just an
  in-memory orchestrator pointed at a workspace.

### Module: `lib/workspace.js` (scaffolded)

```js
const ws = require('./lib/workspace');
const w = ws.create('Trellis Pipeline');   // → { slug, dir }
ws.setActive(w.slug);
const live = ws.load(w.slug);               // { workspace, goals, state, tasks } — small
ws.list();                                  // [{slug,name,updated}]
```

Cold-load contract: `ws.load()` returns *summaries*, not full files. `decisions.json`
and `memories/` are opened lazily via `lib/state.js` / `lib/memory.js`.

---

## 2. Structured State Memory ⬜

The single biggest context saver. We stop narrating and start recording **facts**.

### State vs. Semantic memory

| | **State** (`state.json`) | **Semantic memory** (`memories/`) |
|---|---|---|
| Shape | Typed JSON objects, one per component | Embedded text chunks |
| Question it answers | "What *is* true right now?" | "What did we say/learn about X?" |
| Size | Small, bounded (overwrites) | Large, append-only (millions of tokens) |
| Loaded | Always (it's tiny) | Only top-k by vector search |
| Mutability | Overwrite-in-place + version bump | Immutable chunks; new facts = new chunks |
| Cost to read | ~0 (it's the working set) | 1 embed + 1 sqlite query |

> Rule of thumb: if a future agent needs it to *decide what to do*, it's **state**.
> If it only needs it to *understand why*, it's **memory**.

### Schema — `state.json`

```json
{
  "version": 42,
  "updated": "2026-06-07T11:30:00Z",
  "components": {
    "trellis": {
      "status": "partial",          // planned|partial|working|broken|blocked|done
      "facts": {                     // arbitrary typed key/values — the real data
        "mesh_export": true,
        "uv_mapping": false,
        "api_endpoint": "https://api.trellis...",
        "max_resolution": 512
      },
      "blockers": ["uv_mapping fails on non-manifold meshes"],
      "refs": ["dec_0007", "mem_a91f"],   // links to decisions / memory chunks
      "updated": "2026-06-07T11:29:00Z",
      "rev": 5
    }
  },
  "metrics": { "tokens_today": 18450, "cost_month_usd": 3.12 }
}
```

Each component validates against `lib/schemas/component.schema.json` (scaffolded).

### State update rules

1. **Overwrite, don't append.** `state.set('trellis.facts.uv_mapping', true)` mutates in
   place and bumps `rev` + top-level `version`.
2. **Status is an enum.** Transitions are validated (`planned→partial→working→done`,
   any→`broken`/`blocked`). Illegal transitions throw.
3. **Every write is journaled** to `decisions.json` *only if* it's a decision (see §2
   compression), otherwise it's a silent state mutation. State writes are cheap; the log
   is for the "why."
4. **Conflicting facts resolve by recency + agent trust.** A Coding Agent's claim about
   code beats a Research Agent's guess. Trust ranks live in `protocol.js`.

### Memory compression rules

The Memory Agent (§3) runs these to keep `memories/` lean and `state.json` authoritative:

- **Narrative → fact.** "We discussed Trellis and decided mesh export works but UV
  mapping doesn't" → upserts `components.trellis.facts.{mesh_export:true, uv_mapping:false}`
  and drops the narrative (or stores a one-line chunk for provenance).
- **Dedup by embedding.** New chunk with cosine > 0.92 to an existing chunk → merge,
  keep newest, increment a `seen` counter instead of storing twice.
- **Decay + rollup.** Chunks older than N days with `seen < 2` get rolled into a single
  summary chunk per topic (cluster → 1 summary). Raw chunks move to `memories/cold/`.
- **State supersedes memory.** If a fact is in `state.json`, its source narrative chunks
  are demoted (not retrieved by default) — state is the answer, memory is the citation.

### Module: `lib/state.js` (scaffolded)

```js
const State = require('./lib/state');
const s = State.open(workspaceDir);
s.get('trellis');                       // component or undefined
s.set('trellis.facts.uv_mapping', true);// overwrite + bump rev/version
s.setStatus('trellis', 'working');      // validated transition
s.snapshot();                            // {version, components} small object for prompts
s.diff(fromVersion);                     // changed components since v (for checkpoints)
```

---

## 3. Multi-Agent Architecture ⬜

Six roles. Each is a **stateless function** `run(task) → envelope`. They never see chat
history — only the task envelope the Orchestrator hands them.

```
                          ┌─────────────────────────┐
            user ───────► │     ORCHESTRATOR        │ ◄── state.json / tasks.json
                          │  (plan → dispatch →     │
                          │   integrate → persist)  │
                          └───────────┬─────────────┘
            structured task envelopes │ (JSON, schema-validated)
        ┌──────────┬──────────┬───────┴────┬───────────┬───────────┐
        ▼          ▼          ▼            ▼           ▼           ▼
   ┌────────┐ ┌────────┐ ┌────────┐  ┌─────────┐ ┌────────┐ ┌──────────┐
   │ Coding │ │Research│ │Browser │  │ Memory  │ │Creative│ │ (future) │
   │ Agent  │ │ Agent  │ │ Agent  │  │ Agent   │ │ Agent  │ │  agents  │
   └───┬────┘ └───┬────┘ └───┬────┘  └────┬────┘ └───┬────┘ └──────────┘
       │ result envelopes (only) ─────────┴──────────┘
       ▼
  Orchestrator integrates → updates state.json/tasks.json/decisions.json → next task
```

### Agents

| Agent | Default model | Job | Tools |
|---|---|---|---|
| **Orchestrator** | Qwen (plan), Claude (hard plans) | Decompose goal→tasks, dispatch, integrate results, own state | none (pure planning) |
| **Coding** | Qwen-coder → Claude | Write/edit/run code, tests | fs, shell, source/ |
| **Research** | Gemma/Qwen | Read docs/web, extract facts | web fetch, search |
| **Browser** | Gemma/Qwen | Playwright drive + visual inspect | playwright, screenshot |
| **Memory** | Gemma/Qwen | Compress narrative→state, embed, retrieve | sqlite-vec, embeddings |
| **Creative** | Trellis/SD APIs + local | 3D + image gen | trellis, image pipeline |

### Communication protocol — the envelope

Every dispatch and every result is one of these (validated against
`lib/schemas/envelope.schema.json`):

**Task envelope** (Orchestrator → Agent):

```json
{
  "kind": "task",
  "id": "t_0042",
  "agent": "coding",
  "goal": "Add UV unwrap step to trellis exporter",
  "context": {                         // ONLY what this agent needs — assembled fresh
    "state": { "trellis": { "...": "subset" } },
    "memory": ["mem chunk 1", "mem chunk 2"],   // top-k retrieved, capped
    "files": ["source/trellis/export.py"],       // paths, not contents (agent reads)
    "constraints": ["no new pip deps", "keep <200 lines"]
  },
  "expects": "patch",                  // patch|facts|report|artifact|answer
  "budget": { "model": "auto", "max_tokens": 4000, "max_usd": 0.05 }
}
```

**Result envelope** (Agent → Orchestrator):

```json
{
  "kind": "result",
  "task_id": "t_0042",
  "agent": "coding",
  "status": "ok",                      // ok|partial|failed|needs_input
  "summary": "Added uv_unwrap(); tests pass",   // 1 line, goes to log
  "state_updates": [                   // structured deltas the orchestrator applies
    { "path": "trellis.facts.uv_mapping", "value": true },
    { "path": "trellis.status", "value": "working" }
  ],
  "artifacts": ["source/trellis/export.py"],
  "memory_writes": [                   // narrative worth keeping → Memory Agent embeds
    { "text": "UV unwrap uses xatlas; fails on non-manifold; added guard", "tags": ["trellis"] }
  ],
  "decision": { "what": "use xatlas for UV", "why": "only lib with manifold guard", "alts": ["blender bpy (heavy)"] },
  "next": [                            // proposed follow-up tasks (orchestrator decides)
    { "agent": "browser", "goal": "render exported mesh, verify UVs visually" }
  ],
  "cost": { "model": "qwen2.5-coder", "tokens": 3100, "usd": 0 }
}
```

**Why this matters:** the Orchestrator never re-reads an agent's reasoning. It reads
`summary` (1 line) + applies `state_updates` (structured) + queues `next`. The agent's
multi-thousand-token thinking is **discarded** — that's the context firewall.

### Independence

- Agents run in **child processes** (or `worker_threads`) so a crash/hang is isolated and
  killable (we already learned the "kill by port" lesson — same discipline).
- Agents share nothing but the workspace dir on disk + the envelope passed in.
- Two agents of different roles can run **in parallel** when the orchestrator's task graph
  marks tasks independent (`tasks.json` edges).

### Modules (scaffolded)

```
lib/agents/protocol.js     // envelope build/validate, trust ranks, applyResult()
lib/agents/base.js         // runAgent(role, task): assemble prompt, call router, parse
lib/agents/orchestrator.js // plan(goal)→tasks, dispatch loop, integrate
lib/agents/roles/coding.js // role specs: system prompt, allowed tools, output parser
lib/agents/roles/research.js
lib/agents/roles/browser.js
lib/agents/roles/memory.js
lib/agents/roles/creative.js
```

---

## 4. Context Management System ⬜

Guarantees a project runs forever without exceeding limits.

### Mechanisms

1. **Per-task fresh context.** This is the core defense. An agent's prompt is *assembled*
   from state+memory each call (§3), so context is **O(task)**, never **O(history)**.
   `capTokens()` (✅ already in main.js) stays as the per-call backstop.

2. **Checkpoint generation.** After every N integrations (default 5) or on session end,
   `lib/context.js#checkpoint(ws)` writes `checkpoints/<ts>.json`:
   ```json
   { "version": 42, "open_tasks": [...], "recent_decisions": ["dec_0040","dec_0041"],
     "state_digest": "trellis: working (uv ok, textures todo); exporter: done",
     "next_actions": ["render verify", "wire texture bake"] }
   ```
   A checkpoint is a **resume token**: a new session loads it instead of any transcript.

3. **Context pruning.** The orchestrator keeps a bounded working set in RAM: last K result
   `summary` lines + current task subtree. Anything older is already in
   state/decisions/memory on disk → dropped from RAM. Hard cap enforced (`MAX_WORKING=20`).

4. **Task summarization.** When a task subtree completes, `summarizeSubtree()` replaces its
   N child result lines with **one** rollup line in `tasks.json` (`status: done, summary`).
   The children move to a closed-tasks shard. Tree stays shallow.

5. **Session restart capability.** `bhatbot resume <workspace>` → loads latest checkpoint +
   state snapshot + open tasks. **Zero** prior transcript needed. Identical behavior to a
   warm session because all the truth is on disk.

6. **Automatic memory compression.** Memory Agent runs §2 compression on a timer / on
   checkpoint: narrative→facts, dedup, decay-rollup. `memories/` grows sub-linearly.

### The indefinite-runtime guarantee

Context per active step ≤ `state_snapshot (~2k) + top-k memory (~2k) + task (~1k) +
working_set (~2k)` ≈ **~7k tokens**, *independent of project age*. A 6-month, 5M-token
project and a 1-day project present the **same** prompt size to any agent.

### Module: `lib/context.js` (scaffolded)

```js
const ctx = require('./lib/context');
ctx.checkpoint(wsDir);              // write resume token
ctx.resume(wsDir);                  // latest checkpoint → orchestrator seed
ctx.assemble({ state, task, k });   // build minimal agent context (state subset + mem top-k)
ctx.prune(workingSet);             // enforce MAX_WORKING
```

---

## 5. Local-First Model Routing ⬜ (extends ✅ `taskClassifier.js` + `callModel`)

### Routing table

| Task class | Primary | Escalate to | When escalate |
|---|---|---|---|
| Simple chat / format / classify | Gemma/Qwen | Haiku | local empty/garbled 2× |
| Memory ops (embed, compress, retrieve) | Gemma/Qwen | — | never (deterministic-ish) |
| Browser automation (decide next action) | Gemma/Qwen | Haiku | DOM ambiguous, 2 failed steps |
| Research / extract | Gemma/Qwen | Sonnet | conflicting sources, low confidence |
| **Coding** | **Qwen-coder** | **Sonnet → Opus** | tests fail 2×, multi-file refactor, "hard" tag |
| 3D generation | Trellis API | — | (it's the only path) |
| Image generation | local SD/ComfyUI | Replicate (✅) | local pipeline absent/fails |
| Planning (orchestrator) | Qwen | Sonnet | goal complexity score > threshold |

### Escalation criteria (concrete, in `lib/router.js`)

A task escalates when **any** fires:
- `attempts >= local_retry_limit` (default 2) and result `status != ok`.
- Self-reported `confidence < 0.55` (agents emit confidence in result envelope).
- Verifier failed: code didn't compile / tests red / JSON didn't validate.
- Complexity score (`scoreComplexity(task)`: files touched, goal length, "refactor/design/
  architecture" keywords, cross-component refs) ≥ tier threshold.
- Explicit `budget.model` override or `goal` tagged `[claude]`.

### Fallback behavior

- **Claude unavailable / rate-limited** (✅ `rateBudget()`/`anthropicRequest`): fall back
  *down* to best local model + flag result `degraded:true` so orchestrator can re-queue
  later, or notify+reset (✅ existing behavior).
- **Local model unavailable** (`ollamaUp()` false): jump straight to Haiku for cheap tasks,
  Sonnet for coding; warn once.
- **Both down:** queue task `status:blocked`, checkpoint, notify user. No crash, no loss —
  resumable.

### Cost governor (keeps it < $10/mo)

`router.js` tracks `state.metrics.cost_month_usd`. At 80% of `$10` it forces
`local-only mode` for everything except tasks explicitly tagged `[claude]`, and notifies.
Reset monthly. Estimated steady-state: ~90% tokens local ($0) + occasional Sonnet coding
bursts → well under $10.

### Module: `lib/router.js` (scaffolded)

```js
const router = require('./lib/router');
const choice = await router.pick(task, { config, metrics });
// → { provider:'ollama'|'anthropic'|'trellis'|'replicate', model, reason }
const out = await router.run(choice, prompt, { tools });   // unified call surface
router.recordCost(choice, usage);                          // feeds cost governor
```

Wraps existing ✅ `ollamaChat`, ✅ `callClaude`/`anthropicRequest`. No reinvention.

---

## 6. Browser-Based Autonomous Development ⬜ (extends ✅ Playwright + browser_workflow)

### Loop

```
 user request
     │
     ▼
 ORCHESTRATOR ── plan ──► CODING AGENT ──writes code──► source/
     ▲                          │
     │                          ▼
     │                    launch app (npm dev / serve / electron)
     │                          │
     │                          ▼
     │                    BROWSER AGENT ── navigate + screenshot ──► artifacts/shot.png
     │                          │
     │                          ▼
     │                    VISUAL INSPECT (vision model: Claude vision OR local llava)
     │                    → structured findings: [{severity, where, issue, fix_hint}]
     │                          │
     │              findings empty? ──yes──► DONE (state: working) ─────────────┐
     │                          │ no                                            │
     └──────── feedback task ◄──┘   (Coding Agent applies fix_hints)           │
                                                                                ▼
                                                          orchestrator persists state
```

### Implementation plan

1. **`lib/agents/roles/browser.js`** — actions: `launch(cmd, url)`, `goto`, `act`
   (click/type via existing recorder selectors), `screenshot()→artifacts/`, `console_logs()`,
   `a11y_tree()` (cheap structured DOM for local models instead of raw HTML).
2. **`lib/inspect.js`** — `inspect(screenshotPath, goal)` → calls a **vision** model
   (router: local `llava`/`qwen2-vl` first, Claude vision on escalation) → returns
   `findings[]` validated against `inspect.schema.json`. Prompt asks for *structured*
   defects only, no prose.
3. **Feedback loop driver** in orchestrator: `runDevLoop(goal, {maxIters:5})` —
   code→launch→shot→inspect→ (findings? code : done). Each iteration is its own task pair,
   so context stays flat; only `findings` (structured) cross the boundary.
4. **Guardrails:** max iterations, diff-size cap per iter, auto-`git commit` per accepted
   iteration in `source/` (rollback = checkout), kill app process on each cycle (port
   discipline). On no-progress (same findings 2×) → escalate coding model, then ask user.
5. **Reuse** ✅ `browser_workflow` recorder for deterministic replay of known UI flows
   (login, navigate to the screen under test) so the loop starts from the right state.

---

## 7. Implementation Roadmap

Complexity: ◐ small (≤0.5d) · ◑ medium (1–2d) · ● large (3–5d)

### Phase 1 — Core workspace architecture ◑
- **Create:** `lib/workspace.js`, `lib/schemas/{workspace,goals,tasks}.schema.json`,
  `scripts/ws.js` (CLI: `ws create|list|use|show`).
- **Modify:** `main.js` (add `activeWorkspace` to config, `getWorkspace()` helper, route
  `agentLoop` to read active workspace), `mcp-server.js` (workspace-aware `runAgent`).
- **Detail:** scaffolding + load/save + active pointer. No agents yet; existing single
  loop keeps working but now writes into a workspace.
- **Diagram:** §1.

### Phase 2 — Structured memory system ◑
- **Create:** `lib/state.js`, `lib/memory.js` (sqlite-vec + Jina/local embeddings, lifted
  from Nexus), `lib/schemas/{state,component,decision}.schema.json`.
- **Modify:** `main.js` agentLoop to record `state_updates` + `memory_writes` instead of
  appending to flat `memory.md`; add migration `scripts/migrate-memory.js`
  (memory.md → state facts + embedded chunks).
- **Detail:** §2 schema + update/compression rules. Memory Agent stub does compression.
- **Diagram:** §2 table.

### Phase 3 — Multi-agent orchestration ●
- **Create:** `lib/agents/{protocol,base,orchestrator}.js`, `lib/agents/roles/*.js`,
  `lib/schemas/envelope.schema.json`.
- **Modify:** `main.js` — replace the monolithic `agentLoop` tool-loop with
  `orchestrator.run(goal, ws)`; keep existing TOOLS but expose them per-role; child-process
  runner. `taskClassifier.js` feeds orchestrator planning.
- **Detail:** §3 envelopes, trust, parallelism, process isolation.
- **Diagram:** §3.

### Phase 4 — Context optimization ◑
- **Create:** `lib/context.js`, `scripts/resume.js` (`bhatbot resume <ws>`).
- **Modify:** orchestrator to checkpoint every N + on exit, prune working set, summarize
  subtrees; `main.js` boot path to offer "resume <ws>".
- **Detail:** §4 — checkpoints, pruning, rollups, the ~7k flat-context guarantee.
- **Diagram:** §4.

### Phase 5 — Trellis integration ◑
- **Create:** `lib/agents/roles/creative.js`, `lib/integrations/trellis.js`
  (submit mesh job, poll, download to `artifacts/`), `lib/schemas/creative.schema.json`.
- **Modify:** TOOLS (`generate_3d`), router 3D row, config (`trellisApiKey`).
- **Detail:** mesh export + UV + texture status tracked as `state.components.trellis.facts`
  (closes the very example in the brief).
- **Diagram:** Creative branch of §3.

### Phase 6 — Autonomous development loop ●
- **Create:** `lib/inspect.js`, `lib/agents/roles/browser.js` (dev-loop actions),
  `lib/schemas/inspect.schema.json`.
- **Modify:** orchestrator `runDevLoop()`, reuse `browser_workflow` recorder, vision
  routing in `router.js`.
- **Detail:** §6 — code→launch→shot→inspect→fix loop with guardrails.
- **Diagram:** §6.

### Dependency order
`P1 → P2 → P3 → {P4, P5, P6}` (P4/5/6 parallelizable once P3 lands).

### Migration / backward-compat
- Existing single-agent `agentLoop` stays callable as a "no-workspace" default until P3
  flips the entrypoint. `media_control`, TTS, Spotify, voice — untouched throughout.
- All new state lives under `~/.bhatbot/workspaces/`; nothing existing is deleted.

---

## Appendix A — File manifest (new)

```
lib/
├── workspace.js          P1
├── state.js              P2
├── memory.js             P2
├── context.js            P4
├── router.js             P5-routing (stub P3)
├── inspect.js            P6
├── integrations/trellis.js   P5
├── agents/
│   ├── protocol.js       P3
│   ├── base.js           P3
│   ├── orchestrator.js   P3
│   └── roles/{coding,research,browser,memory,creative}.js  P3/P5/P6
└── schemas/
    ├── workspace.schema.json   P1
    ├── goals.schema.json       P1
    ├── tasks.schema.json       P1
    ├── state.schema.json       P2
    ├── component.schema.json   P2
    ├── decision.schema.json    P2
    ├── envelope.schema.json    P3
    ├── inspect.schema.json     P6
    └── creative.schema.json    P5
scripts/{ws,resume,migrate-memory}.js
```

## Appendix B — config additions (`~/.bhatbot/config.json`)

```jsonc
{
  "activeWorkspace": "trellis-pipeline",
  "models": {
    "local_simple": "gemma2:27b",
    "local_code":   "qwen2.5-coder:latest",
    "local_vision": "llava:latest",
    "claude_code":  "claude-sonnet-4-6",
    "claude_hard":  "claude-opus-4-8",
    "claude_cheap": "claude-haiku-4-5-20251001"
  },
  "budget": { "month_usd_cap": 10, "local_only_at_pct": 0.8 },
  "local_retry_limit": 2,
  "trellisApiKey": "..."
}
```
