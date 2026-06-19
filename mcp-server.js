'use strict';
// Bhatbot MCP server — exposes Bhatbot's agent to the Claude app (and any MCP
// client) as a remote connector over Streamable HTTP. Bound to localhost;
// publish to the internet with `tailscale funnel <port>` so the Claude mobile
// app (which connects from Anthropic's side) can reach it. A secret token in
// the URL path gates access: https://<machine>.<tailnet>.ts.net/mcp/<token>

let httpServer = null;

async function startMcpServer({ port, token, runAgent, transcribe, synthesize, summarize, media, voiceTurn, endVoiceCall, getActivity, nexusUrl, ownerPhone, twilioAuthToken, jobs, control, screenshot }) {
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
  const twilioVerified = (req) => {
    if (!twilioAuthToken) return true;                 // can't verify → don't hard-block (Serve-only setups)
    try {
      const sig = req.get('x-twilio-signature') || '';
      const url = `https://${req.get('host')}${req.originalUrl}`;
      const params = req.body || {};
      let data = url;
      for (const k of Object.keys(params).sort()) data += k + params[k];
      const expected = crypto.createHmac('sha1', twilioAuthToken).update(Buffer.from(data, 'utf-8')).digest('base64');
      const a = Buffer.from(sig), b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
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
      const r = await runAgent(String(text || ''), { reset: !!new_conversation, blocks: hasBlocks ? blocks : [] });
      res.json(r.error ? { error: r.error } : { text: r.text });
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
  // Falls back to Twilio <Say> if synthesis is unavailable so the call never goes silent.
  async function sayElement(req, text) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (synthesize) {
      try {
        const r = await synthesize(t);
        if (r && r.audio) {
          const id = (++clipSeq).toString(36) + Date.now().toString(36);
          const mime = r.mimeType || 'audio/mpeg';
          clips.set(id, { buf: Buffer.from(r.audio, 'base64'), mime, at: Date.now() });
          const ext = /wav/.test(mime) ? 'wav' : 'mp3';
          return `<Play>https://${req.get('host')}/voice/${token}/clip/${id}.${ext}</Play>`;
        }
      } catch {}
    }
    return `<Say voice="Google.en-US-Neural2-D">${xmlEsc(t)}</Say>`;
  }
  function gatherTwiml(req, playEl, hangup) {
    if (hangup) return `<?xml version="1.0" encoding="UTF-8"?><Response>${playEl}<Hangup/></Response>`;
    const action = `https://${req.get('host')}/voice/${token}/gather`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Gather input="speech" action="${action}" method="POST" speechTimeout="auto" speechModel="experimental_conversations" actionOnEmptyResult="true">` +
      `${playEl}</Gather>` +
      // If the gather returns nothing (silence), loop back so it keeps listening.
      `<Redirect method="POST">${action}</Redirect></Response>`;
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
      if (ownerPhone && from && from !== ownerPhone) return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unauthorized.</Say><Hangup/></Response>');
      const callSid = req.body.CallSid || '';
      const answeredBy = String(req.body.AnsweredBy || '');
      const greeting = req.query.msg || 'Good evening, sir. How may I help?';
      if (/^(machine|fax)/.test(answeredBy)) {
        const vm = `Good evening, sir. BhatBot here — you missed my call. ${greeting} The details are also in writing on your phone. That is all. Goodbye.`;
        const play = await sayElement(req, vm);
        if (endVoiceCall) endVoiceCall(callSid);
        return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${play}<Hangup/></Response>`);
      }
      const r = voiceTurn ? await voiceTurn(callSid, '', greeting) : { text: greeting };
      const play = await sayElement(req, r.text);
      res.type('text/xml').send(gatherTwiml(req, play, r.hangup));
    } catch (e) {
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>System error.</Say><Hangup/></Response>`);
    }
  });

  // Subsequent legs: user spoke → agent turn → speak reply → listen again.
  app.post('/voice/:token/gather', guard, form, async (req, res) => {
    try {
      if (!twilioVerified(req)) return res.status(403).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
      const from = req.body.From || '';
      if (ownerPhone && from && from !== ownerPhone) return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unauthorized.</Say><Hangup/></Response>');
      const callSid = req.body.CallSid || '';
      const speech = req.body.SpeechResult || '';
      if (!speech.trim()) {
        // Silence/timeout — gentle reprompt, keep the line open.
        const play = await sayElement(req, 'I am still here, sir. Go on.');
        return res.type('text/xml').send(gatherTwiml(req, play, false));
      }
      const r = voiceTurn ? await voiceTurn(callSid, speech) : { text: 'Voice agent unavailable.' , hangup: true };
      const play = await sayElement(req, r.text);
      if (r.hangup && endVoiceCall) endVoiceCall(callSid);
      res.type('text/xml').send(gatherTwiml(req, play, r.hangup));
    } catch (e) {
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>System error.</Say><Hangup/></Response>`);
    }
  });

  app.post('/voice/:token/status', guard, form, (req, res) => {
    if (!twilioVerified(req)) return res.status(403).end();
    try { if (endVoiceCall && (req.body.CallStatus === 'completed' || req.body.CallStatus === 'failed')) endVoiceCall(req.body.CallSid); } catch {}
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
      if (ownerPhone && from && from !== ownerPhone) return reply(`<Message>Unauthorized.</Message>`);
      if (!text) return res.status(204).end();
      const r = runAgent ? await runAgent('[SMS] ' + text, {}) : { text: 'Agent unavailable.' };
      const out = (r.error ? ('Error: ' + r.error) : (r.text || '(no output)')).replace(/<\/?speak>/gi, '').trim().slice(0, 1500);
      reply(`<Message>${xmlEsc(out)}</Message>`);
    } catch (e) { reply(`<Message>Error: ${xmlEsc(String(e && e.message || e)).slice(0, 300)}</Message>`); }
  });

  await new Promise((resolve) => { httpServer = app.listen(port, '127.0.0.1', resolve); });
  return httpServer;
}

function stopMcpServer() { try { httpServer && httpServer.close(); } catch {} httpServer = null; }

module.exports = { startMcpServer, stopMcpServer };
