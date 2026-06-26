# BhatBot — Schematic & Dossier

> A planning brief for Claude. Read this top-to-bottom, then propose next-phase plans.
> Special focus areas requested: **(1) exploit the new "extra power"** (tier-2 rate
> headroom + per-model ITPM/OTPM budgeting + depth-learning), **(2) rename the
> subagent fleet**, **(3) confirm/extend the full tool catalog.**
> Generated 2026-06-26. Source of truth = `main.js` + `lib/`. Verify against code before acting.

---

## 1. What BhatBot Is

BhatBot is a personal **JARVIS-style desktop agent** — an Electron app (`main.js`, ~7k lines)
that reads `CLAUDE.md` as live context and acts on Siddhant's machine with vision, voice,
browser control, science tooling, and a multi-agent fleet. It is **local-first** (routes to
free local models when it can), **cost- and rate-aware**, and **self-improving** (verify-gated
self-fix loops).

- **Owner/user**: Siddhant Bhat — computational-biology researcher, ML/DL focus.
- **Persona**: calm, refined British butler (J.A.R.V.I.S.), ElevenLabs voice only.
- **Repo**: `~/bhatbot` → github.com/SBhat2026/BhatBot (push = direct to `main`).
- **Config/state**: `~/.bhatbot/` (config.json, costs.json, router.jsonl, depth.jsonl, memory.md, logs/).

### Architecture at a glance
```
                 ┌──────────── Surfaces ────────────┐
  Desktop chat ──┤ Voice (wake word + stream)        │
  Telegram    ───┤ Twilio 2-way phone                │──┐
  Phone PWA   ───┤ MCP server (:8788)                │  │
  Cloud relay ───┤ HTTP/IPC                          │  │
                 └───────────────────────────────────┘  │
                                                         ▼
                        ┌──────── dispatchTurn (serialized) ────────┐
                        │  fastReply (Haiku, no-tools, streamed)     │
                        │  agentLoop (tool loop, ≤20 steps)          │
                        │  pipeline (local Ollama router/planner)    │
                        └───────────────┬────────────────────────────┘
                                        ▼
              callModel ── route → depth-sizing → rate preflight (ITPM/OTPM)
                                        ▼
        ┌─────────── providers ───────────┐     ┌──── fleet/orchestration ────┐
        │ Anthropic (Haiku/Sonnet/Opus)   │     │ delegate_project (DAG)       │
        │ Ollama (qwen3/gemma3, free)     │     │ fleet / agent_team / subagent│
        │ OpenAI / Gemini (text offload)  │     │ plan_and_run                 │
        │ Darkbloom (optional)            │     └──────────────────────────────┘
        └─────────────────────────────────┘
                                        ▼
                          55 tools  +  3-tier memory  +  self-heal
```

---

## 2. Surfaces (entry points)

| Surface | How it reaches the agent | Notes |
|---|---|---|
| **Desktop chat** | Electron window, hotkey `Cmd+Shift+B` | streaming, vision panels, Studio/Legion/Chess windows |
| **Voice** | wake word (`listen.py`) + voicestream | barge-in, 3s endpointing, ElevenLabs TTS |
| **Telegram** | `node-telegram-bot-api` bridge | text relay |
| **Phone (Twilio)** | two-way voice, webhook-driven | JARVIS voice on a real phone call |
| **Phone PWA** | `phone-app/` Chat/Activity/Nexus tabs | 👂 wake word in-browser |
| **MCP server** | `mcp-server.js` on `:8788`, tailnet-only | `mcpToken` is the whole security boundary |
| **Cloud backend** | `cloud/` always-on Claude brain + Mac-executor relay | built + verified local, **not yet deployed** |

---

## 3. Models, Routing, Rate & Depth (the "extra power" layer)

### Providers / models
- **Anthropic**: Haiku `claude-haiku-4-5` (default/cheap), Sonnet `claude-sonnet-4-6` (reasoning/tools), Opus `claude-opus-4-8` (hard coding, via router).
- **Ollama (local, free)**: `qwen3:latest` (tool-capable router/planner/coder), `gemma3:12b` (vision).
- **OpenAI / Gemini**: text-only offload rungs (`gpt-4o-mini`, `gemini-2.0-flash`) to relieve the Anthropic per-minute cap.
- **Darkbloom**: optional gateway (currently disabled).

### Routing
- `chooseModel` (regex intent → Haiku/Sonnet) is the live path; `lib/router.js` has a richer
  escalation-chain design that is **partly wired** (candidate to finish or retire).
- Daily USD budget governor (`overBudget` → forces Haiku); real per-model cost ledger.

