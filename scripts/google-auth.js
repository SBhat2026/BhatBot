#!/usr/bin/env node
'use strict';
// One-time Google OAuth for BhatBot. Mints a refresh token and stores it. Run: `npm run google:auth`
//
// RUNS UNDER ELECTRON, and must. The client secret is kept in the vault as a `CRED_REF_*` handle,
// and those only decrypt through Electron's safeStorage. The previous version of this script read
// `config.google.clientSecret` RAW from config.json, so it handed Google the literal string
// "CRED_REF_CLIENTSECRET_…" as the secret and the token exchange died with `invalid_client` — while
// the browser had ALREADY been shown "Google connected", because the callback page was written
// before the exchange was attempted. That combination is why this looked connected for weeks and
// was not. Both halves are fixed below: credentials are resolved, and the browser is only told the
// truth after the token is actually in hand.
//
// PREREQUISITE (once, in Google Cloud Console):
//   1. Create/select a project → enable Gmail API, Google Calendar API, Google Drive API.
//   2. OAuth consent screen → External → add yourself as a Test user.
//      ⚠️ While the app stays in "Testing", Google EXPIRES refresh tokens after 7 days. Publish it
//         to "In production" to stop having to re-run this every week.
//   3. Credentials → Create OAuth client ID → Desktop app → copy Client ID + Client Secret.
// Then run `npm run google:auth`; a browser opens, you approve, done.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { exec } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const REDIRECT = 'http://localhost:4137/oauth2callback';
const ROOT = path.join(__dirname, '..');
const { SCOPES } = require(path.join(ROOT, 'lib', 'google'));

function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }
function saveConfig(c) { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

// macOS safeStorage derives its Keychain item from the APP NAME. A script launched as
// `electron scripts/foo.js` is called "Electron" and reads a DIFFERENT keychain entry, failing with
// a generic decrypt error. Claim the real identity before ready. (Same fix as triage-backlog.js.)
async function ensureVault() {
  if (!process.versions.electron) return { electron: false };
  const { app } = require('electron');
  app.setName(require(path.join(ROOT, 'package.json')).name);
  await app.whenReady();
  app.on('window-all-closed', () => {});
  return { electron: true };
}

async function main() {
  const { electron } = await ensureVault();
  const config = loadConfig();
  const g = config.google || {};
  const credentials = require(path.join(ROOT, 'lib', 'credentials'));

  // Resolve CRED_REF handles → real values. Env always wins (useful for a fresh setup).
  const resolved = credentials.resolveRefs(g);
  const clientId = process.env.GOOGLE_CLIENT_ID || resolved.clientId;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || resolved.clientSecret;

  if (!clientId || !clientSecret) {
    console.error('✗ Missing clientId/clientSecret.\n  Add config.google.clientId + clientSecret to', CONFIG_PATH);
    process.exit(1);
  }
  if (/^CRED_REF_/.test(String(clientSecret))) {
    console.error('✗ clientSecret is still an unresolved vault handle:', clientSecret);
    console.error('  safeStorage is not available here. Run this through Electron:  npm run google:auth');
    console.error('  ...or export GOOGLE_CLIENT_SECRET for this run.');
    process.exit(1);
  }

  const { google } = require('googleapis');
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);
  // access_type=offline + prompt=consent is what makes Google return a REFRESH token. Without the
  // forced consent, re-authorizing an already-approved app returns only an access token.
  const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  let server;
  const code = await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (!req.url.startsWith('/oauth2callback')) { res.writeHead(404); res.end(); return; }
      const u = new URL(req.url, REDIRECT);
      const c = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (err || !c) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h2>BhatBot: Google authorization failed.</h2><p>${err || 'no code returned'}</p>`);
        server.close(); reject(new Error(err || 'No code in callback')); return;
      }
      // Hold the response open until the exchange actually succeeds — the browser must not be told
      // "connected" before we know that it is. `res` is handed to the caller via the closure below.
      resolve({ code: c, res });
    });
    server.on('error', reject);
    server.listen(4137, () => {
      console.log('→ Opening browser for Google consent…\n  If it does not open, visit:\n ', url, '\n');
      exec(`open "${url}"`);
    });
  });

  const finish = (ok, msg) => {
    try {
      code.res.writeHead(ok ? 200 : 500, { 'Content-Type': 'text/html' });
      code.res.end(ok ? '<h2>BhatBot: Google connected.</h2>You can close this tab.' : `<h2>BhatBot: connection failed.</h2><p>${msg}</p>`);
    } catch {}
    try { server.close(); } catch {}
  };

  let tokens;
  try {
    ({ tokens } = await oauth2.getToken(code.code));
  } catch (e) {
    const m = (e && e.response && e.response.data && e.response.data.error_description) || e.message;
    finish(false, m);
    console.error('✗ Token exchange failed:', m);
    if (/invalid_client/.test(String(m))) console.error('  → clientId/clientSecret are wrong or unresolved.');
    process.exit(1);
  }
  if (!tokens.refresh_token) {
    finish(false, 'Google returned no refresh token.');
    console.error('✗ No refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and retry.');
    process.exit(1);
  }
  finish(true);

  // Store the refresh token in the VAULT when we can, so it never lands on disk in plaintext.
  let stored = tokens.refresh_token;
  let vaulted = false;
  if (electron && credentials.canStore()) {
    try { stored = credentials.store('refreshToken', 'google', '', tokens.refresh_token); vaulted = true; } catch {}
  }
  // Keep the clientSecret exactly as it was (handle or literal) — never downgrade a vaulted secret.
  config.google = { ...g, clientId: g.clientId || clientId, redirectUri: REDIRECT, refreshToken: stored };
  saveConfig(config);

  console.log(`✓ Google connected. refresh_token ${vaulted ? 'stored in the vault' : 'saved (PLAINTEXT — run inside the app to vault it)'}.`);
  console.log('  Scopes:', SCOPES.map((s) => s.split('/auth/')[1]).join(', '));

  // Prove it end-to-end rather than trusting the exchange.
  try {
    const gl = require(path.join(ROOT, 'lib', 'google'));
    const r = await gl.gmailSearch('in:inbox', { limit: 1 });
    if (r && r.success) console.log(`✓ Verified: Gmail responded (${r.count} message read back).`);
    else console.warn('⚠ Saved, but the verification call failed:', (r && r.error) || 'unknown');
  } catch (e) { console.warn('⚠ Saved, but verification threw:', e.message); }

  if (process.versions.electron) { try { require('electron').app.exit(0); } catch {} }
}

main().catch((e) => {
  console.error('✗', e.message);
  if (process.versions.electron) { try { require('electron').app.exit(1); } catch {} }
  process.exit(1);
});
