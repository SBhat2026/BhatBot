# Phase 2 — Clean Slate: Implementation Notes & Judgment Calls

> Built 2026-06-26 against `BHATBOT_PHASE2_PROMPT.md`. Branch `phase2-clean-slate`, local commits only.
> Closes the four out-of-scope findings from `PHASE1_NOTES.md` + adds `web_search` as a first-class tool.

---

## What shipped

| # | Deliverable | Where |
|---|---|---|
| 1 | Retire `router.js` | logic relocated → `lib/agents/select.js`; 4 importers + 1 doc migrated; `lib/router.js` **deleted** |
| 2 | Repair DAG role tool names | `lib/agents/roles/index.js` phantoms → live names; `validateRoleTools()` + startup assertion in `main.js` |
| 3 | `web_search` first-class tool | `lib/websearch.js` + TOOLS def + dispatch + `PARALLEL_SAFE` + ledger + ORACLE/SCOUT allowlists |
| 4 | `offloadText` cost accounting | offload models priced in `MODEL_PRICES`; `offloadText()` now calls `recordCost` |

---

## Deliverable 1 — Retire router.js (the finding was bigger than PHASE1_NOTES said)

**PHASE1_NOTES.md claimed only `perf-eval.js` and `test-pass39.js` import `lib/router.js`. That was
incomplete.** The live DAG agent subsystem also imports it, functionally:

- `lib/agents/base.js` → `router.pick / router.run / router.shouldEscalate / router.estimateUsd`
- `lib/agents/orchestrator.js` → `router.pick / router.run`

…and `lib/agents/orchestrator.js` **is** required by `main.js:20`. So `lib/router.js` was *not* dead
code for the live app — outright deletion would have broken the DAG agents (`agent_team`, `fleet`,
`delegate_project`, `plan_and_run`), violating the "leave nothing importing a deleted module" rule by
breaking live callers.

**Judgment call:** the chat path was already unified in Phase 1 (`chooseModel` + `callModel`). The
*other* thing `router.js` did — provider/model selection for the stateless DAG role agents (which run
with injected, provider-agnostic adapters and their own per-class escalation chains) — is genuinely
separate, load-bearing logic that lives nowhere else. I **relocated** it to `lib/agents/select.js`
(the package where its only consumers live), updated all four importers + the `ARCHITECTURE.md`
reference, and **deleted `lib/router.js`**.

Net result, matching the success criteria: `lib/router.js` does not exist; nothing imports it; the
single live *chat* router stays `chooseModel`/`callModel`; the DAG agent selector is no longer a
top-level "deprecated router" file. This is a relocation, not a second routing system — `select.js`'s
header states explicitly that it is not the chat router.

---

## Deliverable 2 — phantom tool-name mappings

Two surfaces existed in `roles/index.js`:
- **`ROLE_TOOLS`** — the map `base.js` actually filters by. Was already *mostly* real.
- **`ROLES[].tools`** — the role spec. Held the phantoms. (`lib/orchestrator.js` reads `role.tools`.)

Both were reconciled to the live 57-tool catalog. Mappings (authority = live `main.js` TOOLS):

| Phantom | Mapped to | Rationale |
|---|---|---|
| `web_fetch` | `fetch_url` | direct rename — same HTTP-GET capability |
| `web_search` | `web_search` | now a **real** tool (Deliverable 3) |
| `browser_goto`, `browser_act`, `browser_screenshot` | `browser` (+ `browser_workflow`) | the unified `browser` tool covers navigate/act/screenshot actions |
| `browser_a11y` | `browser_observe` | observation / accessibility-tree read |
| `mem_search` | `read_file` + `list_directory` | **ambiguous** — see below |
| `mem_write` | `save_memory` | direct map |
| `mem_compress` | *(dropped)* | **ambiguous** — no live equivalent; see below |
| `generate_3d`, `generate_image` | *(unchanged — already real)* | PHASE1_NOTES wrongly listed `generate_3d` as phantom; it exists in the live catalog |

