# Phase 1 — Implementation Notes & Out-of-Scope Findings

> Built 2026-06-26 against `BHATBOT_PHASE1_PROMPT.md`. All four deliverables landed; VANGUARD
> codenames woven into new fleet code. Local commits only (remote push frozen per directive).
> This file = things I found that were **outside the four deliverables** and did NOT fix silently.

---

## What shipped (summary)

| # | Deliverable | Where |
|---|---|---|
| 1 | `edit_file` surgical patch tool | `main.js` TOOLS def + `applyEdit()` + dispatch case; excluded from `PARALLEL_SAFE` |
| 2 | Budget-aware admission controller | `lib/admission.js` + `pacedSubagentRequest()` wrapping `subagentDeps().anthropicRequest` + `fleetWidth()` replacing the static caps |
| 3 | Single live routing path | `chooseModel` telemetry-nudge (`routeCorrectionRate`) + OTPM-aware model upgrade + `offloadText()` rung in `callModel`; `lib/router.js` deprecated |
| 4 | Clip-aware auto-retry | `continueClipped()` wired into `callClaude` / `callClaudeStream` / `pacedSubagentRequest`; clip logged to `depth.jsonl` |

---

## Deviation from the prompt (1)

**Deliverable #3 said "one routing system… what you delete is your call."** I chose **deprecate, not delete** `lib/router.js`. Reason: it is *already* dead for live routing (`require`d nowhere in `main.js`), but it **is** imported by two offline harnesses — `scripts/perf-eval.js` (uses `classOf`, `shouldEscalate`, part of the "deterministic suites") and `scripts/test-pass39.js` (the "router offload picks" subtest). Deleting it would break both. The net effect is identical to deletion for the *live* path (one routing code path, telemetry-driven, offload rungs ported into the preflight), without breaking tests. The file now carries a loud DEPRECATED header. **TODO:** migrate those two scripts off it, then delete.

---

## Out-of-scope findings (noted, NOT fixed)

1. **DAG role tool names are out of sync with the live tool catalog.** `lib/agents/roles/index.js` references `web_fetch`, `web_search`, `browser_goto`, `browser_act`, `browser_screenshot`, `browser_a11y`, `mem_search`, `mem_write`, `mem_compress`, `generate_3d` — **none of which exist** in the `main.js` TOOLS array (live names are `fetch_url`, `browser`, `save_memory`, `make_printable`, …). `base.js` filters by name, so these roles silently get a *smaller* toolset than intended. The `coding` role's `edit_file` reference is now real (added this phase); the rest are still phantom. Worth a reconciliation pass.

2. **`web_search` is referenced but is not a real tool.** It's in `DEFAULT_SUIT_TOOLS` (orchestrator) and the research/browser DAG roles, but there is no `web_search` handler — suits fall back to `fetch_url`/`browser`. Schematic §9 #16 already flagged adding it as a first-class tool; that's the right fix.

3. **Offload (`offloadText`) calls don't hit the cost ledger.** OpenAI/Gemini offload responses bypass `recordCost`. They're cheap (gpt-4o-mini / gemini-flash) and not Anthropic-billed, but the monthly $ ledger won't see them. Low priority.

4. **Clip continuation re-pays input cost.** Acknowledged design tradeoff (the API is stateless — a continuation resends the prior assistant partial). Mitigated by: bounded rounds (≤2), `CLIP_HARD_CAP` (12k), skipping the `ack` tier, and a live `budgetOk` gate before each continuation. Only fires on genuine prose truncation (never on a clipped tool call).

5. **Ensemble roles are still a static `slice(0, 4)`** (not budget-driven width). Left as-is: ensemble is a fixed small reasoning panel, and the per-request admission ledger already paces its concurrent calls. Only the *distinct-task* fleets (`fleet`, `delegate_project`, `plan_and_run`) got live `fleetWidth()`.

6. **Plaintext secrets in `~/.bhatbot/config.json`** (API keys, app passwords, `mcpToken`). Schematic §F #21. The vault/CRED_REF architecture exists but the raw keys remain in config. Out of scope here; flagged again — rotation + migration recommended.

7. **`main.js` is ~7.7k lines.** `SPLIT_PLAN.md` describes the intended decomposition. Did not restructure (hard constraint). New logic added inline near its peers per the constraint.

---

## Verification run (2026-06-26)

- `node scripts/verify-syntax.js` → ✓ 527 JS files parse cleanly
- `node scripts/test-upgrade.js` → ✅ 48 passed, 0 failed (incl. orchestrator/planner/depth suites)
- `node scripts/test-pass39.js` → "router offload picks" ✅; only FAIL is the pre-existing `gemini-2.0-flash` status probe (depleted prepaid credits, unrelated)
- New-module unit checks (vanguard codenames · admission acquire/release/width · `edit_file` 0/multi/unique/replace_all + atomic) → ✅ all passed
- Self-improvement loops (`self_fix`/`self_heal`) use the Claude Code CLI subprocess, not `chooseModel`/`callModel` — unaffected by the routing change. Verified by inspection (no `lib/router` or routing-internal imports in `lib/selfheal.js`).
