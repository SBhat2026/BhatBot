'use strict';
// Bhatbot MCP server — exposes Bhatbot's agent to the Claude app (and any MCP
// client) as a remote connector over Streamable HTTP. Bound to localhost;
// publish to the internet with `tailscale funnel <port>` so the Claude mobile
// app (which connects from Anthropic's side) can reach it. A secret token in
// the URL path gates access: https://<machine>.<tailnet>.ts.net/mcp/<token>

let httpServer = null;
let _shuttingDown = false;   // distinguishes an intentional stop from a listener that vanished
const callscript = require('./lib/callscript');
// ── CALLS BHATBOT PLACED TO SOMEONE ELSE ───────────────────────────────────────────────────────────
// The voice webhooks below serve ONE person — Siddhant — with the full agent behind them. A call to
// a contact is a different conversation with a different, tool-less brain, so it is admitted only by
// an entry main.js registers at the moment it dials: the id is in the signed webhook URL, and the
// number Twilio says it dialled must be the number registered. Nobody can talk their way from a
// guest call into the owner's agent, because the two never share a route.
const _guests = new Map();   // id → { to, name, purpose, note, lines, history:[], at, callSid }
function registerGuestCall(id, entry) {
  const now = Date.now();
  for (const [k, v] of _guests) if (now - v.at > 60 * 60 * 1000) _guests.delete(k);
  _guests.set(String(id), { history: [], ...entry, at: now });
}
// Speech voiced BEFORE the phone rings, so the first words after he picks up cost no synthesis.
let _prewarm = async () => ({ ok: false, why: 'MCP server not started' });
async function prewarmSpeech(texts) { return _prewarm(texts); }
// Async answering-machine verdicts, by CallSid: Twilio's call record does not always carry them.
const _amd = new Map();
function amdResult(sid) { return _amd.get(String(sid || '')) || null; }

