# Slack investigation 1/3: platform capabilities

Angle: what Slack can do as chat front-end for a personal local agent.
Siblings: `docs/slack/02_bhatbot_integration.md` (chat internals, adapter design), `docs/slack/03_security_cost_alternatives.md` (security, cost, alternatives).
Docs read 2026-11-28 (docs.slack.dev, slack.com/help, slack.com/pricing). Code at `origin/main` 7953034.
Tags: **V** verified (primary page read) · **I** inferred · **U** unknown (not found in pages read).

## Verdict (first 10 lines)
- **GO PARTIALLY.** Slack is a good *text + files + approvals + notifications* front-end. Poor fit for *voice* and *Agent Office visuals*.
- ✅ Socket Mode = outbound WebSocket, no public URL. Fits Mac behind NAT (V, §1).
- ✅ DM-with-app, threads, buttons, reactions, file in/out, native streaming API all exist (V).
- ✅ Closest existing analog: Telegram bridge (`main.js:7273-7342`) maps ~1:1 to a Slack bot. Port, don't redesign.
- ⚠️ Streaming limits: 12,000 chars/stream, 10 min max; edit-in-place fallback is Tier 3 (50+/min) (V, §5).
- ⚠️ Native agent UI (assistant/agent sessions) needs a paid plan; free = plain DM bot (V/U, §3, §9).
- ⚠️ Free plan: 90-day history view, 10-app cap (V, §9). Fine for one personal app.
- ❌ No voice-in/out parity: no bot typing indicator via plain bot API outside agent sessions, no huddle API found (U, §8). Keep voice in Electron/Twilio.
- Effort: MVP text DM bot ~3-4 eng-days; +files/buttons/streaming ~3 days; +slash/threads-per-task polish ~2 days. Total **~8-10 eng-days** (I).
- Recommend: Slack as **additional surface** (Telegram replacement/upgrade), not replacement of Electron/phone PWA.

## 1. App type, tokens, transport
- ✅ Bot token `xoxb-` = app identity, "usually for the best"; user token `xoxp-` acts *as the installer* (V) https://docs.slack.dev/authentication/tokens
- ✅ Use bot token. User token only if BhatBot must speak/act as Siddhant (not wanted).
- ✅ Socket Mode: "use the Events API and interactive features without exposing a public HTTP Request URL"; URL from `apps.connections.open`; for firewalled devs (V) https://docs.slack.dev/apis/events-api/using-socket-mode
- ✅ Needs app-level token `xapp-` (V). Scope name `connections:write` — U on that page.
- ✅ Up to 10 concurrent WebSockets; must handle refresh "once every few hours"; `disconnect` reasons `warning`/`refresh_requested` (V).
- ✅ Not Marketplace-eligible (V). Irrelevant for a single-workspace personal app.
- ⬜ Per-event ack deadline in Socket Mode: U (page says each event must be acked; no ms given). Slash/interaction HTTP rule is 3 s (V, §6).
- Fit: BhatBot Mac already dials *out* (cloud relay WS `cloud/src/server.js:167-179`, `lib/cloud-bridge.js`); Socket Mode is the same shape. No Fly.io/Funnel route needed for Slack. (V code)
- Events API HTTP alternative: needs public URL. BhatBot has Fly cloud (`cloud/`) so possible, but pointless vs Socket Mode. (I)

## 2. Scopes (bot)
| Need | Scope | Status |
|---|---|---|
| Post/update/delete own msgs, streaming | `chat:write` | V https://docs.slack.dev/reference/methods/chat.postMessage |
| Read DMs (event `message.im`) | `im:history` | V https://docs.slack.dev/reference/events/message.im |
| Messages tab | `chat:write` + `im:history` | V https://docs.slack.dev/surfaces/app-home |
| Read user files | `files:read` | V https://docs.slack.dev/messaging/working-with-files |
| Upload files | `files:write` | V https://docs.slack.dev/reference/methods/files.getUploadURLExternal |
| Reactions add / observe | `reactions:write` / `reactions:read` | V https://docs.slack.dev/reference/methods/reactions.add |
| Agent features (top-nav entry, agent label) | `assistant:write` | V https://docs.slack.dev/ai/developing-agents |
| Slash commands | `commands` | U (name not on pages read) |
| Open DM to user proactively (`conversations.open`) | `im:write` | U |
| Resolve user ids | `users:read` | U |
- Minimal MVP: `chat:write im:history files:read files:write reactions:write` + `commands`, `im:write` (U, verify at install).

