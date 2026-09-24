# BhatBot — Backlog

_The single list of what is actually open. Re-verified against the code on 2026-08-21._

> **This file is only worth anything if it is true.** Its first draft was transcribed from the old
> sprint docs and labelled "verified" when it was not: **T4** (streaming digest) and **T5/T6** (the
> learned spoken-length loop) were both fully wired in `main.js` — the grep that "proved" them open
> had looked in `lib/speech.js`, where `makeSpeakStream` does not live — and **B3** was already
> extracted to `mcp-server.js`. Three wrong entries out of about twenty, in a file whose entire job
> is to be trusted, and which `lib/introspect.js` and `lib/codescan.js` read as live open debt.
> Check the code before adding a line here, and check it again before believing one.

This replaces the debt that was scattered across ~17 phase notes, sprint reports and roadmaps.
Those files had drifted badly: **most of what they listed as "not built" had shipped months ago**
(`lib/jobs.js` durable persistence, `lib/agentlock.js`, `lib/livehealth.js`, the whole
`signals`/`triage`/`actionlog` triage lane, `lib/pure.js`, `lib/audit.js`, the `deploy_drones`
tool). Anything reading those files for "open debt" was therefore being fed work that was already
done — and `lib/introspect.js` and `lib/codescan.js` both did exactly that, which is how the agent
came to believe it had debt it had already paid.

**Both readers now point here.** Keep this file honest and they stay honest. Mark an item done by
deleting it, not by leaving a ✅ behind — a list of completed work is what the phase notes were.

---

## Open

### Broken right now (found 2026-09-21)
- ⚠ **Fleet presence: characters can spawn on top of each other.** Two agents landing on adjacent POIs
  overlap their labels so one is unreadable. Cosmetic, but the office is there for the visual read.

### Optimise the tools that cost money
Ordered by spend per call. Each one is a real lever, not a micro-optimisation:
- ⬜ **`visual_build` (video) — the most expensive call in the system.** Priced per second of output
  × resolution; a 10s 1080p clip is ~$3.20. No confirmation gate today. Add a cost estimate in the
  confirm card before it fires, and default `resolution` to 720p rather than inheriting.
- ⬜ **`generate_image` — cheapest big win.** `flux-fast` is $0.003 vs `openai` at $0.04 medium /
  $0.08 high — a 13–27× spread. Route the default by intent: drafts and thumbnails to flux-fast,
  only final assets to the high tier.
- ⬜ **`generate_3d` / `make_asset`** — $0.10 a call through Replicate, and `make_asset` can chain
  image → 3D → STL, so one call is three billable stages. Make the chain resumable so a failure at
  the STL stage does not re-bill the image.
- ⬜ **Fleet and drone fan-out** — N agents multiply every per-turn cost by N. The admission ledger
  paces them against the rate window but does not cap total spend; `envelopeUsd` exists and is not
  enforced as a hard wall (`lib/admission.js` admits on timeout by design, which is right for a
  convoy stall and wrong for a budget).
- ⬜ **Kill the ack/keep-alive spend when idle.** `cacheKeepAlive` refreshes the prompt cache every
  ~4 min within 30 min of activity. Correct for a bursty session; pure waste if the machine is
  standing alone in standby, which it now knows it is.


### Split main.js (the long-running one)
`main.js` is **696KB**. The 150KB target from the old split plan is not realistic as stated, but the
extraction itself still pays: steps 1–7 landed (`lib/pure.js`, `lib/audit.js`, `lib/shell.js`,
`lib/simulate.js`, `lib/creation.js`, `lib/vision.js`, `lib/system.js`, `lib/media.js`,
`lib/browser.js`). What remains needs the GUI to boot to verify, which is why it stalled:

- ⬜ **B1** — extract the agent loop (`agentLoop` / `runPipeline` / `fastReply` / `dispatchTurn`) into `lib/loop.js`
- ⬜ **B2** — extract the tool registry + `executeTool` into `lib/tools/` (one file per tool group)
- ⬜ **B4** — extract voice/TTS (`speakDesktop`, speak-stream, `maybeAdjustSpeed`) into `lib/voice.js`