**Ambiguous cases (conservative interpretation, per directive):** the live memory layer exposes only
`save_memory` plus generic file reads. There is no live semantic `mem_search` nor a `mem_compress`
(dedup/roll-up) tool. Conservative choice: the memory role writes with `save_memory` and reads back
with `read_file`/`list_directory`; the "compress/dedup stale chunks" capability has **no live tool**
and was dropped from the allowlist rather than invented. (Phase 3's episodic vector-recall work is the
natural home for real semantic memory search if it's wanted as a role tool later.)

**Startup assertion:** `validateRoleTools(liveToolNames)` (exported from `roles/index.js`) checks
*both* surfaces against the live catalog. `main.js` calls it right after the TOOLS array is defined:
logs `[roles] ✓ … validation passed` on success, or `[roles] ⚠ …` per offending entry. Wrapped in
try/catch — **warns loudly, never blocks launch.** Verified: passes clean against the live catalog.

---

## Deliverable 3 — web_search

- **Provider chain (cheapest-that-works):** Brave (`braveKey`) → Serper (`serperKey`) → Tavily
  (`tavilyKey`) → **DuckDuckGo HTML (no key, $0)**. No search key is configured in this environment,
  so the live path is the free DDG scraper. Verified working (4 results for a test query, `usd=0`).
- **Parallel-safe:** already present in `PARALLEL_SAFE` (read-only + stateless). Kept.
- **Deterministic:** same query → same provider → same parse order. No randomness in the path.
- **Cost ledger:** keyed providers fold a per-call estimate into `costs.json` via `recordToolCost`
  (`PROVIDER_USD`); DDG is $0 so nothing is recorded for it.
- **Allowlists:** added to `research` (ORACLE) and `browser` (SCOUT) in both `ROLE_TOOLS` and
  `ROLES[].tools`. Also marked retryable (idempotent read) and sanitized as external content.

---

## Deliverable 4 — offloadText cost accounting

- Added `gpt-4o-mini` and `gemini-2.0-flash` to `MODEL_PRICES` (cache tiers mirror input; offload
  usage carries only input/output tokens).
- `offloadText()` now captures usage from each response (OpenAI `j.usage`, Gemini `j.usageMetadata`)
  and calls the **existing** `recordCost(model, usage)` — same daily ledger, same `byModel` shape.
- When a response omits usage, `estOffloadUsage()` estimates tokens (~4 chars/token) so **no offload
  call is silently $0**. Ledger `byModel` key keeps the provider model name (no `claude-` to strip),
  so offload spend is visible and distinguishable from Anthropic spend.
- Verified pricing: gpt-4o-mini 1000in/500out = $0.00045; gemini-2.0-flash = $0.0003.

---

## Additional findings (beyond the PHASE1_NOTES list)

- **`PARALLEL_SAFE` contains `weather`, which is not a live tool.** Harmless (a name that never matches
  a real tool is simply never hit), so left as-is rather than removed — flagging in case a `weather`
  tool is intended. `web_search` was already pre-listed in `PARALLEL_SAFE`, so Deliverable 3 needed no
  change there.
- **`PHASE1_NOTES.md` finding #1 mislabeled `generate_3d` as phantom.** It is a real, live tool. Only
  `web_fetch`/`web_search`/`browser_*`/`mem_*` were genuinely phantom.

---

## Verification (2026-06-26)

- `node scripts/verify-syntax.js` → ✓ 528 JS files parse cleanly (was 527: +`websearch.js` +`select.js` −`router.js`)
- `node scripts/test-upgrade.js` → ✅ 48 passed, 0 failed
- `node scripts/perf-eval.js --no-judge` → routing 100%, args 100%, healing 100% (uses the relocated `lib/agents/select`)
- `web_search` DDG path → ✓ live results, $0
- `validateRoleTools()` against the live catalog → ✓ ok, 0 missing
- router-offload picks (migrated `test-pass39` subtest, run standalone) → ✓ research/memory→openai, no-keys→anthropic
- offload pricing replication → ✓ matches expected USD
