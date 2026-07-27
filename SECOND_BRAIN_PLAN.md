# BhatBot Second Brain — "SYNAPSE"

**Goal (Siddhant's words):** a constantly-running background process that (1) finds connections
between projects in BhatBot's memory, (2) finds relevant information online without my input, and
(3) lets me view + prune it visually on the site whenever I want.

**Design stance (grounded in 2026 research):** the state of the art is *hybrid memory* — vector
similarity + a knowledge graph — with a *self-evolving* graph (agents recursively discover new links
and enrich from the web), *temporal provenance* on every fact (Zep-style: when learned, from where),
and a *human-in-the-loop curation* layer. We build exactly this on top of infra BhatBot already has,
rather than adopting a heavyweight external framework (Mem0/Zep/Letta) — our data is local + private
and the pieces already exist.

Sources reviewed: Mem0 hybrid vector+KG memory; Zep temporal knowledge graph; GraphRAG/HybridRAG
retrieval; self-evolving knowledge graphs via agentic systems (recursive link discovery); AI-Scientist-
style autonomous longitudinal research.

---

## What already exists (we reuse, not rebuild)
- `lib/semantic.js` — embedding vector store (OpenAI embeddings, cosine search). *Just fixed* (was 401'ing).
- `lib/graph.js` — knowledge graph: entities + typed relations, multi-hop `graph.query` (the "knowledge graph +N relations" you see).
- `lib/projects.js` — project records (summary, highlights, specs, artifacts, log).
- `lib/memmaint.js` — decay/dedup + a background scheduler (built for the always-on work).
- Scheduler (30s tick), patrol, self-drive — background-worker plumbing + guardrails.
- `web_search` / `research` / `browser` tools — the online-gathering hands.
- `cloud/` — an always-on Claude brain (SQLite/Fly). **DEPLOYED and live** at `bhatbot-cloud.fly.dev`
  (verified 2026-07-27: `/health` → 401, i.e. up and auth-gated). Note it runs a port of the *old*
  `lib/graph.js`, not `lib/brain.js` — there is no SYNAPSE in the cloud yet.
- D3 (used in the user's Nexus project) + Three.js (the FLEET office) — viz options.

## The gap (what's new)
1. No **unified hybrid store** — vectors, graph, and projects live in separate files with no shared node/edge model.
2. No **Connector** — nothing proactively proposes cross-project links.
3. No **Scout** — nothing autonomously pulls relevant web info per project.
4. No **viz + curation panel** — no way to see/prune the brain.
5. ~~No **always-on host**~~ — **CLOSED 2026-07-27.** This was the binding gap for the whole project:
   the workers lived inside the Electron main process and died with the window, so the brain had
   literally never been built. Now `lib/synapse.js` (pure + DI) runs in `scripts/synapse-worker.js`,
   a plain node LaunchAgent (`com.bhatbot.synapse`) that survives the window closing.

---

## Architecture — the SYNAPSE engine

### 1. Substrate — one hybrid knowledge graph (`lib/brain.js`, store `~/.bhatbot/brain/`)
A single node/edge model layered over the existing stores (does not duplicate them — it *references* them):
- **Nodes**: `{ id, type, label, refs, embedding?, importance, createdBy, createdAt, updatedAt, status }`
  - types: `project` (from projects.js), `concept`/`entity` (from graph.js), `memory` (from semantic.js), `finding` (web, new).
- **Edges**: `{ id, from, to, type, rationale, confidence, provenance, createdBy, createdAt, status }`
  - types: `relates-to`, `applies-pattern`, `derived-from`, `contradicts`, `cites`, `mentions`.
  - `status`: `proposed` → `confirmed` (reinforced / user-approved) → `pruned` (user rejected; never re-proposed).
  - `provenance`: worker + source (url/date for findings; the pair of memories for connections).
- Everything **temporal + sourced** — no edge without a rationale + provenance (no fabricated links).

### 2. Worker A — CONNECTOR (offline, no network)
Periodically finds cross-project connections from memory already on disk.
- Walk pairs of nodes from *different* projects; use existing embeddings → cosine similarity.
- For pairs above a threshold, a cheap LLM pass writes the `rationale` ("both use an idf-weighted
  retrieval refit — FABLE's refactor pattern applies to the uricase novelty filter") and a `confidence`.
- Dedup against existing edges; emit `proposed` edges. Incremental (N pairs/tick), idle-gated, budget-capped.

### 3. Worker B — SCOUT (online)
Autonomously enriches each active project with relevant new web info.
- Per active project, derive queries from its key terms (title, highlights, specs).
- Run `web_search`/`research` on a schedule; sanitize results (existing external-content guard).
- Score each hit by embedding similarity to the project; keep only high-relevance → `finding` nodes
  linked to the project, with url + date + snippet provenance. Dedup by URL + near-dup embedding.
- Hard budget (searches/day), idle-gated, pausable. Never auto-acts on findings — it only *surfaces* them.

### 4. Worker C — GARDENER (maintenance, reuses memmaint patterns)
- Decay stale low-confidence `proposed` edges/findings; merge duplicate nodes.
- Promote repeatedly-reinforced edges to `confirmed`; permanently drop `pruned` items.
- Learns thresholds from your prune/confirm actions (same ridge-model pattern as the router/spoken-length models).

### 5. Scheduler / host
- Connector ~ every 30–60 min; Scout ~ every few hours; Gardener ~ daily. All gated to idle + low CPU + on-power, budget-capped, pausable from the UI.
- Phase 1: runs inside the desktop app (background). Phase 5: also runs in the deployed cloud brain so it's
  *truly* always-on when the Mac is closed, syncing back (local ↔ cloud ↔ Notion).

### 6. Viz + curation panel — the "SYNAPSE" tab
A new nav-rail tab. A force-directed graph (nodes by type/importance, edges by confidence).
- **Inspect**: click a node → its memories/findings/provenance; hover an edge → the "why related" rationale.
- **Review queue** ("inbox"): newly `proposed` edges + fresh `findings` to Accept / Reject at a glance.
- **Prune**: delete any node/edge → marked `pruned`, Gardener never re-proposes it (this is the curation the user asked for).
- **Confirm/pin**: promote an edge; pin a node as important.
- **Filter**: by project / type / recency; search. Live-updates as workers add nodes.
- Viz tech: **D3 force graph** (2D, fast, matches Nexus) — recommended; alt is a Three.js 3D graph to match the office.

### 7. Safety / cost / trust
- Local-first: Connector uses embeddings already computed (near-zero cost). Scout is the only network spend — hard daily budget.
- Provenance on everything; findings always carry a real URL (no hallucinated sources).
- Idle/on-power gating + global pause; never interrupts an active turn (same rule as the health monitor).
- Human-in-the-loop: nothing is "truth" until confirmed; pruning is permanent and teaches the Gardener.

---

## Phasing (each phase independently useful; stop anywhere)
- **P0 — Substrate**: `lib/brain.js` + schema + import existing semantic/graph/projects into nodes. Tests. *(no UI, no workers)*
- **P1 — Connector + read-only viz**: propose cross-project edges; a SYNAPSE tab that just *renders* the graph. First "wow".
- **P2 — Curation**: prune / confirm / review-inbox + Gardener promote/decay + learned thresholds.
- **P3 — Scout**: autonomous web enrichment with budget; findings in the graph + inbox.
- **P4 — Learning**: threshold models from your curation; importance ranking; better rationales.
- **P5 — Always-on**: deploy the `cloud/` brain (Fly) so it runs 24/7 when the Mac is off; local↔cloud↔Notion sync.

## DECISIONS LOCKED (2026-07-11)
1. **Viz** → **Both**: D3 2D force-graph as the working/curation view + a Three.js 3D "constellation" toggle for show.
2. **Scout autonomy** → **Auto-add, prune later**: high-relevance findings auto-join the graph flagged `unreviewed`; Siddhant prunes the bad ones. (Hard daily search budget still applies.)
3. **Host** → **Deploy the cloud brain now** (Fly), so SYNAPSE is genuinely 24/7 from day one — pulled ahead of the original P5. *(Cloud deployed ✅ — but see the 2026-07-27 hosting decision below: the deploy alone did not deliver 24/7, because the workers never left the Electron process.)*
4. **Scope** → **BhatBot memory + ~/repos + Notion**: index project records, local repos, and Notion pages as nodes (denser graph; more ingest + noise to garden).

## Status (2026-07-27)

| Phase | State | Notes |
|---|---|---|
| **D0 — Cloud deploy** | ✅ **DONE** | Live at `bhatbot-cloud.fly.dev`. Runs the old `lib/graph.js`, not SYNAPSE. |
| **P0 — Substrate** | ✅ done | `lib/brain.js` (211 lines, Electron-free, `scripts/test-brain.js`). Importers: projects, semantic memories, `~` repos, Notion. |
| **P1 — Connector + viz** | ✅ done | `synapseConnect` (cosine ≥ 0.8 + LLM rationale on the top 8) + the SYNAPSE tab (2D canvas force-graph, 3D toggle). |
| **P2 — Curation** | ✅ done | prune/confirm/inbox + **`lib/gardener.js`** (decay / merge+rewire / promote), running daily in the headless worker. |
| **P3 — Scout** | ⬜ not built | No web enrichment at all. |
| **P4 — Learning** | ◑ partial | Learned connect threshold + importance ranking, both in the Gardener. Better rationales still TODO. |
| **P5 — Sync** | ⬜ not built | No local ↔ cloud ↔ Notion reconciliation. |

> **✅ It runs now.** For most of this project's life `~/.bhatbot/brain/graph.json` **did not exist** —
> the "always-on worker" lived inside the Electron main process and died with the window, and the app
> had gone 15 days without launching. The worker was correct; it had never had a process to run in.
> Fixed 2026-07-27: the engine moved to `lib/synapse.js` (pure + DI) and now runs in
> `scripts/synapse-worker.js`, a plain node process installed as the `com.bhatbot.synapse`
> LaunchAgent. First real graph: **195 nodes / 30 edges, $0 spent** — the free pass needs no API key.
> See `DAEMON.md`.

## Revised sequencing
- **D1 — Headless host** ✅ **DONE (2026-07-27)**: `lib/synapse.js` (pure + DI) +
  `scripts/synapse-worker.js` (plain node, no electron in its require graph — asserted by a test that
  spawns it) + `lib/pidlock.js` so it never double-runs alongside the GUI, installed as
  `com.bhatbot.synapse`. *Every phase below was theoretical until this landed.*
- **P2b — Gardener** ✅ **DONE (2026-07-27)**: `lib/gardener.js` — half-life decay on *unconfirmed*
  edges only, near-duplicate merge that **rewires** the dropped node's edges (a naive merge silently
  orphans them), importance promotion, and a clamped proportional controller over the confirm/prune
  ratio that feeds `connectThreshold` back into the Connector. Runs daily inside the headless worker.
  Note: the controller judges **only** `createdBy: 'connector'` edges — structural `part-of` imports
  are born `confirmed` and nobody curates them, so counting them reads as 100% approval on an
  unreviewed graph and walks the bar down (observed live: 30 import edges moved it 0.80 → 0.78).
- **P3 — Scout**: `lib/scout.js`, autonomous web enrichment, auto-add flagged `unreviewed` + hard
  daily budget through the existing cost ledger. Pure and file-free by construction — so it is the one
  worker that could later move to the cloud.
- **P4 — Learning** ◑ mostly done in the Gardener; what remains is better *rationales*, not more
  learning machinery.
- **P5 — Sync**: push a **pruned** graph view (no embeddings, no file bodies) to the deployed cloud
  brain after each local pass, so the phone can read it when the Mac is off.

### Hosting decision (2026-07-27): workers stay LOCAL
`_scanRepos` walks `$HOME` for git repos and reads READMEs + key files; `_semanticRecords` reads the
local embedding store; `projects.list()` reads `~/.bhatbot/projects`. None of that substrate exists on
Fly, and replicating it would mean shipping the contents of every repo in the home directory to a
hosted box — a real exfiltration surface for a $1/month knowledge graph. The cloud gets a **read
replica**, not the workers. (Scout is the sole exception worth revisiting, since it needs no local files.)
