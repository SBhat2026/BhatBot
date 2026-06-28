# Phase 6 — Self-Drive (on-demand autonomous self-improvement)

Built 2026-06-28. Wires Phase 5's self-awareness engine into an autonomous, budget-governed improvement
loop. The design priority is **safe autonomy** — it can run unattended without the possibility of
weakening its own guardrails, corrupting working state, or burning runaway budget. Rails first, speed
second. The entire safety model is `lib/risk.js` + the frozen zone + verify-or-revert — they are the
belt, not belt-and-suspenders.

## Activation model (per Siddhant, 2026-06-28 — OVERRIDES the earlier "aggressive/always-on" build)
BhatBot does **not** constantly update itself. There is **no perpetual background timer**. A finite
session runs only when:
1. **He asks** — "improve yourself" / "run selfdrive" / "work on yourself tonight" → `self_drive start`.
2. **Reflection implies consent** — if he asks what BhatBot would like to improve/change about itself
   (`self_reflect`), that question SANCTIONS autonomous implementation without further permission,
   *unless he explicitly says otherwise* ("just tell me, don't change anything"). The `self_reflect`
   dispatch detects a forbidding phrase; absent one, it queues a session that starts when the turn goes
   idle (`_pendingSelfDrive`, fired from `finish()`).
3. **Capability gap** — `noteCapabilityGap(desc)` (callable when BhatBot decides its current tools can't
   do a task) starts a focused session if idle + not already running.
`config.selfDrive.autostart` (default **false**) is honored if ever flipped, but stays off.