### Rate budgeting — **NEW (2026-06-26)**
Tier-2 limits now modeled **per model**, tracking **both** input and output:
- Rolling 60s windows per model for ITPM **and** OTPM (OTPM was previously untracked).
- `config.rateLimits`: Sonnet 450k/90k, Haiku 100k/50k, Opus 100k/16k (itpm/otpm).
- Preflight paces on input **and** output; chooses model before checking so it uses that model's caps.

### Depth-learning — **NEW (2026-06-26)**
- Every response logged to `~/.bhatbot/depth.jsonl` {tier, allocated max_tokens, actual output, clipped}.
- `depthCal()` learns a right-sized ceiling per tier (p90 + 30%, grows when clip-rate >12%).
- Over-allocated tiers shrink (cheaper long convos); chronically clipped tiers grow.
- **This is a live, growing dataset** — the foundation many "extra power" ideas in §9 build on.

### Wattage — **NEW (2026-06-26)**
- `shouldSpareWatts()` (battery + `powerSaver`): ambient watcher skips polls; `screen_parse` drops the heavy caption pass.

---

## 4. Full Tool Catalog (55 tools)

### Files & shell
- **read_file** — read a UTF-8 text file (100KB max).
- **write_file** — write a UTF-8 file, mkdir -p parent.
- **list_directory** — list dir entries with name + type.
- **run_shell** — run a shell command (60s; destructive-pattern gated).

### Web & browser
- **fetch_url** — HTTP GET, return text (15s, 50KB cap).
- **open_in_browser** — open a URL in Siddhant's default browser.
- **browser** — dedicated headless Playwright browser; returns screenshots (vision).
- **browser_workflow** — record/replay reusable browser macros.
- **browser_observe** — watch-my-browsing and learn from it.
- **smart_login** — sign into a site/app via a saved domain profile, auto-handles 2FA.
- **manage_logins** — manage domain-keyed login profiles for smart_login.

### Vision & screen control
- **ui_inspect** — screenshot (browser/screen) → structured visual-QA findings from a local model.
- **screen_parse** — OmniParser map of on-screen elements (+ click coords) for ANY app.
- **vision_click** — click coordinates from screen_parse; closed-loop verify.
- **vision_local** — second-opinion vision from a local Ollama model (free/offline).
- **screen_observe** — watch Siddhant's whole screen to learn how he works.
- **request_permissions** — trigger macOS Screen Recording + Accessibility prompts.

### Memory & knowledge
- **save_memory** — persist a fact to long-term memory; mines a knowledge graph; multi-hop query.
- **project** — open/track a project with a living auto-updating summary injected each turn.
- **notion_write** — persist a durable fact to the Notion Memory DB (cross-device).
- **notion_search** — search the Notion Memory DB by keyword.
- **notion_log_activity** — append significant completed work to today's Notion Daily Log.

### Credentials & auth
- **keychain_lookup** — macOS login Keychain → CRED_REF handle (never raw password).
- **onepassword_lookup** — 1Password `op` CLI → CRED_REF handle.
- **generate_totp** — current 6-digit TOTP (2FA) from a stored secret.

### System & media
- **system_control** — macOS GUI/system automation via AppleScript + System Events.
- **media_control** — control Spotify + system audio.

### AI, research & reasoning
- **ask_ai** — query another AI (claude/openai/gemini/local) for a second opinion / cross-check.
- **write_agent_directive** — author a full system-prompt/task directive for another agent/workflow.
- **claude_code** — delegate a coding/build task to the Claude Code CLI (headless, 5min).
- **math_reason** — code-first math agent (smolagents, executes numpy/sympy/scipy).
- **news** — skim latest NYT headlines + abstracts (public feeds, no login).
- **world_cup** — FIFA World Cup 2026 live data + analysis.

### Science & creation
- **simulate** — physics/chem/math sim in a sandboxed scientific Python env (scipy/sympy/rdkit/openmm/pyscf…).
- **predict_function** — protein function via FABLE (ProtFunc), shown on the 3D structure.
- **molecule** — render a protein or small molecule in 3D.
- **make_figure** — data-accurate matplotlib/seaborn figure from a real data file.
- **make_printable** — image → 3D-printable STL mesh, or convert a model to STL.
- **maps** — map / directions in an in-app window.

### Creative & play
- **generate_image** — image from a text prompt.
- **studio_write** — write/replace the live HTML design canvas (Studio window).
- **play_chess** — playable chess window (standard + atomic variant engine).

### Agents & orchestration
- **delegate_project** — background DAG project (planner → ≤3 parallel agents).
- **subagent** — persistent specialized sub-agent with its own memory + scoped tools.
- **agent_team** — multiple agents on ONE task in parallel (speedup + depth).
- **fleet** — "Iron Legion": several distinct tasks at once, each its own autonomous suit, live panel.
- **plan_and_run** — decompose a goal into a parallelizable task DAG, then execute guardrailed.
- **manage_jobs** — inspect/control background jobs and their agent tasks.

