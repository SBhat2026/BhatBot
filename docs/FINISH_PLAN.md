# Finishing BhatBot: action plan

_Written 2026-11-25, after the wiring map (`npm run wiring`), a live call test, and profiling the
running app. Every item below points at something measured or found today, not at an old roadmap._

## Where it stands

| Layer | State |
|---|---|
| Wiring | **0 broken** · 37 dead · 8 untested. That covers 11 pages, 161 bridge calls, 106 IPC handlers, 147 of 155 modules live, and 96 tools, all with handlers. |
| Calls | Opener plays **~0.4 s** after pickup, and replies come back in ~0.35 s plus 1 s of listening. Three bugs from the live test are fixed (duplicate dial, test re-ring, late voicemail verdict). |
| Responsiveness | The main process was frozen **62%** of the time (stalls up to 4 s); now none over 100 ms. The causes were synchronous spawns in the status bar and an O(N²) link scan. |
| Second brain | Two processes were overwriting each other's copy. Now coherent; the Projects tab shows real projects again. |
| Tools | Tree retrieval is live. A mean turn costs 3,008 tokens of schema (was 4,778); the full catalog is 29,884. |
| Tests | `npm run verify` 133/133. |

## Stage A: dependable (do first; mostly yours)

1. ⬜ **Publish the Google OAuth app** (Cloud Console → Audience → Publish). Testing mode expires tokens
   every 7 days, which is what killed all three accounts on 22 Sep. Then re-run `google:auth` once per
   account.
2. ⬜ **Pay Fly** so the cloud can deploy. The cloud still runs July's v35, so its calls lack the
   second-person/identified wording, the 2 s listen and the written summaries. Then:
   `cd cloud && fly deploy`.
3. ⬜ **Link Telegram** (⌘K → "How BhatBot reaches me"). Until then the only written channel is the
   desktop, so a "medium" message when you're away has nowhere to go.
4. ⬜ **One week of real calls**, then read the outcomes: `scripts/live/twilio-timings` plus
   `~/.bhatbot/reach.json`. Check that pickup→first word stays under 1 s, that voicemail detection
   is right, and that no ticket is dialled twice.
5. ⬜ **The first watched `long_run` on Claude** (BACKLOG): one goal, `hours: 0.25`,
   `budget_usd: 0.50`. The hour-long lane has only ever run against a local model.

## Stage B: keep it fast and honest (one session)

6. ⬜ **A permanent main-thread watchdog.** Today's 62% freeze went unnoticed for weeks. Add an
   event-loop-lag sentinel that logs any block over 200 ms with the timer or IPC name that caused it,
   and a static check in `verify` that fails on `execSync`/`spawnSync` in `main.js` outside startup.
7. ⬜ **Single writer for the brain.** `freshen()` stops the overwrite. The clean end state is that
   the worker owns every write and the app queues prune/confirm requests to it.
8. ⬜ **Work the wiring map's 37 dead items** (`docs/wiring/index.html`):
   - 21 bridge calls no page uses (the `cred*` trio, `weaver*`, `open*` launchers…): wire each or remove it.
   - `preload-activity.js` is loaded by no window.
   - `open-blender-studio` and `set-briefing-hour` are handlers with no caller.
   - 7 modules nothing in the app loads (`adapters`, `eval`, `agenteval`, `glbcheck`, `miniagent`,
     `speechaudit`, `visualcheck`): delete them or make them tools.
   - 8 live modules have no test (`garmin`, `voiceid`, `localstt`, `phonemirror`, `vanguard`, `taper`,
     `depthmodel`, `smart-windows`). Garmin first, since it failed silently for two months.

   Then add `npm run wiring -- --check` to `verify`.
9. ⬜ **Schema diet.** 96 tools; the six biggest (`make_model`, `long_run`, `forge_tool`,
   `build_project`, `make_asset`, `smart_login`) are 4,100 tokens between them. Merge the overlapping
   ones (`make_asset`/`visual_build`/`make_model`; `agent_team`/`deploy_drones`/`long_run`). Target
   mean ≤ 2,600.

## Stage C: the unbuilt redesign phases (REDESIGN_PLAN §13)

10. ⬜ **Phase 2, `lib/providers.js`** (missing): one tool-calling interface over Anthropic, OpenAI and
    Ollama. Everything in phase 6 depends on it.
