# Slack for BhatBot chat — security, cost, alternatives (3/3)

Angle: data egress, threat model, cost, alternatives, what is lost. Sibling reports: `docs/slack/01_slack_platform.md` (platform capabilities), `docs/slack/02_bhatbot_integration.md` (chat internals / adapter design). Investigation only — no Slack app created, no Slack call made, no code changed.

Legend: ✅ done/good · ⬜ todo · ⚠️ risk/broken. Confidence: **[V]** verified (read the code / the Slack page) · **[I]** inferred · **[U]** unknown.

## Recommendation (first 10 lines)

- **GO PARTIALLY.** Slack as a **notification + approval + low-sensitivity chat side-channel**, owner-only, in a **private, personal, free workspace**, over **Socket Mode** (no public URL). **NO-GO** for replacing the Electron app, the phone PWA, or voice, and **NO-GO** for anything touching health / SYNAPSE graph content / contacts / calendar / credentials.
- Why: BhatBot already has an authenticated, owner-only remote chat channel (Telegram) with identical risk shape; Slack adds one more third-party-hosted copy of every message, for little new capability. The unique wins are (a) threads/buttons for approvals, (b) team-visible Agent Office status.
- Fix first, regardless of Slack: ⚠️ the Telegram bridge runs turns as *local* (autonomous auto-approve), not *remote* — a new Slack adapter must not copy that (§B.5).
- Effort (this angle only): hardening + redaction gate + confirm path ≈ **3–4 eng-days**; adapter itself is 02's estimate. Full "move everything" would add ≈ 8–10 days plus permanent loss of offline/voice — not recommended.
- Flips to GO (fuller): owner confirms a paid Slack plan already exists and they accept retention, a per-category egress allow-list exists, and a button-based out-of-band confirm is built. Flips to NO-GO: if Slack can only be a *shared* workspace (other members) or if the adapter would need `conversations.history` polling on a non-internal app (§C.3).

---

## A. Data egress

### A.1 What BhatBot already sends off-box [V]
- Local-first intent: "under **$10/mo** by routing most work to local Ollama" — `ARCHITECTURE.md:5`.
- Reality: Claude is the default voice; local tier is **opt-in** — `main.js:1511-1519` (`cheapEnabled()` needs `useLocalCheap === true`). ⚠️ `README.md:77` says default `true` — docs contradict code (code wins).
- So Claude (Anthropic) already receives chat text; Slack would be a **second** third party holding the same text *and* the model replies.

### A.2 What Slack would see and keep [V unless noted]
- Everything posted: user prompts, BhatBot replies, tool summaries, filenames, attachments. Slack is the system of record once posted.
- Retention (`https://slack.com/help/articles/203457187`): Free plan offers only "90 days or one year"; Pro/Business+ add never-delete and custom timelines. "Data deleted according to your retention setting is permanent." Paid-plan owners can let members override retention.
- Free plan visibility (`https://slack.com/help/articles/115002422943`): messages/files older than 90 days are hidden; "more than one year old will be permanently deleted." Max 10 third-party/custom apps (`https://slack.com/pricing` also "Up to 10 apps").
- Export (`https://slack.com/help/articles/201658943`, `.../204897248`): owners/admins can export public channels on all plans; private channels + DMs only via an application on Business+ (Free/Pro only on valid legal process, member consent, or legal requirement). Whether exports include edit/deletion history: **[U]** — pages don't say. Edits are tracked only under the "save edits" retention option.
- Implication: in a 1-person workspace Siddhant is owner and can read everything he posts; the *extra* exposure is Slack the company + any workspace admin/guest added later. A shared workspace makes every BhatBot reply visible to the other members of the channel (public channel default).
- Slack's AI-training statements (`https://slack.com/trust/ai-principles`, `https://slack.com/help/articles/28310650165907-Security-for-AI-features-in-Slack`): "Your data is never used to train large language models" — covers Slack's own pipeline [V]; does not constrain the *Anthropic* side of a BhatBot call.
- Slack API ToS (`https://slack.com/terms-of-service/api`, effective Oct 10 2025): for apps "offered for use outside your organization" you may not train LLMs on API Data. A private, internal, single-owner app is outside that clause [I]. Developer Policy (`https://api.slack.com/developer-policy`) **not read [U]**.

