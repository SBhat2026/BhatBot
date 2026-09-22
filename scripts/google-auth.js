#!/usr/bin/env node
'use strict';
// Google OAuth for BhatBot. Mints a refresh token for ONE account and appends it to the account
// list. Run: `npm run google:auth` — once per mailbox you want connected, and again for any mailbox
// whose token has expired (matching is by address, so a re-auth replaces rather than duplicates).
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
  // `select_account` MATTERS NOW THAT THERE ARE SEVERAL. With `consent` alone Google silently reuses
  // whichever account the browser is already signed in as, so "add my school mail" hands back the
  // personal one, the address matches an existing entry, and the run reports success having
  // connected nothing new. Asking for the chooser every time costs one extra click and removes an
  // entire class of "I ran it twice and still only have one account".
  // `login_hint` pre-selects an address in the chooser. It is a convenience, not an access change:
  // Google still applies the test-user list, the publishing status and any Workspace admin policy
  // exactly as before — it only saves picking the account out of a list.
  //
  //   npm run google:auth -- me@princeton.edu
  const hint = process.argv.slice(2).find((a) => /@/.test(a) && !a.startsWith('-')) || '';
  // A placeholder pasted out of an example is a real way to lose two minutes: login_hint does not
  // restrict anything, so Google happily opens the chooser and the mistake only surfaces later as
  // "why did it connect the wrong mailbox".
  if (/^(your|my|someone|user|netid|name|email)[^@]*@/i.test(hint)) {
    console.error(`✗ "${hint}" looks like a placeholder, not your address. Re-run with the real one.`);
    process.exit(2);
  }
  const url = oauth2.generateAuthUrl({
    access_type: 'offline', prompt: 'select_account consent', scope: SCOPES,
    ...(hint ? { login_hint: hint } : {}),
  });
  if (hint) console.log(`  (pre-selecting ${hint} in the chooser)`);

  // A CONSENT FLOW THAT IS NEVER COMPLETED MUST NOT OUTLIVE THE TERMINAL IT WAS STARTED IN.
  //
  // This server has exactly one job — catch one redirect — and it used to wait for it forever. Close
  // the browser tab, or walk away, and the process stayed alive holding :4137. The next run then
  // failed with a bare `EADDRINUSE: address already in use :::4137`, which names neither the port's
  // owner nor the fact that the owner is a previous copy of this very script. Observed 2026-09-22:
  // an abandoned run from 00:19 blocked the retry eleven hours later.
  //
  // So: it gives up after ten minutes, and if the port is taken it says who has it.
  const CONSENT_TIMEOUT_MS = 10 * 60 * 1000;
  let server, giveUp;
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
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        // Almost always an abandoned run of this same script. Name it, and name the way out, rather
        // than leaving a port number and a shrug.
        exec("lsof -nP -iTCP:4137 -sTCP:LISTEN -t", (_e, out) => {
          const pids = String(out || '').trim().split(/\s+/).filter(Boolean);
          reject(new Error(
            'port 4137 is already in use' + (pids.length ? ' by PID ' + pids.join(', ') : '') + '.\n'
            + '  That is almost certainly a previous `npm run google:auth` whose browser tab was never\n'
            + '  completed — it waits for the redirect and holds the port.\n'
            + (pids.length ? '  Free it with:  kill ' + pids.join(' ') + '\n' : '')
            + '  Then run this again.'));
        });
        return;
      }
      reject(e);
    });
    server.listen(4137, () => {
      console.log('→ Opening browser for Google consent…\n  If it does not open, visit:\n ', url, '\n');
      exec(`open "${url}"`);
      giveUp = setTimeout(() => {
        try { server.close(); } catch {}
        reject(new Error('timed out after 10 minutes waiting for the Google consent redirect. '
          + 'Nothing was changed; run it again when you can finish the flow in the browser.'));
      }, CONSENT_TIMEOUT_MS);
      giveUp.unref && giveUp.unref();
    });
  });
  clearTimeout(giveUp);

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
    // TWO BLOCKS THAT LOOK ALIKE AND ARE NOT. One is yours to fix in thirty seconds; the other
    // belongs to a Workspace administrator and no setting on this machine touches it. Saying which
    // is the difference between a minute's work and a week of guessing.
    if (/access_denied|admin|policy|org/i.test(String(m))) {
      console.error('\n  This can be either of two different refusals:');
      console.error('   • "developer-approved testers" / unverified app → YOURS to fix: add that');
      console.error('     address under Google Cloud Console → OAuth consent screen → Test users,');
      console.error('     then run this again. (Publishing the app also ends the 7-day token expiry.)');
      console.error('   • a message naming an administrator or your organization → that is the');
      console.error('     Workspace tenant blocking unconfigured third-party apps. Nothing here can');
      console.error('     change it; the client ID has to be allowlisted by that domain\'s IT.');
    }
    process.exit(1);
  }
  if (!tokens.refresh_token) {
    finish(false, 'Google returned no refresh token.');
    console.error('✗ No refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and retry.');
    process.exit(1);
  }
  finish(true);

  // WHICH MAILBOX DID WE JUST CONNECT? Ask, before storing anything. An account list where the
  // entries are distinguishable only by position is unusable — you cannot say "search my school
  // mail" to a list of anonymous refresh tokens, and you cannot tell which one to re-auth when one
  // of them expires. The address comes from the token we just minted, so it cannot be wrong.
  let email = '';
  try {
    oauth2.setCredentials(tokens);
    const { google } = require('googleapis');
    const prof = await google.gmail({ version: 'v1', auth: oauth2 }).users.getProfile({ userId: 'me' });
    email = String((prof.data && prof.data.emailAddress) || '').toLowerCase();
  } catch (e) { console.warn('⚠ Could not read the account address:', e.message); }

  // Store the refresh token in the VAULT when we can, so it never lands on disk in plaintext.
  let stored = tokens.refresh_token;
  let vaulted = false;
  if (electron && credentials.canStore()) {
    const handleName = 'refreshToken' + (email ? '_' + email.replace(/[^a-z0-9]+/g, '_') : '');
    try { stored = credentials.store(handleName, 'google', '', tokens.refresh_token); vaulted = true; } catch {}
  }

  // ── APPEND, DO NOT REPLACE ─────────────────────────────────────────────────────────────────────
  // This used to overwrite `config.google.refreshToken`, so connecting a second mailbox silently
  // disconnected the first. Accounts are a list now. Re-running for an address already in the list
  // REPLACES that entry — which is exactly what a re-auth after an expiry should do, and is why the
  // match is on the address rather than on the token.
  const prior = Array.isArray(g.accounts) ? g.accounts.slice() : [];
  // A pre-multi-account config carried one token at the top level; carry it in as account one — and
  // carry its TRIAGE setting with it. Triage is off by default for a new account, but the account
  // being migrated is the one triage was already configured against, and a migration that silently
  // switches a working subsystem off is not a migration.
  if (!prior.length && g.refreshToken) {
    const wasTriaging = !!(config.triage && config.triage.enabled);
    prior.push({ email: g.email || '', refreshToken: g.refreshToken, primary: true, triage: wasTriaging });
    if (wasTriaging) console.log('  (carried the existing mail-triage opt-in onto the first account)');
  }

  const at = email ? prior.findIndex((a) => String(a.email || '').toLowerCase() === email) : -1;
  const entry = {
    email,
    label: (at >= 0 && prior[at].label) || email || ('account ' + (prior.length + 1)),
    refreshToken: stored,
    // The first mailbox connected becomes the one writes go to. Later ones do not take that over —
    // silently moving where drafts are sent from is not something a re-auth should ever do.
    primary: at >= 0 ? !!prior[at].primary : prior.length === 0,
    // Triage is opt-in per account and a new account does not get it. Connecting an inbox for search
    // and calendar must not, by itself, enrol it in something that proposes to archive mail.
    triage: at >= 0 ? prior[at].triage === true : false,
  };
  if (at >= 0) prior[at] = entry; else prior.push(entry);
  if (!prior.some((a) => a.primary)) prior[0].primary = true;

  // Keep the clientSecret exactly as it was (handle or literal) — never downgrade a vaulted secret.
  config.google = { ...g, clientId: g.clientId || clientId, redirectUri: REDIRECT, accounts: prior };
  delete config.google.refreshToken;      // migrated into accounts[]; leaving it would shadow the list
  delete config.google.email;
  saveConfig(config);

  const readded = at >= 0;
  console.log(`\n✓ ${readded ? 'Re-connected' : 'Connected'} ${email || '(address unknown)'}${entry.primary ? '  [primary — writes go here]' : ''}.`);
  if (readded) console.log('  (this address was already connected — its token was refreshed, not duplicated)');
  // Asked for one mailbox and got another. Google's chooser is free to hand back whichever account
  // the browser is signed in as, and silently connecting the wrong one is how you end up believing
  // an account is connected when it is not.
  if (hint && email && hint.toLowerCase() !== email) {
    console.warn(`\n⚠ You asked for ${hint} but ${email} was authorised — pick the other account in the chooser and run this again.`);
  }
  console.log(`  refresh_token ${vaulted ? 'stored in the vault' : 'saved (PLAINTEXT — run inside the app to vault it)'}.`);
  console.log('  Scopes:', SCOPES.map((s) => s.split('/auth/')[1]).join(', '));
  console.log(`\n  ${prior.length} account${prior.length === 1 ? '' : 's'} connected:`);
  for (const a of prior) {
    console.log(`    ${a.primary ? '●' : '○'} ${a.email || a.label}${a.primary ? '  (primary)' : ''}${a.triage ? '  · triage on' : ''}`);
  }
  console.log('\n  Run this again to add another. Mail triage is OFF for new accounts —');
  console.log('  turn it on per account with config.google.accounts[].triage = true.\n');

  // Prove it end-to-end rather than trusting the exchange. Verifies THIS account specifically:
  // a fan-out that succeeded on a different mailbox would be a false pass.
  try {
    const gl = require(path.join(ROOT, 'lib', 'google'));
    const r = await gl.gmailSearchOne('in:inbox', { limit: 1, account: email || 'primary' });
    if (r && r.success) console.log(`✓ Verified: ${email || 'the account'} responded (${r.count} message read back).`);
    else console.warn('⚠ Saved, but the verification call failed:', (r && r.error) || (r && r.reason) || 'unknown');
  } catch (e) { console.warn('⚠ Saved, but verification threw:', e.message); }

  if (process.versions.electron) { try { require('electron').app.exit(0); } catch {} }
}

main().catch((e) => {
  console.error('✗', e.message);
  if (process.versions.electron) { try { require('electron').app.exit(1); } catch {} }
  process.exit(1);
});
