'use strict';
// Bhatbot MCP server — exposes Bhatbot's agent to the Claude app (and any MCP
// client) as a remote connector over Streamable HTTP. Bound to localhost;
// publish to the internet with `tailscale funnel <port>` so the Claude mobile
// app (which connects from Anthropic's side) can reach it. A secret token in
// the URL path gates access: https://<machine>.<tailnet>.ts.net/mcp/<token>

let httpServer = null;

async function startMcpServer({ port, token, runAgent, transcribe, synthesize, summarize, media }) {
  if (httpServer) return httpServer;
  const express = require('express');
  const fs = require('fs');
  const path = require('path');
  const { z } = require('zod');
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

  const guard = (req, res, next) => {
    if (req.params.token !== token) return res.status(401).json({ error: 'unauthorized' });
    next();
  };

  // Stateless Streamable HTTP: one transport per request.
  app.post('/mcp/:token', guard, async (req, res) => {
    try {
      const server = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { try { transport.close(); server.close(); } catch {} });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: String(e && e.message ? e.message : e) });
    }
  });
  app.get('/mcp/:token', guard, (_req, res) => res.status(405).json({ error: 'method not allowed (stateless)' }));
  app.get('/health', (_req, res) => res.json({ ok: true, name: 'bhatbot-mcp' }));

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

  app.get('/app/:token/sw.js', guard, (_req, res) => {
    res.type('application/javascript').send(
      "self.addEventListener('install',e=>self.skipWaiting());" +
      "self.addEventListener('activate',e=>self.clients.claim());" +
      "self.addEventListener('fetch',()=>{});"
    );
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

  await new Promise((resolve) => { httpServer = app.listen(port, '127.0.0.1', resolve); });
  return httpServer;
}

function stopMcpServer() { try { httpServer && httpServer.close(); } catch {} httpServer = null; }

module.exports = { startMcpServer, stopMcpServer };