### A.3 What the code can and can't redact today
- `lib/redact.js` is **secret-only**: exact known values + vendor-prefixed shapes — `lib/redact.js:10-27` (design), `:35-53` (shapes). It already has a Slack-token shape `xox[abprs]-…` — `lib/redact.js:41`. [V]
- ⚠️ It is built for **tool results → model** (`lib/redact.js:2-8`), not **model → third-party chat**. It does **not** redact: email/phone, calendar details, health numbers, filenames/paths, SYNAPSE node text. There is no PII/category redactor anywhere (grep `lib/redact.js`, `lib/security.js` for health/PII: no hits). [V]
- `lib/security.js:13-23,51-66` is **inbound** injection flagging (escape + `⟦flagged⟧`), not egress. [V]
- Config secrets: vault + write-time validator — `lib/configsec.js:15-24,69-83`; `lib/credentials.js:2-5,61-71` (Keychain-backed `safeStorage`, `CRED_REF_*` handles). The vault field list is explicit: `main.js:602` — ⬜ no `slackBotToken` / `slackAppToken` entries; they'd match the key-name regex (`configsec.js:15-17`) so write-time vaulting would catch them, but add them to `VAULT_FIELDS` for the startup migration. [V/I]

### A.4 Sensitive categories — verdict
| Category | Where it lives | Slack? |
|---|---|---|
| Health (Garmin biometrics) | `~/.bhatbot/health/history.jsonl` — `lib/garmin.js:1-12,24`; analysis `lib/health.js:1-5` | ❌ never. Health data of a named individual; Slack Marketplace listing for Claude states "HIPAA compliant: no" (`https://slack.com/marketplace/A08SF47R6P4-claude`) [V]. At most: "health check ready — open the app" |
| SYNAPSE / second brain / "brain health" | `~/.bhatbot/brain`, `lib/synapse.js`, `lib/brain.js`; issue #1 | ❌ node/edge *content*. ✅ counts/status only ("paid pass skipped: budget") |
| Contacts / call+SMS targets | `cloud/src/tools.js:110-121` (`text_person`, `ask_owner`) | ❌ numbers/names; ✅ "texted 1 contact" |
| Calendar / mail | `ambient` tool (`BHATBOT_STATE.md:49`) | ⚠️ titles at most, no attendees/bodies; default off |
| Credentials, 2FA codes | `credentials.js`; `deliverTwoFactorCode` path `main.js:7310` | ❌ hard-block. Do not route 2FA replies through Slack |
| Screen captures, files, voice audio | `redact.js` `BINARY_KEYS` `:60` | ❌ by default |
| Project/code chat, research, Office status | — | ✅ |

**Rule for the adapter:** default-deny. Outbound goes through an allow-list of message *kinds* (reply text, status, approval prompt) + `redact()` + a category scrubber (⬜ new), and any tool result tagged health/brain/contact is replaced by a pointer ("details in app"). [I — design]

---

## B. Threat model

### B.1 Assets
Mac shell (`run_shell`, `write_file`, `claude_code`), Keychain vault, Garmin/brain data, Twilio (calls/SMS), cloud brain secrets. A chat channel that can drive `agentLoop` is a **remote shell** — the same class as Telegram today.

### B.2 Current remote-channel posture [V]
- MCP server binds `127.0.0.1` and is exposed via Tailscale Funnel; bearer/path token with `timingSafeEqual` — `mcp-server.js:4,23,493`. "mcpToken … the whole security boundary" — `BHATBOT_STATE.md:~23`.
- Remote turns set `remoteDepth++` (`main.js:7129`, `7167`, `7197`) so destructive shell is denied and `confirm`-tier tools denied unless `remoteAllowDestructive` — `main.js:2590-2602`, `lib/risk.js:6-22`.
- Telegram: polling (no inbound port), allow-list = one `telegramChatId` — `main.js:7288-7294`; text goes through `sanitizeExternalContent` — `main.js:7311`.

