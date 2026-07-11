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
- `cloud/` — an always-on Claude brain (SQLite/Fly), built + verified, **undeployed** — the 24/7 host.
- D3 (used in the user's Nexus project) + Three.js (the FLEET office) — viz options.

## The gap (what's new)
1. No **unified hybrid store** — vectors, graph, and projects live in separate files with no shared node/edge model.
2. No **Connector** — nothing proactively proposes cross-project links.
3. No **Scout** — nothing autonomously pulls relevant web info per project.
4. No **viz + curation panel** — no way to see/prune the brain.
5. No **always-on host** — workers only run while the desktop app is open (cloud brain undeployed).

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

## Open decisions for Siddhant (need input before P1)
1. **Viz**: D3 2D force-graph (recommended) vs Three.js 3D (matches the office) vs both.
2. **Scout autonomy**: auto-add findings to the graph (prune later) vs hold in an inbox for approval first; and a daily search budget.
3. **Host**: desktop-only for now (simplest) vs deploy the cloud brain now for true 24/7 (bigger lift).
4. **Scope of "projects"**: just BhatBot's own project records, or also index the user's other repos/Nexus/Notion as project nodes?
