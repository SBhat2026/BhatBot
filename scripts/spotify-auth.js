#!/usr/bin/env node
'use strict';
// One-time Spotify Connect login for Bhatbot. Opens the Spotify authorize page,
// catches the redirect on http://127.0.0.1:8888/callback, exchanges the code, and
// saves a long-lived refresh token to ~/.bhatbot/config.json (spotifyRefreshToken).
// After this, Bhatbot can control playback on ANY of your devices (phone, Mac,
// speakers) via Spotify Connect. Requires Spotify Premium for playback control.
//
//   node ~/bhatbot/scripts/spotify-auth.js
//
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const CONFIG = path.join(os.homedir(), '.bhatbot', 'config.json');
const REDIRECT = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

if (typeof fetch !== 'function') {
  console.error('Node 18+ required (global fetch missing). Your node:', process.version);
  process.exit(1);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
catch (e) { console.error('Cannot read', CONFIG, '-', e.message); process.exit(1); }
const { spotifyClientId: id, spotifyClientSecret: secret } = cfg;
if (!id || !secret) { console.error('Set spotifyClientId + spotifyClientSecret in config first.'); process.exit(1); }

const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
  response_type: 'code', client_id: id, scope: SCOPES, redirect_uri: REDIRECT
}).toString();

async function exchange(code) {
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }).toString()
  });
  if (!r.ok) throw new Error('token ' + r.status + ' ' + (await r.text()));
  return r.json();
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:8888');
  if (u.pathname !== '/callback') { res.writeHead(404); return res.end('not found'); }
  const code = u.searchParams.get('code');
  const err = u.searchParams.get('error');
  if (err) { res.writeHead(400); res.end('Spotify error: ' + err); console.error('Auth denied:', err); return process.exit(1); }
  if (!code) { res.writeHead(400); return res.end('No code'); }
  try {
    const tok = await exchange(code);
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));      // re-read in case it changed
    cfg.spotifyRefreshToken = tok.refresh_token;
    cfg.spotifyUseConnect = true;                            // prefer Connect once linked
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<body style="font:18px system-ui;background:#090d13;color:#39d7ff;padding:40px"><h2>Bhatbot: Spotify connected ✓</h2><p>You can close this tab and return to Bhatbot.</p></body>');
    console.log('\n✓ Saved spotifyRefreshToken. Spotify Connect is ready.');
    console.log('  Now say e.g. "play Bohemian Rhapsody on my phone" (open Spotify on the phone first).');
    setTimeout(() => process.exit(0), 600);
  } catch (e) { res.writeHead(500); res.end('Error: ' + e.message); console.error(e); process.exit(1); }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('Port 8888 in use — close whatever is using it and retry.');
  else console.error(e.message);
  process.exit(1);
});

server.listen(8888, '127.0.0.1', () => {
  console.log('Opening Spotify login in your browser…');
  console.log('If it does not open, paste this URL:\n' + authUrl + '\n');
  exec(`open "${authUrl}"`);
});