### B.3 Threats specific to Slack
1. **Compromised Slack account (owner)** — attacker types into the owner-only DM → equals remote shell. Slack sessions are long-lived, SSO/2FA optional on Free. Worse than Telegram? Similar [I]. Mitigation: owner-ID allow-list is *necessary, not sufficient*; add step-up for risky tools (below).
2. **Compromised/malicious workspace member or guest** — can post in any channel the bot is in; can @-mention. Only safe if the adapter ignores *every* event whose `event.user !== OWNER_ID`. Slack puts the sender in `user` (`https://docs.slack.dev/reference/events/app_mention`, [V]). Restricting an app to one user/channel natively: **[U]** — not in docs; must be done in code.
3. **Prompt injection via others' messages** — bot reads channel history/threads/links/files posted by others. Today's defence is regex flagging (`lib/security.js:16-23`), which is easy to evade [I]. Rule: **only the owner's own messages are ever "instructions"**; everything else (other users, bot posts, file text, link previews) enters context as quoted, untrusted data, and tools requested after untrusted content ingestion drop to `stepup`. Slack itself documents injection guardrails only for *its own* AI (`https://slack.com/help/articles/53359847722131-Guide-to-the-Slack-AI-Guardrails`) — nothing for third-party apps [V].
4. **Token theft** — three token types: `xoxb-` bot, `xoxp-` user, `xapp-` app-level; "App-level tokens do not expire by default"; bot/user tokens never expire unless rotation is on, and "may not be turned off once it's turned on" (`https://docs.slack.dev/authentication/tokens`, `.../using-token-rotation`) [V]. Store in the Keychain vault (`credentials.store`, `credentials.js:61`), never plaintext config (`configsec.js:69-83`). `redact.js:41` already scrubs `xox*` in tool output; ⬜ add `xapp-` to SHAPES. Rotation needs refresh-token persistence + 12h expiry handling — extra complexity; skip for a private internal app, rely on revoke-on-suspicion [I].
5. **Inbound authenticity** — Socket Mode: "no need to verify or validate inbound events" (`https://docs.slack.dev/apis/events-api/using-socket-mode`) [V] because the app dials out over WebSocket; HTTP mode needs `X-Slack-Signature` HMAC + 5-min replay window (`https://docs.slack.dev/authentication/verifying-requests-from-slack`) [V]. **Use Socket Mode**: no new public ingress (the Funnel is already a standing risk, `agentoffice.js:281-333` on branch `psychiatrist-agent`). Socket Mode apps cannot be listed in the Marketplace — irrelevant for a private app.
6. **Workspace admins / Slack staff read access** — see A.2. Accepted for non-sensitive content only.
7. **Slack MCP server for Claude clients** is a *different* attack surface: user-OAuth tokens with `chat:write`, `search:read.*`, `*:history` scopes; admin-approved and auditable; "Only apps published in the Slack Marketplace and internal apps can use MCP" (`https://docs.slack.dev/ai/slack-mcp-server`) [V]. Any Claude session with it attached can *send as the user*.

### B.4 Out-of-band confirmation for destructive actions
- Today the confirm card is a desktop UI card (`main.js:2597-2616`, `sendToActivity('confirm-required')`), auto-approved when `autonomousMode` is on (default ON, `main.js:2585-2588`) — except `forceHuman`.
- Slack **Block Kit buttons** produce a `block_actions` payload with `user.id` (`https://docs.slack.dev/apis/events-api/using-socket-mode` sample [V]) — so the click can be checked against `OWNER_ID`. Ack within 3 s; `response_url` valid 5× / 30 min (`https://docs.slack.dev/interactivity/handling-user-interaction` [V]). Whether *other* channel members' clicks are rejected by Slack: **[U]** → must check `user.id` in code.
- ⚠️ A confirm sent over the **same** channel as the command is *not* out-of-band: a compromised Slack account approves its own request. True out-of-band = approve on desktop card, or on a **different** channel (Telegram/Twilio call `ask_owner`, `cloud/src/tools.js:120`). Recommended: Slack may *request*, desktop/phone must *approve* for `stepup`; `confirm` tier can be approved in Slack only if a per-action nonce is echoed from the app UI [I — design].

