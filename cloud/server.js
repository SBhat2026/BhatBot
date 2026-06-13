'use strict';
// ===========================================================================
// BhatBot CLOUD backend (Phase 2) — an always-on service so the phone works even
// when the Mac is ASLEEP and without Tailscale. It speaks the EXACT same
// /api/:token/{chat,tts,stt} contract the phone UI already uses, so going live is
// just: deploy this, then point the app (Settings → Server host) at its URL.
//
// What it does on its own (no Mac): chat (Anthropic), voice out (ElevenLabs Jarvis),
// voice in (Whisper). What still needs the Mac: desktop tools (files/shell/apps) — those
// are RELAYED to the Mac when it's reachable (MAC_RELAY_URL), else it says the Mac's asleep.
//
// Runs anywhere Node runs: `node server.js` locally, or Fly.io / Railway / a VPS for
// always-on. Config via env (.env.example). No dependency on the desktop main.js.
// ===========================================================================
const express = require('express');
const notion = require('./notion');   // shared Notion memory bank (no-ops if NOTION_TOKEN unset)

const PORT = process.env.PORT || 8790;
const TOKEN = process.env.BHATBOT_TOKEN || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || 'EzDG2x1uAnCqbzN9Q0wA'; // BhatBot Jarvis
const EL_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const TTS_SPEED = Math.max(0.7, Math.min(1.2, parseFloat(process.env.TTS_SPEED) || 1.08));
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const MAC_RELAY_URL = (process.env.MAC_RELAY_URL || '').replace(/\/+$/, ''); // e.g. https://...trycloudflare.com
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const MAX_HISTORY = 30;

const SYSTEM = `You are BhatBot — Siddhant's personal AI assistant, reachable from his phone while
he's away from his Mac. Speak like a calm, dry-witted British butler (think JARVIS): brief,
direct, no filler. You are running on the CLOUD right now, so you can chat, reason, and answer
anything from knowledge, but you CANNOT touch his Mac (files, apps, shell) unless it's awake —
if he asks for something that needs the desktop and it's unreachable, say so plainly and offer
to do it the moment the Mac is back. Keep spoken-style replies short and natural; no markdown.`;

// ---- speech normalization (mirror of the desktop normalizeForSpeech, audio only) ----
function normalizeForSpeech(input) {
  let s = String(input || '');
  s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*([-*•]|\d+\.)\s+/gm, '');
  s = s.replace(/(^|\s)((?:~|\.\.?)?\/(?:[\w.@%+-]+\/)+[\w.@%+-]*)/g, (_m, pre, p) => pre + (p.replace(/\/+$/, '').split('/').pop() || ''));
  s = s.replace(/\be\.g\.,?/gi, 'for example,').replace(/\bi\.e\.,?/gi, 'that is,').replace(/\betc\.?/gi, 'etcetera').replace(/\bvs\.?/gi, 'versus');
  s = s.replace(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g, (_m, d, c) => { d = d.replace(/,/g, ''); return d + (d === '1' ? ' dollar' : ' dollars') + (c ? ' and ' + c + ' cents' : ''); });
  s = s.replace(/([A-Za-z])\.([A-Za-z0-9])/g, '$1 dot $2');
  s = s.replace(/&/g, ' and ').replace(/%/g, ' percent').replace(/(\S)@(\S)/g, '$1 at $2').replace(/\s@\s/g, ' at ')
       .replace(/#(\d+)/g, 'number $1').replace(/#/g, ' hash ').replace(/\s\+\s/g, ' plus ')
       .replace(/([A-Za-z])\/([A-Za-z])/g, '$1 slash $2').replace(/°/g, ' degrees').replace(/\$(?=[A-Za-z])/g, '').replace(/[~^|<>*$]/g, ' ');
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
  return s || String(input || '').trim();
}