### Scheduling & proactive
- **manage_schedule** — proactive/autonomous reminders, recurring checks, timed tasks.
- **ambient** — opt-in proactive Calendar/Mail awareness (off by default, privacy-first).
- **notify_user** — reach Siddhant out-of-band for a mid-task decision or completion.

### Self-improvement
- **self_fix** — fix BhatBot's own code via built-in Claude Code, verify-gated + auto-revert.
- **self_heal** — autonomous always-on version of self_fix (disabled by default).
- **self_improve** — scan the audit log for recurring failures, draft a reviewable fix diff.

### Extensibility
- **plugin** — run a user-defined plugin tool in a sandboxed worker thread (no fs/net/vault unless opted in).

> Concurrency note: a `PARALLEL_SAFE` subset (read-only tools) runs concurrently via `Promise.all`;
> stateful tools stay sequential. Tier-2 RPM (1000) and high ITPM make parallel fan-out cheap — see §9.

---

## 5. The Agent Fleet — current roster & **proposed renames**

There are **three distinct fleet systems** today, with overlapping generic role names. Renaming
should give each a memorable, theme-consistent codename (Iron-Man "Legion" flavor already in use).

### 5a. Current roster
| System | Roles (current names) | Source |
|---|---|---|
| **Ensemble** (same task, many angles) | implementer · skeptic · synthesizer · tester | `lib/orchestrator.js` |
| **Persistent sub-agents** (long-lived, own memory) | research · coding · lifeadmin | `lib/subagents.js` |
| **Project DAG roles** (one-off, per project) | orchestrator · coding · research · browser · memory · creative | `lib/agents/roles/index.js` |

### 5b. Proposed naming scheme — "The Legion" (primary)
Keep the JARVIS/Iron-Legion universe. One codename per *function*, reused across systems so
"FORGE" always means coding whether it's a suit, a persistent agent, or a DAG node.

| Function | Proposed codename | Rationale |
|---|---|---|
| Orchestrator / planner | **OVERMIND** | commands the legion, owns the DAG |
| Coding | **FORGE** | builds/repairs |
| Research / analysis | **ORACLE** | knowledge & synthesis |
| Browser / web automation | **SCOUT** | navigates the field |
| Memory / knowledge graph | **VAULT** | durable store |
| Creative / design | **ATELIER** | studio + image gen |
| QA / red-team tester | **SENTINEL** | guards quality |
| Life-admin / scheduling | **WARDEN** | keeps order |
| Self-heal / maintenance | **MEDIC** | fixes the agent itself |
| Reasoning skeptic | **DEVIL'S-ADVOCATE / ECHO** | adversarial angle |

Alternates if a different flavor is wanted:
- **Marvel-AI set**: FRIDAY, EDITH, KAREN, VERONICA, HOMER, JOCASTA…
- **Greek/mythic**: ATLAS (orchestrator), HEPHAESTUS (coding), ATHENA (research), HERMES (browser), MNEMOSYNE (memory), CALLIOPE (creative), NEMESIS (tester).
- **NATO-phonetic Marks**: Mark-I…Mark-N with role subtitles (cleanest for a "Legion" UI).

> Decision needed: pick one scheme; then unify the three systems so role identity is shared,
> and surface the codenames in the live Legion panel.

---

## 6. Memory & Learning Systems
- **3-tier memory**: episodic (capped, evicted) → semantic (durable facts) → knowledge graph (entities + relationships, multi-hop query).
- **Notion Memory DB**: cross-device durable log + daily activity log.
- **Router telemetry** (`router.jsonl`): per-route decisions/latency/cost/correction-rate (measurement layer; not yet driving routing).
- **Depth dataset** (`depth.jsonl`): per-turn output-need learning (NEW; see §3).
- **Cost ledger** (`costs.json`): real per-model + per-tool USD, 60-day retention.
- **Fine-tune pipeline**: `ft:export/train/eval/cycle` — export preference data, LoRA train, eval.
- **Live-feedback learning**: corrections mid-task feed agents; reflectOnCorrection flags router rows.

## 7. Self-Improvement Loops
- **self_fix** (manual, verify-gated, auto-revert) · **self_heal** (autonomous, disabled by default, frozen-zone + cooldown rails) · **self_improve** (audit-log → drafted diff, human merge gate).
- **World Cup iteration harness**: self-driving build loop logged to `WORLDCUP_ITERATION_LOG.md`.
- Local commits from self-loops are **never pushed**.

## 8. Library Module Inventory (`lib/`)
`orchestrator` · `planner` · `subagents` · `router` · `toolselect` · `depth` · `risk` · `audit` ·
`semantic` · `graph` · `memory` · `context` · `state` · `prompts` · `scheduler` · `jobs` ·
`ambient` · `selfheal` · `sandbox` · `a2a` · `simulate` · `molecule` · `maps` · `figures` ·
`protfunc` · `worldcup` · `chesscore` · `news` · `notion` · `projects` · `voicestream` · `voiceid` ·
`security` · `credentials` · `logins` · `shell` · `adapters` · `inspect` · `pure` · `eval` ·
`cloud-bridge` · `workspace` + `agents/` (base, exec, protocol, orchestrator, roles).

