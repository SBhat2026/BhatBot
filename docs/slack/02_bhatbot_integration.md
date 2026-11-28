# Slack investigation 2/3 — BhatBot integration & adapter design

Angle: how a chat message enters/leaves BhatBot today, where a Slack adapter plugs in, what breaks.
Siblings: `docs/slack/01_slack_platform.md` (Slack capabilities), `docs/slack/03_security_cost_alternatives.md` (security/cost/alternatives).
Base: `origin/main` @ `7953034`. Investigation only — no code, no Slack calls, no app created.

Legend: **verified** = read in code/docs · **inferred** = reasoned from verified facts · **unknown** = not checked / not in repo.
Code cites are `file:line` on that commit. Slack cites are URLs read on 2026-11-28.

## Verdict (read this first)

- ✅ **GO PARTIALLY.** Chat can move to Slack for text command/reply, notifications, button confirmations and files. Voice, wake word, and the desktop's HUD/3D/streaming-TTS UX cannot.
- ✅ **Smallest seam already exists and is proven**: `runAgentHeadless()` (`main.js:7107`) → `dispatchTurn()` (`main.js:7021`). Phone MCP (`mcp-server.js:205`), SMS (`mcp-server.js:479`), cloud executor and Telegram (`main.js:7273`) all funnel through the same pipeline. Telegram is a ~70-line twin of what Slack needs (`main.js:7273-7341`).
- ✅ **Outbound seam is one function**: `telegramNotify()` (`main.js:7343`) has ~25 call sites; `notifyUser()` (`main.js:7682`) routes by urgency. Swap/fan-out there = Slack notify-only in ~1 day.
- ⚠️ **Not in the daemon today.** The headless daemon (`scripts/synapse-worker.js`) has no agent loop; `agentLoop`/`executeTool` live inside the 11k-line Electron `main.js` (`main.js:3` requires electron; `main.js:5890`, `main.js:4325`). Run the adapter **in the Electron main process** (what Telegram does), or in the **Fly cloud brain** (`cloud/`) for Mac-off presence.
- ⚠️ **Confirmations need real work**: `requestConfirm` (`main.js:2597`) has no timeout, and remote turns auto-deny step-up tools (`lib/risk.js:61`). Slack buttons fit the shape (promise-per-id) but a new trust tier must be decided.
- ⚠️ **Degrades**: voice/wake/endpointing, TTS, live token streaming, 3D/HUD/Activity window, phone Control tab, concurrent turns (global serial chain).
- Effort: **stage 0 ≈ 1 d · stage 1 ≈ 3–4 d · stage 2 ≈ 4–5 d · stage 3 ≈ 8–12 d** (engineer-days). Recommend stopping at **stage 2, stay hybrid**.

## 1. How a chat message enters and leaves today

