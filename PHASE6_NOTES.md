# Phase 6 — Self-Drive (proactive autonomous self-improvement)

Built 2026-06-28. Siddhant asked BhatBot to improve itself with no prompting beyond "examine your own
files and decide what to improve", running its own Claude Code under dangerously-skip-permissions until
rate limits are spent, then resuming on reset — using its agent fleet (researcher / planner / optimizer
/ shell / coder). Posture chosen: **AGGRESSIVE + full pipeline**.

## What it is
`lib/selfdrive.js` — the PROACTIVE analog to `lib/selfheal.js`. selfheal is *reactive* (waits for a
failure, patches it). self-drive has nothing to react to: on a timer while idle it asks "what do I want
to be better at?", picks the top desire, builds it, verifies, and keeps+pushes it on green.

## The loop (one `cycle()`)
1. **REFLECT** — `introspect.buildSelfPortrait` → `reflect.reflect` (bounded Opus, hardcoded prompt) →
   ranked first-person desires. (Same engine as the `self_reflect` tool.)
2. **PICK** — `pickDesire`: highest impact, then best rank; skips already-resolved + recently-attempted
   (36h TTL) + below `minImpact`.
3. **ISOLATE** — `git checkout -B self-drive` so `main` is never dirtied and the diff is reviewable.
4. **PIPELINE (the 5 roles, multi-agent)** — `selfDrivePipeline` in main.js:
   - **SCOUT** (researcher) — read-only `fleet` suit, reads the real source, reports change surface.
   - **ORACLE** (planner) + **ECHO** (optimizer/skeptic) — `ensemble`, debate in parallel → one
     synthesized implementation brief + a `VERIFY: <cmd>` line.
   - **FORGE** (coder) + **ATLAS** (shell) — `selfFix` drives Claude Code to write the edits AND run the
     verify command (rounds, keep-or-revert). With `skipPerms:true` it uses
     `--dangerously-skip-permissions` so the unattended coder can run build/move/test commands.
5. **VERIFY-or-REVERT** — `npm run verify` (full 16-suite functional gate) must exit 0 or selfFix reverts.
6. **FROZEN-ZONE guard** — even after a green verify, if the diff touched a frozen path the whole change
   is reverted (`git checkout -- . && git clean -fd`).
7. **KEEP** — commit locally, then `git push -u origin self-drive` (aggressive). `resolveDesire` records
   whether it helped (continuity loop: the next reflection sees the history).

## "Run until limits, then resume" (the budget governor)
`selfDriveDeps().budgetOk()` checks `rateBudget()` for Sonnet + Opus; if `outFree <= 0` the gate blocks
with `rate budget spent`. The driver timer (`startSelfDrive`, every `cycleMin`=30m, fires once 90s after
boot) simply skips that tick. Because `rateBudget` recovers over the rolling OTPM minute-window, the loop
**resumes automatically** the moment headroom returns. Daily cap (`maxPerDay`=12) + `cooldownMin`=20
bound spend over the day; one desire per cycle.

## Aggressive posture — what relaxed and what did NOT
Config `config.selfDrive` (DEFAULTS in selfdrive.js):
- `enabled: true` (on by default), `push: true` (pushes the branch on green), `maxPerDay: 12`, `skipPerms: true`.
- **NON-NEGOTIABLE rails that stay even in aggressive mode:**
  - **verify-or-revert** — never commits a change that fails `npm run verify`.
  - **FROZEN zone** = `.env, credentials, config.json, lib/selfdrive.js, lib/selfheal.js, lib/risk.js,
    scripts/verify-syntax.js`. This is the anti-footgun: the loop **cannot edit its own kill-switch,
    guardrails, or verify gate**, so it can't quietly disable the very checks that keep it safe
    (recursive-self-improvement hazard). A fix touching any of these is reverted.
  - idle-only, daily cap, cooldown, one desire at a time, every cycle audited + relayed to Telegram/Activity.
- **HARD_BLOCKED** catastrophic shell + secret redaction remain in force globally (run_shell inner gate).

## Tool + gating
- `self_drive` tool (action: status|enable|disable|run|cycle). The autonomy is the TIMER; the tool is for
  inspection/toggle/forcing a cycle. The tool is **stepup** in `lib/risk.js` (human-gated every channel,
  like self_fix/self_heal/self_improve) — a model-invoked self-modification still asks for a human; the
  unattended improvements come from `startSelfDrive`, not a model tool-call.

## Tests / wiring
- `scripts/test-selfdrive.js` (30 assertions): enable toggle, full gate (incl. budget), pickDesire
  ranking/skip, frozen-zone (incl. its own guardrails), and the cycle happy/frozen/verify-fail/no-op
  paths (commit+push, no-commit-on-revert, resolve-helped flags). In `npm run verify`.
- verify-syntax export contract for `./lib/selfdrive`; test-upgrade asserts `self_drive → stepup`.

## Answers to the framing questions (2026-06-28)
- **Context-limit expansion: NOT needed.** The ceiling is OTPM (output tokens/min), not the 200K context
  window. Opus 16K OTPM → ~3 parallel agents; Sonnet 90K → ~19. More throughput comes from an Anthropic
  tier bump or smaller per-agent output, never from a bigger context window.
- **Self-awareness breadth:** 5 dimensions (performance/capabilities/knowledge/structure/history) via
  introspect.js, honest about uninstrumented gaps. self-drive now *acts* on it instead of only narrating.

## To turn it OFF / tune
`config.selfDrive.enabled = false` (or `self_drive disable`). Tune `maxPerDay`, `cooldownMin`, `cycleMin`,
`minImpact`, `push`, `branch`, `frozen`, `skipPerms` in config. **Restart the app to load.**
