#!/usr/bin/env node
'use strict';
// One-time Google OAuth for BhatBot. Mints a refresh token and writes it into
// ~/.bhatbot/config.json → config.google. Run: `npm run google:auth`
//
// PREREQUISITE (once, in Google Cloud Console):
//   1. Create/select a project → enable Gmail API, Google Calendar API, Google Drive API.
//   2. OAuth consent screen → External → add yourself as a Test user.
//   3. Credentials → Create OAuth client ID → Desktop app → copy Client ID + Client Secret.
//   4. Put them into ~/.bhatbot/config.json:  { "google": { "clientId": "...", "clientSecret": "..." } }
//      (or pass GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars).
// Then run this script; a browser opens, you approve, done.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { exec } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const REDIRECT = 'http://localhost:4137/oauth2callback';
const { SCOPES } = require('../lib/google');

function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }
function saveConfig(c) { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

async function main() {
  const config = loadConfig();
  const g = config.google || {};
  const clientId = process.env.GOOGLE_CLIENT_ID || g.clientId;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || g.clientSecret;
  if (!clientId || !clientSecret) {
    console.error('✗ Missing clientId/clientSecret.\n  Add config.google.clientId + clientSecret to', CONFIG_PATH,
      '\n  (create a Desktop OAuth client in Google Cloud Console — see the header of this file).');
    process.exit(1);
  }

  const { google } = require('googleapis');
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);
  const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url.startsWith('/oauth2callback')) { res.writeHead(404); res.end(); return; }
      const u = new URL(req.url, REDIRECT);
      const c = u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>BhatBot: Google connected.</h2>You can close this tab.');
      server.close();
      c ? resolve(c) : reject(new Error('No code in callback'));
    });
    server.listen(4137, () => {
      console.log('→ Opening browser for Google consent…\n  If it does not open, visit:\n ', url, '\n');
      exec(`open "${url}"`);
    });
  });

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error('✗ No refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and retry.');
    process.exit(1);
  }
  config.google = { ...g, clientId, clientSecret, redirectUri: REDIRECT, refreshToken: tokens.refresh_token };
  saveConfig(config);
  console.log('✓ Google connected. refresh_token saved to', CONFIG_PATH);
  console.log('  Scopes:', SCOPES.map((s) => s.split('/auth/')[1]).join(', '));
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
