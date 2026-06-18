'use strict';
// HTTP + WebSocket server. Speaks the SAME /api/:token/* contract the phone UI already uses
// (so the app just repoints its host here) AND serves the PWA at /app/:token, so phone + the
// native app + a browser can all use the cloud independently of the Mac. A WebSocket at
// /mac/:token is where the Mac executor dials in for the relay.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');

const db = require('./db');
const voice = require('./voice');
const { runTurn } = require('./agent');
const relay = require('./relay');
const scheduler = require('./scheduler');

const PORT = process.env.PORT || 8790;
const TOKEN = process.env.BHATBOT_TOKEN || '';
const PUBLIC = path.join(__dirname, '..', 'public');
const tokenBuf = Buffer.from(TOKEN);

const safeEq = (cand) => { const b = Buffer.from(String(cand || '')); return TOKEN && b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf); };
const presented = (req) => { const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || ''); return (m && m[1]) || req.params.token || (req.query && req.query.token) || ''; };

const app = express();
app.use(express.json({ limit: '16mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const guard = (req, res, next) => safeEq(presented(req)) ? next() : res.status(401).json({ error: 'unauthorized' });
const noStore = (res) => res.set('Cache-Control', 'no-store');

// ---- health (token-gated) -----------------------------------------------------
app.get('/health', guard, (_q, s) => s.json({ ok: true, name: 'bhatbot-cloud', mac: relay.macStatus(), cost: db.costToday() }));

// ---- chat → the agent loop ----------------------------------------------------
app.post('/api/:token/chat', guard, async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.json({ error: 'empty' });
    const r = await runTurn('phone', text, { reset: !!(req.body && req.body.new_conversation) });
    res.json(r.error ? { error: r.error } : { text: r.text, _provider: 'cloud', _macOnline: r._macOnline });
  } catch (e) { res.json({ error: String(e && e.message || e) }); }
});

// ---- voice --------------------------------------------------------------------
app.post('/api/:token/tts', guard, async (req, res) => {
  const r = await voice.tts((req.body && req.body.text) || '', req.body || {});
  res.json(r.error ? { error: r.error } : r);
});
app.post('/api/:token/stt', guard, express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const r = await voice.stt(req.body, req.query.mime || 'audio/webm');
  res.json(r.error ? { error: r.error } : r);
});
app.post('/api/:token/summarize', guard, async (req, res) => {
  // Reuse the agent for a faithful spoken condense (kept tiny).
  try {
    const t = String((req.body && req.body.text) || '').trim(); if (!t) return res.json({ error: 'empty' });
    const r = await runTurn('summarize', `Condense this into one or two spoken sentences, faithful, no markdown:\n\n${t}`, { reset: true });
    res.json({ text: r.text || t });
  } catch (e) { res.json({ error: String(e && e.message || e) }); }
});

// ---- activity + config --------------------------------------------------------
app.get('/api/:token/activity', guard, (req, res) => { noStore(res); res.json(db.getActivity(req.query.since)); });
app.get('/api/:token/config', guard, (_q, s) => { noStore(s); s.json({ nexusUrl: process.env.NEXUS_URL || '', mac: relay.macStatus() }); });

// ---- PWA (serve the same mobile UI so phone/native/browser can point here) -----
const MOBILE = path.join(PUBLIC, 'mobile.html');
const appVersion = () => { try { return String(Math.floor(fs.statSync(MOBILE).mtimeMs)); } catch { return '0'; } };
app.get('/app/:token', guard, (_q, res) => { try { noStore(res); res.type('html').send(fs.readFileSync(MOBILE, 'utf8').replace(/__BUILD__/g, appVersion())); } catch { res.status(404).send('UI not synced — run npm run sync-ui'); } });
app.get('/app/:token/version', guard, (_q, s) => { noStore(s); s.json({ version: appVersion() }); });
app.get('/app/:token/manifest.webmanifest', guard, (req, res) => {
  const base = `/app/${req.params.token}`;
  res.type('application/manifest+json').json({ name: 'BhatBot', short_name: 'BhatBot', start_url: base, scope: base + '/', display: 'standalone', background_color: '#090d13', theme_color: '#090d13',
    icons: [{ src: base + '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: base + '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] });
});
for (const ic of ['icon-192.png', 'icon-512.png']) {
  app.get('/app/:token/' + ic, guard, (_q, res) => { try { res.type('png').send(fs.readFileSync(path.join(PUBLIC, ic))); } catch { res.status(404).end(); } });
}

// ---- schedules (phone/computer can manage proactive tasks) ---------------------
app.get('/api/:token/schedules', guard, (_q, s) => s.json({ schedules: scheduler.list() }));
app.post('/api/:token/schedules', guard, (req, res) => res.json(scheduler.add(req.body || {})));
app.post('/api/:token/schedules/:id/delete', guard, (req, res) => res.json(scheduler.remove(req.params.id)));

const server = http.createServer(app);

// ---- WebSocket: the Mac executor dials in here --------------------------------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/mac\/([^/]+)$/);
    const tok = (m && m[1]) || url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!m || !safeEq(tok)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      relay.attachMac(ws, { host: req.headers.host });
      ws.send(JSON.stringify({ type: 'hello', name: 'bhatbot-cloud' }));
      console.log('[relay] Mac executor connected');
      db.pushActivity('relay', 'Mac executor connected');
    });
  } catch { socket.destroy(); }
});

function start() {
  server.listen(PORT, () => {
    console.log(`[bhatbot-cloud] http+ws on :${PORT}`);
    if (!TOKEN) console.warn('[bhatbot-cloud] ⚠ BHATBOT_TOKEN not set — all requests 401');
    if (!process.env.ANTHROPIC_API_KEY) console.warn('[bhatbot-cloud] ⚠ ANTHROPIC_API_KEY not set — chat will fail');
  });
  scheduler.start();
}

module.exports = { start };