async function startMcpServer({ port, token, runAgent, transcribe, synthesize, synthUlaw, summarize, media, voiceTurn, voiceBegin, voicePoll, endVoiceCall, getActivity, nexusUrl, ownerPhone, twilioAuthToken, publicHost, jobs, control, screenshot, voice, biometrics, opsStatus, guestTurn, onGuestEnd, updateCall }) {
  if (httpServer) return httpServer;
  const express = require('express');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const crypto = require('crypto');
  const { z } = require('zod');

  // Constant-time token compare — avoids leaking match progress via response timing.
  const tokenBuf = Buffer.from(String(token));
  const safeEq = (cand) => {
    const b = Buffer.from(String(cand || ''));
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  };
  // Accept the token from the Authorization: Bearer header (preferred — stays out of URLs,
  // logs, history) OR the URL path (fallback the PWA bootstrap + manifest/SW still need).
  const presentedToken = (req) => {
    const h = req.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return (m && m[1]) || req.params.token || (req.query && req.query.token) || '';
  };
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

  function build() {
    const server = new McpServer({ name: 'bhatbot', version: '1.0.0' });
    server.tool(
      'run_task',
      "Send an instruction to Bhatbot running on Siddhant's Mac. Bhatbot executes it with full tool access (filesystem, shell, Playwright browser, image & 3D generation, memory, Claude Code) and returns the result. Use this for ANY task you want performed on his computer while he is away.",
      {
        instruction: z.string().describe('Exactly what Bhatbot should do, in natural language.'),
        new_conversation: z.boolean().optional().describe('Set true to start fresh and forget prior remote context.')
      },
      async ({ instruction, new_conversation }) => {
        const r = await runAgent(instruction, { reset: !!new_conversation });
        return { content: [{ type: 'text', text: r.error ? ('Error: ' + r.error) : (r.text || '(no output)') }] };
      }
    );
    server.tool('status', 'Confirm Bhatbot is online and reachable.', {}, async () => ({
      content: [{ type: 'text', text: 'Bhatbot is online on the Mac and ready for instructions.' }]
    }));
    return server;
  }

  const app = express();
  app.use(express.json({ limit: '16mb' }));

  // CORS: the native app loads a BUNDLED copy of the UI (origin "null" / app scheme) and
  // calls these endpoints cross-origin. Access is already gated by the secret token in the
  // path and there are no cookies, so a permissive origin is safe here. Answer preflights.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,mcp-session-id,mcp-protocol-version');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const guard = (req, res, next) => {
    if (!safeEq(presentedToken(req))) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
  // Twilio webhook authenticity: verify X-Twilio-Signature (HMAC-SHA1 of the full URL +
  // sorted POST params, keyed by the Twilio auth token). Blocks spoofed webhook POSTs even
  // from someone who learned the token URL. Skipped only if no auth token is configured.
  // Why BhatBot rang, held until he has said he can talk. Bounded — a call that never reaches its
  // second turn must not leak an entry.
  const pendingReason = new Map();

  // ── WHO IS THE OWNER ON THIS CALL? ──────────────────────────────────────────────────────────────
  // On an INBOUND call Siddhant is `From` — he dialled us. On an OUTBOUND call he is `To` — we
  // dialled him, and `From` is the Twilio number. Checking `From` unconditionally therefore refuses
  // every outbound call with "Unauthorized", which is exactly what happened: the call connected, the
  // webhook answered, and he heard a failure instead of BhatBot. The direction decides which party
  // to authorise.
  //
  // Numbers are compared on DIGITS. +16094806321, 16094806321 and (609) 480-6321 are one phone, and
  // a string comparison makes a config entry typed in a human format silently refuse every call.
  const digits = (v) => String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const samePhone = (a, b) => { const x = digits(a), y = digits(b); return !!x && !!y && x === y; };
  /** The party who must be the owner for this webhook to proceed, or '' when there is nobody to check. */
  const ownerParty = (req) => {
    const outbound = /^outbound/i.test(String(req.body.Direction || ''));
    return outbound ? (req.body.To || '') : (req.body.From || '');
  };
  const ownerOk = (req) => {
    if (!ownerPhone) return true;                       // nothing configured → nothing to enforce
    const party = ownerParty(req);
    if (!party) return true;                            // Twilio did not say → do not invent a refusal
    return samePhone(party, ownerPhone);
  };

  const twilioVerified = (req) => {
    if (!twilioAuthToken) return true;                 // can't verify → don't hard-block (Serve-only setups)
    try {
      const sig = req.get('x-twilio-signature') || '';
      if (!sig) return false;
      // THE URL IS PART OF THE SIGNATURE, so getting it wrong fails exactly like a forgery.
      //
      // Behind the Tailscale funnel this request arrives proxied to 127.0.0.1:8788, and whether the
      // ORIGINAL Host survives that hop is not ours to assume. If it does not, `req.get('host')`
      // yields a string Twilio never signed, every real call is rejected with <Reject/>, and the
      // symptom — the call simply not working — is indistinguishable from the funnel being down.
      //
      // So both representations are checked: the Host header as received, and the public host we
      // ourselves handed to Twilio when placing the call. This weakens nothing — each is a full
      // HMAC comparison against the same secret, and a forger still cannot produce either.
      const candidates = new Set([
        `https://${req.get('host')}${req.originalUrl}`,
        `https://${req.get('x-forwarded-host') || req.get('host')}${req.originalUrl}`,
      ]);
      const pub = (typeof publicHost === 'function' ? publicHost() : publicHost) || '';
      if (pub) candidates.add(`https://${String(pub).replace(/^https?:\/\//, '').replace(/\/+$/, '')}${req.originalUrl}`);

      const params = req.body || {};
      const sigBuf = Buffer.from(sig);
      for (const url of candidates) {
        let data = url;
        for (const k of Object.keys(params).sort()) data += k + params[k];
        const expected = crypto.createHmac('sha1', twilioAuthToken).update(Buffer.from(data, 'utf-8')).digest('base64');
        const b = Buffer.from(expected);
        if (sigBuf.length === b.length && crypto.timingSafeEqual(sigBuf, b)) return true;
      }
      console.warn('[twilio] signature did not match any candidate URL: ' + [...candidates].join(' | '));
      return false;
    } catch { return false; }
  };

  // Session-based Streamable HTTP. A stateless transport (sessionIdGenerator:undefined) breaks
  // real MCP clients (Claude Code/Claude app): they POST `initialize`, then `tools/list` on the
  // SAME session — but a per-request server has no memory of the init and rejects with
  // "Server not initialized". We keep one transport per mcp-session-id and reuse it.
  const transports = {};                                 // sessionId -> StreamableHTTPServerTransport
  const isInit = (b) => !!b && (Array.isArray(b) ? b.some((x) => x && x.method === 'initialize') : b.method === 'initialize');
  app.post('/mcp/:token', guard, async (req, res) => {
    try {
      const sid = req.get('mcp-session-id');
      let transport = sid && transports[sid];
      if (!transport && isInit(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => { transports[id] = transport; }
        });
        transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
        await build().connect(transport);
      } else if (!transport) {
        return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: no valid session id (send initialize first)' } });
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: String(e && e.message ? e.message : e) });
    }
  });
  // GET = server→client SSE stream; DELETE = end the session. Both need an existing session.
  const sessionStream = async (req, res) => {
    const sid = req.get('mcp-session-id');
    const transport = sid && transports[sid];
    if (!transport) return res.status(400).send('Invalid or missing mcp-session-id');
    await transport.handleRequest(req, res);
  };
  app.get('/mcp/:token', guard, sessionStream);
  app.delete('/mcp/:token', guard, sessionStream);
  // Health is token-gated now (no unauthenticated "a BhatBot lives here" disclosure). Probe
  // with: curl -H "Authorization: Bearer <token>" .../health  (serve-remote.sh does this).
  app.get('/health', guard, (_req, res) => res.json({ ok: true }));

  // -------------------------------------------------------------------------
  // Phone PWA — a real app you "Add to Home Screen". Same express app, same
  // token gate, same Tailscale funnel. Talks straight to Bhatbot (no Claude).
  // -------------------------------------------------------------------------
  const SRC = path.join(__dirname, 'src');
  const MOBILE = path.join(SRC, 'mobile.html');
  // Build id = mobile.html mtime → changes whenever the UI is edited, stays
  // stable across server restarts. Drives the phone's auto-reload.
  const appVersion = () => { try { return String(Math.floor(fs.statSync(MOBILE).mtimeMs)); } catch { return '0'; } };
  const noStore = (res) => res.set('Cache-Control', 'no-store, no-cache, must-revalidate').set('Pragma', 'no-cache');

  app.get('/app/:token', guard, (_req, res) => {
    const html = fs.readFileSync(MOBILE, 'utf8').replace(/__BUILD__/g, appVersion());
    noStore(res); res.type('html').send(html);
  });
  // Tiny endpoint the installed app polls; if version != the one it booted with → reload.
  app.get('/app/:token/version', guard, (_req, res) => { noStore(res); res.json({ version: appVersion() }); });

  app.get('/app/:token/manifest.webmanifest', guard, (req, res) => {
    const base = `/app/${req.params.token}`;
    res.type('application/manifest+json').json({
      name: 'Bhatbot', short_name: 'Bhatbot',
      start_url: base, scope: base + '/', display: 'standalone',
      background_color: '#090d13', theme_color: '#090d13',
      icons: [
        { src: base + '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: base + '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    });
  });

  // Real caching service worker → the home-screen app launches instantly, survives the
  // Mac being briefly unreachable, and NEVER needs re-adding. Network-first for the app
  // shell (so edits land via the version poll), cache-first for static assets (icons).
  // Cache name keyed to the build id so a new build cleanly supersedes the old cache.
  app.get('/app/:token/sw.js', guard, (req, res) => {
    const base = `/app/${req.params.token}`;
    noStore(res);
    res.type('application/javascript').send(`
const CACHE = 'bhatbot-${appVersion()}';
const SHELL = ['${base}', '${base}/icon-192.png', '${base}/icon-512.png', '${base}/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(()=>{})).then(()=>self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks)=>Promise.all(ks.filter((k)=>k!==CACHE).map((k)=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                    // never cache POST (chat/stt/tts)
  const url = new URL(req.url);
  if (!url.pathname.startsWith('${base}')) return;     // only the app scope
  if (url.pathname.includes('/version') || url.pathname.includes('/activity') || url.pathname.includes('/config')) return; // always live
  const isShell = req.mode === 'navigate' || url.pathname === '${base}';
  if (isShell) {
    e.respondWith(fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c)=>c.put('${base}', cp)); return r; }).catch(() => caches.match('${base}')));
  } else {
    e.respondWith(caches.match(req).then((c) => c || fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((cc)=>cc.put(req, cp)); return r; })));
  }
});`);
  });

  // One-tap iOS install: serve the freshly built .ipa over the (tailnet-only) tunnel so the
  // phone downloads it directly in Safari → SideStore — no AirDrop routing. Token-gated.
  app.get('/app/:token/bhatbot.ipa', guard, (_req, res) => {
    const f = [
      path.join(__dirname, 'phone-app', 'dist', 'BhatBot-unsigned.ipa'),
      path.join(os.homedir(), 'bhatbot', 'phone-app', 'dist', 'BhatBot-unsigned.ipa'),
    ].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!f) return res.status(404).json({ error: 'ipa not built — run phone-app/build-ipa.sh' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="BhatBot.ipa"');
    res.send(fs.readFileSync(f));
  });
  app.get('/app/:token/icon-192.png', guard, (_req, res) => res.type('png').send(fs.readFileSync(path.join(SRC, 'mobile', 'icon-192.png'))));
  app.get('/app/:token/icon-512.png', guard, (_req, res) => res.type('png').send(fs.readFileSync(path.join(SRC, 'mobile', 'icon-512.png'))));

  // Chat → drives the same agentLoop the desktop uses. `blocks` = vision blocks
  // from /attach (screenshots/photos/screen-recording frames).
  app.post('/api/:token/chat', guard, async (req, res) => {
    try {
      const { text, new_conversation, blocks } = req.body || {};
      const hasBlocks = Array.isArray(blocks) && blocks.length;
      if ((!text || !String(text).trim()) && !hasBlocks) return res.status(400).json({ error: 'empty text' });
      const t0 = Date.now();
      const r = await runAgent(String(text || ''), { reset: !!new_conversation, blocks: hasBlocks ? blocks : [] });
      // A TURN THAT ANSWERS WITH NOTHING. Seen three times, always on a LONG turn, never reproducible
      // on demand — and every time the only evidence was the caller printing "(no text)". That is the
      // shape of a bug that costs days: intermittent, silent, and it destroys exactly the property
      // that matters for unattended work, because a background job cannot notice it answered nobody.
      //
      // So it records ITSELF. The next occurrence arrives with its duration, its stop reason and the
      // prompt that caused it, instead of three characters on a terminal nobody was watching.
      if (!r.error && !String(r.text || '').trim()) {
        const ms = Date.now() - t0;
        console.warn(`[no-text] a turn produced no text after ${(ms / 1000).toFixed(1)}s`
          + ` · stop_reason=${r.stop_reason || r.stopReason || '?'} · keys=${Object.keys(r).join(',') || 'none'}`
          + ` · prompt="${String(text || '').slice(0, 80)}"`);
      }
      res.json(r.error ? { error: r.error } : { text: r.text, stop_reason: r.stop_reason || r.stopReason || null, ms: Date.now() - t0 });
    } catch (e) { res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
  });

  // Attach media from the phone (Photos/Camera/Files) → normalized vision blocks.
  app.post('/api/:token/attach', guard, express.raw({ type: '*/*', limit: '120mb' }), async (req, res) => {
    try {
      if (!media) return res.status(501).json({ error: 'attach unavailable' });
      const blocks = await media(req.body, req.query.mime || 'application/octet-stream');
      res.json({ blocks });
    } catch (e) { res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
  });

  // STT — raw audio body, mimeType in ?mime= (iOS sends audio/mp4).
  app.post('/api/:token/stt', guard, express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
    try {
      if (!transcribe) return res.status(501).json({ error: 'stt unavailable' });
      const r = await transcribe(req.body, req.query.mime || 'audio/webm');
      res.json(r.error ? { error: r.error } : { text: r.text });
    } catch (e) { res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
  });

  // TTS — Jarvis voice; returns base64 audio. Phone can pass {voice, speed} to customize.
  app.post('/api/:token/tts', guard, async (req, res) => {
    try {
      if (!synthesize) return res.status(501).json({ error: 'tts unavailable' });
      const b = req.body || {};
      const opts = {};
      if (b.voice) opts.voice = String(b.voice);
      if (b.speed != null) opts.speed = Number(b.speed);
      const r = await synthesize(b.text || '', opts);
      res.json(r.error ? { error: r.error } : { audio: r.audio, mimeType: r.mimeType, via: r.via });
    } catch (e) { res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
  });

  // Spoken summary of a long reply (for read-aloud).
  app.post('/api/:token/summarize', guard, async (req, res) => {
    try {
      if (!summarize) return res.status(501).json({ error: 'summarize unavailable' });
      const r = await summarize((req.body && req.body.text) || '');
      res.json(r.error ? { error: r.error } : { text: r.text });
    } catch (e) { res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
  });

  // Activity feed — phone Activity tab polls this (?since=lastId) to mirror the desktop's
  // live tool/thinking stream. No-op if the host didn't provide getActivity.
  app.get('/api/:token/activity', guard, (req, res) => {
    if (!getActivity) return res.json({ seq: 0, events: [] });
    noStore(res); res.json(getActivity(req.query.since));
  });

  // Health (Garmin biometrics) + ops snapshot for the phone's Health / Manage screens. No-op if the
  // host didn't inject the providers (older builds). Data lives on the Mac; this serves it read-only.
  app.get('/api/:token/biometrics', guard, (_req, res) => { noStore(res); res.json(biometrics ? biometrics() : { error: 'not available' }); });
  app.get('/api/:token/ops', guard, (_req, res) => { noStore(res); res.json(opsStatus ? opsStatus() : { error: 'not available' }); });

  // Where the phone's Nexus tab should point.
  app.get('/api/:token/config', guard, (_req, res) => { noStore(res); res.json({ nexusUrl: nexusUrl || '' }); });

  // -------------------------------------------------------------------------
  // Phone Control tab — full desktop control over the same token-gated funnel.
  // Background jobs (view/cancel/steer), a whitelisted tool passthrough (system/
  // media/shell — the chat endpoint already grants the agent all of these, so no
  // new exposure), and a live desktop screenshot.
  // -------------------------------------------------------------------------
  app.get('/api/:token/jobs', guard, (_req, res) => {
    noStore(res); res.json({ jobs: jobs ? jobs.list().slice(-40) : [] });
  });
  app.post('/api/:token/jobs/:id/cancel', guard, (req, res) => {
    if (!jobs) return res.status(501).json({ error: 'jobs unavailable' });
    res.json({ ok: jobs.requestCancel(req.params.id) });
  });
  app.post('/api/:token/jobs/:id/guide', guard, (req, res) => {
    if (!jobs) return res.status(501).json({ error: 'jobs unavailable' });
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'unknown job' });
    const target = j.kind === 'task' && j.parent ? j.parent : j.id;   // steering rides on the project
    res.json({ ok: jobs.addGuidance(target, String((req.body || {}).text || '')) , target });
  });
  app.post('/api/:token/control', guard, async (req, res) => {
    try {
      if (!control) return res.status(501).json({ error: 'control unavailable' });
      const { tool, input } = req.body || {};
      res.json(await control(String(tool || ''), input || {}));
    } catch (e) { res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
  });
  app.get('/api/:token/screen', guard, async (_req, res) => {
    try {
      if (!screenshot) return res.status(501).json({ error: 'screenshot unavailable' });
      const r = await screenshot();
      noStore(res); res.json(r);
    } catch (e) { res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
  });

  // -------------------------------------------------------------------------
  // Twilio two-way voice — webhook-driven phone CONVERSATION in the JARVIS voice.
  // Twilio POSTs urlencoded; these routes return TwiML. Synthesized clips are
  // cached briefly and served via <Play> so the call uses BhatBot's own TTS.
  // -------------------------------------------------------------------------
  const form = express.urlencoded({ extended: false });
  const clips = new Map();   // id → { buf, mime, at }
  let clipSeq = 0;
  setInterval(() => { const now = Date.now(); for (const [k, v] of clips) if (now - v.at > 600000) clips.delete(k); }, 120000).unref?.();
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Synthesize `text` in the Jarvis voice → cache → return a <Play>…</Play> element.
  // Fail the voice leg explicitly rather than substituting a Twilio voice.
  // The same sentence is voiced once: a line prepared while the phone rang — or the canned "is now
  // a good time?" said on every call — is served from memory instead of round-tripping to TTS.
  const clipByText = new Map();   // text → clip id
  const voicing = new Map();      // text → in-flight synthesis (a line still being voiced when Twilio asks for it)
  function clipFor(t) {
    const hit = clipByText.get(t);
    if (hit && clips.has(hit)) { clips.get(hit).at = Date.now(); return Promise.resolve(hit); }
    if (voicing.has(t)) return voicing.get(t);
    const p = voiceClip(t).finally(() => voicing.delete(t));
    voicing.set(t, p);
    return p;
  }
  async function voiceClip(t) {
    if (!synthesize) return null;
    const r = await synthesize(t);
    if (!(r && r.audio)) return null;
    const id = (++clipSeq).toString(36) + Date.now().toString(36);
    clips.set(id, { buf: Buffer.from(r.audio, 'base64'), mime: r.mimeType || 'audio/mpeg', at: Date.now() });
    clipByText.set(t, id);
    if (clipByText.size > 300) clipByText.delete(clipByText.keys().next().value);
    return id;
  }
  _prewarm = async (texts) => {
    const list = [...new Set((texts || []).map((x) => String(x || '').trim()).filter(Boolean))];
    const out = await Promise.all(list.map((t) => clipFor(t).then((id) => !!id).catch(() => false)));
    return { ok: out.every(Boolean), voiced: out.filter(Boolean).length, of: list.length };
  };
  async function sayElement(req, text) {
    const t = String(text || '').trim();
    if (!t) return '';
    try {
      const id = await clipFor(t);
      if (id) {
        const ext = /wav/.test(clips.get(id).mime) ? 'wav' : 'mp3';
        return `<Play>https://${req.get('host')}/voice/${token}/clip/${id}.${ext}</Play>`;
      }
    } catch {}
    throw new Error('Selected ElevenLabs voice unavailable');
  }
  // Voice-recognition tuning (config-driven, sensible defaults). These directly improve how well
  // the call LISTENS: speech `hints` bias Twilio's recognizer toward BhatBot's own vocabulary
  // (names/projects/commands it would otherwise mis-hear); `enhanced` + telephony speechModel raise
  // accuracy on a phone line; profanityFilter off keeps transcripts verbatim (no ***-masking that
  // breaks intent). speechTimeout=auto = natural end-of-utterance detection; nested <Play> in the
  // <Gather> means the caller can BARGE IN over the reply (Twilio stops the prompt on speech).
  const V = voice || {};
  const DEFAULT_HINTS = 'Bhatbot, Jarvis, Nexus, Sledfall, ProtFunc, FABLE, PRISM, World Cup, molecule, protein, simulate, schedule, reminder, calendar, email, Notion, Spotify, Telegram, brief';
  const vHints = [DEFAULT_HINTS, V.hints].filter(Boolean).join(', ').slice(0, 2000);
  const vModel = V.speechModel || 'experimental_conversations';
  const vSpeechTimeout = V.speechTimeout || 'auto';
  const vTimeout = Number(V.timeout) || 8;          // seconds of initial silence before reprompt
  const vEnhanced = V.enhanced !== false;
  const vLang = V.language || 'en-US';
  function gatherTwiml(req, playEl, hangup) {
    if (hangup) return `<?xml version="1.0" encoding="UTF-8"?><Response>${playEl}<Hangup/></Response>`;
    const action = `https://${req.get('host')}/voice/${token}/gather`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Gather input="speech" action="${action}" method="POST"` +
      ` language="${vLang}" speechTimeout="${vSpeechTimeout}" speechModel="${xmlEsc(vModel)}"` +
      ` enhanced="${vEnhanced ? 'true' : 'false'}" profanityFilter="false" timeout="${vTimeout}"` +
      ` hints="${xmlEsc(vHints)}" actionOnEmptyResult="true">` +
      `${playEl}</Gather>` +
      // If the gather returns nothing (silence), loop back so it keeps listening.
      `<Redirect method="POST">${action}</Redirect></Response>`;
  }
  // Play something (filler or a mid-reply chunk) then immediately poll /await again — does NOT
  // listen, so the caller hears continuous speech while a complex turn computes/streams.
  function continueTwiml(req, playEl) {
    const awaitUrl = `https://${req.get('host')}/voice/${token}/await`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${playEl}<Redirect method="POST">${awaitUrl}</Redirect></Response>`;
  }

  app.get('/voice/:token/clip/:id', guard, (req, res) => {
    const c = clips.get(String(req.params.id).replace(/\.(mp3|wav)$/, ''));
    if (!c) return res.status(404).end();
    res.set('Content-Type', c.mime).set('Cache-Control', 'no-store').send(c.buf);
  });

  // First leg: greet (msg from query) then listen. With AMD enabled on the outbound call,
  // AnsweredBy tells us WHO answered: a machine_end_* value means we're at the voicemail
  // BEEP → leave the message in the JARVIS voice and hang up (no gather — nobody's there).
  app.post('/voice/:token/incoming', guard, form, async (req, res) => {
    try {
      if (!twilioVerified(req)) return res.status(403).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
      const from = req.body.From || '';
      // A call BhatBot placed to someone else has its own door (see _guests) — checked before the
      // owner gate, and never falling through to it.
      if (req.query.guest) return guestOpen(req, res);
      if (!ownerOk(req)) { console.warn(`[voice] refused ${String(req.body.Direction || '?')} call — ${ownerParty(req)} is not the owner`); return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'); }
      const callSid = req.body.CallSid || '';
      const answeredBy = String(req.body.AnsweredBy || '');
      const reason = String(req.query.msg || '').trim();
      // Written before the call was placed (main.js voiced these same strings while it rang).
      const lines = callscript.ownerLines(reason);
      if (/^(machine|fax)/.test(answeredBy)) {
        const play = await sayElement(req, lines.voicemail);
        if (endVoiceCall) endVoiceCall(callSid);
        return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${play}<Hangup/></Response>`);
      }
      // Real-time path (opt-in): hand the whole call to a Media Streams WebSocket — the greeting,
      // listening, thinking and speaking all happen over the socket (sub-second turn-taking).
      if (V.mediaStreams && synthUlaw && voiceBegin) {
        const host = req.get('host');
        return res.type('text/xml').send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Connect>` +
          `<Stream url="wss://${host}/voice/${token}/stream">` +
          `<Parameter name="callSid" value="${xmlEsc(callSid)}"/>` +
          `</Stream></Connect></Response>`);
      }
      // ── THE OPENER MUST BE INSTANT ─────────────────────────────────────────────────────────────
      // Twilio abandons a webhook after ~15 SECONDS and plays "An application error has occurred".
      // This used to run a full agent turn here — voiceTurn(), an LLM round-trip — and then wait on
      // TTS synthesis on top. On anything but a trivial turn that blows through the limit, which is
      // why three rounds of "the call connected and then errored": the call was fine, we were late.
      //
      // So the first thing said on the line is CANNED. No model, no agent, nothing that can be slow.
      // It is also better manners, and it is what Siddhant asked for: do not open by silently
      // waiting for him to talk, and do not launch into the reason before knowing he can listen.
      // Ask whether now is a good time, then say why on the next turn once he has answered.
      //
      // The reason is stashed against the callSid rather than spoken, so the agent picks it up when
      // the conversation actually starts.
      if (reason && voiceBegin) { try { pendingReason.set(callSid, lines); } catch {} }
      const play = await sayElement(req, lines.opener);
      res.type('text/xml').send(gatherTwiml(req, play, false));
    } catch (e) {
      console.warn('[voice] selected voice failed:', e.message);
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }
  });

  // Subsequent legs: user spoke → agent turn → speak reply → listen again.
  app.post('/voice/:token/gather', guard, form, async (req, res) => {
    try {
      if (!twilioVerified(req)) return res.status(403).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
      const from = req.body.From || '';
      if (!ownerOk(req)) { console.warn(`[voice] refused ${String(req.body.Direction || '?')} call — ${ownerParty(req)} is not the owner`); return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'); }
      const callSid = req.body.CallSid || '';
      const speech = req.body.SpeechResult || '';
      if (!speech.trim()) {
        // Silence/timeout — gentle reprompt, keep the line open.
        const play = await sayElement(req, 'I am still here, sir. Go on.');
        return res.type('text/xml').send(gatherTwiml(req, play, false));
      }
      // ── HE HAS ANSWERED "IS NOW A GOOD TIME?" ──────────────────────────────────────────────────
      // The opener asked; this is the reply. If he said yes, say WHY we rang — the reason stashed
      // when the call was placed — and hand him the floor. If he said no, apologise and get off the
      // phone rather than pressing on, because the whole point of asking was to respect the answer.
      //
      // Both branches are canned and therefore instant, which matters as much as the manners: this
      // is still inside Twilio's ~15s webhook budget, and a model call here would risk the same
      // "application error" the opener used to cause.
      if (pendingReason.has(callSid)) {
        const lines = pendingReason.get(callSid);
        pendingReason.delete(callSid);
        if (callscript.saidNotNow(speech)) {
          const bye = await sayElement(req, lines.later);
          if (endVoiceCall) endVoiceCall(callSid);
          return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${bye}<Hangup/></Response>`);
        }
        // Anything else is taken as "go ahead" — an ambiguous answer should not cost him the call.
        const play = await sayElement(req, lines.reason);
        return res.type('text/xml').send(gatherTwiml(req, play, false));
      }

      // Two-tier path: simple turns answer immediately; complex turns return 'thinking' →
      // play a "let me think" filler and poll /await while the reply streams in the background.
      if (voiceBegin) {
        const b = await voiceBegin(callSid, speech);
        if (b.mode === 'thinking') {
          const play = await sayElement(req, b.filler);
          return res.type('text/xml').send(continueTwiml(req, play));
        }
        const play = await sayElement(req, b.text);
        if (b.hangup && endVoiceCall) endVoiceCall(callSid);
        return res.type('text/xml').send(gatherTwiml(req, play, b.hangup));
      }
      const r = voiceTurn ? await voiceTurn(callSid, speech) : { text: 'Voice agent unavailable.' , hangup: true };
      const play = await sayElement(req, r.text);
      if (r.hangup && endVoiceCall) endVoiceCall(callSid);
      res.type('text/xml').send(gatherTwiml(req, play, r.hangup));
    } catch (e) {
      console.warn('[voice] selected voice failed:', e.message);
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }
  });

  // Poll leg for a complex/streaming turn: speak the next ready chunk (and keep polling if more is
  // coming), or play a short filler while the agent is still working, or re-open the mic when done.
  app.post('/voice/:token/await', guard, form, async (req, res) => {
    try {
      if (!twilioVerified(req)) return res.status(403).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
      const callSid = req.body.CallSid || '';
      const p = voicePoll ? voicePoll(callSid) : { ready: true, text: '', more: false };
      if (!p.ready) {
        const play = await sayElement(req, p.filler);
        return res.type('text/xml').send(continueTwiml(req, play));
      }
      if (p.text && p.more) {
        const play = await sayElement(req, p.text);   // a chunk, more coming → keep speaking
        return res.type('text/xml').send(continueTwiml(req, play));
      }
      // final chunk (or nothing left) → speak it if present, then listen again
      const play = p.text ? await sayElement(req, p.text) : '';
      res.type('text/xml').send(gatherTwiml(req, play, false));
    } catch (e) {
      console.warn('[voice] selected voice failed:', e.message);
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }
  });

  // ── GUEST CALLS (someone other than Siddhant, dialled by BhatBot) ─────────────────────────────────
  const guestFor = (req) => {
    const g = _guests.get(String(req.query.guest || req.query.g || ''));
    if (!g) return null;
    // The number Twilio dialled must be the one registered — an id alone does not admit a call.
    if (!/^outbound/i.test(String(req.body.Direction || '')) || !samePhone(req.body.To, g.to)) return null;
    return g;
  };
  const guestGather = (req, playEl, id) => {
    const action = `https://${req.get('host')}/voice/${token}/guest?g=${encodeURIComponent(id)}`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Gather input="speech" action="${action}" method="POST" language="${vLang}" speechTimeout="auto"` +
      ` speechModel="${xmlEsc(vModel)}" enhanced="${vEnhanced ? 'true' : 'false'}" profanityFilter="false" timeout="${vTimeout}" actionOnEmptyResult="true">` +
      `${playEl}</Gather><Redirect method="POST">${action}</Redirect></Response>`;
  };
  async function guestOpen(req, res) {
    const id = String(req.query.guest);
    // The preflight knocks with guest=preflight: answer with the same SHAPE a real guest call gets.
    if (id === 'preflight') {
      const play = await sayElement(req, callscript.guestLines({}).opener);
      return res.type('text/xml').send(guestGather(req, play, 'preflight'));
    }
    const g = guestFor(req);
    if (!g) { console.warn('[voice] refused guest call — no matching registration'); return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'); }
    g.callSid = req.body.CallSid || g.callSid;
    g.stage = 'asked';
    g.history.push({ role: 'assistant', content: g.lines.opener });
    const play = await sayElement(req, g.lines.opener);
    res.type('text/xml').send(guestGather(req, play, id));
  }
  app.post('/voice/:token/guest', guard, form, async (req, res) => {
    try {
      if (!twilioVerified(req)) return res.status(403).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
      const id = String(req.query.g || '');
      if (id === 'preflight') return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      const g = guestFor(req);
      if (!g) return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      const speech = String(req.body.SpeechResult || '').trim();
      if (!speech) {
        g.silences = (g.silences || 0) + 1;
        if (g.silences >= 3) return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${await sayElement(req, g.lines.voicemail)}<Hangup/></Response>`);
        return res.type('text/xml').send(guestGather(req, await sayElement(req, 'Sorry, I didn’t catch that.'), id));
      }
      g.history.push({ role: 'user', content: speech });
      // Their answer to "do you have a moment?" — the reason was voiced while the phone rang.
      if (g.stage === 'asked') {
        g.stage = 'talking';
        if (callscript.saidNotNow(speech)) {
          g.history.push({ role: 'assistant', content: g.lines.later });
          return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${await sayElement(req, g.lines.later)}<Hangup/></Response>`);
        }
        g.history.push({ role: 'assistant', content: g.lines.purposeLine });
        return res.type('text/xml').send(guestGather(req, await sayElement(req, g.lines.purposeLine), id));
      }
      const r = guestTurn ? await guestTurn(g, speech).catch(() => null) : null;
      const text = (r && r.text) || 'I’ll pass that along to him. Thank you — goodbye.';
      const end = !r || r.hangup;
      g.history.push({ role: 'assistant', content: text });
      const play = await sayElement(req, text);
      return res.type('text/xml').send(end ? `<?xml version="1.0" encoding="UTF-8"?><Response>${play}<Hangup/></Response>` : guestGather(req, play, id));
    } catch (e) {
      console.warn('[voice] guest turn failed:', e.message);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }
  });

  // ── ASYNC ANSWERING-MACHINE DETECTION ───────────────────────────────────────────────────────────
  // The call now asks for its first words the moment it is answered, instead of waiting seconds for
  // Twilio to decide whether a person picked up. The verdict lands here; if it was a voicemail, the
  // live call is redirected to leave the prepared message at the beep.
  app.post('/voice/:token/amd', guard, form, async (req, res) => {
    if (!twilioVerified(req)) return res.status(403).end();
    res.status(204).end();
    const sid = String(req.body.CallSid || ''), by = String(req.body.AnsweredBy || '');
    if (!sid) return;
    _amd.set(sid, by);
    if (_amd.size > 200) _amd.delete(_amd.keys().next().value);
    if (!/^machine_end|^fax/.test(by) || !updateCall) return;
    try {
      const guest = [..._guests.values()].find((g) => g.callSid === sid);
      const lines = guest ? guest.lines : (pendingReason.get(sid) || callscript.ownerLines(''));
      pendingReason.delete(sid);
      if (/^fax/.test(by)) return await updateCall(sid, '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      const play = await sayElement(req, lines.voicemail);
      await updateCall(sid, `<?xml version="1.0" encoding="UTF-8"?><Response>${play}<Hangup/></Response>`);
    } catch (e) { console.warn('[voice] voicemail redirect failed:', e.message); }
  });

  app.post('/voice/:token/status', guard, form, (req, res) => {
    // A call that never reached its second turn still has a reason held for it. Twilio tells us when
    // the call is over; that is the moment to let go of it.
    try { const sid = req.body.CallSid; if (sid) pendingReason.delete(sid); } catch {}
    if (!twilioVerified(req)) return res.status(403).end();
    try { if (endVoiceCall && (req.body.CallStatus === 'completed' || req.body.CallStatus === 'failed')) endVoiceCall(req.body.CallSid); } catch {}
    try {
      for (const [k, g] of _guests) if (g.callSid && g.callSid === req.body.CallSid) {
        _guests.delete(k);
        if (onGuestEnd) Promise.resolve(onGuestEnd(g, { status: req.body.CallStatus, answeredBy: req.body.AnsweredBy || amdResult(g.callSid) || '' })).catch(() => {});
      }
    } catch {}
    res.status(204).end();
  });

  // -------------------------------------------------------------------------
  // Inbound SMS — you text the BhatBot number, it runs the agent and texts back the
  // reply (TwiML <Message>). Closes the two-way loop so you can answer a notify_user
  // prompt ("retry the deploy?" → "yes") and unblock a task. Owner number gated.
  // (Twilio TRIAL note: receiving works once SMS is enabled on the number; sending the
  //  reply on an unregistered US 10DLC number may be filtered — upgrade + register A2P.)
  // -------------------------------------------------------------------------
  app.post('/sms/:token/incoming', guard, form, async (req, res) => {
    const reply = (xml) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`);
    try {
      if (!twilioVerified(req)) return res.status(403).end();
      const text = String(req.body.Body || '').trim();
      const from = req.body.From || '';
      if (!ownerOk(req)) return reply(`<Message>Unauthorized.</Message>`);
      if (!text) return res.status(204).end();
      const r = runAgent ? await runAgent('[SMS] ' + text, {}) : { text: 'Agent unavailable.' };
      const out = (r.error ? ('Error: ' + r.error) : (r.text || '(no output)')).replace(/<\/?speak>/gi, '').trim().slice(0, 1500);
      reply(`<Message>${xmlEsc(out)}</Message>`);
    } catch (e) { reply(`<Message>Error: ${xmlEsc(String(e && e.message || e)).slice(0, 300)}</Message>`); }
  });

  _shuttingDown = false;   // a fresh start re-arms the vanished-listener warning
  // A LISTEN THAT FAILS MUST NOT HANG. `app.listen(port, host, cb)` calls cb only on SUCCESS; an
  // EADDRINUSE arrives as an 'error' EVENT, so the old one-armed promise never settled and boot
  // simply stopped there — no error, no log, no server, and an app that looks like it started.
  httpServer = await new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
    srv.once('error', reject);
  });

  // ...AND A LISTENER THAT GOES AWAY MUST SAY SO. Observed 2026-09-22: the process was alive and
  // healthy, `[mcp] listening` had been printed, and nothing was bound to the port — every tool call
  // failed with "app not reachable" while the app itself looked fine. Whatever closed it, the
  // silence was the real problem: a server that stops serving should be as loud as one that never
  // started. This re-binds and logs rather than leaving the next person to discover it with lsof.
  httpServer.on('close', () => {
    if (_shuttingDown) return;                       // an intentional stop is not an incident
    console.error('[mcp] the HTTP server CLOSED without being asked to — rebinding on ' + port);
    setTimeout(() => {
      try {
        httpServer = app.listen(port, '127.0.0.1', () => console.log('[mcp] rebound on ' + port));
        httpServer.once('error', (e) => console.error('[mcp] rebind failed: ' + ((e && e.message) || e)));
      } catch (e) { console.error('[mcp] rebind threw: ' + ((e && e.message) || e)); }
    }, 1000).unref?.();
  });

  // -------------------------------------------------------------------------
  // Twilio Media Streams WebSocket (opt-in real-time voice). Twilio connects to
  // wss://<host>/voice/<token>/stream after the <Connect><Stream> TwiML above.
  // Token-gated on the upgrade path; one voicestream session per connection.
  // -------------------------------------------------------------------------
  if (voice && voice.mediaStreams && synthUlaw && voiceBegin) {
    try {
      const { WebSocketServer } = require('ws');
      const voicestream = require('./lib/voicestream')({
        transcribe, synthUlaw, voiceBegin, voicePoll,
        onEnd: endVoiceCall, log: (...a) => console.log(...a),
      });
      const wss = new WebSocketServer({ noServer: true });
      const streamPath = `/voice/${token}/stream`;
      httpServer.on('upgrade', (req, socket, head) => {
        let pathname; try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = req.url; }
        if (pathname !== streamPath) { socket.destroy(); return; }   // token in path gates access
        wss.handleUpgrade(req, socket, head, (ws) => voicestream.handle(ws, {}));
      });
      console.log('[voice] Media Streams enabled → wss://<host>' + streamPath);
    } catch (e) { console.error('[voice] Media Streams init failed:', e.message); }
  }

  return httpServer;
}

function stopMcpServer() { _shuttingDown = true; try { httpServer && httpServer.close(); } catch {} httpServer = null; }

module.exports = { startMcpServer, stopMcpServer, registerGuestCall, prewarmSpeech, amdResult };