### B.5 ⚠️ Existing gap the adapter must not inherit [V]
`remoteDepth` is incremented only in MCP/phone paths (`main.js:7129`, `7167`, `7197`). The Telegram handler calls `agentLoop(hist, …)` directly (`main.js:7285-7326`, call at `~7317`) with no `remoteDepth++`. So Telegram turns count as **local**: `isRemote()` is false → `requestConfirm` auto-approves under `autonomousMode` (`main.js:2603-2607`) and `risk.js` remote denial doesn't apply. Also Telegram **first message authorizes the chat** (`main.js:7288-7292`, trust-on-first-use): whoever messages a fresh bot first owns it. Slack adapter requirements: (1) wrap every turn in `remoteDepth++/--`; (2) hard-code `OWNER_ID` from config at setup, never TOFU; (3) ignore all else. ⬜ Consider also patching Telegram (out of scope here).

---

## C. Cost

### C.1 Slack plan [V]
- Free: $0, 90-day visible/1-yr hard delete, ≤10 apps (see A.2). Enough for a one-user workspace; **whether a 1-person workspace is allowed on Free: [U]** — pricing page silent on seat minimums (but nothing says otherwise).
- Paid (list, `https://slack.com/pricing`): Pro $7.25/user/mo annual (promo $4.38 monthly first 3 mo); Business+ $15 annual / $18 monthly; Enterprise+ $45 annual. Business+ is the first tier with private-channel/DM export and Slack AI features; Slack AI needs paid plans (`https://slack.com/help/articles/25076892548883-Guide-to-AI-features-in-Slack`).
- One Pro seat ≈ $7.25/mo (annual billing) = **72% of the $10/mo budget** [I math]. Free tier is the only plan consistent with `ARCHITECTURE.md:5`.
- No per-message fees for a custom app [I — pricing/API pages list none; not explicitly stated].

### C.2 API / rate limits
- Tiered per-method per-workspace; `chat.postMessage` ≈ 1 msg/s/channel (`https://docs.slack.dev/apis/web-api/rate-limits`) [V]. Streaming-style edits (`chat.update` every token) would hit this → post paragraphs, not tokens (loses the streaming feel; see §E).

### C.3 ⚠️ History-read limits
- Since 29 May 2025, `conversations.history`/`.replies` for **commercially distributed non-Marketplace** apps are 1 req/min, 15 objects; **internal customer-built apps** keep 50+/min, 1000 objects (`https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps`) [V]. A private app in your own workspace is the internal case; if it were ever distributed, thread-context fetching breaks. Socket Mode events carry the message text so no history read is needed for the happy path [I].

### C.4 Claude billing split (issue #4) and the "cost governor"
- ⚠️ **Premise correction:** `lib/governor.js` is the **thermal/memory** governor ("THERMAL / MEMORY GOVERNOR", `lib/governor.js:2`; sheds local model/vision under heat), not a cost governor. [V] Cost caps live in: `ARCHITECTURE.md:373-378` (DAG agents 80% of $10 → local-only; design doc), `lib/pricing.js` PRICES enforced by `select.js` (`lib/pricing.js:7`), SYNAPSE's per-day cap (`lib/synapse.js:21-24`), and `lib/costpilot.js` — which is **not on `main`**; it exists on branch `psychiatrist-agent` and in the main checkout (`costpilot.js:27-44`, ceiling `$3.5/h`, reader-only of the ledger). Same for `lib/agentoffice.js`. [V]
- Chat turns go through `anthropicRequest` (`main.js:1639`) → API billing, all recorded by the ledger. **Slack as a transport adds no model cost** — the same `agentLoop` runs. Cost impact is indirect: more convenient chat → more turns; threads re-send history (Telegram trims to 20 msgs, `main.js:7316-7318`; mirror that).
- Issue #4 (open): background work should use the subscription (`claude -p`) with API as fallback. Existing `claude -p` call sites: `main.js:2461,2538,2560,5169,8092`; branch `subscription-routing` commit `5afb21c` routes background LLM calls that way. **Chat turns are interactive and use API/`anthropicStream`** [V]. Slack chat should stay on the same path as desktop chat; do **not** try to run Slack-triggered chat via `claude -p` (different tool surface, subscription terms for automated use: **[U]**).
- Alternative **Claude Tag** (Slack-side Claude) bills "to a usage balance under an Owner-set spend limit" and is only on **Team/Enterprise** plans (`https://claude.com/docs/claude-tag/overview`) [V] → a *new* cost line outside the $10 budget, and not available if Siddhant is on Pro/Max (**which plan he has: [U]**).