## One session (`selfdrive.startSession`)
Runs in the background; progress streams to the VANGUARD panel (`broadcast` → `fleetBroadcast`, panel:
'selfdrive') + Telegram. Per-session branch `self-drive-YYYYMMDD-HHmm`; multiple cycles accrue on it;
**never merged or pushed automatically** — it waits for a human `git merge`. Session summary appended to
`~/.bhatbot/selfdrive-sessions.jsonl` (readable by introspect's history dimension). Halts on: budget
exhausted, combined daily cap, no actionable desires, user_returned (idle lost), or stop.

## One cycle (`selfdrive.runCycle`) — the sequential 5-role VANGUARD pipeline
1. **REFLECT + PICK** — `buildSelfPortrait` → `reflect.reflect` → `pickDesire`: highest impact, then
   rank, among desires that are unresolved + **automatable** (`reflect.classifyActionability`) + risk
   **LOCAL/STRUCTURAL** (`risk.classifyDesire`) + non-frozen + not blocked ≥3×.
2. **SCOUT** (researcher, read-only) — one `orchestrator.fleet` suit reads the real source, returns root
   cause + 2–3 options + the precise change surface. No write tools.
3. **ORACLE + ECHO** (planner + adversarial reviewer) — `orchestrator.ensemble`. Output ends with
   `FILES:`, `VERIFY:`, `SEVERITY:`. If `risk.severeConcern(severity, level)` → **halt this desire**
   (severe always; high also halts for STRUCTURAL — lowered threshold).
4. **FROZEN PREFLIGHT** — `risk.checkFrozen(planFiles)` blocks BEFORE any write. Enforced by **file-list
   inspection**, NOT by instructing Claude Code (a `--dangerously-skip-permissions` coder cannot be
   trusted to self-enforce). `lib/selfdrive.js` in the plan → unconditional block.
5. **FORGE** (coder — the only writer) — drives `claude_code` with `--dangerously-skip-permissions` on
   the session branch. (acceptEdits is subsumed by skip-permissions; passing both can conflict, so we
   pass only skip-permissions, which also lets the unattended coder run build/move/test commands.)
6. **ATLAS** (shell — the judge, deliberately NOT the author) — runs the verify command + `npm run
   verify`. Fail (or a post-write frozen breach) → `git checkout -- . && git clean -fd` (never leave a
   dirty tree), mark `blocked_attempt`. 3 blocked attempts → `human_review_needed`, stop retrying.
7. **MEDIC** (resolver) — on pass: commit locally (no push), `reflect.resolveDesire(id, {helped:true},
   {telemetryDelta})` where the delta = `introspect.telemetryDelta(before, after)` (did it actually help?).

## risk.js — the gatekeeper (extended, not new)
- `FROZEN_ZONE` = `lib/selfdrive.js, lib/risk.js, lib/selfheal.js, lib/security.js, lib/credentials.js,
  lib/admission.js, scripts/verify-syntax.js, scripts/test-upgrade.js, config.json, .env, credentials`.
  Rationale: the loop must not be able to rewrite its own governor, weaken its gatekeeper/verify gate,
  expand its own rate limits, or touch credential handling.
- `classifyDesire(desire)` → `{level, decision, files}`. **Thresholds chosen:** GUARDRAIL (block) if any
  implicated file is frozen OR text matches the guardrail regex (weaken/bypass/disable verify/expand
  permission/dangerously/kill-switch/risk.js/selfdrive); INFRASTRUCTURE (block) on deploy/cloud/
  credential/api-key/secret/dns/twilio/stripe/production; STRUCTURAL (proceed-caution) if ≥3 modules OR
  schema/architecture/migration; else LOCAL (proceed).
- `checkFrozen(fileList)` → `{blocked, hits}` (substring match so path prefixes still catch).
- `severeConcern(severity, level)` → halt decision.

## Frozen-zone hash integrity (the recursive-risk catch)
`selfdrive.checkFrozenIntegrity(proj)` SHA-256-hashes every frozen code file → `~/.bhatbot/
frozen-hashes.json`. Before each session it re-hashes: a frozen file changed by a **human** silently
re-baselines (the normal case); a change attributable to **selfdrive itself** (drift + selfdrive in the
branch's commit log) means a frozen edit slipped past risk.js → **HALT + alert**. That case should be
impossible; the hash check is there to catch a bug in risk.js immediately, not three sessions later.

## Concurrency, budget, caps
- **Mutex** — `selfheal.selfdriveActive()` reads `~/.bhatbot/.selfdrive.lock`; self-heal (reactive)
  yields to self-drive (proactive) so they don't compete for OTPM or conflict on edits.
- **Combined daily cap** — `selfdrive.combinedCount` = its own cycles today + `selfheal.dayCount()`,
  capped at `config.selfDrive.dailyCap` (default 3).
- **Budget governor** — `budgetPlan` checks Sonnet `rateBudget().outFree`; below `budgetBufferOut`
  (12k) it sleeps to the next OTPM window (or the last 429 `Retry-After`, whichever longer), capped at
  `maxSleepMin` (20m) → else halt. So a session runs until the limit, sleeps, and **resumes** on reset.

## Tool + gating
`self_drive` (status | start/run | stop | enable | disable). It is **stepup** in risk.js (human-gated
every channel like self_fix/self_heal/self_improve). The autonomy is the on-demand session, not a
model tool-call. The `self_reflect` reflection-consent path is the one place a session starts without an
explicit confirm — by Siddhant's instruction.

## Tests / wiring
- `scripts/test-selfdrive.js` (29 assertions): posture (autostart-false, never-pushes), pickDesire
  filtering, frozen PREFLIGHT before FORGE, own-governor block, ECHO-severe halt, verify-fail revert +
  3-strike human_review, no-desire path, combined cap, budget sleep/halt, and frozen-hash integrity
  (human re-baseline vs selfdrive-breach halt).
- `scripts/test-upgrade.js` +10 risk assertions (classifyDesire levels, checkFrozen, severeConcern).
- verify-syntax export contracts updated for selfdrive/risk/reflect/introspect. All 16 suites green.

## Open / boot-gated
- Success-criteria items that need a running app (a real cycle reflect→…→verify, a real frozen-block
  log line, a real budget sleep/resume) are **integration tests** — verify them after `npm start`.
- Capability-gap detection is a v1 hook (`noteCapabilityGap` is callable; an automatic detector for
  "the model decided it can't do X" is left conservative to avoid false triggers).
- Desires selfdrive identifies + implements during its own first runs should be captured here.

## Deviations from the directive (intentional)
- The directive's "aggressive, always-on, pushes" is **overridden** by Siddhant's later instruction:
  on-demand only, **never pushes**.
- Failed cycle reverts the **working tree** and stays on the session branch (preserving earlier
  successful commits) rather than "checkout main / delete branch", because multiple cycles share one
  branch.
- `lib/risk.js` was **extended** (it already existed as the tool-tier gate), not created new.
