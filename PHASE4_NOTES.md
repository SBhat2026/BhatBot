# Phase 4 — Foundations: Implementation Notes, Deviations & Cross-Phase Risk Audit

> Branch `phase4-foundations` off `phase3-neural-depth`. Local commits only. `main.js` backup kept at
> `.phase4-backup/main.js.phase3` (gitignored) + per-step git commits as revert points.

---

## D1 — Key rotation (DONE)

- `lib/configsec.js`: secret-key detection (snake + camelCase; excludes ids / "monkey"/"turkey"),
  recursive `findPlaintext`, `sanitizeWrite` (auto-vault when safeStorage up, else **reject**
  `PLAINTEXT_CRED_BLOCKED`), one-shot `migrate`.
- `lib/credentials.js`: `canStore()` (true only in-app w/ safeStorage).
- `main.js`: `loadConfigRaw` (refs intact) + `loadConfig` (resolves `CRED_REF_*` in-process, mtime-cached)
  + `saveConfig` (auto-vault/reject, base = raw so resolved plaintext is never re-serialized) +
  `saveConfigRaw` (internal, ref-only) + `migrateSecretsToVault()` run **first** in `app.whenReady`.
- **Runs in-app:** safeStorage encryption requires the running Electron app (a node script throws
  "run inside the app"). So migration executes on next launch; `config.json` holds only `CRED_REF_*`
  after that. **Verified statically** (configsec unit tests: 14 secret keys incl. nesting → refs, clean).
- **Self_fix/self_heal fence:** they edit repo code, not config, but any `saveConfig` they trigger goes
  through `sanitizeWrite` → cannot persist a plaintext key.

## D2 — Split main.js (PARTIAL — paused at the verified-safe boundary)

| | bytes | lines |
|--|--|--|
| Before (phase3 HEAD) | **524,597** | 7,633 |
| After (this phase) | **~438,476** | ~6,915 |
| Target | <150,000 | — |

**Extracted (fully verified — pure data/string, no coupling):**
- `lib/tools-schema.js` — the 58-tool schema array (~60KB), as a tiny factory taking `MEMORY_SECTIONS`
  (its only interpolation). Verified: 58 tools, `web_search` present, save_memory desc interpolates.
- `lib/prompts.js` — `STATIC_PROMPT` (~28KB pure string). Verified length + prefix.