### C.5 Cost summary
| Item | Cost | Notes |
|---|---|---|
| Slack Free workspace | $0 | 90-day window, ≤10 apps |
| Socket Mode adapter | $0 | no hosting; runs in Electron main |
| Pro seat | ~$7.25/mo | only if retention needed; eats 72% of budget |
| Claude Tag | usage-billed, Team/Ent only | not a fit |
| Extra Claude spend | ≈ same as Telegram | track via ledger; cap Slack turns same as desktop |

---

## D. Alternatives to a custom adapter

| Option | Effort | Security | Fidelity | Offline | Verdict |
|---|---|---|---|---|---|
| **Custom Slack adapter** (Socket Mode, owner-only) | 02's estimate + 3–4d hardening | mid (third-party copy; owner-ID gate) | text, threads, buttons; no voice; no streaming | ✗ Mac must be on; cloud brain could serve | partial go |
| **Slack MCP server** (`https://mcp.slack.com/mcp`) used by Claude clients | ~0.5d config | mid-low: user-OAuth with send+search scopes, admin approval | BhatBot *calls* Slack, can't be *driven from* Slack | n/a | ✅ good for "post my brief to Slack" / read a channel; **not** a chat transport. **BhatBot has no MCP client** (`lib/garmin.js:3-4`) [V] — so only Claude Code/Desktop would use it |
| **Claude Tag / Claude in Slack** | 0.5–1d admin setup | channel-scoped, ephemeral sandbox, admin-governed | Claude, *not BhatBot* — no BhatBot tools/memory/voice | ✗ | ❌ different product; Team/Ent only; old `code.claude.com/docs/en/slack` page says the earlier Claude Code in Slack "is retired" |
| **Slack AI / agents API** (assistant threads, streaming: `https://docs.slack.dev/ai/developing-agents`) | high | needs paid plan for some features | nicer UX (streaming, status) | ✗ | ⬜ revisit only if on a paid plan; guests barred from platform AI features (RTS page) |
| **Telegram** (exists) | 0 (+fix B.5) | single-chat allow-list, TOFU flaw | text+voice notes (`main.js:7296-7308`) | ✗ (polling) | ✅ best existing remote channel; already supports voice |
| **Phone PWA / cloud brain** (exists) | 0 | token boundary; Tailscale Funnel | full UI, voice, activity | cloud works with Mac asleep (`BHATBOT_STATE.md:25-29`) | ✅ keep |
| **Twilio SMS/voice** (exists) | 0 | phone-number based | `notifyUser` (`main.js:7682`), `ask_owner` calls | needs Mac/cloud | ✅ best true out-of-band approval channel |
| **iMessage** | — | — | — | — | ⚠️ **no iMessage code exists**. grep finds only a routing regex (`main.js:6576`). The brief's "iMessage via lib/agentoffice.js" is **not verified**: `agentoffice.js` drives the Agent Office over WebSocket (`agentoffice.js:1-14`), no iMessage. `lib/phonemirror.js` is iPhone Mirroring (UI automation). Marked **[U/refuted]** |

Takeaway: Slack's *marginal* value over Telegram + PWA + Twilio is small for a single owner. It is strongest where Agent Office (issue #5, "Control all of BhatBot from the Agent Office section") needs a **team-visible, threaded** status/approval surface — and there the Slack MCP server or a one-way webhook-style poster is cheaper than a full bidirectional chat adapter.

---

## E. What is lost by leaving the native app

- **Latency** [I]: Socket Mode round trip is small, but no token streaming (post per paragraph, rate limit C.2); Electron fast-reply path (`fastReply`, `BHATBOT_STATE.md:~66`) wouldn't be perceptible in Slack anyway.
- **Voice**: Slack has no wake word, no ElevenLabs/Kokoro TTS, no speaker-verify, no barge-in learning (spoken-length model, README "Learns your style"). ❌ Loses a headline feature. Telegram voice notes work today (`main.js:7296-7308`); Slack voice clips would need a new STT path [I].
- **Offline/local-only guarantee**: the app works on Ollama with no network; Slack chat needs internet at both ends. Replacing the app would end the local-only guarantee; *adding* Slack leaves it intact if the adapter is optional and dormant by default (like Telegram, `main.js:7275`).
- **Rich surfaces**: 3D viewer, Activity/Nexus tabs, confirm cards, screen vision previews — Slack can host links/images only; images are sensitive (A.4).
- **Concurrency/state**: Telegram keeps a separate rolling history (`main.js:7272,7314-7318`); a Slack adapter inherits the "separate history" split — memory continuity across surfaces needs `dispatchTurn` (`main.js:~7033`, "single entry point every chat surface routes through") — see `02_bhatbot_integration.md`.

