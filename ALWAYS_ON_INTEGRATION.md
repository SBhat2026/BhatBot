# BHATBOT — ALWAYS-ON INTEGRATION PLAN

_Single tracker consolidating six sprint docs (always-on roadmap, triage spec, Phase A, Passes B–E, Glimmer local tier, intake sprint) into one merge order. Status is verified against the tree, not the docs — several doc "TODOs" already shipped._

## 0. Verified state (2026-08-12)

| Sprint item | Doc says | Tree says |
|---|---|---|
| Intake T1 deterministic router | TODO | ✅ `classifyIntake` in `lib/pure.js`, wired at `main.js:6101` |
| Intake T2 `TurnState` reducer | TODO | ✅ `lib/turnstate.js`, wired at `main.js:1112` |
| Intake T3/T4 state-bound progress | TODO | ✅ `turn_start` before recall, `pushTurnState` |
| Pass B5 checkpointing | TODO | ✅ **superseded by `lib/mission.js`** — goal externalization, plan artifact, step journal, durable circuit breakers, park/resume |
| Scheduler yields to foreground | — | ⚠️ partial: `tickScheduler` checks `agentState !== 'idle'`, ambient/synapse/patrol do not |
| B1 job persistence | TODO | ⬜ `lib/jobs.js` is a bare `Map`, zero writes |
| B2 single lock | TODO | ⬜ no lock; 6 independent timers |
| B3 buffer caps | TODO | ⬜ `screenWatchBuffer`, `sessionSpoken` unbounded |
| B4 thermal governor | TODO | ⬜ only `shouldSpareWatts()` (battery, binary) |
| C1 live-heal lane | TODO | ⬜ |
| Phase A triage | TODO | ⬜ `lib/{signals,triage,actionlog}.js` absent |
| Glimmer three-slot models | TODO | ⬜ |

## 1. Merge order

**Wave 1 — endurance infrastructure. ✅ SHIPPED** (branch `endurance-pass-b`, 42 new assertions, `npm run verify` green).
- ✅ `B1` durable job bus — `lib/jobs.js` now JSONL-backed; in-flight work returns as `interrupted`
- ✅ `B2` `lib/agentlock.js` — one re-entrant lock; all six background timers now `tryRun` (skip-if-busy)
- ✅ `B3` bounded `screenWatchBuffer` (300) + `sessionSpoken` (400) + heap/lock line in `rstate`
- ✅ `B4` `lib/governor.js` — thermal + memory shed ladder, sized for the **measured 16GB** Air
- ✅ `C1` `lib/livehealth.js` — in-run recovery (re-auth / restart / backoff), no git writes; C3 blocker report wired to mission park

Two defects were found by the tests during this pass and fixed:
1. **Governor first-poll throttle** — `lastSample = 0` meant the very first `poll()` was throttled away, so the governor ran on a null sample until its first window elapsed.
2. **Scheduler→dispatchTurn deadlock** — `tickScheduler` holds the lock *and* calls the agent, which also takes it. A plain mutex would have wedged the entire app on the most routine path in the system. Fixed with `AsyncLocalStorage` re-entrancy (a boolean would not survive `await` boundaries).

**Wave 2 — local tier. ❌ SKIPPED (Siddhant, 2026-08-13).** Glimmer 30B can't run on a 16GB fanless Air, so the three-slot config buys nothing here. Phase A shipped without a `triage` model slot: the deterministic ladder resolves everything, and `ambiguous` simply means "surface it, touch nothing". Revisit only if a hosted judge slot is wanted for cost reasons.

**Wave 3 — proactive mail. ✅ SHIPPED.** `lib/{signals,triage,triage-table,triagerun,actionlog}.js` + `triage_mail` tool + `scripts/triage-backlog.js`. Acts on NEW `noise` only; backlog stays dry-run. 45 assertions.
- ⚠️ **BLOCKED ON RE-AUTH:** the Google refresh token is expired (`invalid_grant`). Run `npm run google:auth`. Triage no-ops until then and says so once.
- Two pre-existing bugs fixed en route: `lib/google.js` never resolved `CRED_REF` handles (every Gmail call had been failing `invalid_client` while `isConfigured()` returned true), and macOS safeStorage keys off the app NAME (a script run as `electron foo.js` reads the wrong Keychain item).

**Wave 3b — second brain. ✅ SHIPPED.** `lib/fileindex.js` deep file index (20,132 candidates → 1,719 indexed, ~$0.009 to embed) + PROJECTS tab (⌘7). 49 file nodes → 1,684.

**Wave 3c — file_tools. ✅ SHIPPED.** `lib/filetools.js` (16/19 ops local via sips/ffmpeg/pypdf/PIL) + `lib/filesense.js` learned upload gate. thetoolbus.ai is behind bot protection (403 to any scripted request) so it is opened in the browser, never scraped.

**Wave 4 — deep autonomy.** C2 backtracking (on mission checkpoints), D tool authoring, E memory consolidation.

## 2. Wave 1 rationale

The failure modes that end a long run, in observed frequency order:

1. **Timer/turn contention.** `dispatchTurn` serializes turns, but ambient (30m), synapse (hydrateMin), patrol (5m), self-heal (15m), health (15m+) and scheduler (30s) fire independently into module-level globals (`agentState`, `currentMode`, `_activeTools`, `ttsStream*`). → **B2**.
2. **Transient externals.** Expired OAuth, hung Playwright page, rate limit, unloaded Ollama model. The deep self-heal lane cannot fire (it requires `idle: true`, and a long run is never idle). → **C1**.
3. **Thermal throttle.** Fanless Air sustains local inference ~8–12 min before dropping 15–25%. Current gate is battery-only and binary. → **B4**.
4. **Crash amnesia.** In-flight jobs vanish; missions survive, jobs do not. → **B1**.
5. **Slow leak.** Two unbounded buffers over an 8-hour session. → **B3**.

## 3. Guardrails (unchanged)

Frozen zone · `lib/risk.js` · verify-or-revert · untrusted-code wall · never-push · ElevenLabs-only voice · `gmail.modify` scope (no send, ever).
`npm run verify` stays green; every new module gets a `scripts/test-*.js` in the chain.