## 3. DM with the app / agent surfaces
- ✅ App Home **Messages tab**: toggle "Messages Tab" under Show Tab; subscribe `message.im` (V) https://docs.slack.dev/surfaces/app-home
- ⚠️ Doc: "Newly created apps can only use the Agent messaging experience" if Agents toggle used (V, same page). Agents toggle optional (I).
- ✅ Agent flow today: events `app_context_changed`, `agent_session_stopped`, `agent_session_title_changed`, plus `app_home_opened` (`tab="messages"`) and `message.im` (V) https://docs.slack.dev/ai/developing-agents
- ⚠️ `assistant_thread_started` no longer means "user opened a DM" for Agents apps (V) https://docs.slack.dev/reference/events/assistant_thread_started
- ⚠️ "Developing and using some AI features require a paid plan, despite being visible in the app settings on any plan" (V). Free dev sandbox via Developer Program (V).
- Legacy `assistant.threads.setStatus/setTitle` still work via compat bridge (V). New: `agents.sessions.setStatus` / `.rename` (V; method pages not fetched).
- Decision: MVP = plain bot DM (Messages tab). Agent UI = optional upgrade if workspace is paid/sandbox.

## 4. Threading
- ✅ `thread_ts` = parent ts; "avoid using a reply's ts" (V) https://docs.slack.dev/reference/methods/chat.postMessage
- ✅ `reply_broadcast` default false (V).
- ✅ Files can be posted to thread via `thread_ts` on `files.completeUploadExternal` (V).
- Use: one thread per BhatBot task/turn; top-level DM = new conversation. Maps to Telegram's single flat history (`main.js:7272`, `7313-7318`) but better. (I)
- ⚠️ Slash commands cannot be invoked inside threads (V) https://docs.slack.dev/interactivity/implementing-slash-commands -> in-thread control must be plain text or buttons.

## 5. Message size, formatting, streaming
- ✅ `text`: best ≤4,000 chars; longer "may be split"; >40,000 truncated (V) chat.postMessage page.
- ⚠️ `chat.update` error `msg_too_long` quotes 4,000-char text cap (V) https://docs.slack.dev/reference/methods/chat.update; docs inconsistent. Chunk at ≤3,900.
- ✅ `markdown_text` param: 12,000 chars, can't combine with `blocks`/`text` (V).
- ✅ Blocks: 50 per message (V) https://docs.slack.dev/reference/block-kit/blocks; section text 3,000; fields 10 x 2,000 (V).
- ✅ Markdown block: messages only, 12,000 cumulative, supports tables/code/lists (V) https://docs.slack.dev/reference/block-kit/blocks/markdown-block. Best fit for LLM output (no mrkdwn conversion).
- ✅ Table block: 100 rows, 20 cols, 10,000 chars (V) .../table-block.
- ✅ mrkdwn differs from markdown (`*bold*`, `<url|text>`) (V) https://docs.slack.dev/messaging/formatting-message-text. Telegram bridge uses `parse_mode:'Markdown'` with plain fallback (`main.js:7320`).
- **Native streaming**: `chat.startStream` (Tier 2, 20+/min) -> `chat.appendStream` (Tier 4, 100+/min) -> `chat.stopStream` (Tier 2) (V) https://docs.slack.dev/reference/methods/chat.startStream
  - ⚠️ stream open ≤10 min total (not idle); `markdown_text` 12,000 chars total; 50 tasks; 50 blocks (V).
  - ✅ chunk types: `markdown_text`, `task_update` (pending/in_progress/complete/error), `plan_update`, `blocks` (V). `task_update` fits BhatBot tool-call progress.
  - ⚠️ Can't mix `markdown_text` and `chunks`; only owning app can append (V).
  - ⚠️ Paid-plan/agent-eligibility for streaming methods: U (page lists only `chat:write`).