| Surface | Entry | Pipeline | History | Reply path | Verified |
|---|---|---|---|---|---|
| Desktop UI | `ipcMain.handle('chat')` `main.js:10730`; renderer calls `bhatbot.chat` (`preload.js:9`) | `dispatchTurn(..., {stream:true})` `main.js:10813` | renderer owns `history`, passed in each call | return value + `tool-update` IPC events (`type:'token'` partials, `main.js:6779`, `main.js:6880`); TTS stream | ✅ |
| Phone PWA / native app → Mac | `POST /api/:token/chat` `mcp-server.js:205` | `runAgentHeadless` `main.js:7107` → `dispatchTurn` | **one global** `mcpHistory`, last 40 msgs (`main.js:7106`, `7134`) | single JSON `{text}`; phone polls `/activity` every 3 s (`mobile.html:834`) | ✅ |
| Claude app / MCP | `run_task` tool `mcp-server.js:34` | same | same global | MCP result text | ✅ |
| SMS | `POST /sms/:token/incoming` `mcp-server.js:479` | `runAgent('[SMS] …')`; 2FA/pending-reply hooks `main.js:7113-7130` | global | TwiML `<Message>` ≤1500 chars | ✅ |
| Telegram | polling bot `main.js:7273` | `agentLoop` directly (bypasses `dispatchTurn`: no slash cmds/intake router) `main.js:7317` | per-chat `Map`, last 20 `main.js:7272,7314` | `sendMessage` ≤4000 chars, Markdown w/ plain fallback | ✅ |
| Cloud brain (Fly) | `POST /api/:token/chat` `cloud/src/server.js:78` → `runTurn('phone',…)` `cloud/src/agent.js:56` | **separate agent** with its own tools, SQLite memory | per-convId in SQLite | JSON; Mac-only tools dispatched over WS | ✅ |
| Mac as cloud executor | Mac dials `wss://…/mac/:token`, `lib/cloud-bridge.js:19-26`; cloud `relay.macExec` `cloud/src/relay.js:62` | `executeTool` directly with `remoteDepth++` `main.js:7197` | n/a | `{type:'result'}`; queues when Mac asleep `relay.js:26` | ✅ |
| Phone call (Twilio) | `/voice/:token/*` `mcp-server.js:377-466` → `voiceBegin` `main.js:7397` | fast path or background agent with filler + sentence streaming | per-CallSid `voiceCalls` | TwiML/TTS | ✅ |