### Deferred capability modules (designed, never built)
From the FORGE sprint. The runtime floor each depends on **does** exist
(`lib/sandboxexec.js`, `lib/drone.js`, `lib/fleet.js`, `lib/blackboard.js`):

- ⬜ `lib/repoauto.js` + a `test_repo` tool — clone an untrusted repo, install/test/run it behind the sandbox wall, report with screenshots
- ⬜ `lib/swarm.js` — persona/scenario runner so drones can swarm-test an app (two agents conversing)
- ⬜ `lib/visualloop.js` — design → critique → revise loop for visual work (N iterations against a rubric)
- ⬜ `lib/compbio.js` — AlphaFold/PDB fetch + render (a `1crn.cif` fixture is already in the repo for an offline test)
  — now also has a renderer: `make_model` can build the figure in Blender rather than only viewing a structure.

### Blender (`lib/blender.js`, shipped — these are the next steps, not gaps)
- ⬜ **Reuse a build.** Every `make_model` call starts from an empty scene. Opening the previous
  `.blend` and editing it is what "make the shade taller" should mean, and today it re-runs the script.
- ⬜ **Materials beyond a base colour.** `_paint` sets Base Color; roughness, metalness and emission
  are reachable from the same node and would cost almost nothing to expose.
- ⬜ **Turn a render into a video.** The frames exist and Seedance is already wired for image→video.

### Second brain (SECOND_BRAIN_PLAN.md)
- ⬜ **P3 Scout** — web enrichment of graph nodes. No enrichment exists at all today.
- ⬜ **P5 Sync** — local ↔ cloud ↔ Notion reconciliation.

### Proactivity
- ⬜ **C1 initiative engine** — idle-time pass over calendar + unread important mail that proposes, not just reports
- ⬜ **C3 outcome learning** — track whether a proactive ping was acted on, feed that back into C1's threshold

### Fine-tuning (AMBITIOUS_ROADMAP §A)
Gated on data volume, not on code:
- ⬜ **A1** — accrue past ~200 SFT pairs before the next train
- ⬜ **A3** — DPO pass over preference pairs (`finetune.sh` is SFT-only)
- ⬜ **A4** — surface the active local model + last A/B win-rate in the UI

---

## Needs Siddhant, not code

- ⬜ **SideStore install** for the native phone build (instructions in `SIDESTORE-AND-NOTION-SETUP.txt`)
- ⬜ **Cloud deploy** — `cloud/` is ready; deploying it and setting its secrets is your call, since your keys live there
- ⬜ **Stable tunnel** — a Cloudflare named tunnel needs a domain on your CF account
- ⬜ **Tune the wake gate against your room.** `make_model` and the addressivity gate need no tuning,
  but the loudness floor does: it ships at `wakeRms 0.02` / `wakeMargin 3.5`. If it still triggers
  from across the room, raise `wakeRms` in config; if you have to lean into the mic, lower it. Every
  gated trigger is reported (`[wake] gated N quiet trigger(s) in the last minute …` with the measured
  peak and bar), so tune against the numbers rather than the feel.

---

## Known-good, do not "fix"

Recorded because each one looks like a bug until you know why it is that way:

- **Playwright is installed and both launch paths work.** This file claimed five browser tools were
  dead because `~/Library/Caches/ms-playwright/` did not exist. It does (`chromium-1223`), and both
  `chromium.launch()` and `channel:'chrome'` were observed opening a page and reading its title on
  2026-09-23. The entry was a claim nobody re-checked; `self_check area:browser` now checks it, so the
  next version of this worry answers itself. Do not add `channel:'chrome'` — it buys nothing here and
  pins the stack to whatever Chrome ships.

- `lib/brain.js` keeps its own `cosine()` rather than importing `lib/semantic.js` — deliberate, so the
  graph layer stays dependency-free and runs in the cloud brain.
- `sayLocal()` falls through to macOS `say` ONLY when no TTS provider is configured. It is not a
  second voice; the rogue-voice bug was fixed by routing it through `speakDesktop`.
- `lib/agents/select.js` is not the chat router. It is the separate provider selector for the
  stateless DAG role agents, which cannot reach `chooseModel`/`callModel` (those are Electron-internal).
- `ROLES[x].tools` no longer exists — `ROLE_TOOLS` is the only grant list. `validateRoleTools` fails
  if a second one reappears.