- Fallback streaming (edit-in-place): `chat.update` Tier 3 = 50+/min (V). Practical: edit every ~1.5-2 s, ≤30/min/message, coalesce tokens. `chat.postMessage` ~1/s/channel (V) https://docs.slack.dev/apis/web-api/rate-limits. 429 + `Retry-After` (V).
- ⚠️ BhatBot streams per-token UI events (`main.js:6779`, `6880`); Telegram path does NOT stream at all (waits for full result, `main.js:7316-7319`). Slack needs a token buffer + flush timer (see 02).
- ⚠️ Long turns: >10 min agent runs exceed one stream. Post "working" msg, then final msg (I).

## 6. Interactivity: confirm-before-act
- ✅ Buttons in `actions`/`section` blocks; `style` primary/danger; `value` ≤2,000; `action_id` ≤255; built-in `confirm` dialog (title 100, text 300, buttons 30) (V) https://docs.slack.dev/reference/block-kit/block-elements/button-element , .../composition-objects/confirmation-dialog-object
- ✅ Interaction payload must be acked within **3 s**; `response_url` reusable 5x in 30 min, `replace_original` to swap card to "approved" (V) https://docs.slack.dev/interactivity/handling-user-interaction
- ✅ Input blocks (checkboxes, multi-select, radio, text) allowed in **messages**, not only modals (V) https://docs.slack.dev/reference/block-kit/blocks/input-block -> covers `ask_options` (`main.js:2617-2638`) and `ask_form` (`main.js:2641-2656`). Submit-button handling: `block_actions` payload fields not fetched (U).
- ✅ `trigger_id` for modals expires in 3 s, single use (V) -> modal forms must open immediately inside interaction handler.
- Existing: `requestConfirm` promise-per-id (`main.js:2597-2615`), Map at `main.js:477`; options/forms resolve empty after 5 min (`main.js:2628`, `2647`). Slack button click = resolve(id). Same pattern. (I)
- ⚠️ Gap: no push-modal when Mac asleep; pending promise lives in Mac process memory. If app restarts, buttons are dead -> must `chat.update` them to "expired". (I)
- ⚠️ Risk tiers (`lib/risk.js:30-62`): `stepup` demands a human even in autonomous mode. Slack DM from authenticated user ≈ human-present? Policy call, see 03. (I)
- ⚠️ Slack interaction must verify the clicking `user.id` == Siddhant before resolving (Telegram does chat-id check, `main.js:7294`).

## 7. Files and images
- Upload (✅ V): `files.getUploadURLExternal` (Tier 4) -> POST bytes -> `files.completeUploadExternal` (`channel_id`, `thread_ts`, `initial_comment`) https://docs.slack.dev/messaging/working-with-files . `files.upload` sunset 2025-11-12 (V) https://docs.slack.dev/reference/methods/files.upload
- Download (✅ V): GET `url_private` with `Authorization: Bearer xoxb-…`, needs `files:read`; only send token to host `files.slack.com` (V).
- Event: `file_shared` (`files:read`) or `files` array on `message.im` (inferred; file-object page not read).
- Size limits: max per-file U; free workspace 5 GB total store -> `storage_limit_reached` (V on getUploadURLExternal page). Snippets 1 MB (V).
- BhatBot side: `lib/attach.js:10-18` classifies image/video/pdf/text; Telegram only handles `msg.voice` (`main.js:7297-7309`), no photo/doc path -> Slack gives parity+ for attachments. (V code)
- ⚠️ Slack PNG/JPG inline preview OK; HEIC, huge video: preview behaviour U.