Notes
- ✅ `_dispatchTurnInner` (`main.js:7032`) is documented as "single entry point every chat surface routes through": slash commands (`lib/commands.js`, `main.js:7063-7076`), intake router, `agentLoop`/`fastReply`/pipeline, episodic recording. Telegram skipping it is an existing inconsistency, not a design.
- ✅ Turns are **globally serialised** (`_turnChain`, `main.js:7021-7030`; `agentLock`). A long Slack task blocks the desktop and vice-versa. Same today for phone/Telegram.
- ✅ No `lib/agentoffice.js`, `lib/addressee.js`, `lib/callgate.js`, `lib/callscript.js`, `relay/` dir, or `BACKGROUND_EXECUTION.md` exist in this repo at `origin/main` (checked `git ls-files`, grep for "agent office" = 0 hits). Nearest equivalents: `lib/addressivity.js`, `cloud/src/relay.js`, `lib/jobs.js`, `DAEMON.md`. ⚠️ Brief's file list partly stale.
- ✅ **Agent Office is a separate repo/product** (`~/bhatbot-office/work/office`, TypeScript server). Its iMessage path is `src/server/knock.ts:87-99` (AppleScript `Messages` → owner phone, link is the owner's tailnet base `config.ownerBase`); owner identity = loopback + `tailscale-user-login` header (`src/server/owner.ts`). Nothing in BhatBot imports it. **Unknown**: how the "Agent Office section" inside BhatBot UI is wired (no code in this repo).

## 2. Feature-by-feature map

### Inbound text, attachments, images
- ✅ Text → `lastUserText(history)` (`main.js:2003`). External text should pass `security.sanitizeExternalContent(text,'slack')` as Telegram/SMS do (`main.js:7311`, `7123`; `lib/security.js:51`).
- ✅ Attachments: phone uploads raw bytes to `/attach` (`mcp-server.js:216`) → `mediaBytesToBlocks(buf,mime)` (`main.js:2389`) → vision blocks passed as `opts.blocks` (`main.js:7132`). `lib/attach.js` classifies ext (image/video/pdf/text/file). Slack adapter: download `url_private` with bot token + `files:read`, host must be `files.slack.com`, https only (https://docs.slack.dev/messaging/working-with-files), then same `mediaBytesToBlocks`. Inferred: reuses everything. Telegram does **not** handle attachments (voice only) → new code.
- ✅ Voice notes: Telegram transcribes via `transcribeAudio` (`main.js:7296-7301`). Slack voice clips are files → same pattern (inferred; clip format unknown).

### Outbound text and partial output
- ✅ Final reply = `res.text`. Partial tokens are emitted only through `event.sender.send('tool-update',{type:'token'})` (`main.js:6779`) — headless callers pass a no-op sender (`main.js:7141`). So today **no remote surface gets token streaming**; phone shows "…" then whole reply (`mobile.html:473-480`).
- ✅ Activity events are also ringed by `pushActivity` (`lib/runtime-state.js:23`), served by `getActivity` (`:35`). A Slack adapter can poll/subscribe this to post progress (inferred).
- Slack: reply ≤4,000 chars recommended, truncates >40,000; ~1 msg/s/channel (https://docs.slack.dev/reference/methods/chat.postMessage). Edit-in-place via `chat.update`, Tier 3 ≈50/min (https://docs.slack.dev/reference/methods/chat.update) → throttle progress edits to ≥2–3 s. Native streaming exists (`chat.startStream/appendStream/stopStream`, ≤10 min open, needs `assistant:write`, paid-plan caveat **unknown**) (https://docs.slack.dev/ai/developing-agents). Needs a token-callback hook that `agentLoop` doesn't expose to headless callers → only worth it in stage 3.
- ⚠️ Long replies: split at paragraph boundaries into threaded chunks; code → file snippet.

### Slash commands
- ✅ Builtins `/help /agents /agent /new-command /blender` (`lib/commands.js:26-32`) executed at `main.js:7063`. Go through `dispatchTurn` → free in Slack. ⚠️ Slack reserves `/` for its own slash commands: a message starting `/agents` typed in a DM is intercepted by Slack client unless registered as app slash command. Mitigation: register `/bhat <cmd>` (one slash command) and rewrite to `/<cmd>` (inferred; see 01 for Slack slash-command limits). **Unknown** until tested.

### Addressivity / wake word
- ✅ `lib/addressivity.js` decides "to me vs about me" for **spoken** utterances (header, lines 1-30). Irrelevant for Slack DMs (explicit addressing). For channel use, replace with Slack's own `app_mention` (https://docs.slack.dev/reference/events/message.channels says use `app_mention` to receive only messages sent to the app). ✅ → **drop**, no port.

### Voice
- ✅ Desktop: wake word, adaptive endpointing (`lib/endpoint.js`), ElevenLabs/local TTS (`main.js:9682`, `9821`), voice-id (`lib/voiceid.js`). Phone: Twilio call engine (`main.js:7397+`), `cloud/src/voice.js`.
- ⚠️ **No Slack equivalent** for live voice. Slack gets: voice-note in (STT) and text out. Calls keep running on Twilio. Slack huddles are not an API surface I verified → **unknown / out of scope** (see 01).

### Tool-use confirmation prompts
- ✅ Three desktop prompts, all "promise keyed by id, resolved by IPC":
  - `requestConfirm(command, reason, opts)` `main.js:2597` → renderer event `confirm-required` (`main.js:2612`) → `ipcMain.on('confirm-response')` `main.js:10868`. **No timeout** (verified: `pendingConfirms.set` `main.js:2611`, no timer). Differs from options/forms which time out at 5 min (`main.js:2630,2650`).
  - `requestOptions` `main.js:2621` (checkbox card) → `options-answer` `main.js:2632`.
  - `requestForm` `main.js:2641` → `form-answer` `main.js:2652`.
- ✅ Gating: `executeTool` classifies via `riskOf(name,input,channel)` (`lib/risk.js:59`); `channel='remote'` when `isRemote()` (`main.js:4346`). Over remote: `confirm` tier allowed+audited (`remoteOk`), `stepup` tier (code mods, secrets) **denied**, destructive shell denied unless `remoteAllowDestructive` (`main.js:2598-2603`, `lib/risk.js:61`). `forceHuman` bypasses autonomy but only if a human can answer.
- Slack mapping (inferred):
  - `requestConfirm` ↔ Block Kit message with Approve/Deny buttons; `block_actions` payload carries `user`, `actions[].action_id/value` (https://docs.slack.dev/apis/events-api/using-socket-mode, button example). `action_id` = pending id; handler calls the same `pendingConfirms.get(id)(approved)`.
  - Slack requires ack of the interaction **within 3 s**; heavy work must go async. `response_url` valid 5 uses / 30 min (https://docs.slack.dev/interactivity/handling-user-interaction). Because our resolver only flips a promise, ack is trivial; use `chat.update` to replace buttons with "✅ approved by @you".
  - `requestOptions` ↔ buttons (single) / `static_select`/checkboxes (multi). `requestForm` ↔ Slack modal via `views.open` (needs `trigger_id`, which **expires in 3 s and is single-use**, same page) → forms must be opened from a button click, not proactively. ⚠️ degrade: send form as threaded question + typed reply for stage 2, modal in stage 3.
  - **Must add**: a timeout (e.g. 10 min → auto-deny) to Slack-originated confirms and store pending ids on disk so a restart doesn't strand a button (inferred; none persisted today).
  - **Trust-tier decision (needs Siddhant)**: do Slack taps count as "human present"? Recommended: Slack = `remote` channel (stepup still denied; confirm-tier needs a tap rather than auto-pass), plus an explicit opt-in `slackAllowStepup` that demands a tap from the pinned user ID **and** desktop-side re-confirm. Don't add a fourth auto-approving tier.

### Background / long-running tasks and progress
- ✅ Background work registers in the job bus `lib/jobs.js` (append-only JSONL, durable, "interrupted" on boot), emits `emitter.emit('job',{event,job})` (`lib/jobs.js:128`). Existing subscribers: Activity panel, spoken relay. Phone endpoints `/jobs`, `/jobs/:id/cancel`, `/jobs/:id/guide` (`mcp-server.js:276-290`).
- Slack mapping (inferred): subscribe to `jobs` emitter → one **thread per job**: root message = job name + progress, `chat.update` on status change (throttled), final summary + "Cancel" / "Guide" buttons that call the same cancel/guide functions. Interrupted-on-boot jobs → post "was interrupted" on startup.
- ✅ `notify_user(awaitReply)` (`main.js:4429`, `7682`, pending store `main.js:7637-7653`) already models "ask, then resume on reply" — keyed by taskId, popped by next inbound SMS. Slack equivalent is a thread reply keyed by `thread_ts`: **better** than SMS (no ambiguity; inferred).
- ✅ 2FA hand-off: `deliverTwoFactorCode(text)` (`main.js:7666`) intercepts the next inbound text before the agent. Slack adapter must call it first (Telegram does, `main.js:7310`). ⚠️ A 2FA code in Slack = secret in Slack history/retention → prefer ephemeral prompt + delete; flag to doc 03.

### Per-workspace state
- ✅ BhatBot "workspace" = `~/.bhatbot/workspaces/<slug>` with `activeWorkspace` pointer (`ARCHITECTURE.md` §1); `maybeSwitchProject(userText)` (`main.js:1343`, called `main.js:7052`) shifts focus by what the text names. State is **process-global**, not per-conversation.
- Slack mapping: channel-per-workspace is attractive but conflicts with global active-workspace + serial turn chain. Stage 1: one DM, global workspace (identical to phone). Stage 3: channel→workspace map in config, adapter sets active workspace under the turn lock before dispatch (inferred; races possible with desktop use → **unknown risk**).
- ⚠️ History: reuse Telegram-style per-conversation `Map` (20 msgs), keyed `channel+thread_ts` — not the shared `mcpHistory`, otherwise Slack and phone contaminate each other.

### Always-on daemon vs Electron
- ✅ Daemon facts (`DAEMON.md`): a headless node worker (`scripts/synapse-worker.js`) runs SYNAPSE + memory upkeep, no electron in its require graph, pidfile lock (`lib/pidlock.js`). It has **no tools, no vault** (`DAEMON.md` "Next steps" #1) — it can't run turns. `config.json` secrets are `CRED_REF_*` handles decryptable only via Electron `safeStorage` (`DAEMON.md` credentials caveat; `scripts/bhatctl.js:29-39` hits this too).
- ⚠️ So a Slack adapter in the daemon would need either (a) Slack tokens stored in login Keychain read via `security` CLI (`lib/llm.js` already does for API keys, per `DAEMON.md`) **and** a way to run an agent turn — which means extracting `agentLoop`+`executeTool` out of `main.js` (large refactor, weeks, not days) or (b) daemon → `POST 127.0.0.1:8788/api/:token/chat` to the running app (needs the app up; then no gain vs in-app). Both bad.
- ✅ **Recommended hosting** (inferred):
  1. **In the Electron main process**, next to `startTelegramBridge` (boot at `main.js:11015-11019`). Socket Mode (outbound WS; no public URL; `up to 10` connections; Marketplace-ineligible, irrelevant for a private app) (https://docs.slack.dev/apis/events-api/using-socket-mode). Works behind home NAT with no Tailscale Funnel. Tokens vaulted like `telegramToken` (`unusableSecret` guard, `main.js:7276`).
  2. App liveness: GUI is a LaunchAgent target today only in theory (`DAEMON.md` warning: `com.bhatbot.agent` never installed; `DAEMON.md` next step #2 "background/tray mode" unbuilt). Slack chat is therefore **only as available as the GUI app**. Pair with `caffeinate` keep-awake already done for the cloud bridge (`main.js:7183-7187`).
  3. **Mac off/asleep**: put a second Slack handler in the Fly cloud brain (HTTP Events API, signing-secret verification; https://docs.slack.dev/authentication/verifying-requests-from-slack: v0 HMAC-SHA256, ±5 min) calling `runTurn('slack',…)` and `relay.queueExec` for Mac tools (`cloud/src/relay.js:26`). Two brains = two memories (existing caveat, `ARCHITECTURE.md` status) and Slack allows one delivery mode per app → **choose Socket Mode (Mac) or HTTP (cloud), not both** (inferred; confirm in 01). Defer cloud variant until needed.

### Tailnet reachability
- ✅ Phone/MCP server binds `127.0.0.1:8788` and is published via `tailscale funnel` / Serve (`mcp-server.js:493`, `main.js:7263`); auth = secret token in path/Bearer, constant-time compare (`mcp-server.js:21-30`, `:71`).
- Slack via Socket Mode is outbound-only → **adds no inbound exposure**; HTTP Events mode would require a public HTTPS URL (Funnel or Fly) → new attack surface. Prefer Socket Mode. Agent Office approve links are tailnet-only (`knock.ts:92`): a Slack DM containing such a link is useless off-tailnet; replace with Slack approve buttons that call the office API over loopback/tailnet from the Mac (inferred; office repo change, out of scope).

## 3. Identity and auth

- ✅ Existing patterns: Twilio signature + `ownerPhone` match for SMS (`mcp-server.js:76-90`, `:485`); Telegram `chatId` match (`main.js:7294`); phone token.
- ⚠️ **Do not copy Telegram's enrolment**: "First message authorizes this chat" (`main.js:7288-7292`) is trust-on-first-use — anyone who finds the bot first becomes owner. Slack must use a **pre-configured immutable user ID** (`U…`), set in `config.slackOwnerUserId`, never auto-learned.
- Rules for adapter (inferred):
  1. Drop any event where `event.user !== slackOwnerUserId`. For `block_actions` check `payload.user.id` too (buttons in a shared channel can be clicked by others).
  2. Ignore bot messages/own echoes (`bot_id`/`subtype`); event pages did **not** confirm the field (**unknown**, 01 to verify) → also compare `user` to own bot user id.
  3. Restrict to DMs (`channel_type:"im"`, https://docs.slack.dev/reference/events/message.im, scope `im:history`) plus optionally one pinned private channel; ignore everything else.
  4. Check `team_id`/`api_app_id` equal configured values.
  5. HTTP mode only: verify signature on raw body; Socket Mode is authenticated by the app-level token (scope name **unknown**, not on page read).
  6. Idempotency: dedupe by `event_id`/`client_msg_id` (Slack retries unacked events; ack text on page: "so that Slack knows whether to retry") — otherwise a retried event runs the agent twice.
  7. Workspace admins/Slack can read DMs with the bot; treat Slack as less trusted than the phone token → keep `remote` tier restrictions (see doc 03).
- Slack message text is **external content** → `sanitizeExternalContent(...,'slack')` (`lib/security.js:51`). Prompt-injection via other users' messages is the reason for rule 1/3.

## 4. What breaks or degrades (list)

- ⚠️ Voice: wake word, endpointing, speaker-ID, TTS read-back, `/voice` calls — stay on desktop/Twilio. Slack = text + voice notes in.
- ⚠️ Live partial output: nothing streams to remote surfaces today; Slack gets throttled `chat.update` at best (rate limits above).
- ⚠️ Desktop-only UI: HUD, 3D/Blender/molecule/map windows, Activity window, `hud_control`, `focus-browser`, terminal pty (`main.js:9136`) — results must be exported as files/screenshots (`captureScreenJpeg` `main.js:7144` exists).
- ⚠️ Stepup tools (code-mod, secrets) stay denied remotely (`lib/risk.js:61`) → "improve yourself"/self-drive gating (`main.js:10760`) says must start at desktop.
- ⚠️ `ask_form` → modal needs fresh `trigger_id` (3 s) → degrade to threaded Q&A.
- ⚠️ Concurrency: serial turn chain → Slack message during a desktop turn waits silently; need "queued" reaction/ack.
- ⚠️ Message size: 4k/40k chars; markdown dialect differs (Slack mrkdwn) → formatter needed; Telegram code already falls back to plain.
- ⚠️ No `/` commands in plain text (see slash mapping).
- ⚠️ Slack app is Marketplace-ineligible in Socket Mode (irrelevant if private) (https://docs.slack.dev/apis/events-api/using-socket-mode).
- ⚠️ Availability = GUI app running (no headless chat host).
- ⚠️ Data residency: transcripts/files now in Slack's storage; 2FA codes (see above).
- ⚠️ Agent Office: knock approval flow keeps iMessage unless office repo changes.
- ✅ Unaffected: tools, memory, jobs, scheduling, notifications to other channels.

## 5. Adapter design (interface sketch, prose/pseudocode only)

Goal: one `lib/chatbridge.js` (pure + DI, like `lib/synapse.js`/`cloud-bridge.js`), with `main.js` supplying callbacks. Telegram migrates onto it later (optional).

```
// lib/slackbridge.js  (sketch — not implemented)
start({ appToken, botToken, ownerUserId, teamId,
        runTurn(convKey, text, {blocks, source}) -> {text|error},   // wraps dispatchTurn w/ per-conv history, remoteDepth++
        resolveConfirm(id, approved), resolveOptions(id, sel), cancelJob(id), guideJob(id, text),
        toBlocks(fileMeta) -> vision blocks,                         // downloads w/ bot token, calls mediaBytesToBlocks
        deliverTwoFactorCode(text) -> bool, sanitize(text) -> text,
        log }) -> { notify(text, {urgency, thread}), askConfirm(card) , stop() }

on message(event):  owner/team/channel_type gate -> dedupe(event_id) -> ack
                    -> 2FA intercept -> sanitize -> add reaction "eyes" -> runTurn -> post reply (chunked, mrkdwn)
on block_actions:   ack(<3s) -> owner gate -> route by action_id prefix (cf:/op:/job:) -> chat.update card
outbound hooks:     main.js requestConfirm()  -> if slack enabled & turn originated from slack: bridge.askConfirm
                    telegramNotify()/notifyUser() -> also bridge.notify  (fan-out; rename to notifyChannels)
                    jobsBus 'job' events      -> thread per job (throttled update)
```

Key integration points (main.js): `requestConfirm` must learn "who asked" (a per-turn `origin` alongside `remoteDepth`, which is a global counter and wrong under concurrency; `main.js:2591`); boot next to `startTelegramBridge` (`main.js:11019`); config keys `slackAppToken`, `slackBotToken` (vaulted, `unusableSecret`), `slackOwnerUserId`, `slackTeamId`.

## 6. Staged plan

| Stage | Scope | Files changed | Effort | Exit test |
|---|---|---|---|---|
| **0 notify-only** | Bot token only; `chat.postMessage` from `telegramNotify`/`notifyUser`; no inbound. Pinned DM. | `main.js` (`telegramNotify` ~7343, `notifyUser` ~7682, config + vault keys), new `lib/slack.js` (post, throttle, chunk, retry on 429 `Retry-After`), `scripts/test-slack-notify.js` | **~1 d** | all ⏰/🛠/🩺 alerts appear in Slack DM; rate-limit test |
| **1 command/reply** | Socket Mode inbound DM; owner gate; dedupe; per-conv history; `dispatchTurn` via headless path; chunked reply; typing/👀 ack; 2FA + `notify_user(awaitReply)` thread resume; `/bhat` slash. | new `lib/slackbridge.js`, `main.js` (boot, `runAgentHeadless` gets `{history,origin}` opt instead of global `mcpHistory`), `lib/security.js` (source label), tests `scripts/test-slackbridge.js` (mock events) | **3–4 d** | DM "status" round-trips; non-owner and echo ignored; duplicate event runs once; two surfaces don't share history |
| **2 confirmations + files** | Block Kit confirm/option cards ↔ `pendingConfirms`/`pendingOptions`; timeout + persisted pending; inbound files/images → `mediaBytesToBlocks`; outbound files via `files.getUploadURLExternal`/`completeUploadExternal`; job threads with Cancel/Guide; stepup policy decision | `main.js` (`requestConfirm`/`requestOptions`/`requestForm` origin routing, timeouts), `lib/slackbridge.js`, `lib/jobs.js` (no change; subscribe), `lib/risk.js` (only if tier changed), `lib/attach.js` (none), tests | **4–5 d** | destructive tool prompts approve/deny in Slack; non-owner click ignored; restart with pending card → "expired"; 5 MB image analysed |
| **3 parity or hybrid** | Native streaming (`chat.*Stream`), forms as modals, channel↔workspace map, App Home dashboard, cloud (HTTP) variant for Mac-off, optional daemon extraction | `main.js` (token hook out of `agentLoop`), `cloud/src/server.js`+new `cloud/src/slack.js`, `lib/workspace.js`, big refactor if daemon | **8–12 d** (daemon extraction alone: >10 d, **not recommended**) | — |

**Recommendation:** ship 0 → 1 → 2 (~8–10 d total), **stay hybrid** at stage 3: Slack for text/ops/approvals/files while desktop + Twilio keep voice, HUD, 3D. Revisit stage 3 only if Mac-off availability matters (then the Fly handler, ~4 d, is the value item).

## 7. Open questions / unknowns
- **unknown**: Slack app-level token scope name and Socket Mode ack deadline (not on the page read) → 01.
- **unknown**: bot-message echo fields on `message.im` → 01.
- **unknown**: streaming API plan restriction → 01/03.
- **unknown**: whether `/agents`-style text is intercepted by Slack client in DMs with an app.
- **unknown**: wiring of the in-app "Agent Office" section (no code in this repo); office repo is separate (`work/office`).
- Decision for Siddhant: Slack taps for step-up tier? (default: **no**).
- Decision for Siddhant: shared `mcpHistory` vs per-surface history (recommend per-surface).