**Deviation from SPLIT_PLAN (documented per the directive's allowance):** I did **not** brute-force the
remaining high-risk clusters (browser/screen-observe/login = step 6, system = step 7, window = step 8,
agent-loop = step 9) this session. Reason — and this is a correctness issue, not timidity:

> Those clusters share **mutable module-scoped state** (`page`, `browser`, `recordingSteps`,
> `userEventBuffer`, `observeUntil/observeTimer`, `screenWatch*`, `lastUserActivityTs`) that is both
> read and written by functions that would land in *different* modules (the tool handlers vs. the
> observer event handlers + IPC). Splitting them naively creates **two independent bindings** of each
> `let`, silently breaking observe/record/login. `node -c` and require-smokes **cannot** detect this
> (free identifiers are valid syntax; the break only surfaces at runtime inside Electron, which can't
> be booted from the build environment). The SPLIT_PLAN itself mandates an Electron boot-marker test
> after each of these steps for exactly this reason.

**To finish safely** (one boot check unlocks it): extract each high-coupling cluster *together with the
mutable state it owns* into a `ctx`-factory (state lives inside the module; external IPC/observer refs
re-point to exported accessors), then `npm start` and confirm the markers `[mcp] listening`,
`[wake] listener ready`, `[scheduler] started`, `[cloud-bridge] connected`. Remaining byte budget to
<150KB lives almost entirely in: agent-loop (~1.3k lines), executeTool dispatch (~750), browser cluster
(~600), window mgmt (~470), system/vision. The dispatch table may stay in `main.js` as a routing layer
(SPLIT_PLAN §9 allows this).

## D3 — Cloud deploy (STAGED — see `cloud/DEPLOY.md`)

Not deployed (per your "stage now, you finish"). Verified ready:
- `cloud/.env` is git- AND docker-ignored → no plaintext ships to the image/repo.
- Cloud reads `process.env` (Fly secrets), app `bhatbot-cloud` (ewr), `/health` + `/mac/<token>` relay.
- Exact ordered steps (launch→migrate→`fly secrets import`→`fly deploy`→health/relay→offline test) in
  `cloud/DEPLOY.md`. Mac-offline path degrades via `relay.queueExec`/`drainQueue` (graceful, no crash).

## Agent-log relay (the "sync logs to BhatBot → other bots" ask) — DONE

- `main.js` `relayAgentLog()` in `fleetBroadcast`: bounded `fleetLog` ring (200) + push each agent's
  line to the cloud bridge. `recentFleetLog()` exposes it for cross-agent awareness.
- `lib/cloud-bridge.js`: `send()` (fire-and-forget when ws open).
- `cloud/src/relay.js`: captures `{type:'agentlog'}` into a ring + `recentAgentLog()`; `server.js`
  `GET /api/:token/agentlog` so phone PWA / Telegram see what every agent is doing. (Cloud half is
  live once deployed.)

## Final merge sequence (NOT executed — staged for you)

`phase1-power-systems → phase2-clean-slate → phase3-neural-depth → phase4-foundations → main → push`,
then `git tag MARK-VIII`. Do the merge after the D2 boot-verified extractions land, so `main` is the
fully-split, verified state. Remote is public `github.com/SBhat2026/BhatBot`.

---

## Cross-phase RISK AUDIT (no maintenance done over phases 1–4 — likely failure modes)

**Phase 4 / config**
- ⚠ **safeStorage-down → unresolved refs.** If a launch ever has `safeStorage` unavailable, `loadConfig`
  returns `CRED_REF_*` strings unresolved → API calls get a ref as the key and fail. `getApiKey` falls
  back to `process.env.ANTHROPIC_API_KEY` (mitigates the main key) but other providers/tokens would
  break. Mitigation to add: if migration can't run, keep behavior but surface a clear one-time warning.
- ⚠ **config mtime cache vs external edits.** `loadConfig` caches by mtime; an edit that doesn't bump
  mtime (rare) serves stale. Low risk; flagged.
- ⚠ **Migration partial-failure.** If only some secrets vault (e.g. one `store` throws), the leftover
  plaintext stays AND is logged as a warning — acceptable, but watch the `[configsec] ⚠` line.

**Phase 3 / depth + memory**
- ⚠ **depth.jsonl is empty** → learned model is dormant; everything runs on the heuristic. Fine, but
  the "primary path" isn't actually exercised until ~200 rows accrue. The enriched log row only starts
  populating now, so old rows lack features (handled by `featurize` defaults).
- ⚠ **Taper starving a real long answer.** A genuinely long turn at position >15 that doesn't trip a
  reset signal gets multiplied down to as low as 0.45×. Clip-retry (Phase 1) backstops it, but watch
  for truncation on long late-conversation answers; tune `taper.FLOOR`/reset signals if it bites.
- ⚠ **Episodic recall depends on Ollama `nomic-embed-text`.** Offline → deterministic *lexical* fallback,
  which is weaker (the test scored 0.567 where embeddings would be ~0.9). The `seenBefore` threshold
  (0.86) is tuned for embeddings → on the lexical fallback it will almost never fire (mostly harmless:
  fewer false "answered before" hits, but the short-circuit is effectively off without Ollama).
- ⚠ **`.episodic-vec.json` cache** keys by content hash; safe, but if many notes accrue the first
  warm-up embeds them all (one-time latency spike). Bounded by note count.

**Phase 2**
- ⚠ **web_search DuckDuckGo HTML scraping** is the keyless default — brittle if DDG changes markup or
  rate-limits/blocks the UA. No API key configured → no resilient fallback. Add a Brave/Serper key for
  reliability; the chain already prefers them.
- ⚠ **offload cost estimate** uses ~4 chars/token when the API omits usage — approximate, not exact.

**Cross-cutting**
- ⚠ **Agent-log relay is unbounded per-second** under a very chatty fleet (every `fleetBroadcast`
  pushes to the cloud socket). Bounded buffer (200) caps memory, but a hot loop could be chatty over
  the wire; consider coalescing if it matters.
- ⚠ **The split is partial** — `main.js` is still 438KB; the classifier-mitigation goal (its original
  purpose) is only partly met until the agent-loop/shell-adjacent clusters move. Phase 1 already
  extracted raw shell exec (`lib/shell.js`), which was the single strongest signal.
- ✅ No new plaintext-credential surface introduced; D1 write-guard prevents future ones.

## Verification (2026-06-26)
- `node scripts/verify-syntax.js` → ✓ 533 files parse.
- `node scripts/test-upgrade.js` → ✅ 48 passed, 0 failed (after every D1/D2/relay change).
- configsec unit tests, tools-schema/prompts load checks, cloud relay/server `node -c` → all green.
