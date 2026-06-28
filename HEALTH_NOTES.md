# Health (Garmin biometrics) + Manage (ops monitor)

Built 2026-06-28. Two features: (1) a Garmin-backed Health section that proactively monitors Siddhant's
biometrics and surfaces trends/improvements; (2) a "Manage" monitor so he can see, at any time, exactly
what BhatBot is running. Decisions: **native Garmin integration** (BhatBot has no MCP client, so a Python
venv worker using the same `garminconnect`/`garth` stack the eddmann garmin-connect-mcp wraps); surfaces
on the **desktop window** (two tabs, also openable on request) and the **phone PWA** (a Health screen
opened on request / via the Health tab).

## Garmin link (native, like sim-venv/mesh-venv)
- `scripts/garmin_worker.py` — runs in `~/.bhatbot/garmin-venv`. Stateless: node sends a JSON request,
  it returns one JSON object. Actions: login / status / daily / activities. Every Garmin call is wrapped
  → a missing metric is `null`, never a crash; nothing is fabricated.
- `scripts/garmin-setup.sh` — one-time: creates the venv, installs garminconnect, runs an INTERACTIVE
  login that handles MFA once and caches OAuth tokens to `~/.bhatbot/garmin/tokens` (last ~a year).
- `lib/garmin.js` — spawns the worker. **Credentials never reach the model**: email from
  `config.garmin.email`, password from the macOS Keychain (`security -s bhatbot-garmin -a <email>`),
  used only for login; thereafter cached tokens. `sync()` pulls today's biometrics + recent activities
  and appends a normalized row to `~/.bhatbot/health/history.jsonl`.

### One-time setup (Siddhant must do this — Garmin needs his login)
```
security add-generic-password -s bhatbot-garmin -a "you@email.com" -w   # prompts for Garmin password
# add to ~/.bhatbot/config.json:  "garmin": { "email": "you@email.com" }
bash scripts/garmin-setup.sh                                            # handles MFA, caches tokens
```
Until this runs, the Health monitor is a clean no-op (logs a hint).

## Analysis — `lib/health.js` (pure + DI)
- `trends(history)` — per metric: latest, 7d avg, 30d avg, delta vs baseline, direction, and `improving`
  (accounts for lower-is-better like resting HR/stress). Metrics: resting HR, HRV, sleep h, sleep score,
  body battery, stress, training readiness, steps, intensity min, VO₂max, SpO₂, respiration, weight.
- `flags(history)` — grounded, conservative, non-diagnostic observations (`concern|watch|good`) that only
  fire with real data behind them: resting HR ≥4 over 30d baseline → concern; HRV <85% baseline → watch;
  <7h avg sleep → watch; body battery <25 → watch; stress 7d-avg >50 → watch; readiness <35 → watch;
  VO₂max up / resting HR down / HRV up → good.
- `insights(portrait, deps)` — ONE bounded model call (Haiku, cheap) with a HARDCODED non-medical
  disclaimer → trends + ranked where-to-improve + safe suggestions, grounded (treats portrait as data).
  Falls back to the offline `brief()` with no model.
- 18-assertion test (`test-health.js`): normalization (sleep→h, weight→kg, same-day dedup), trend
  direction/improving, the flag thresholds (incl. a single spike NOT tripping a 7d-avg watch), and
  no-fabrication (a metric with no data produces no flag).

## Proactive monitor (default ON, no prompting)
`startHealthMonitor()` (main.js): every `config.health.syncEveryMin` (default 90m), idle of quiet hours
(no biometric pings 23:00–07:00), it syncs, pushes the portrait to the Health panel, and relays any NEW
concern/watch flag once per metric per day via Telegram + the activity stream. Toggle: `health monitor`
tool action or `config.health.enabled/proactive/quietHours/syncEveryMin`.

## Manage / ops monitor — `lib/opsstatus.js` (pure, probes injected)
`gather(deps)` → one live snapshot: every background service (self-heal, self-drive, patrol, ambient,
scheduler, health monitor, cloud relay) with on/off + detail, the active agent fleet, upcoming schedules,
per-model rate-limit budget, today's spend, and the recent event stream. Each probe is wrapped so a
broken subsystem degrades to `state:'unknown'` instead of crashing the snapshot. 12-assertion test.

## Tools + UI
- `health` tool (show/sync/insights/status/monitor/login) — opens the desktop Health tab and returns the
  portrait; `ops_status` tool (what's running) — opens the Manage tab.
- Desktop: two tabs in `src/index.html` — **❤ Health** (metric cards + trend arrows + flags + activities
  + a ✦ Insights button + ⟳ Sync) and **🛰 Manage** (service dots, fleet, schedules, budget, events;
  polls every 4s while open). IPC: `get-biometrics` / `biometrics-update` (proactive push) /
  `get-ops-status`.
- Phone: `src/mobile.html` gets a **Health** tab/screen that fetches `/api/<token>/biometrics`
  (served read-only by `mcp-server.js`, data lives on the Mac); opens via the tab or the `#health` deep
  link. `/api/<token>/ops` is also exposed for a future phone Manage view.

## Not a clinician
Every surface carries the disclaimer; the insight prompt forbids diagnoses/medication/supplement advice
and alarming language. This is decision-support over the user's own wearable data.

## Boot-gated / open
- The live Garmin pull, MFA flow, and real metric coverage can only be verified after `garmin-setup.sh`
  + a boot (the worker/venv aren't created until then). Pure logic (trends/flags/ops) is unit-tested.
- The phone "open on request" is the Health tab + `#health` deep link today; a true server→phone push
  (open-screen) can be layered on the activity stream later.
- Garmin sync cadence is conservative (90m) to stay well within Garmin's tolerance; tune in config.