11. ⬜ **Phase 6, `lib/cascade.js`** (missing): local model first, with confidence-based escalation and
    a spoken warning when it escalates. Gate: a blind A/B you sign off on.
12. ⬜ **Phase 10, making tools and the UI**: bring back the making tools on the freed context budget.
    Apply the logo (`docs/LOGO_BRIEF.md` → Claude Design) across the app icon, title bar, phone icon
    and README.
13. ⬜ **Cloud parity.** `cloud/src/toolselect.js` is still the old embedding top-k with a
    full-catalog fallback; port the category tree. Keep `cloud/src/callscript.js` in sync; the
    call-path test enforces that.

## Stage D: what "finished" means

BhatBot is done when, for one ordinary week:

- every call it places is answered correctly, leaves the right voicemail, or is skipped for a
  stated reason, and none is placed twice;
- no main-thread stall over 200 ms appears in the watchdog log;
- `npm run verify` and `npm run wiring -- --check` are both green on every commit;
- spend stays inside $5/day, with the hard ceiling of $10 never touched;
- the Projects tab and the second brain agree with what you actually worked on that week.

## Security watch: the Agent Office's public link

The office (`~/bhatbot-office`, the 3D office with live terminals on this Mac) is reachable two ways:

- **Tailnet only:** https://siddhants-macbook-pro.tail816be0.ts.net:8443 (Tailscale Serve). Only devices signed in to his Tailscale.
- **Public:** https://siddhants-macbook-pro.tail816be0.ts.net:10000 (Tailscale Funnel). Anyone with the URL reaches the sign-in page.

⚠️ **Known risk.** A desk's terminal is a shell on this Mac, so the public link is only as strong as the office's sign-in. The office limits sign-in attempts per visitor (10 per window; `--trust-proxy` makes that apply to the real visitor, not the proxy).

**His rule (26 Nov):** once the office has more than 20 users, it becomes tailnet-only. `lib/agentoffice.js` → `exposureGuard()` checks hourly and closes the public link past 20 accounts, then tells him.

**Guests (26 Nov).** People he invites as guests (BhatBot: "invite Sam to the office", or ☰ → 🔑 Accounts → Guest) can walk round, talk by proximity voice, type in chat, sit at the meeting table or on its bench, and play the games and the jukebox. They can't hire, prompt or send home a worker, read a terminal, or touch GitHub, settings or accounts unless he switches that group on under **What guests can do**. The office checks every guest message and request on the server, not just the buttons. A guest's wall picture can't point at this Mac or its networks, and the office only fetches pictures that are already hung for a guest. Each guest is an account, so guests count toward the 20.

⚠️ Voice between people uses STUN only. Guests behind strict NATs (some campus or phone networks) get text chat but may get no audio. A TURN relay fixes that (`--turn turn:user:pass@host:3478`); the Fly coturn would do once Fly is paid.

⬜ Make yourself an admin account (`agent-office accounts invite <name> --admin`), sign in with it, then switch the shared password off. Anyone with the shared password is an admin and counts as zero accounts, so the 20-user rule can't see them.

## Needs your judgement (research, held back from the cleanup)

| Folder | Why it might go | Why it's held |
|---|---|---|
| `~/build` (Apr 2026, 93 MB) | No activity in 7 months | Molecular-dynamics run files (`1AKI.pdb`, GROMACS `.gro`/`.edr`) |
| `~/myenv` (Sep 2025, 914 MB) | Over a year old | Python environment with `esm`, a protein language model |
| `~/pfun-env` (Sep 2025, 785 MB) | Over a year old | Protein-function environment |
| `~/Desktop/Folders/cell-model` (Jun 2026) | One HTML file, untouched for 5 months | A cell-model visualisation |
| `~/bioconvert`, `~/chemparse`, `~/sci-services` (Jun 2026) | Each was written in one day, never revisited | Science tools, all pushed to GitHub |

Already moved to the Trash today, all restorable:

- `~/TRELLIS.2` (BhatBot uses TRELLIS through Replicate, not this clone)
- the Iron Man suit project file and its 10 notes
- `~/void_engine` (on GitHub)
- `~/env` (an empty environment)
- `~/venv` (an old Flask/Dash environment)
- `~/Desktop/Folders/BhatBot` (the June Xcode prototype, replaced by `phone-app/`)

The Iron Man note `…eurocase-challenge-progress.md` was kept, because it also records uricase work.
