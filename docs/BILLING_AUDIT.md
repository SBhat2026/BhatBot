# Billing audit — who talks to `api.anthropic.com`, and who now uses the subscription

Scope: every call site that reaches the metered Anthropic API (`x-api-key`), classified **interactive** vs
**background**, and what it does after the subscription-routing change (issue #4). No key values appear here
or in any log: keys resolve from `ANTHROPIC_API_KEY` / Keychain / `config.json` / the vault and are only
ever placed in a request header or a redaction-tested child env.

Line numbers are for `origin/main` before this change (8ef2f87).

## How background routing works

`lib/bgllm.js` runs a tool-less text request through `claude -p --model sonnet --output-format json --tools ""`
with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `BHATBOT_ANTHROPIC_KEY` **removed from the child env**
(the CLI would otherwise prefer the key and bill the API). The prompt goes on stdin. The CLI uses the
claude.ai login = subscription.

* **Fallback to the metered API** when the CLI is missing (ENOENT), logged out, rate-limited/usage-limited,
  times out, or errors. A failure starts a cooldown (rate-limit 15 min, logged-out 30 min, missing 10 min) so
  a dead CLI is not re-spawned every tick.
* **Toggle:** `config.billing.backgroundViaSubscription` (default `true`; only an explicit `false` disables).
* **Ledger tag:** `~/.bhatbot/costs.json[day].byBilling.{subscription,api}` and `bySource["<caller>:<billing>"]`.
  `subscription` records `calls`, tokens and `equivUsd` (what the API would have charged); it does **not** add to
  the metered `usd` total. API fallbacks from background callers are tagged `api`.
* **Background detection in the app:** `bgTick()` (every timer tick: scheduler, weaver, triage, ambient,
  self-heal, health, backlog, synapse) wraps its work in `bgllm.runBackground()` (AsyncLocalStorage). Inside it,
  `anthropicRequest` routes tool-less requests subscription-first. Interactive turns are never inside that
  context, so chat routing is unchanged (`test-bgllm.js` checks a concurrent chain is not marked).
* **Tool-using or image requests** cannot be served by the CLI (it runs its own agent loop and ignores a
  caller tool schema) and keep using the API.

## Call sites

| # | Call site | Kind | Before | After |
|---|-----------|------|--------|-------|
| 1 | `main.js` `anthropicRequest` (~1639) — shared non-streaming client | both | API | Interactive: API (unchanged). Inside `bgTick`: subscription-first if tool-less; API fallback. Streaming/tool loops: API |
| 2 | `main.js` `anthropicStream` (~1881) — desktop chat stream | **interactive** | API | **unchanged** |
| 3 | `main.js` `callClaude` / `callClaudeStream` (~1821, ~1980) — chat turns | **interactive** | API | **unchanged** |
| 4 | `main.js` `ipcMain 'chat'` (~10732), `runAgentHeadless` (~7109, phone/MCP remote control) | **interactive** (user-initiated) | API | **unchanged** |
| 5 | `main.js` `synapse()` llm dep — SYNAPSE rationale + suggest passes | **background** | API, charged against `synapseBudgetUsd` ($0.25/day, exhausted every cycle) | Subscription-first via `synapseLlm`; **charges the SYNAPSE $ budget 0** when subscription-served; API fallback charges as before |
| 6 | `main.js` backlog worker `runAgent` (~8481) | **background** | API tool loop via `subagents.run` | `claude -p` with read-only built-ins (`Read,Grep,Glob,WebSearch,WebFetch`, cwd = repo) via `bgllm.agentRequest`; metered `subagents.run` loop is the fallback |
| 7 | `main.js` `cheapText` (~1529), `graphIngest` (~3368), speech summary (~10376), planner/critique/health/reflect/narrate callers that run from timers | mixed | API | Routed when called from inside a `bgTick`; interactive callers unchanged |
| 8 | `main.js` self-drive / self-heal / reflect passes (`selfDriveReflect`, `selfDriveReview`, `reflect.reflect`) | **background** (timer) | API | Routed (tool-less, inside `bgTick`) |
| 9 | `main.js` `pacedSubagentRequest` (~3798) — fleet/sub-agent tool loops | interactive-initiated | API | **unchanged** (tool loops) |
| 10 | `main.js` `orchestratorAdapters.anthropic` / `anthropicTools` (~3449–3487) | interactive-initiated | API | **unchanged** |
| 11 | `lib/llm.js` `anthropicRequest` / `ask` — headless client used by `scripts/synapse-worker.js` and `lib/miniagent.js` | **background** | API (key from env/Keychain/config) | Subscription-first via `lib/bgllm.js`; `apiRequest` (old behaviour) is the fallback. `canCall()` counts subscription routing as reachable, so a worker with **no** metered key still runs the paid pass |
| 12 | `scripts/synapse-worker.js` — SYNAPSE paid pass (`buildLlm`) | **background** | API | Subscription-first; `ask.lastBilling` → `lib/synapse.js charge()` skips $ when subscription-served |
| 13 | `lib/miniagent.js` — scheduled-task tool loop (headless) | **background** | API | **Still API** — it needs the caller-defined tool schema (`defer_to_app` etc.). Follow-up: express as a CLI `--allowedTools` run |
| 14 | `lib/backlogworker.js` | **background** | (no direct HTTP; goes through `runAgent`, row 6) | see row 6 |
| 15 | `lib/adapters.js` `anthropic` (L32), `anthropicTools` (L67) — orchestrator CLI path | background-ish (`scripts/orchestrate.js` CLI) | API | **Unchanged** (tool loop at L67); `anthropic()` (L32) is system-cached text and left on API — follow-up candidate |
| 16 | `lib/eval.js` (L18) | manual eval | API | unchanged |
| 17 | `cloud/src/llm.js` (L43) — Fly.io cloud brain (`agent.js`, `twilio.js`) | interactive (phone/SMS) | API | unchanged. The cloud box has no claude.ai login, so subscription routing does not apply |
| 18 | `lib/gardener.js`, `lib/memmaint.js` | background | **no LLM calls** (pure local decay/dedup/trim) | n/a — nothing to route |
| 19 | `main.js` ~3301 reachability probe (`HEAD /v1/models`) | background | unauthenticated, no tokens | unchanged, not billed |
| 20 | `scripts/chess-agent-test.js`, `ft-eval.js`, `parallel-bench.js`, `perf-eval.js`, `test-pass39.js` | manual dev/bench | API | unchanged (deliberately metered, measuring the API) |

Other `claude` CLI uses already on the subscription (not touched): `claude_code` tool (~5169), the
self-drive / project-run `claude -p … --permission-mode plan` paths (~2461, ~2538, ~2560, ~8092), and the
embedded terminal (`claude`, ~8973).

## Not changed on purpose

* **Interactive chat** (rows 2–4, 9, 10, 17).
* **Tool loops** — the CLI cannot honour a caller tool schema.
* **API key** — still resolved, still the fallback. Nothing here deletes or rotates it.

## Residual API spend to watch

Rows 9, 10, 13, 15, 17 and every interactive turn. Check `costs.json[day].byBilling` — `subscription.calls`
vs `api.calls`, and `bySource` (`synapse:subscription`, `backlog:api`, …) to see which jobs still fall back.
