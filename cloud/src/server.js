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
const { runTurn, dailyBriefIfDue } = require('./agent');
const relay = require('./relay');
const scheduler = require('./scheduler');
const twilio = require('./twilio');

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

// ---- SYNAPSE read replica -----------------------------------------------------
// The second brain's WORKERS stay on the Mac: hydrating needs the local repos, the semantic store and
// ~/.bhatbot/projects, none of which exist here — and replicating them would mean shipping the
// contents of every repo in his home directory to a hosted box. So the cloud gets a READ REPLICA:
// the local worker POSTs a pruned graph view (labels + edges + rationales; NO embeddings, NO file
// bodies) after a successful pass, and the phone reads it here when the Mac is off.
//
// Stored as a single JSON blob on the volume rather than in SQLite: it is a whole-snapshot replace,
// never a query target, and this keeps the schema untouched.
const BRAIN_FILE = path.join(process.env.DATA_DIR || '/data', 'brain-replica.json');
const BRAIN_MAX_BYTES = 8 * 1024 * 1024;

app.post('/api/:token/brain', guard, express.json({ limit: '10mb' }), (req, res) => {
  try {
    const g = req.body || {};
    if (!g || !Array.isArray(g.nodes)) return res.status(400).json({ error: 'expected { nodes: [], edges: [] }' });
    // Defence in depth: the sender already strips these, but a replica must never become a copy of
    // his private file contents or a place embeddings accumulate.
    const nodes = g.nodes.map(({ embedding, ...n }) => ({ ...n, text: String(n.text || '').slice(0, 300) }));
    const body = JSON.stringify({ nodes, edges: g.edges || [], stats: g.stats || null, meta: g.meta || null, at: Date.now() });
    if (body.length > BRAIN_MAX_BYTES) return res.status(413).json({ error: 'replica too large' });
    fs.mkdirSync(path.dirname(BRAIN_FILE), { recursive: true });
    fs.writeFileSync(BRAIN_FILE + '.tmp', body);
    fs.renameSync(BRAIN_FILE + '.tmp', BRAIN_FILE);   // atomic — a phone never reads a half-written graph
    res.json({ ok: true, nodes: nodes.length, edges: (g.edges || []).length, bytes: body.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/:token/brain', guard, (_q, res) => {
  noStore(res);
  try { res.type('json').send(fs.readFileSync(BRAIN_FILE, 'utf8')); }
  catch { res.json({ nodes: [], edges: [], at: null, note: 'no replica yet — the Mac worker pushes one after each successful pass' }); }
});

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

// ---- first-open-of-the-day brief — the phone/computer calls this on launch -----
app.get('/api/:token/morning', guard, async (_q, res) => {
  try { res.json(await dailyBriefIfDue()); } catch (e) { res.json({ fresh: false, error: String(e && e.message || e) }); }
});

// ---- activity + config --------------------------------------------------------
app.get('/api/:token/activity', guard, (req, res) => { noStore(res); res.json(db.getActivity(req.query.since)); });
app.get('/api/:token/audit', guard, (req, res) => { noStore(res); res.json({ entries: db.getAuditLog(Number(req.query.limit) || 100) }); });
app.get('/api/:token/config', guard, (_q, s) => { noStore(s); s.json({ nexusUrl: process.env.NEXUS_URL || '', mac: relay.macStatus() }); });
// Phase 4 — relayed fleet-agent activity, so other bots/surfaces (phone PWA, Telegram) can see what each agent is doing.
app.get('/api/:token/agentlog', guard, (req, res) => { noStore(res); res.json({ entries: relay.recentAgentLog(Number(req.query.n) || 30) }); });

// ---- contacts (Mac imports them here; agent + butler use them for who's-who) ---
app.post('/api/:token/contacts', guard, (req, res) => {
  try { const n = db.upsertContacts((req.body && req.body.contacts) || []); res.json({ ok: true, count: n }); }
  catch (e) { res.json({ error: String(e && e.message || e) }); }
});
app.get('/api/:token/contacts', guard, (_q, res) => { noStore(res); res.json({ contacts: db.getContacts() }); });
app.post('/api/:token/contacts/note', guard, (req, res) => {
  const c = db.setContactNote((req.body && req.body.name) || '', (req.body && req.body.note) || '');
  res.json(c ? { ok: true, contact: c } : { error: 'no matching contact' });
});

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
// Download the native .ipa over public HTTPS (no Tailscale) → open in SideStore. Token-gated.
app.get('/app/:token/bhatbot.ipa', guard, (_q, res) => {
  try { res.set('Content-Type', 'application/octet-stream').set('Content-Disposition', 'attachment; filename="BhatBot.ipa"').send(fs.readFileSync(path.join(PUBLIC, 'bhatbot.ipa'))); }
  catch { res.status(404).json({ error: 'ipa not synced — run npm run sync-ui then redeploy' }); }
});

// ---- schedules (phone/computer can manage proactive tasks) ---------------------
app.get('/api/:token/schedules', guard, (_q, s) => s.json({ schedules: scheduler.list() }));
app.post('/api/:token/schedules', guard, (req, res) => res.json(scheduler.add(req.body || {})));
app.post('/api/:token/schedules/:id/delete', guard, (req, res) => res.json(scheduler.remove(req.params.id)));

// Twilio voice + SMS webhooks (calling people / answering your number in your name). Mounted
// only if Twilio is configured. urlencoded body parser because Twilio POSTs form-encoded.
if (twilio.configured()) twilio.mount(app, { token: TOKEN, form: express.urlencoded({ extended: false }) });

// When the Mac wakes and drains commands queued while it slept, text Siddhant the outcome.
relay.setDrainNotifier((results) => {
  try {
    const ok = results.filter((r) => r.ok).length;
    twilio.notifyOwner(`🖥 Mac woke — ran ${results.length} queued command(s) (${ok} ok): ${results.map((r) => `${r.ok ? '✓' : '✗'} ${r.tool}`).join(', ')}`);
  } catch {}
});

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
