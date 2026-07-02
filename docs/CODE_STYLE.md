# BhatBot — Code Style (the standard every agent writes to)

Distilled from the strongest patterns in this repo. The self-drive REVIEWER stage and the
optional `claude_code` review gate load this and score diffs against it. Rules are concrete and
checkable; a `severe` violation blocks an autonomous change until revised.

## JavaScript / Electron (main process, `lib/*`)

1. **`'use strict';` at the top of every module.** No exceptions.
   - GOOD: `'use strict';\nconst fs = require('fs');`
2. **Pure, DI-friendly lib modules.** A `lib/*` module takes its dependencies as injected params
   (a factory or an explicit `deps` object); it does NOT reach back into `main.js` or Electron.
   This is what makes it testable headless.
   - GOOD: `function createAdmission({ freeBudget, sleep, log }) { … }`
   - BAD: `const { mainWindow } = require('../main');` inside a lib module.
3. **Comments explain WHY, not WHAT.** Dense header block per module stating its job + any
   non-obvious decision ("DECISION — … because …"). Inline comments justify a choice or flag a
   constraint; never restate the code.
   - GOOD: `// allow-list, never deny-list → a new secret env var is excluded by construction`
   - BAD: `// loop over the array` above a `for`.
4. **Call out invariants explicitly** where one exists (e.g. "tts-idle MUST fire every turn").
   Name the invariant so a future edit knows not to break it.
5. **Defensive caps + graceful degradation.** Bound every unbounded thing (slice tool results,
   cap history, cap injected text). A missing dependency (package, key, service) returns a clear
   `{ error, hint }` and degrades — it never throws on the hot path.
   - GOOD: `JSON.stringify(r).slice(0, 16 * 1024)` ; `if (!c.elevenLabsKey) return { error: 'no elevenLabsKey' };`
6. **Never swallow an error silently in a way that hides a real failure.** `try {} catch {}` is
   fine for best-effort side-effects (telemetry, a board post); it is NOT fine around the core
   operation whose failure the caller needs to know about.
7. **Secrets never reach the model or a log.** Vault handles (`CRED_REF_*`) only; redact before
   audit; the untrusted-code wall (`lib/sandboxexec.js`) for anything cloned or generated.
8. **Match surrounding style.** Terse, high-signal. No reformatting untouched lines. New/changed
   lines only.

## Python (`scripts/*`, sim/compbio venvs)

9. Import-guard optional deps; print an install hint and exit non-zero rather than a stack trace.
10. Deterministic where it matters: log seed + versions for anything a result depends on.
11. Keep workers small and single-purpose (one `*_worker.py` = one job over stdio/JSON).

## Web frontend (Next.js / Tailwind — his stack)

12. Server Components by default; `'use client'` only where interactivity requires it.
13. One accent color, restraint over decoration, hairline borders, system type unless branded.
14. No inline mega-styles; compose Tailwind utilities; extract a component when a pattern repeats.

## Commit messages

15. `area: imperative summary` subject (≤ ~72 chars), then a body explaining WHY + what changed +
    how it was verified. End with the `Co-Authored-By` trailer. One logical change per commit.

## Self-modification (autonomous changes)

16. Never touch the frozen zone (`lib/risk.js` `FROZEN_ZONE`). Never weaken a guardrail, gate,
    limit, or the verify suite — that is self-degradation and is banned.
17. Smallest correct change. Read before editing. Verify (`npm run verify`) must pass green.
