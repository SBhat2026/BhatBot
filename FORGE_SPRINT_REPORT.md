# FORGE Sprint — Progress Report (branch `forge-sprint`, not pushed)

_2026-07-02. Verify-gated foundation delivered; feature phases mapped honestly to status._

## Decision on scope

The FORGE sprint specifies 8 phases + 8 acceptance demos — genuinely weeks of work, much of
it gated on external tooling that can't be verified headless (Docker, Blender, iOS Simulator,
live scholarly APIs, comp-bio venvs). The discipline is explicit: **"never red, extend the
suite every phase."** Scattering 8 half-wired, unverifiable features across the codebase
would violate that. So this session built the **load-bearing foundations every later phase
depends on, each fully tested**, and stops there rather than shipping untested breadth.

## Shipped + verified this session (49 new assertions, full `npm run verify` green)

| Task | Module | Tests | What it delivers |
|---|---|---|---|
| **T5** shared blackboard | `lib/blackboard.js` | 17 | Per-workspace live cross-agent state (post/read/fleetStatusBlock/claim/heartbeat). Injected into every agent's context via `base.js`. |
| **T6** DAG dependencies | `lib/agents/orchestrator.js` | 7 | `needs:[]` edges, ready-set scheduling, failed-dep → blocked-with-reason (independent branches continue), dep-summary injection. Planner prompt emits ids+needs. |
| **Untrusted-code wall** | `lib/sandboxexec.js` | 12 | Scrubbed-env exec floor: allow-list env (no secrets/keychain/dotfiles), throwaway HOME, opportunistic macOS network-deny. **Canary test proves a real parent-env secret is invisible inside.** |
| **D1** drone runtime + fleet | `lib/drone.js`, `lib/fleet.js` | 13 | Scoped BhatBot instances (persona + strict tool subset + budget + board); fleet supervisor with admission-gated launch, envelope wallet, hard cap, and cooperative **stall reaping**. |

## Acceptance demos → status

| # | Demo | Status |
|---|---|---|
| 1 | Clone & test a repo → report w/ screenshots | ⬜ Deferred — the sandbox lane (floor) is built (`lib/sandboxexec.js`); `lib/repoauto.js` + `test_repo` tool + probe pipeline not yet built. |
| 2 | Deploy drones to swarm-test the phone app, two conversing | ⬜ Deferred — drone/fleet runtime built; `deploy_drones` tool wiring in main.js + `lib/swarm.js` persona/scenario runner not yet built. |
| 3 | Design a hero section w/ 3 critique iterations | ⬜ Deferred — `lib/visualloop.js` not built. |
| 4 | Sweep a param across 20 values and plot | ⬜ Deferred — `simulate` session/sweep not built. |
| 5 | Pull an AlphaFold structure and show it | ⬜ Deferred — `lib/compbio.js` not built (note: `1crn.cif` fixture noted for offline test). |
| 6 | Triangulated lit review w/ citations | ⬜ Deferred — `lib/integrations/scholar.js` not built. |
| 7 | "Improve yourself" w/ reviewer gate, style-clean | ◑ Partial — approve-at-start + free-run + self-degradation ban shipped last session; REVIEWER stage + `docs/CODE_STYLE.md` (C1/C2) not yet added. |
| 8 | Voice continuous/digest/v3 acks; zen UI w/ drone dots | ⬜ Deferred — Phase 8 (previous sprint's T1–T4, T8–T10). |

## What's now unblocked (foundations are the hard part)

- **Fan-out (T7)** is a thin wrapper over `runFleet` + a synthesis call — the runtime exists.
- **Repo autopilot (Phase 2)** install/test lanes route through `sandboxexec.run` (built);
  remaining work is recon/run/probe DAG nodes + report.
- **Swarm (Phase 3)** persona drones = `createDrone` with behavioral personas + Playwright
  contexts; the coordination substrate (blackboard barriers) exists.
- **Sim sweeps / research triangulation** are DAG shapes over drones — both primitives exist.

## Next-session order (recommended)

1. `deploy_drones` tool + Activity rows (D2) — makes the fleet user-reachable.
2. T7 fan-out (subagent parallel mode + synthesis) on top of `runFleet`.
3. Phase 2 `repoauto` (the sandbox floor is the risky part; it's done + canary-tested).
4. Phase 3 swarm, then 4/5/6, then 7 reviewer gate, then Phase 8 voice/UI.