---

## F. Conditions that flip the call

| To GO (broader) | To NO-GO |
|---|---|
| Per-category egress allow-list + scrubber built and tested (⬜) | Workspace has other human members/guests who can't be excluded from the bot's channel |
| `remoteDepth` + `OWNER_ID` gate verified by a test that other-user events are dropped | Health/brain content would need to appear in Slack to be useful |
| Button-confirm with desktop/Twilio out-of-band for `stepup` | Only available via paid plan that blows the $10/mo budget (Pro ≈ $7.25/mo) |
| Owner OK with Slack holding a copy under Free retention (90d/1yr) | Slack requires Marketplace distribution / non-internal app (history rate limit C.3) |
| Siddhant is on Claude Team/Enterprise and wants Claude Tag for *code review of PRs* (separate from BhatBot) | Slack security review finds app-level token can't be vaulted |

## G. Next steps (if go-partial)
- ⬜ Fix B.5 on Telegram (TOFU, `remoteDepth`) — 0.5 d, independent of Slack.
- ⬜ `lib/egress.js` (pure): allow-list of message kinds + category scrubber + `redact()`; tests — 1.5 d.
- ⬜ Slack adapter shell: Socket Mode, owner-ID, `remoteDepth`, vaulted tokens (`xoxb`, `xapp`), history cap 20 — see 02 for the adapter — 1 d (hardening share).
- ⬜ Block Kit confirm w/ `user.id` check + out-of-band for `stepup` — 1 d.
- ⬜ Add `xapp-` to `redact.js` SHAPES; add token names to `VAULT_FIELDS` (`main.js:602`) — 0.25 d.

## H. Open unknowns
- [U] Siddhant's Claude plan (Pro/Max vs Team) — decides Claude Tag eligibility.
- [U] Whether a 1-person Free workspace is permitted/stable; Slack Developer Policy text (not read).
- [U] Whether exports include edit/deletion history; whether others' button clicks are rejected by Slack natively.
- [U] Subscription (`claude -p`) terms for automated, chat-triggered use.
- [U] `message.channels` / `message.im` scope details — see 01.

## Sources (Slack, all read 2026-11-28)
- Retention `https://slack.com/help/articles/203457187` · Export `https://slack.com/help/articles/201658943`, `.../204897248` · Free limits `https://slack.com/help/articles/115002422943` · Pricing `https://slack.com/pricing`
- Rate limits `https://docs.slack.dev/apis/web-api/rate-limits`; non-Marketplace change `https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps`
- Socket Mode `https://docs.slack.dev/apis/events-api/using-socket-mode`; signatures `https://docs.slack.dev/authentication/verifying-requests-from-slack`; tokens `https://docs.slack.dev/authentication/tokens`, `.../using-token-rotation`; interactivity `https://docs.slack.dev/interactivity/handling-user-interaction`; events `https://docs.slack.dev/reference/events/app_mention`
- API ToS `https://slack.com/terms-of-service/api`
- MCP `https://docs.slack.dev/ai/slack-mcp-server` (alias `/ai/mcp-server`); agents `https://docs.slack.dev/ai/developing-agents`; RTS `https://docs.slack.dev/apis/web-api/real-time-search-api`
- Claude Tag `https://claude.com/docs/claude-tag/overview`; Claude listing `https://slack.com/marketplace/A08SF47R6P4-claude`
- Slack AI `https://slack.com/help/articles/25076892548883-Guide-to-AI-features-in-Slack`, `https://slack.com/trust/ai-principles`, `https://slack.com/help/articles/28310650165907-Security-for-AI-features-in-Slack`, `https://slack.com/help/articles/53359847722131-Guide-to-the-Slack-AI-Guardrails`
- Not fetched (429): `https://slack.com/help/articles/27204752526611`.
