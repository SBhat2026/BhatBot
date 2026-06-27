# Cloud Deploy — Phase 4 D3 (STAGED)

The always-on brain + Mac-executor relay in `cloud/` is ready to deploy to **Fly.io** (app
`bhatbot-cloud`, region `ewr`, configured in `fly.toml`). Deploy is **staged, not executed** —
per the Phase 4 plan, the Mac key-migration must run first so the cloud never receives a plaintext
secret, and the final deploy/push were left for you to trigger.

## Why it's staged (do this in order)

1. **Launch BhatBot on the Mac once.** On `app.whenReady`, `migrateSecretsToVault()` encrypts every
   plaintext secret in `~/.bhatbot/config.json` into the safeStorage vault, leaving `CRED_REF_*`
   handles. Confirm the log line `[configsec] migrated N plaintext secret(s) → vault`.
   - Verify: `~/.bhatbot/config.json` now shows `CRED_REF_*` for `apiKey`, `openaiKey`, etc.

2. **Set Fly secrets (NOT baked into the image).** The cloud reads `process.env`; on Fly those are
   encrypted secrets, never in git or the Docker image (`.env` is git- and docker-ignored). Source
   the values once from the local, gitignored `cloud/.env`:
   ```bash
   cd ~/bhatbot/cloud
   fly secrets import < .env        # sets BHATBOT_TOKEN, ANTHROPIC_API_KEY, ELEVENLABS_API_KEY,
                                    # ELEVENLABS_VOICE_ID, OPENAI_API_KEY as encrypted Fly secrets
   ```
   (First-time only: `fly launch --no-deploy` keeps the existing `fly.toml`, then
   `fly volumes create bhatbot_data --region ewr --size 1` for the durable SQLite mount.)

3. **Deploy.**
   ```bash
   fly deploy -a bhatbot-cloud
   ```

4. **Health + relay check.**
   ```bash
   TOKEN=$(node -e "console.log(require('os').homedir())")  # then read cloudToken from config in-app
   curl -s https://bhatbot-cloud.fly.dev/health?... # guarded; use the BHATBOT_TOKEN path
   ```
   - `/health` returns `{ ok:true, mac:{ online:bool } }`.
   - With the Mac app running + `startCloudBridge` connected, `mac.online` should be `true`
     (the bridge logs `[cloud-bridge] connected — Mac is now the cloud executor`).

5. **End-to-end tests.**
   - **Mac awake:** from the phone PWA / Telegram, issue a command → it routes cloud → Mac executor →
     result returns. The new `GET /api/<token>/agentlog` shows relayed per-agent activity.
   - **Mac offline (simulate):** quit BhatBot. The cloud brain should QUEUE exec requests
     (`relay.queueExec` / `macStatus().queued`) and degrade gracefully (no crash); they drain when
     the Mac reconnects (`drainQueue` on `attachMac`).

6. **(Optional) Scrub local plaintext:** once Fly secrets are set, `cloud/.env` is no longer needed
   on disk — `shred -u cloud/.env` (or delete) so no plaintext lingers locally either.

## Security invariants (verified)
- `cloud/.env` is **gitignored** (`git check-ignore cloud/.env` ✓) and **dockerignored** → no
  plaintext ships to the image or the repo.
- The cloud accepts exec on behalf of the Mac **only** behind `BHATBOT_TOKEN` (the `/mac/<token>`
  socket + `guard` on every API route). Keep that token secret.
- Remote-dispatched tools run with `remoteDepth++` so the destructive-shell guard treats them as
  "no human at the keyboard" (no silent auto-approve).