// ---- Anthropic (no SDK; plain fetch with backoff) ----
async function claude(messages, { retries = 3, system = SYSTEM } = {}) {
  let attempt = 0;
  while (true) {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages })
      });
    } catch (e) { if (attempt++ >= retries) throw e; await sleep(800 * attempt); continue; }
    if (r.status === 429 || r.status === 529 || r.status >= 500) {
      if (attempt++ >= retries) throw new Error('anthropic ' + r.status);
      await sleep(Math.min(1000 * 2 ** attempt, 8000)); continue;
    }
    if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }
}
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ---- ElevenLabs TTS (Jarvis voice) ----
async function tts(text) {
  const t = normalizeForSpeech(text);
  if (!t) return { error: 'empty' };
  if (!EL_KEY) return { error: 'no ELEVENLABS_API_KEY' };
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}?output_format=mp3_44100_128&optimize_streaming_latency=3`, {
    method: 'POST', headers: { 'xi-api-key': EL_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: t, model_id: EL_MODEL, voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.2, use_speaker_boost: false, speed: TTS_SPEED } })
  });
  if (!r.ok) return { error: 'elevenlabs ' + r.status + ': ' + (await r.text()).slice(0, 160) };
  const buf = Buffer.from(await r.arrayBuffer());
  return { audio: buf.toString('base64'), mimeType: 'audio/mpeg', via: 'elevenlabs' };
}

// ---- OpenAI Whisper STT ----
async function stt(buf, mime) {
  if (!OPENAI_KEY) return { error: 'no OPENAI_API_KEY' };
  const ext = /wav/.test(mime) ? 'wav' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /mpeg|mp3/.test(mime) ? 'mp3' : 'webm';
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.' + ext);
  fd.append('model', 'gpt-4o-mini-transcribe');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + OPENAI_KEY }, body: fd });
  if (!r.ok) return { error: 'whisper ' + r.status + ': ' + (await r.text()).slice(0, 160) };
  const j = await r.json();
  return { text: (j.text || '').trim() };
}

// ---- Relay desktop-only requests to the Mac when it's reachable ----
async function relayToMac(pathSuffix, init) {
  if (!MAC_RELAY_URL) return { error: 'Mac relay not configured (no MAC_RELAY_URL).', asleep: true };
  try {
    const r = await fetch(`${MAC_RELAY_URL}/api/${TOKEN}${pathSuffix}`, { ...init, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { error: 'Mac relay ' + r.status, asleep: r.status >= 500 };
    return await r.json();
  } catch (e) { return { error: 'Mac unreachable (asleep?): ' + e.message, asleep: true }; }
}

// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '16mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const guard = (req, res, next) => (req.params.token === TOKEN && TOKEN) ? next() : res.status(401).json({ error: 'unauthorized' });

app.get('/health', (_q, s) => s.json({ ok: true, name: 'bhatbot-cloud', mac: MAC_RELAY_URL ? 'relay-configured' : 'standalone', memory: notion.configured() ? 'notion' : 'in-process' }));

// Rolling conversation per token. In-memory survives between turns within a run; the DURABLE
// layer is Notion (recall + persisted facts), shared with the Mac and other agents — so memory
// outlives restarts and is the same bank everywhere.
const histories = new Map();

// Explicit-memory cue: when Siddhant says "remember …" / "note that …" / "my X is Y", persist
// the fact to the shared Notion bank so every agent (Mac, cloud, future) sees it.
const REMEMBER_RE = /\b(remember(?:\s+that)?|note\s+that|don'?t\s+forget|keep\s+in\s+mind|for\s+the\s+record)\b[:,]?\s*(.+)/i;
function extractFact(text) {
  const m = text.match(REMEMBER_RE);
  if (m && m[2] && m[2].trim().length > 3) return m[2].trim().replace(/[.\s]+$/, '');
  if (/\bmy\s+\w+\s+(is|are|=)\s+\S/i.test(text) && text.length < 200) return text.trim();
  return null;
}

app.post('/api/:token/chat', guard, async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.json({ error: 'empty' });
    if (req.body.new_conversation) histories.delete(TOKEN);
    const hist = histories.get(TOKEN) || [];

    // 1) RECALL relevant durable facts from the shared bank and fold them into the system.
    let sys = SYSTEM;
    let recalled = [];
    try { recalled = await notion.recallSmart(text, 5); } catch {}
    if (recalled.length) sys += '\n\nRELEVANT MEMORY (from Siddhant\'s shared knowledge bank — use silently, do not enumerate):\n' + recalled.map((f) => '- ' + f).join('\n');

    hist.push({ role: 'user', content: text });
    const reply = await claude(hist.slice(-MAX_HISTORY), { system: sys });
    hist.push({ role: 'assistant', content: reply });
    histories.set(TOKEN, hist.slice(-MAX_HISTORY));

    // 2) PERSIST: explicit "remember …" facts as durable memory; every turn as a light daily log.
    const fact = extractFact(text);
    if (fact) notion.appendMemory(fact, { tags: ['phone'], source: 'user', confidence: 0.9 }).catch(() => {});
    notion.logActivity(text.slice(0, 200) + (reply ? ' → ' + reply.slice(0, 120) : '')).catch(() => {});

    res.json({ text: reply, _provider: 'cloud:anthropic', _memory: notion.configured() ? { recalled: recalled.length, saved: !!fact } : undefined });
  } catch (e) { res.json({ error: String(e && e.message || e) }); }
});

app.post('/api/:token/tts', guard, async (req, res) => {
  const r = await tts((req.body && req.body.text) || '');
  res.json(r.error ? { error: r.error } : r);
});

app.post('/api/:token/stt', guard, express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const r = await stt(req.body, req.query.mime || 'audio/webm');
  res.json(r.error ? { error: r.error } : r);
});

// Desktop-only endpoints → relay to the Mac (or report it's asleep).
for (const ep of ['/control', '/screen', '/jobs']) {
  app.all('/api/:token' + ep, guard, async (req, res) => {
    const r = await relayToMac(ep + (req.url.split(ep)[1] || ''), {
      method: req.method, headers: { 'content-type': 'application/json' },
      body: req.method === 'POST' ? JSON.stringify(req.body || {}) : undefined
    });
    res.json(r);
  });
}
// Config endpoint the UI pings on load.
app.get('/api/:token/config', guard, (_q, s) => s.json({ nexusUrl: process.env.NEXUS_URL || '' }));
app.get('/api/:token/activity', guard, (_q, s) => s.json({ seq: 0, events: [] }));

app.listen(PORT, () => {
  console.log(`[bhatbot-cloud] listening on :${PORT} — ${MAC_RELAY_URL ? 'relay→' + MAC_RELAY_URL : 'standalone (no Mac relay)'}`);
  if (!TOKEN) console.warn('[bhatbot-cloud] ⚠ BHATBOT_TOKEN not set — all requests will 401');
  if (!ANTHROPIC_KEY) console.warn('[bhatbot-cloud] ⚠ ANTHROPIC_API_KEY not set — chat will fail');
});