---

## 9. NEXT PLANS — exploiting the extra power

> Tier-2 reality: **1000 RPM**, **ITPM 100k–450k** (Sonnet highest), **OTPM 8k–90k**, **$500/mo**.
> The bottleneck flipped from "barely any headroom" to "lots of parallel headroom + OTPM is the
> tightest knob." Plans below lean into that.

### A. Turn the depth dataset into real intelligence
1. **Predictive depth model** — replace the regex tier-picker with a tiny learned classifier trained on `depth.jsonl` (features: length, intent regex hits, conversation position, prior-turn sizes). Goal: predict *actual* output need ±20%, not a coarse 4-bucket guess.
2. **Per-conversation adaptive budget** — long threads should taper: learn that turn 30 in a chat rarely needs 8k. Feed conversation-position into depth + cap growth.
3. **Clip-aware auto-retry** — when a turn clips (`stop_reason=max_tokens`), auto-continue with a raised ceiling instead of leaving a truncated answer; log it as a strong "needs more" signal.
4. **Quality signal** — fold corrections (`reflectOnCorrection`) into depth: a tier that's right-sized but frequently corrected may need *more reasoning*, not more tokens.

### B. Massively parallel fleet (use the RPM/ITPM headroom)
5. **Scale fleet width** — current cap is 3 parallel agents; tier-2 supports far more. Make width a function of *available* ITPM/OTPM budget computed live (the new `rateBudget(model)` already exposes `inFree`/`outFree`).
6. **Budget-aware scheduler** — a central admission controller that reserves ITPM/OTPM per in-flight agent (fixes the "convoy" race noted in the rate work) and dispatches as budget frees.
7. **Map-reduce research** — fan a research question to N SCOUT/ORACLE agents (different sources) in parallel, then one synthesizer pass. Cheap now.
8. **Speculative execution** — for ambiguous requests, run 2–3 interpretations in parallel, keep the best (pairs with the ensemble system).

### C. Smarter model mix (cost/latency/OTPM)
9. **Finish or retire `lib/router.js`** — drive routing from `router.jsonl` telemetry (data, not regex). One routing system, not two.
10. **OTPM-aware model choice** — when OTPM is the binding constraint, prefer Sonnet (90k OTPM) over Haiku (50k) for big generations even if Haiku is "cheaper per token."
11. **Offload more text to OpenAI/Gemini/Ollama** during Anthropic OTPM pressure (rungs exist; wire them into the live preflight, not just `lib/router.js`).
12. **Opus tier** — route genuinely hard coding/architecture to Opus (it's defined but barely used).

### D. Fleet identity & UX (ties to §5 rename)
13. Unify the 3 fleet systems under one shared codename roster; show live per-suit ITPM/OTPM usage + cost in the Legion panel.
14. Persistent-subagent expansion: add SENTINEL (QA), WARDEN (life-admin already ~exists), MEDIC (self-heal) as standing agents.

### E. Capability expansion (new tools)
15. **edit_file** (surgical patch) — agents currently rewrite whole files; a diff/patch tool cuts output tokens hugely (direct OTPM win).
16. **web_search** as a first-class tool (currently leans on browser/fetch).
17. **Vector recall** over `depth.jsonl` + episodic memory for "have I answered this before?" → skip a full generation.
18. **Deploy the cloud backend** (`cloud/`) — always-on brain so phone/computer act independently.

### F. Efficiency / hygiene
19. **Split `main.js`** (490KB) per `SPLIT_PLAN.md` — cold-start watt + maintainability.
20. **Cache-hit telemetry** — the code already logs `[CACHE MISS]`; surface a hit-rate metric (a silent miss doubles input cost).
21. **Rotate plaintext keys** in `~/.bhatbot/config.json` (vault arch exists; config still holds raw keys).

---

## 10. Questions for Claude to resolve before planning
1. Which fleet naming scheme (§5b) — Legion / Marvel-AI / Mythic / Marks?
2. Should depth-learning stay heuristic+calibration, or graduate to a trained classifier (A1)?
3. How wide should the fleet go on tier-2 — and do we build the budget-aware admission controller (B6) first?
4. Finish `lib/router.js` or delete it and centralize routing in the preflight?
5. Priority order across A–F given the $500/mo cap and the goal of *cheaper long conversations*?

---
*Schematic auto-derived from `main.js` + `lib/` on 2026-06-26. Counts: 55 tools, 3 fleet systems, ~45 lib modules. Verify against code before implementing.*