## 8. Voice, status, presence
- Voice notes: Telegram bridge transcribes voice (`main.js:7297-7309`, `transcribeAudio`). Slack: audio/video **clips** and mobile voice messages as files — API access/transcript/mimetype U (not found). Treat as ⬜: test in a sandbox before promising.
- Huddles: free plan 2 participants (V) https://slack.com/help/articles/4402059015315. Bot join / audio access to huddles: U (not found). Assume ❌.
- TTS replies: send audio file (mp3) via files API (I; works as file, no inline voice-message bubble guaranteed U).
- Twilio calls/ElevenLabs desktop voice unaffected; keep.
- **Typing indicator**: no Web API bot typing method found; `user_typing` is RTM-only event, RTM labelled legacy (V) https://docs.slack.dev/reference/events/user_typing . Substitutes: agent-session status `processing` (V, 1 h timeout) or `assistant.threads.setStatus` (2 min timeout, 600/min, `loading_messages` ≤10) (V) https://docs.slack.dev/reference/methods/assistant.threads.setStatus ; else a ⏳ reaction (below).
- Telegram does `sendChatAction('typing')` at `main.js:7299`, `7313` -> partial gap for plain bots.

## 9. Reactions, notifications, plan limits
- ✅ `reactions.add` Tier 3, `reactions:write` (V). Pattern: 👀 on receipt -> ⏳ working -> ✅/⚠️ done (add/remove). Each swap = 2 calls; fine at 50/min (I). `already_reacted` error must be swallowed (V).
- ✅ Default notifications: DMs and followed-thread replies, "desktop and mobile" (V) https://slack.com/help/articles/360025446073. Bot-DM push parity with human DM: U (article doesn't mention apps). DND/schedule behaviour: U.
- ⚠️ Edits via `chat.update` do not re-notify (I, standard Slack behaviour; not found in pages read). Final result should be a *new* message so phone buzzes; stream message alone may not (I).
- Plan: Free keeps/searches 90 days, deletes >1 yr (V) https://slack.com/pricing , https://slack.com/help/articles/115002422943-Message-and-file-history. Up to **10 third-party or custom apps** on free (V). One BhatBot app = 1 of 10.
- ⚠️ Agent/assistant UI on free: pricing page ambiguous (V/U). Treat as paid-only (conservative).
- Slack history is not BhatBot's memory; BhatBot keeps own history (Telegram keeps last 20 in-process, `main.js:7272`, `7313-7318`). Don't rely on `conversations.history`; its limit is Tier 3 (V) https://docs.slack.dev/reference/methods/conversations.history ; 2025 non-Marketplace restrictions: U (not found).
- Edit window: governed by workspace edit settings; `edit_window_closed` possible (V chat.update). Bots updating own messages: assumed OK (I).
- Retention: free owner may choose delete-after-90-days (V).

## 10. Slash commands
- ✅ 3 s ack, `response_url` (5 uses/30 min), form-encoded payload (V) https://docs.slack.dev/interactivity/implementing-slash-commands
- ⚠️ Not invocable in threads (V). Delivery over Socket Mode not stated on that page (U) but Socket Mode doc says interactive features work (V).
- Candidate commands: `/bhat status`, `/bhat stop`, `/bhat fleet`. BhatBot already has command parsing (`lib/commands.js`, not read) (I).
- ⚠️ Slash command names aren't namespaced — "most recently installed" wins (V).

## 11. What Slack cannot do (for this use)
- ❌ Typing indicator for plain bots (see §8).
- ❌ Single stream >10 min or >12,000 chars of markdown (V).
- ❌ Messages >40,000 chars (truncated) (V) -> upload as file/canvas instead.
- ❌ Ephemeral messages can't be `chat.update`d (V chat.postEphemeral) -> don't use for pending-approval cards.
- ❌ Slash commands in threads (V).
- ❌ Wake the Mac: if Mac asleep/offline, Socket Mode is down -> Slack messages queue? Slack retries only within envelope redelivery; no durable inbox (I). Cloud relay (`cloud/`) is the always-on option; Slack bot could live there instead (see 02).
- ❌ Rich 3D/visual Agent Office (`/Open 3D office`) inside Slack; only text/images/links. Agent Office section not in this repo at main (grep found nothing) -> U; link-out or screenshot only.
- ❌ Desktop push-to-talk, wake word, barge-in, orb UI.
- ⚠️ 1 msg/s/channel posting cap (V): burst fleet-status spam must be coalesced.

## 12. Feature-parity table
| BhatBot chat needs | Slack mechanism | Gap |
|---|---|---|
| Send text turn from phone/desktop | DM to app (`message.im`, `im:history`) V | ✅ none |
| Reach Mac with no public URL | Socket Mode WS V | ✅ none; ⚠️ reconnect every few h |
| Always-on while Mac asleep | Run bot in Fly `cloud/` instead of Mac I | ⚠️ cloud has own brain `cloud/src/server.js:78`; routing decision in 02 |
| Streamed reply | `chat.startStream`/`appendStream`/`stopStream` V; or `chat.update` ≤50/min V | ⚠️ 10 min / 12k chars; paid/agent eligibility U |
| Long reply (>4k) | split / markdown block 12k / file V | ⚠️ >40k truncated |
| Markdown, code, tables | markdown block, table block V | ⚠️ Slack subset; images → links |
| Tool progress | `task_update`/`plan_update` chunks V; or reactions | ✅ better than Telegram |
| Thinking indicator | agent `setStatus` V (paid); ⏳ reaction I | ⚠️ no plain-bot typing |
| Confirm-before-act (`requestConfirm`) | Block Kit buttons + `confirm` dialog V; `replace_original` V | ⚠️ 3 s ack; restart kills pending ids; verify clicker id |
| Option picker / form (`ask_options`/`ask_form`) | input blocks in messages V; modals via `trigger_id` V | ⚠️ 3 s trigger window; payload shape U |
| Step-up (human required) | button from verified user; maybe extra modal/2FA I | ⚠️ policy, see 03 |
| Attachments in (image/pdf/text/csv) | `files:read` + `url_private` V | ⚠️ size cap U |
| Files/images out | `files.getUploadURLExternal`+`complete` V | ✅ |
| Voice note in | audio clip/voice msg file U | ⬜ untested |
| Spoken reply | mp3 upload I | ⚠️ no auto-play bubble U |
| Live call / wake word / barge-in | huddle/none U | ❌ keep Electron/Twilio |
| Status at a glance | reactions V | ✅ |
| Push notification | native DM push V (default) | ⚠️ bot-vs-human parity U; edits don't re-notify I |
| Slash/quick commands | `/bhat …` V | ⚠️ not in threads |
| Per-task context | thread per task V | ✅ (improves on flat history) |
| Multi-agent fleet activity feed | 1 channel or thread, coalesced posts V | ⚠️ 1 msg/s/channel |
| Agent Office (3D/visual) | link/screenshot | ❌ not portable |
| Chat history | Slack + BhatBot own memory | ⚠️ free: 90 d visible V |
| Auth: only Siddhant | `user` id allow-list on every event/interaction I | ⬜ implement; analog `main.js:7289-7294` |
| Cost | free plan OK (10 apps) V; agent UI paid V | see 03 |

## 13. Open questions (need sandbox test, no Slack calls made here)
- ⬜ Socket Mode ack ms, `connections:write` name.
- ⬜ Bot-DM mobile push parity; DND handling.
- ⬜ Voice message / clip file mimetype + download.
- ⬜ Free-plan eligibility of streaming + agent APIs.
- ⬜ `block_actions` payload for input-block submit; `views.open` limits.
- ⬜ Max file size; 2025 `conversations.history` limits for custom apps.

## 14. Effort (rough, eng-days; I)
- 1.0 app manifest, tokens in vault (`VAULT_FIELDS` `main.js:602`), Socket Mode client (Bolt), allow-list.
- 2.0 text DM turn -> `agentLoop` -> reply, chunking, formatting, per-thread history (port of `main.js:7273-7342`).
- 1.5 files in/out via `lib/attach.js`.
- 2.0 confirm/option/form cards -> existing `pendingConfirms/Options/Forms` maps.
- 1.5 streaming (native + `chat.update` fallback) and reactions.
- 1.0 slash commands, notify (`telegramNotify` equivalent), tests.
- **Total 8-10 days.** Voice and Agent Office parity: not estimated (out of scope / ❌).
