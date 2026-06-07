'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, shell, dialog, screen } = require('electron');
// Electron/Chromium blocks audio autoplay after async calls → desktop TTS was silent.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const darkbloom = require('./darkbloom');
const { classify } = require('./taskClassifier');
const { startMcpServer, stopMcpServer } = require('./mcp-server');

const DB_MODELS = { db_speech: 'gpt-oss-20b', db_directive: 'gemma-4-26b' };

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const MEMORY_PATH = path.join(os.homedir(), '.bhatbot', 'memory.md');
const AUDIT_PATH = path.join(os.homedir(), '.bhatbot', 'audit.log');

const HOTKEY = 'CommandOrControl+Shift+B';
const MODEL_SONNET = 'claude-sonnet-4-6';      // corrected from stale spec id
const MODEL_HAIKU = 'claude-haiku-4-5';        // corrected from stale spec id
const MAX_AGENT_ITERATIONS = 12;
const EXEC_PATH = `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin`;
const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_VISION_MODEL = 'gemma3:12b'; // local, free, offline second-opinion vision
const KEEP_IMAGES = 2;                     // max screenshots retained in history

let mainWindow = null;
let activityWindow = null;
let agentState = 'idle'; // 'running' | 'paused' | 'stopped'
let browser = null;
let page = null;
const pendingConfirms = new Map();
let pendingGuidance = [];   // live feedback queued mid-task (steering)
let nexusWindow = null, studioWindow = null, terminalWindow = null;
let studioWatcher = null, ptyProc = null, wakeProc = null;

const STUDIO_DIR = path.join(os.homedir(), '.bhatbot', 'studio');
const STUDIO_INDEX = path.join(STUDIO_DIR, 'index.html');
const NEXUS_URL = 'https://nexusresearch.xyz';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Config / memory
// ---------------------------------------------------------------------------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}
function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || loadConfig().apiKey || '';
}

const today = () => new Date().toISOString().slice(0, 10);

const INITIAL_MEMORY = `# Bhatbot Memory
_Auto-maintained. Last updated: ${today()}_

## Personal
- Name: Siddhant Bhat
- Status: Incoming Princeton student, fall 2026, age 18
- Machine: Mac (Apple Silicon)

## Active Projects
- Nexus Research (nexusresearch.xyz): Next.js/Vercel, Supabase
  (ulccvepwbgqvcglaugju), Jina AI, Groq (Llama 3.3 70B), OpenAlex, D3.
  Freemium auth in progress. Google OAuth credentials obtained.
- PRISM (prism-assembly.prismlab.workers.dev): GATv2Conv GNN ~167K params,
  τ=0.986. Paper targeting PLOS Comp Bio / Bioinformatics / eLife.
- FABLE (protfunc.prismlab.workers.dev): GO term prediction, ESM-2 8M.
  Critical bug: zero saliency, detach() fix not redeployed.
- Skipper: Unity 6 sled game, personal project. Core loop works.
  Known issues: E key dismount, upslope physics, dismount animation.
- Revenue: no-code comp chem parser (LAMMPS/Gaussian/CP2K). Regex-based.

## Preferences & Patterns
- Claude Code prompts: always "ask clarifying questions before making any
  changes" at top. Write complete and ordered.
- Max 2 serious concurrent projects.
- Delegates implementation to Claude Code; uses Bhatbot for architecture,
  strategy, debugging, research, writing.
- Direct, technical communication. No filler. Dry humor fine.

## Decisions Log
- ${today()}: Chose regex-based comp chem parser (no API cost constraint).
- ${today()}: Chose Electron + Playwright for Bhatbot desktop agent.
- ${today()}: Prompt caching + Haiku routing for cost optimization.

## Recurring Tasks

## Notes
`;

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_PATH)) {
      fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
      fs.writeFileSync(MEMORY_PATH, INITIAL_MEMORY);
    }
    return '\n\n---\n## BHATBOT MEMORY\n\n' + fs.readFileSync(MEMORY_PATH, 'utf8');
  } catch { return ''; }
}

function resolveContextPath() {
  const candidates = [process.env.BHATBOT_PROJECT, process.cwd()].filter(Boolean);
  for (const base of candidates) {
    let dir = path.resolve(base);
    for (let i = 0; i < 6; i++) {
      const p = path.join(dir, 'CLAUDE.md');
      if (fs.existsSync(p)) return p;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}
function loadProjectContext() {
  const p = resolveContextPath();
  if (!p) return '';
  try { return '\n\n---\n## LIVE PROJECT CONTEXT (CLAUDE.md)\n\n' + fs.readFileSync(p, 'utf8'); }
  catch { return ''; }
}

const STATIC_PROMPT = `You are Bhatbot — Siddhant Bhat's personal Jarvis-style AI desktop agent.
You run natively on his Mac with full access to his filesystem, terminal,
browser, and Claude Code CLI. You are independent of Claude Desktop and
claude.ai.

IDENTITY: Siddhant is an 18-year-old incoming Princeton student (fall 2026).
Deep expertise in GNN/ML, computational biology, full-stack dev (Next.js /
Supabase / Vercel), Unity/C#, Blender, scientific software.

PERSONALITY: Direct, technical, no preamble, no filler. Dry wit acceptable.
Jarvis-style: capable, never effusive. Address as Siddhant occasionally.

TOOLS: Use them proactively. When given a path — read it. When asked to run
something — run it. Don't narrate what you're about to do, just do it.

BROWSER: You have a dedicated Playwright browser, completely separate from
Siddhant's browser. His cursor never moves. Use it for web research, checking
deployments, reading docs, navigating web UIs.

SAFEGUARDS: The ONLY commands requiring user confirmation are those containing
rm, rmdir, or trash. Everything else — sudo, git push to any branch, npm
publish, pip upload, brew install — execute freely. For any action that feels
irreversible or large in scope beyond deletion, surface a one-line heads-up in
your response before running, but do not ask for permission. Use judgment.

MEMORY: After any session where you learn something persistent about Siddhant —
a preference, decision, project update, personal fact, or recurring pattern —
call save_memory before finishing. Be selective. One to three entries per
conversation is normal. When he corrects you or signals a preference about how
you should work, capture it in 'Preferences & Patterns'.

CLAUDE CODE: When writing Claude Code prompts for Siddhant, write them complete
and ordered. Always include "ask clarifying questions before making any
changes" at the top.

ACTIVITY WINDOW: Assume Siddhant is doing other work during long tasks. Narrate
key decisions in tool call arguments so the activity log is readable. Don't
wait for input unless you genuinely need it.

VISUAL CREATION: You can SEE what you make. After every studio_write or
generate_image you receive a screenshot of the result as a vision block.
If it needs work, state exactly what's wrong and call the tool again with
specific fixes — iterate up to 3 times on creative work before asking for
human direction. Prefer SVG via studio_write (free, infinitely scalable,
editable) for logos, icons, diagrams, and UI. Use generate_image (GPT Image 1,
~$0.04/image) only for photorealistic or complex artistic content SVG can't
express. generate_3d turns any image into a GLB model (Blender/Unity/Three.js).

VOICE: Your replies are spoken aloud (TTS). Keep them concise and conversational
— no markdown or code blocks in what should be spoken; put detailed output in the
chat and lead with a short spoken-friendly summary. Long replies are auto-summarized
for voice; the user can ask to "read the full response".

MEDIA: Use media_control for any Spotify or volume request (play, pause, skip,
"what's playing", set Spotify or system volume).

PHONE: Messages may arrive from Siddhant's phone via Telegram or the PWA — no
activity window there. Keep those replies tight (≤400 chars when possible) and say
if a task needs the desktop.

PROACTIVE: A daily briefing runs automatically at the configured hour. Surface
deployment status, new papers, and project changes there — don't wait to be asked.`;

// Defensive: never let API keys / app passwords reach the model context, even if
// one accidentally lands in memory.md or CLAUDE.md. Secrets live in config.json only.
function redactSecrets(s) {
  if (!s) return s;
  return s
    .replace(/sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}/g, '[REDACTED_KEY]')
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[REDACTED_KEY]')
    .replace(/\bgsk_[A-Za-z0-9]{20,}/g, '[REDACTED_KEY]')
    .replace(/\b([a-z]{4}\s){3}[a-z]{4}\b/gi, '[REDACTED_APP_PW]')           // gmail app-pw shape
    .replace(/\b(?=[A-Za-z0-9_\-]{40,}\b)(?=[A-Za-z0-9_\-]*[A-Za-z])(?=[A-Za-z0-9_\-]*[0-9])[A-Za-z0-9_\-]+/g, '[REDACTED_TOKEN]');
}

function buildSystemPrompt() {
  return redactSecrets(STATIC_PROMPT + loadMemory() + loadProjectContext());
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------
function chooseModel(lastUserMessage) {
  const sonnet = [
    /write.*prompt/i, /claude.?code/i, /architect/i, /refactor/i, /debug/i,
    /explain.*why/i, /design/i, /strategy/i, /research/i, /paper/i,
    /how.*work/i, /optimize/i, /plan/i, /review/i
  ];
  return sonnet.some((p) => p.test(lastUserMessage)) ? MODEL_SONNET : MODEL_HAIKU;
}

// ---------------------------------------------------------------------------
// Claude API (prompt caching GA — cache_control, no beta header needed)
// ---------------------------------------------------------------------------
async function callClaude(messages, apiKey, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

function lastUserText(messages) {
  const lu = [...messages].reverse().find((m) => m.role === 'user');
  if (!lu) return '';
  if (typeof lu.content === 'string') return lu.content;
  const t = Array.isArray(lu.content) ? lu.content.find((b) => b.type === 'text') : null;
  return t ? t.text : '';
}

// Unified router: Darkbloom (when funded/enabled) for cheap Q&A + directives,
// Claude for everything needing tools, reasoning, memory, or as fallback.
// `allowDarkbloom` is only true on the first turn (Darkbloom path is single-shot,
// no tool loop). Returns Anthropic-shaped response so agentLoop is unchanged.
async function callModel(messages, apiKey, allowDarkbloom) {
  const cfg = loadConfig();
  const route = classify(lastUserText(messages));
  const dbReady = cfg.darkbloomEnabled && cfg.darkbloomKey;

  if (allowDarkbloom && dbReady && (route === 'db_speech' || route === 'db_directive')) {
    try {
      const oa = messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content
          : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      }));
      const text = await darkbloom.chat(oa, DB_MODELS[route], cfg.darkbloomKey, buildSystemPrompt(), cfg.darkbloomBaseUrl);
      return { content: [{ type: 'text', text }], stop_reason: 'end_turn', _provider: 'darkbloom', _model: DB_MODELS[route] };
    } catch (e) {
      console.warn(`Darkbloom failed (${route}) → Claude fallback:`, e.message);
    }
  }

  const claudeModel = (route === 'sonnet' || route === 'db_directive') ? MODEL_SONNET : MODEL_HAIKU;
  const r = await callClaude(messages, apiKey, claudeModel);
  r._provider = 'anthropic';
  r._model = claudeModel;
  return r;
}

// Cross-provider research: ask another AI directly. Providers: claude, openai, gemini, local(ollama).
async function askAI(input) {
  const cfg = loadConfig();
  const provider = input.provider;
  const prompt = input.prompt;
  try {
    if (provider === 'openai') {
      if (!cfg.openaiKey) return { success: false, error: 'No openaiKey configured.' };
      const model = input.model || cfg.openaiModel || 'gpt-4o-mini';
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.openaiKey },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] })
      });
      const j = await r.json();
      if (!r.ok) return { success: false, error: j.error?.message || `OpenAI ${r.status}` };
      return { success: true, provider, model, answer: j.choices?.[0]?.message?.content || '' };
    }
    if (provider === 'gemini') {
      if (!cfg.geminiKey) return { success: false, error: 'No geminiKey configured.' };
      const model = input.model || cfg.geminiModel || 'gemini-2.0-flash';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const j = await r.json();
      if (!r.ok) return { success: false, error: j.error?.message || `Gemini ${r.status}` };
      return { success: true, provider, model, answer: j.candidates?.[0]?.content?.parts?.[0]?.text || '' };
    }
    if (provider === 'claude') {
      const r = await callClaude([{ role: 'user', content: prompt }], getApiKey(), MODEL_SONNET);
      return { success: true, provider, model: MODEL_SONNET, answer: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
    }
    if (provider === 'local') {
      const model = input.model || cfg.localModel || 'qwen3.5:latest';
      const r = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false })
      });
      const j = await r.json();
      if (!r.ok) return { success: false, error: `Ollama ${r.status}` };
      return { success: true, provider, model, answer: j.response || '' };
    }
    return { success: false, error: `Unknown provider: ${provider}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Keep only the last `keep` screenshot image blocks; replace older ones with a
// text note so vision works without re-sending megabytes every iteration.
function evictOldImages(history, keep) {
  const h = structuredClone(history);
  const refs = [];
  for (const m of h) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (let ci = 0; ci < b.content.length; ci++) {
          if (b.content[ci].type === 'image') refs.push({ arr: b.content, ci });
        }
      }
    }
  }
  for (const r of refs.slice(0, Math.max(0, refs.length - keep))) {
    r.arr[r.ci] = { type: 'text', text: '[earlier screenshot omitted to save tokens]' };
  }
  return h;
}

async function trimHistory(history, apiKey) {
  if (history.length <= 20) return history;
  const toSummarize = history.slice(0, -4);
  const recent = history.slice(-4);
  const summary = await callClaude([
    ...toSummarize,
    { role: 'user', content: 'Summarize this conversation in under 200 words. Preserve: decisions made, file paths referenced, unresolved tasks, any code written.' }
  ], apiKey, MODEL_HAIKU);
  const text = (summary.content.find((b) => b.type === 'text') || {}).text || '';
  return [
    { role: 'user', content: `[Conversation summary]: ${text}` },
    { role: 'assistant', content: 'Understood.' },
    ...recent
  ];
}

// ---------------------------------------------------------------------------
// User media attachments → Claude vision blocks. Images (screenshots/photos,
// incl. HEIC) are normalized to JPEG ≤1568px via `sips`; screen recordings are
// sampled into frames via `ffmpeg`. Used by the desktop picker AND the phone PWA.
// ---------------------------------------------------------------------------
const VISION_MAX_DIM = 1568;
const imgBlock = (data, mt) => ({ type: 'image', source: { type: 'base64', media_type: mt, data } });
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff'];
const VID_EXT = ['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.webm'];

function sipsToJpeg(src) {
  const out = path.join(os.tmpdir(), `bb-img-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  const r = spawnSync('sips', ['-Z', String(VISION_MAX_DIM), '-s', 'format', 'jpeg', src, '--out', out],
    { env: { ...process.env, PATH: EXEC_PATH } });
  return (r.status === 0 && fs.existsSync(out)) ? out : null;
}
function videoFrames(src, max = 6) {
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-vid-')); } catch { return []; }
  spawnSync('ffmpeg', ['-i', src, '-vf', `fps=1/2,scale=${VISION_MAX_DIM}:-1:force_original_aspect_ratio=decrease`,
    '-frames:v', String(max), '-y', path.join(dir, 'f-%02d.jpg')], { env: { ...process.env, PATH: EXEC_PATH } });
  let frames = [];
  try { frames = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort()
    .map(f => fs.readFileSync(path.join(dir, f)).toString('base64')); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return frames;
}
async function mediaFileToBlocks(p) {
  const ext = path.extname(p).toLowerCase();
  const blocks = [];
  if (IMG_EXT.includes(ext)) {
    const jpg = sipsToJpeg(p);
    if (jpg) { blocks.push(imgBlock(fs.readFileSync(jpg).toString('base64'), 'image/jpeg')); fs.unlink(jpg, () => {}); }
    else {
      const mt = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      blocks.push(imgBlock(fs.readFileSync(p).toString('base64'), mt));
    }
  } else if (VID_EXT.includes(ext)) {
    const frames = videoFrames(p);
    if (frames.length) { blocks.push({ type: 'text', text: `[screen recording — ${frames.length} sampled frames follow]` }); frames.forEach(f => blocks.push(imgBlock(f, 'image/jpeg'))); }
    else blocks.push({ type: 'text', text: `[video at ${p}: frame extraction failed; inspect it with run_shell/ffmpeg]` });
  } else {
    blocks.push({ type: 'text', text: `[attached file: ${p} — use your tools to inspect it]` });
  }
  return blocks;
}
function mimeToExt(mime) {
  const m = (mime || '').split(';')[0].trim();
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/heic': '.heic', 'image/heif': '.heif', 'video/quicktime': '.mov', 'video/mp4': '.mp4',
    'video/webm': '.webm', 'video/x-m4v': '.m4v' })[m] || '.bin';
}
async function mediaBytesToBlocks(buf, mime) {
  const tmp = path.join(os.tmpdir(), `bb-up-${Date.now()}${mimeToExt(mime)}`);
  try { fs.writeFileSync(tmp, Buffer.from(buf)); const b = await mediaFileToBlocks(tmp); fs.unlink(tmp, () => {}); return b; }
  catch (e) { return [{ type: 'text', text: '[attachment failed: ' + e.message + ']' }]; }
}

// ---------------------------------------------------------------------------
// Media control — Spotify + system volume via AppleScript (zero deps).
// ---------------------------------------------------------------------------
function osa(args) {
  return new Promise((resolve) => {
    const p = spawn('osascript', args);
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => err += d);
    p.on('error', (e) => resolve({ ok: false, out: '', err: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
  });
}
async function mediaControl(input) {
  const a = input.action;
  const q = input.query || '';
  const vol = Math.max(0, Math.min(100, Number(input.volume)));
  const spotify = (body) => ['-e', `tell application "Spotify" to ${body}`];
  let args;
  switch (a) {
    case 'pause':            args = spotify('pause'); break;
    case 'resume':           args = spotify('play'); break;
    case 'next':             args = spotify('next track'); break;
    case 'previous':         args = spotify('previous track'); break;
    case 'get_now_playing':  args = spotify('return name of current track & " — " & artist of current track'); break;
    case 'set_volume':       args = spotify(`set sound volume to ${vol}`); break;
    case 'set_system_volume':args = ['-e', `set volume output volume ${vol}`]; break;
    case 'play_track':
    case 'search_and_play':  args = ['-e', `tell application "Spotify" to play track "${q.replace(/"/g, '')}"`]; break;
    default: return { success: false, error: `Unknown action: ${a}` };
  }
  const r = await osa(args);
  // search_and_play often needs a URI; if direct play fails, fall back to opening a search in the app.
  if (!r.ok && (a === 'search_and_play' || a === 'play_track') && q) {
    await osa(['-e', `tell application "Spotify" to search for "${q.replace(/"/g, '')}"`]);
    return { success: true, result: `Opened Spotify search for "${q}". Pick a track to play.` };
  }
  return r.ok ? { success: true, result: r.out || 'done' } : { success: false, error: r.err || 'osascript failed' };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const MEMORY_SECTIONS = ['Personal', 'Active Projects', 'Preferences & Patterns', 'Decisions Log', 'Recurring Tasks', 'Notes'];

const TOOLS = [
  { name: 'read_file', description: 'Read a UTF-8 text file (100KB max). Absolute paths.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write a UTF-8 file, mkdir -p on parent.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'list_directory', description: 'List directory entries with name + type.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_shell', description: 'Run a shell command (60s). rm/rmdir/trash require user confirmation. Homebrew + claude CLI on PATH.',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } },
  { name: 'fetch_url', description: 'HTTP GET a URL, return text (15s, 50KB cap).',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'open_in_browser', description: "Open a URL in Siddhant's default browser.",
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'media_control', description: 'Control Spotify + system audio via AppleScript. Use for any play/pause/skip/volume/"what\'s playing" request. set_volume = Spotify volume; set_system_volume = macOS output volume (both 0-100).',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['play_track','pause','resume','next','previous','set_volume','get_now_playing','search_and_play','set_system_volume'] },
      query: { type: 'string', description: 'Track/artist for play_track or search_and_play' },
      volume: { type: 'number', description: '0-100 for volume actions' }
    }, required: ['action'] } },
  { name: 'save_memory', description: `Persist a fact to long-term memory. section ∈ {${MEMORY_SECTIONS.join(', ')}}.`,
    input_schema: { type: 'object', properties: { section: { type: 'string', enum: MEMORY_SECTIONS }, content: { type: 'string' } }, required: ['section', 'content'] } },
  { name: 'browser', description: 'Dedicated headless Playwright browser; you SEE its screenshots (vision). actions: navigate, click, type, screenshot, get_text, evaluate.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['navigate', 'click', 'type', 'screenshot', 'get_text', 'evaluate'] },
      url: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, js: { type: 'string' }
    }, required: ['action'] } },
  { name: 'vision_local', description: `Second-opinion vision from a LOCAL model (via Ollama) on the current browser page. Free/offline. Use to cross-check your own read or when you want an independent description.`,
    input_schema: { type: 'object', properties: { prompt: { type: 'string', description: 'What to ask about the page' } } } },
  { name: 'ask_ai', description: 'Query ANOTHER AI model for research, a second opinion, or to cross-check. Providers: claude (Sonnet), openai (GPT), gemini (Google), local (your Ollama models). Use when you want an independent answer or to compare models.',
    input_schema: { type: 'object', properties: {
      provider: { type: 'string', enum: ['claude', 'openai', 'gemini', 'local'] },
      prompt: { type: 'string', description: 'The question/prompt to send' },
      model: { type: 'string', description: 'Optional model override (e.g. an Ollama model name)' }
    }, required: ['provider', 'prompt'] } },
  { name: 'write_agent_directive', description: 'Write a complete, structured directive (system prompt + task instructions) for another AI agent or automated workflow (Claude Code prompt, n8n spec, second Bhatbot, generic agent). Output is a self-contained block ready to paste.',
    input_schema: { type: 'object', properties: {
      target_agent: { type: 'string', enum: ['claude_code', 'bhatbot_instance', 'n8n_workflow', 'generic_llm_agent'] },
      task_description: { type: 'string', description: 'What the agent should accomplish. Be specific.' },
      context: { type: 'string', description: 'File paths, project state, constraints the agent needs.' },
      output_format: { type: 'string', enum: ['markdown_prompt', 'json_spec', 'shell_script', 'yaml_workflow'], default: 'markdown_prompt' }
    }, required: ['target_agent', 'task_description'] } },
  { name: 'studio_write', description: 'Write/replace the live HTML design canvas (Bhatbot Studio window) and open it — renders instantly. Use when asked to design, prototype, or visualize a UI/page/chart. Provide a full standalone HTML document (inline CSS/JS).',
    input_schema: { type: 'object', properties: { html: { type: 'string', description: 'Full standalone HTML document' } }, required: ['html'] } },
  { name: 'claude_code', description: 'Delegate a coding/build task to the Claude Code CLI (headless, one-shot, 5min). For larger interactive work, the Claude Code terminal window is better. Returns Claude Code output.',
    input_schema: { type: 'object', properties: { prompt: { type: 'string' }, cwd: { type: 'string', description: 'Project dir (default BHATBOT_PROJECT or home)' } }, required: ['prompt'] } },
  { name: 'generate_image', description: 'Generate an image with GPT Image 1 (OpenAI). Use for logos, illustrations, diagrams, UI mockups, graphical abstracts, posters — anything raster/photographic that SVG cannot express. The result is returned to you as a vision block so you CAN see it: critique and call again with fixes if needed. Write a precise, detailed prompt (style, composition, colors, mood).',
    input_schema: { type: 'object', properties: {
      prompt: { type: 'string', description: 'Detailed image prompt — be specific about style, composition, colors, mood.' },
      quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'low≈$0.01, medium≈$0.04, high≈$0.08. Default medium.' },
      size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'], description: 'Square for icons/logos; landscape/portrait for illustrations.' },
      filename: { type: 'string', description: 'Optional filename (no extension). Defaults to timestamp.' }
    }, required: ['prompt'] } },
  { name: 'generate_3d', description: 'Convert a 2D image into a textured 3D model (GLB) using Microsoft TRELLIS via Replicate. Input a local PNG/JPG path (from generate_image or the user). Output a GLB with PBR textures saved locally. Takes 30–90s. Requires replicateKey in config. Good for: 3D logos, object prototypes, Skipper assets, structure visualizations.',
    input_schema: { type: 'object', properties: {
      image_path: { type: 'string', description: 'Absolute path to input PNG or JPG.' },
      texture_size: { type: 'number', enum: [512, 1024, 2048], description: 'Texture resolution. Default 1024.' },
      filename: { type: 'string', description: 'Output filename (no extension). Defaults to timestamp.' }
    }, required: ['image_path'] } }
];

// shell safety
const HARD_BLOCKED = [
  /rm\s+-rf\s+\/(?:\s|$)/,
  /:\(\)\{.*\}/,
  /mkfs\./,
  /dd\s+if=.*of=\/dev\/(sd|disk)/
];
const CONFIRM_PATTERNS = [
  { re: /\brm\b/, reason: 'This will permanently delete files.' },
  { re: /\brmdir\b/, reason: 'This will remove a directory.' },
  { re: /\btrash\b/, reason: 'This will move files to Trash.' }
];

function auditLog(name, input, result) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_PATH, JSON.stringify({
      ts: new Date().toISOString(), tool: name,
      input: JSON.stringify(input).slice(0, 200), ok: result.success !== false
    }) + '\n');
  } catch {}
}

function requestConfirm(command, reason) {
  return new Promise((resolve) => {
    openActivityWindow();
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    pendingConfirms.set(id, resolve);
    sendToActivity('confirm-required', { id, command, reason });
  });
}

function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    exec(command, { cwd: cwd || os.homedir(), timeout: timeoutMs || 60000, env: { ...process.env, PATH: EXEC_PATH }, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) return resolve({ success: false, error: `Command timed out (${Math.round((timeoutMs || 60000) / 1000)}s)` });
        resolve({ success: !err, stdout: stdout || '', stderr: stderr || '', exitCode: err ? err.code : 0 });
      });
  });
}

async function ensureBrowser() {
  if (browser && page) return;
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true, slowMo: 200 });
  page = await browser.newPage();
}

async function browserAction(input) {
  openActivityWindow();
  await ensureBrowser();
  // Screenshots stream to the activity window AND are returned as `_image`
  // (base64). agentLoop turns `_image` into a real vision image block so Claude
  // sees the page, then evicts old images so we don't re-bomb the rate limit.
  const shot = async () => {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
    const b64 = buf.toString('base64');
    sendToActivity('screenshot', { data: b64 });
    return b64;
  };
  switch (input.action) {
    case 'navigate':
      await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { success: true, url: page.url(), title: await page.title(), _image: await shot() };
    case 'click':
      await page.click(input.selector, { timeout: 15000 });
      return { success: true, _image: await shot() };
    case 'type':
      await page.fill(input.selector, input.text);
      return { success: true, _image: await shot() };
    case 'screenshot':
      return { success: true, note: 'Screenshot captured.', _image: await shot() };
    case 'get_text': {
      const txt = await page.innerText(input.selector || 'body');
      return { success: true, text: txt.slice(0, 10 * 1024) };
    }
    case 'evaluate':
      return { success: true, result: await page.evaluate(input.js) };
    default:
      return { success: false, error: 'Unknown browser action' };
  }
}

async function visionLocal(input) {
  if (!page) return { success: false, error: 'No active browser page — navigate somewhere first.' };
  const model = loadConfig().visionModel || OLLAMA_VISION_MODEL; // swap via config.visionModel
  const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
  sendToActivity('screenshot', { data: buf.toString('base64') });
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, stream: false,
        prompt: input.prompt || 'Describe this screenshot in detail: layout, UI quality, readability, and any broken elements, errors, or empty states.',
        images: [buf.toString('base64')]
      })
    });
    if (!res.ok) return { success: false, error: `Ollama ${res.status} — is it running with ${model}?` };
    const j = await res.json();
    return { success: true, model, description: j.response };
  } catch (e) {
    return { success: false, error: `Ollama unreachable at ${OLLAMA_URL}: ${e.message}` };
  }
}

function saveMemoryEntry(section, content) {
  if (!MEMORY_SECTIONS.includes(section)) return { success: false, error: 'Unknown section' };
  if (/sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}|AIza[0-9A-Za-z_\-]{20,}|gsk_[A-Za-z0-9]{20,}|\b([a-z]{4}\s){3}[a-z]{4}\b/i.test(content)) {
    return { success: false, error: 'Refused: that looks like an API key / app password. Secrets belong in config.json (never in memory — memory is sent to the model on every call).' };
  }
  let md = fs.existsSync(MEMORY_PATH) ? fs.readFileSync(MEMORY_PATH, 'utf8') : INITIAL_MEMORY;
  md = md.replace(/_Auto-maintained\. Last updated: .*_/, `_Auto-maintained. Last updated: ${today()}_`);
  const line = `- ${today()}: ${content}\n`;
  const heading = `## ${section}`;
  const idx = md.indexOf(heading);
  if (idx === -1) return { success: false, error: 'Section not found' };
  const insertAt = idx + heading.length;
  md = md.slice(0, insertAt) + '\n' + line + md.slice(insertAt + 1);
  fs.writeFileSync(MEMORY_PATH, md);
  return { success: true, saved: `${section}: ${content}` };
}

async function executeTool(name, input) {
  let result;
  try {
    switch (name) {
      case 'read_file': {
        const stat = fs.statSync(input.path);
        if (stat.size > 100 * 1024) { result = { success: false, error: 'File exceeds 100KB' }; break; }
        result = { success: true, content: fs.readFileSync(input.path, 'utf8') }; break;
      }
      case 'write_file':
        fs.mkdirSync(path.dirname(input.path), { recursive: true });
        fs.writeFileSync(input.path, input.content);
        result = { success: true, path: input.path }; break;
      case 'list_directory':
        result = { success: true, entries: fs.readdirSync(input.path, { withFileTypes: true })
          .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) }; break;
      case 'run_shell': {
        if (HARD_BLOCKED.some((re) => re.test(input.command))) { result = { success: false, error: 'Blocked: destructive command' }; break; }
        const gate = CONFIRM_PATTERNS.find((g) => g.re.test(input.command));
        if (gate) {
          const approved = await requestConfirm(input.command, gate.reason);
          if (!approved) { result = { success: false, error: 'Declined by user.' }; break; }
        }
        result = await runShell(input.command, input.cwd); break;
      }
      case 'fetch_url': {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        try {
          const res = await fetch(input.url, { signal: ctrl.signal });
          result = { success: res.ok, status: res.status, content: (await res.text()).slice(0, 50 * 1024) };
        } finally { clearTimeout(t); }
        break;
      }
      case 'open_in_browser':
        await shell.openExternal(input.url); result = { success: true, opened: input.url }; break;
      case 'media_control':
        result = await mediaControl(input); break;
      case 'save_memory':
        result = saveMemoryEntry(input.section, input.content); break;
      case 'browser':
        result = await browserAction(input); break;
      case 'vision_local':
        result = await visionLocal(input); break;
      case 'ask_ai':
        result = await askAI(input); break;
      case 'studio_write': {
        fs.mkdirSync(STUDIO_DIR, { recursive: true });
        fs.writeFileSync(STUDIO_INDEX, input.html);
        const fresh = !studioWindow || studioWindow.isDestroyed();
        openStudioWindow();
        // Let the DOM (and any reload) settle, then capture what rendered so Claude can SEE it.
        await sleep(fresh ? 1200 : 700);
        let shot = null;
        try {
          if (studioWindow && !studioWindow.isDestroyed()) {
            const img = await studioWindow.webContents.capturePage();
            shot = img.resize({ width: 1200 }).toJPEG(75).toString('base64');
          }
        } catch (e) { console.warn('Studio screenshot failed:', e.message); }
        result = shot
          ? { success: true, path: STUDIO_INDEX, _image: shot, _imageMime: 'image/jpeg', note: 'Rendered in Studio — screenshot attached, you can see the result. Critique and iterate if needed.' }
          : { success: true, path: STUDIO_INDEX, note: 'Rendered in Studio. Screenshot unavailable.' };
        break;
      }
      case 'claude_code':
        result = await runShell('claude -p ' + JSON.stringify(input.prompt), input.cwd || process.env.BHATBOT_PROJECT || os.homedir(), 300000);
        break;
      case 'write_agent_directive': {
        const cfg = loadConfig();
        const sys = `You are an expert at writing precise, complete directives for AI agents and automated systems. Output is always self-contained and immediately usable. You know Siddhant Bhat's projects (Nexus Research, PRISM, FABLE, Skipper) and style (direct, technical, implementation-ready; Claude Code prompts always start with "ask clarifying questions before making any changes").`;
        const user = `Write a ${input.output_format || 'markdown_prompt'} directive for: ${input.target_agent}\n\nTask: ${input.task_description}\n\n${input.context ? 'Context:\n' + input.context : ''}\n\nRequirements:\n- Complete and self-contained (receiver has no other context)\n- Implementation-ready (no placeholder TODOs unless intentional)\n- For Claude Code prompts: include the clarifying-questions instruction at top\n- For n8n/workflow specs: include trigger, steps, and error handling\n- Output the directive only, no meta-commentary`;
        if (cfg.darkbloomEnabled && cfg.darkbloomKey) {
          try {
            const d = await darkbloom.chat([{ role: 'user', content: user }], 'gemma-4-26b', cfg.darkbloomKey, sys, cfg.darkbloomBaseUrl);
            result = { success: true, directive: d, via: 'darkbloom:gemma-4-26b' }; break;
          } catch (e) { /* fall through to Claude */ }
        }
        const r = await callClaude([{ role: 'user', content: user }], getApiKey(), MODEL_SONNET);
        result = { success: true, directive: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), via: 'claude-sonnet' };
        break;
      }
      case 'generate_image': {
        const cfg = loadConfig();
        if (!cfg.openaiKey) { result = { success: false, error: 'No openaiKey in config.' }; break; }
        const quality = input.quality || cfg.imageGenQuality || 'medium';
        const size = input.size || cfg.imageGenSize || '1024x1024';
        const fname = (input.filename || `img_${Date.now()}`).replace(/[^\w.-]/g, '_');
        const outDir = (cfg.imageOutputDir || '~/.bhatbot/generated').replace(/^~/, os.homedir());
        fs.mkdirSync(outDir, { recursive: true });
        const ir = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.openaiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.imageGenModel || 'gpt-image-1', prompt: input.prompt, n: 1, size, quality }),
          signal: AbortSignal.timeout(120000)
        });
        if (!ir.ok) { result = { success: false, error: `OpenAI Images ${ir.status}: ${(await ir.text()).slice(0, 300)}` }; break; }
        const idata = await ir.json();
        const b64 = idata.data?.[0]?.b64_json;
        if (!b64) { result = { success: false, error: 'No image in response.' }; break; }
        const outPath = path.join(outDir, `${fname}.png`);
        fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
        if (cfg.imageAutoStudio) {
          fs.mkdirSync(STUDIO_DIR, { recursive: true });
          fs.writeFileSync(STUDIO_INDEX, `<!doctype html><html><body style="margin:0;background:#090d13;display:flex;align-items:center;justify-content:center;height:100vh"><img src="file://${outPath}?t=${Date.now()}" style="max-width:100%;max-height:100vh;object-fit:contain"></body></html>`);
          openStudioWindow();
        }
        result = { success: true, path: outPath, size, quality, _image: b64, _imageMime: 'image/png', message: `Generated → ${outPath}. Inspecting the result; critique and regenerate with fixes if needed.` };
        break;
      }
      case 'generate_3d': {
        const cfg = loadConfig();
        if (!cfg.replicateKey) { result = { success: false, error: 'No replicateKey in ~/.bhatbot/config.json. Get one free at replicate.com.' }; break; }
        if (!fs.existsSync(input.image_path)) { result = { success: false, error: `Image not found: ${input.image_path}` }; break; }
        const mime = input.image_path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        const dataUrl = `data:${mime};base64,${fs.readFileSync(input.image_path).toString('base64')}`;
        const outDir = (cfg.imageOutputDir || '~/.bhatbot/generated').replace(/^~/, os.homedir());
        fs.mkdirSync(outDir, { recursive: true });
        const fname = (input.filename || `3d_${Date.now()}`).replace(/[^\w.-]/g, '_');
        const cr = await fetch('https://api.replicate.com/v1/models/firtoz/trellis/predictions', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.replicateKey, 'Content-Type': 'application/json', 'Prefer': 'wait' },
          body: JSON.stringify({ input: { images: [dataUrl], texture_size: input.texture_size || 1024, mesh_simplify: 0.95, generate_color: true, generate_model: true, generate_normal: true, ss_sampling_steps: 12, slat_sampling_steps: 12, ss_guidance_strength: 7.5, slat_guidance_strength: 3 } }),
          signal: AbortSignal.timeout(120000)
        });
        if (!cr.ok) { result = { success: false, error: `Replicate ${cr.status}: ${(await cr.text()).slice(0, 300)}` }; break; }
        let pred = await cr.json();
        let tries = 0;
        while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled' && tries < 40) {
          await sleep(3000);
          const pr = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, { headers: { 'Authorization': 'Bearer ' + cfg.replicateKey } });
          pred = await pr.json(); tries++;
        }
        if (pred.status !== 'succeeded') { result = { success: false, error: `3D failed: ${pred.error || pred.status}` }; break; }
        const glbUrl = pred.output?.model_file || pred.output?.glb || (Array.isArray(pred.output) ? pred.output[0] : null);
        if (!glbUrl) { result = { success: false, error: 'No GLB URL in output: ' + JSON.stringify(pred.output).slice(0, 200) }; break; }
        const gr = await fetch(glbUrl);
        const gbuf = Buffer.from(await gr.arrayBuffer());
        const outPath = path.join(outDir, `${fname}.glb`);
        fs.writeFileSync(outPath, gbuf);
        result = { success: true, path: outPath, size_mb: (gbuf.length / 1048576).toFixed(2), message: `3D model → ${outPath}. Import into Blender, Unity, or Three.js.` };
        break;
      }
      default:
        result = { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    result = { success: false, error: String(e && e.message ? e.message : e) };
  }
  auditLog(name, input, result);
  return result;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------
function sendToAll(chatEvent, channel, data) {
  try { chatEvent.sender.send(channel, data); } catch {}
  sendToActivity(channel, data);
}
function sendToActivity(channel, data) {
  try { if (activityWindow && !activityWindow.isDestroyed()) activityWindow.webContents.send(channel, data); } catch {}
}

async function agentLoop(history, apiKey, event) {
  agentState = 'running';
  pendingGuidance = [];          // fresh per task
  const usedGuidance = [];       // collected for the post-task "learn this?" prompt
  let iterations = 0;
  history = await trimHistory(history, apiKey);

  // All exits go through here so live guidance can be offered for learning (2a).
  const finish = (text) => {
    agentState = 'idle';
    if (usedGuidance.length) sendToActivity('learn_prompt', { text: usedGuidance.join(' | ') });
    return { text, history };
  };

  while (iterations < MAX_AGENT_ITERATIONS) {
    if (agentState === 'stopped') return finish('⏹ Stopped.');
    while (agentState === 'paused') await sleep(300);

    history = evictOldImages(history, KEEP_IMAGES);
    const response = await callModel(history, apiKey, iterations === 0);
    sendToActivity('model', { model: response._model });
    sendToAll(event, 'tool-update', { type: 'provider_used', provider: response._provider || 'anthropic', model: response._model });
    const hasTools = response.content.some((b) => b.type === 'tool_use');
    history = [...history, { role: 'assistant', content: response.content }];

    if (!hasTools || response.stop_reason === 'end_turn') {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return finish(text);
    }

    const thinkText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (thinkText) sendToAll(event, 'tool-update', { type: 'thinking', text: thinkText });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      sendToAll(event, 'tool-update', { type: 'tool_start', name: block.name, input: block.input });
      const result = await executeTool(block.name, block.input);
      sendToAll(event, 'tool-update', { type: 'tool_done', name: block.name, result: { ...result, _image: undefined, _imageMime: undefined } });
      let trContent;
      if (result._image) {
        const { _image, _imageMime, ...rest } = result;
        trContent = [
          { type: 'text', text: JSON.stringify(rest).slice(0, 8192) },
          { type: 'image', source: { type: 'base64', media_type: _imageMime || 'image/jpeg', data: _image } }
        ];
      } else {
        trContent = JSON.stringify(result).slice(0, 100 * 1024);
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: trContent, is_error: result.success === false });
    }

    // Live feedback: fold any queued guidance into this same user turn (avoids
    // two consecutive user messages) so the model course-corrects next step.
    if (pendingGuidance.length) {
      const g = pendingGuidance.splice(0);
      usedGuidance.push(...g);
      toolResults.unshift({ type: 'text', text: '[Live guidance from Siddhant — adjust accordingly]: ' + g.join(' | ') });
      sendToAll(event, 'tool-update', { type: 'guidance_applied', text: g.join(' | ') });
    }

    history = [...history, { role: 'user', content: toolResults }];
    iterations++;
  }
  return finish('⚠ Max iterations reached.');
}

// ---------------------------------------------------------------------------
// Remote control (MCP) — run the agent headless, keep a rolling remote history.
// Activity still streams to the activity window via sendToActivity, so you can
// watch phone-issued tasks execute on the Mac.
// ---------------------------------------------------------------------------
let mcpHistory = [];
async function runAgentHeadless(instruction, opts = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return { error: 'No ANTHROPIC_API_KEY in env or config.json' };
  if (opts.reset) mcpHistory = [];
  const blocks = Array.isArray(opts.blocks) ? opts.blocks : [];
  mcpHistory.push({ role: 'user', content: blocks.length ? [{ type: 'text', text: String(instruction || '') }, ...blocks] : String(instruction || '') });
  sendToActivity('tool-update', { type: 'thinking', text: '📱 remote task: ' + String(instruction || '').slice(0, 200) });
  try {
    const res = await agentLoop(mcpHistory, apiKey, { sender: { send() {} } });
    mcpHistory = res.history;
    if (mcpHistory.length > 40) mcpHistory = mcpHistory.slice(-40);
    return { text: res.text };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

async function initMcpServer() {
  const c = loadConfig();
  if (c.mcpEnabled === false) return;
  let token = c.mcpToken;
  if (!token) { token = crypto.randomBytes(24).toString('hex'); saveConfig({ mcpToken: token }); }
  const port = c.mcpPort || 8788;
  try {
    await startMcpServer({ port, token, runAgent: runAgentHeadless, transcribe: transcribeAudio, synthesize: synthesizeSpeech, summarize: summarizeForSpeech, media: mediaBytesToBlocks });
    console.log(`[mcp] listening on http://127.0.0.1:${port}/mcp/${token}`);
    console.log(`[app] phone PWA at  http://127.0.0.1:${port}/app/${token}`);
    console.log(`[mcp] publish with:  tailscale funnel ${port}`);
  } catch (e) { console.error('[mcp] failed to start:', e.message); }
}

// ---------------------------------------------------------------------------
// Telegram bridge — control Bhatbot from the phone over Telegram (text + voice).
// Dormant until telegramToken is set in config. Separate rolling history.
// ---------------------------------------------------------------------------
let telegramBot = null;
const telegramHistories = new Map();
function startTelegramBridge() {
  const cfg = loadConfig();
  if (!cfg.telegramToken) { console.log('[telegram] no token — bridge dormant'); return; }
  let TelegramBot;
  try { TelegramBot = require('node-telegram-bot-api'); }
  catch { console.warn('[telegram] node-telegram-bot-api not installed'); return; }
  try {
    telegramBot = new TelegramBot(cfg.telegramToken, { polling: true });
  } catch (e) { console.error('[telegram] init failed:', e.message); return; }
  console.log('[telegram] bridge active');

  telegramBot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const c = loadConfig();
    // First message authorizes this chat.
    if (!c.telegramChatId) {
      saveConfig({ telegramChatId: chatId });
      telegramBot.sendMessage(chatId, '✓ Bhatbot connected. This device is now authorized.');
      return;
    }
    if (chatId !== c.telegramChatId) return;   // ignore everyone else

    let userText = msg.text || '';
    if (msg.voice) {
      try {
        telegramBot.sendChatAction(chatId, 'typing');
        const link = await telegramBot.getFileLink(msg.voice.file_id);
        const buf = Buffer.from(await (await fetch(link)).arrayBuffer());
        const r = await transcribeAudio(Array.from(new Uint8Array(buf)), 'audio/ogg');
        if (r.error) { telegramBot.sendMessage(chatId, '⚠ Could not transcribe voice note.'); return; }
        userText = r.text;
        telegramBot.sendMessage(chatId, `🎙 _${userText}_`, { parse_mode: 'Markdown' }).catch(() => {});
      } catch { telegramBot.sendMessage(chatId, '⚠ Voice transcription failed.'); return; }
    }
    if (!userText.trim()) return;

    telegramBot.sendChatAction(chatId, 'typing');
    const hist = (telegramHistories.get(chatId) || []).slice(-20);
    hist.push({ role: 'user', content: userText });
    try {
      const res = await agentLoop(hist, getApiKey(), { sender: { send() {} } });
      telegramHistories.set(chatId, res.history.slice(-20));
      const reply = (res.text || '(no output)').slice(0, 4000);
      telegramBot.sendMessage(chatId, reply, { parse_mode: 'Markdown' }).catch(() => telegramBot.sendMessage(chatId, reply));
    } catch (e) { telegramBot.sendMessage(chatId, `⚠ Error: ${e.message}`); }
  });
  telegramBot.on('polling_error', (e) => console.warn('[telegram] polling:', e.message));
}
function telegramNotify(text) {
  try {
    const c = loadConfig();
    if (telegramBot && c.telegramChatId) telegramBot.sendMessage(c.telegramChatId, String(text).slice(0, 4000)).catch(() => {});
  } catch {}
}

// ---------------------------------------------------------------------------
// Daily briefing — runs at config.briefingHour (null = not scheduled). Notifies,
// speaks a short intro, and forwards to Telegram if connected.
// ---------------------------------------------------------------------------
let briefingTimer = null;
function scheduleBriefing() {
  if (briefingTimer) { clearTimeout(briefingTimer); briefingTimer = null; }
  const cfg = loadConfig();
  if (cfg.briefingEnabled === false) { console.log('[briefing] disabled'); return; }
  const hour = cfg.briefingHour;
  if (hour == null) { console.log('[briefing] no time set — not scheduled'); return; }
  const msUntil = (h) => { const now = new Date(), next = new Date(); next.setHours(h, 0, 0, 0); if (next <= now) next.setDate(next.getDate() + 1); return next - now; };
  briefingTimer = setTimeout(runBriefing, msUntil(hour));
  console.log(`[briefing] scheduled for ${hour}:00`);
}
async function runBriefing() {
  const cfg = loadConfig();
  const proj = process.env.BHATBOT_PROJECT || os.homedir();
  const checks = (cfg.briefingChecks && cfg.briefingChecks.length) ? cfg.briefingChecks
    : ['https://prism-assembly.prismlab.workers.dev', 'https://protfunc.prismlab.workers.dev'];
  const prompt = `Morning briefing. Be terse, max 5 bullets, each ≤15 words. Check:
1. git status on ${proj}
2. HTTP status of: ${checks.join(', ')}
3. Search for papers on "protein complex assembly order" from the last 30 days
4. Files modified in ${proj} in the last 24h
5. Current date/time
Flag anything urgent with ⚠.`;
  try {
    const res = await agentLoop([{ role: 'user', content: prompt }], getApiKey(), { sender: { send() {} } });
    const text = res.text || 'briefing produced no output';
    const note = text.slice(0, 220).replace(/"/g, '\\"');
    try { spawn('osascript', ['-e', `display notification "${note}" with title "Bhatbot Briefing" sound name "Ping"`]); } catch {}
    sayLocal('Good morning Siddhant. Your briefing is ready.');
    telegramNotify('☀️ Morning briefing:\n\n' + text);
    sendToActivity('tool-update', { type: 'thinking', text: '☀️ briefing:\n' + text });
  } catch (e) { console.error('[briefing] failed:', e.message); }
  briefingTimer = setTimeout(runBriefing, 24 * 60 * 60 * 1000);   // next day
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: 430, height: 650, x: width - 450, y: 50,
    frame: false, fullscreen: false, alwaysOnTop: false, skipTaskbar: false, resizable: true, maximizable: true,
    minWidth: 360, minHeight: 400, backgroundColor: '#090d13',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.maximize();   // big like before, but now freely resizable (was locked fullscreen)
}

function openActivityWindow() {
  if (activityWindow && !activityWindow.isDestroyed()) { activityWindow.show(); return; }
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  activityWindow = new BrowserWindow({
    width: 500, height: 700, x: Math.max(20, width - 1000), y: 50,
    resizable: true, maximizable: true, minWidth: 360, minHeight: 320,
    title: 'Bhatbot Activity', frame: true, alwaysOnTop: false, backgroundColor: '#090d13',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload-activity.js') }
  });
  activityWindow.loadFile(path.join(__dirname, 'src', 'activity.html'));
}

function toggleWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

// --- Nexus (embedded research navigator) ---
function openNexusWindow() {
  if (nexusWindow && !nexusWindow.isDestroyed()) { nexusWindow.show(); nexusWindow.focus(); return; }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  nexusWindow = new BrowserWindow({
    width: Math.min(1400, width - 80), height: Math.min(900, height - 80),
    resizable: true, maximizable: true, minWidth: 480, minHeight: 360,
    title: 'Nexus — Research Navigator', backgroundColor: '#090d13',
    webPreferences: { contextIsolation: true }
  });
  nexusWindow.loadURL(NEXUS_URL);
  nexusWindow.on('closed', () => { nexusWindow = null; });
}

// --- Studio (live HTML preview; auto-reloads when files change) ---
function ensureStudio() {
  if (!fs.existsSync(STUDIO_INDEX)) {
    fs.mkdirSync(STUDIO_DIR, { recursive: true });
    fs.writeFileSync(STUDIO_INDEX, `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:'JetBrains Mono',monospace;background:#090d13;color:#5b708a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
      div{max-width:520px;line-height:1.7}b{color:#00c8ff}</style></head><body>
      <div><b>BHATBOT STUDIO</b><br>Live preview canvas.<br>Ask Bhatbot to design something (it writes <code>~/.bhatbot/studio/index.html</code>) and it renders here instantly.</div>
      </body></html>`);
  }
}
function openStudioWindow() {
  ensureStudio();
  if (studioWindow && !studioWindow.isDestroyed()) { studioWindow.show(); studioWindow.focus(); return; }
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  studioWindow = new BrowserWindow({
    width: 940, height: 720, x: Math.max(20, Math.floor(width / 2) - 470), y: 50,
    resizable: true, maximizable: true, minWidth: 420, minHeight: 320,
    title: 'Bhatbot Studio', backgroundColor: '#090d13', webPreferences: { contextIsolation: true }
  });
  studioWindow.loadFile(STUDIO_INDEX);
  try { if (studioWatcher) studioWatcher.close(); } catch {}
  let deb = null;
  studioWatcher = fs.watch(STUDIO_DIR, () => {
    clearTimeout(deb);
    deb = setTimeout(() => { try { if (studioWindow && !studioWindow.isDestroyed()) studioWindow.reload(); } catch {} }, 200);
  });
  studioWindow.on('closed', () => { try { studioWatcher && studioWatcher.close(); } catch {} studioWatcher = null; });
}

// --- Embedded Claude Code terminal (node-pty + xterm) ---
function openTerminalWindow() {
  if (terminalWindow && !terminalWindow.isDestroyed()) { terminalWindow.show(); terminalWindow.focus(); return; }
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  terminalWindow = new BrowserWindow({
    width: 860, height: 600, x: Math.max(20, width - 900), y: 80,
    resizable: true, maximizable: true, minWidth: 480, minHeight: 280,
    title: 'Claude Code', backgroundColor: '#0a0f17',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload-terminal.js') }
  });
  terminalWindow.loadFile(path.join(__dirname, 'src', 'terminal.html'));
  terminalWindow.on('closed', () => {
    try { if (ptyProc) ptyProc.kill(); } catch {}
    ptyProc = null; terminalWindow = null;
  });
}

function startPty(cols, rows) {
  if (ptyProc) { try { ptyProc.kill(); } catch {} ptyProc = null; }
  const pty = require('node-pty');
  const shell = process.env.SHELL || '/bin/zsh';
  const cwd = process.env.BHATBOT_PROJECT || os.homedir();
  ptyProc = pty.spawn(shell, ['-lc', 'claude || exec ' + shell], {
    name: 'xterm-color', cols: cols || 100, rows: rows || 30, cwd,
    env: { ...process.env, PATH: EXEC_PATH, TERM: 'xterm-256color' }
  });
  const ptySend = (chan, payload) => {
    for (const w of [mainWindow, terminalWindow]) {
      try { if (w && !w.isDestroyed()) w.webContents.send(chan, payload); } catch {}
    }
  };
  ptyProc.onData((d) => ptySend('pty-data', d));
  ptyProc.onExit(() => { ptySend('pty-exit'); ptyProc = null; });
}

// --- Vosk always-on listener: "bhatbot <command>" → feed command into the agent loop ---
function startWakeHelper() {
  if (wakeProc) return;
  const script = path.join(__dirname, 'scripts', 'listen.py');
  if (!fs.existsSync(script)) return;
  try {
    wakeProc = require('child_process').spawn('python3', ['-u', script], { env: { ...process.env, PATH: EXEC_PATH } });
    let buf = '';
    const triggerWake = (cmd) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show(); mainWindow.focus();
        mainWindow.webContents.send('wake-command', { text: cmd || '' });
      }
      sendToActivity('tool-update', { type: 'thinking', text: cmd ? '🎙 wake → ' + cmd : '🎙 wake word detected — listening…' });
    };
    wakeProc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'WAKE') triggerWake('');               // bare wake → renderer arms Whisper
        else if (line.startsWith('CMD')) triggerWake(line.slice(3).trim());
        else if (line === 'READY') console.log('[wake] listener ready');
      }
    });
    // Surface python errors instead of swallowing them — this was hiding mic/model failures.
    wakeProc.stderr.on('data', (d) => {
      const s = d.toString();
      s.split('\n').forEach((ln) => {
        const t = ln.trim();
        if (!t || t.startsWith('LOG (')) return;            // drop noisy Vosk LOG lines
        if (t.startsWith('WAKE_ERR') || t.startsWith('STREAM_ERR')) {
          console.error('[wake]', t);
          sendToActivity('tool-update', { type: 'thinking', text: '⚠ wake helper: ' + t });
        } else if (t.startsWith('[wake]')) {
          console.log(t);                                   // debug lines
        }
      });
    });
    wakeProc.on('exit', (code) => { console.log('[wake] listener exited', code); wakeProc = null; });
  } catch (e) { console.warn('wake helper failed:', e.message); }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('get-api-key', () => getApiKey());
ipcMain.handle('save-api-key', (_e, key) => { saveConfig({ apiKey: key }); return true; });
ipcMain.handle('get-context-path', () => resolveContextPath());
ipcMain.handle('get-memory-path', () => MEMORY_PATH);
ipcMain.handle('open-nexus', () => { openNexusWindow(); return true; });
ipcMain.handle('open-studio', () => { openStudioWindow(); return true; });
ipcMain.handle('open-terminal', () => { openTerminalWindow(); return true; });
ipcMain.on('pty-start', (_e, { cols, rows }) => startPty(cols, rows));
ipcMain.on('pty-input', (_e, data) => { try { ptyProc && ptyProc.write(data); } catch {} });
ipcMain.on('pty-resize', (_e, { cols, rows }) => { try { ptyProc && ptyProc.resize(cols, rows); } catch {} });
ipcMain.handle('get-voice-config', () => {
  const c = loadConfig();
  const ttsProvider = c.ttsProvider || (c.elevenLabsKey ? 'elevenlabs' : (c.openaiKey ? 'openai' : (c.piperBin ? 'piper' : null)));
  const hasTTS = ttsProvider === 'elevenlabs' ? !!c.elevenLabsKey
    : ttsProvider === 'openai' ? !!c.openaiKey
    : ttsProvider === 'piper' ? !!c.piperBin : false;
  return {
    hasOpenAI: !!(c.openaiKey || (c.sttProvider === 'groq' && c.groqKey)),
    picovoiceKey: c.picovoiceKey || null, wakeWord: c.wakeWord || 'jarvis', silenceMs: c.silenceMs || 2000,
    ttsEnabled: c.ttsEnabled !== false, ttsProvider, hasTTS,
    hasReplicateKey: !!c.replicateKey, hasImageGen: !!c.openaiKey
  };
});
// Multi-provider TTS — openai (default, deep male "onyx"), elevenlabs (real JARVIS voice), piper (offline)
// Plain function so both the IPC handler (desktop HUD) and the express server (phone PWA) can call it.
async function synthesizeSpeech(text) {
  const c = loadConfig();
  const t = (text || '').trim();
  if (!t) return { error: 'empty text' };
  const provider = c.ttsProvider || (c.elevenLabsKey ? 'elevenlabs' : (c.openaiKey ? 'openai' : (c.piperBin ? 'piper' : null)));
  try {
    if (provider === 'elevenlabs') {
      if (!c.elevenLabsKey) return { error: 'no elevenLabsKey' };
      const voiceId = c.ttsVoice || c.elevenLabsVoiceId || 'pNInz6obpgDQGcFmaJgB'; // default deep male (Adam); set a JARVIS voice id
      const model = c.ttsModel || 'eleven_turbo_v2_5';
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: 'POST', headers: { 'xi-api-key': c.elevenLabsKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t, model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25 } })
      });
      if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); return { success: true, audio: buf.toString('base64'), mimeType: 'audio/mpeg', via: 'elevenlabs' }; }
      // quota/auth/rate → fall back to OpenAI onyx so voice never dies mid-session
      if (![401, 402, 429].includes(r.status) || !c.openaiKey) return { error: `elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}` };
    }
    if (provider === 'piper') {
      if (!c.piperBin) return { error: 'no piperBin' };
      const model = c.piperModel || path.join(os.homedir(), '.bhatbot', 'piper', 'jarvis.onnx');
      const out = path.join(os.tmpdir(), `bhatbot-tts-${Date.now()}.wav`);
      await new Promise((res, rej) => {
        const p = spawn(c.piperBin, ['--model', model, '--output_file', out], { env: { ...process.env, PATH: EXEC_PATH } });
        p.on('error', rej); p.on('close', (code) => code === 0 ? res() : rej(new Error('piper exit ' + code)));
        p.stdin.write(t); p.stdin.end();
      });
      const buf = fs.readFileSync(out); fs.unlink(out, () => {});
      return { success: true, audio: buf.toString('base64'), mimeType: 'audio/wav' };
    }
    // default: OpenAI
    if (!c.openaiKey) return { error: 'no TTS provider configured (set openaiKey, elevenLabsKey, or piperBin)' };
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + c.openaiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: c.openaiTtsModel || 'gpt-4o-mini-tts', voice: c.openaiTtsVoice || 'onyx', input: t, response_format: 'mp3',
        instructions: c.ttsInstructions || 'Calm, refined British butler. Measured, crisp, understated wit — like J.A.R.V.I.S.' })
    });
    if (!r.ok) return { error: `openai-tts ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const buf = Buffer.from(await r.arrayBuffer());
    return { success: true, audio: buf.toString('base64'), mimeType: 'audio/mpeg', via: 'openai' };
  } catch (e) { return { error: e.message }; }
}
ipcMain.handle('synthesize-speech', (_e, { text }) => synthesizeSpeech(text));

// Plain STT function (shared by desktop HUD + phone PWA). iOS MediaRecorder emits
// audio/mp4, not webm — derive the upload filename ext from mimeType so Whisper sniffs it.
async function transcribeAudio(audioBuffer, mimeType) {
  const c = loadConfig();
  const useGroq = c.sttProvider === 'groq' && c.groqKey;             // fastest path (opt-in)
  const endpoint = useGroq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
  const key = useGroq ? c.groqKey : c.openaiKey;
  if (!key) return { error: 'No STT key (set openaiKey, or groqKey + sttProvider="groq").' };
  const primary = c.sttModel || (useGroq ? 'whisper-large-v3-turbo' : 'gpt-4o-mini-transcribe');
  const mt = (mimeType || 'audio/webm').split(';')[0].trim();
  const ext = mt === 'audio/mp4' || mt === 'audio/m4a' || mt === 'audio/aac' ? 'm4a'
    : mt === 'audio/mpeg' ? 'mp3' : mt === 'audio/wav' || mt === 'audio/x-wav' ? 'wav'
    : mt === 'audio/ogg' ? 'ogg' : 'webm';
  const buf = Buffer.from(audioBuffer);
  const attempt = async (model) => {
    const form = new FormData();
    form.append('model', model);
    form.append('file', new Blob([buf], { type: mt }), 'audio.' + ext);
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Authorization': 'Bearer ' + key }, body: form });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, text: (j.text || '').trim(), err: j.error?.message };
  };
  try {
    let res = await attempt(primary);
    if (!res.ok && !useGroq && primary !== 'whisper-1') res = await attempt('whisper-1'); // fallback if model unavailable on account
    if (!res.ok) return { error: res.err || `STT ${res.status}` };
    return { success: true, text: res.text, model: primary };
  } catch (e) {
    return { error: e.message };
  }
}
ipcMain.handle('transcribe-audio', (_e, { audioBuffer, mimeType }) => transcribeAudio(audioBuffer, mimeType));

// Spoken-summary: long replies get condensed for voice (the full text still shows on
// screen / can be read in full on demand). Lightweight Haiku call, no tools.
async function summarizeForSpeech(text) {
  const t = (text || '').trim();
  if (!t) return { error: 'empty text' };
  const apiKey = getApiKey();
  if (!apiKey) return { error: 'no api key' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL_HAIKU, max_tokens: 200,
        system: "You are a British butler (J.A.R.V.I.S.) condensing a written reply for spoken delivery. Give a crisp 1–2 sentence spoken summary capturing the key point and any direct answer. No preamble, no markdown, no lists, no code — just the spoken line.",
        messages: [{ role: 'user', content: t }]
      })
    });
    if (!res.ok) return { error: `summary ${res.status}` };
    const j = await res.json();
    const out = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    return out ? { success: true, text: out } : { error: 'empty summary' };
  } catch (e) { return { error: e.message }; }
}
ipcMain.handle('summarize-for-speech', (_e, { text }) => summarizeForSpeech(text));

// Free local TTS (macOS `say`) — used by the desktop HUD for ultra-short replies
// (<80 chars) to avoid an API call. Default voice Daniel = British (Jarvis-ish).
function sayLocal(text) {
  const c = loadConfig();
  const v = c.ttsLocalVoice || 'Daniel';
  const t = String(text || '').slice(0, 400);
  if (!t.trim()) return { success: false };
  try {
    const p = spawn('say', ['-v', v, t]);
    p.on('error', () => { try { spawn('say', [t]); } catch {} });   // voice missing → default
  } catch { try { spawn('say', [t]); } catch {} }
  return { success: true };
}
ipcMain.handle('say-local', (_e, { text }) => sayLocal(text));

// Set + persist the daily-briefing hour, then reschedule.
ipcMain.handle('set-briefing-hour', (_e, { hour }) => {
  const h = Math.max(0, Math.min(23, Number(hour)));
  saveConfig({ briefingHour: h, briefingEnabled: true });
  scheduleBriefing();
  return { success: true, hour: h };
});

// Live health stats for the activity-window status strip.
ipcMain.handle('get-health', async () => {
  const dir = path.join(os.homedir(), '.bhatbot');
  const memPath = path.join(dir, 'memory.md');
  const auditPath = path.join(dir, 'audit.log');
  let todayEntries = 0, estimatedCost = 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean);
    todayEntries = lines.filter((l) => l.includes(today)).length;
    estimatedCost = todayEntries * 0.004;
  } catch {}
  let memEntries = 0, memKb = 0;
  try {
    const mem = fs.readFileSync(memPath, 'utf8');
    memEntries = (mem.match(/^- /gm) || []).length;
    memKb = Math.round(Buffer.byteLength(mem) / 1024 * 10) / 10;
  } catch {}
  let ollamaOnline = false;
  try { const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(500) }); ollamaOnline = r.ok; } catch {}
  const cfg = loadConfig();
  return {
    todayEntries, estimatedCost: `$${estimatedCost.toFixed(3)}`,
    memEntries, memKb, ollamaOnline, agentState,
    telegram: !!cfg.telegramToken, briefingHour: cfg.briefingHour ?? null
  };
});
ipcMain.handle('hide-window', () => mainWindow && mainWindow.hide());
ipcMain.handle('minimize-window', () => mainWindow && mainWindow.minimize());
ipcMain.handle('pick-directory', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// Import screenshots / photos / screen recordings → vision blocks for the next message.
ipcMain.handle('pick-media', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images & Video', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'mov', 'mp4', 'm4v', 'webm'] }]
  });
  if (r.canceled) return { blocks: [], names: [] };
  const blocks = [], names = [];
  for (const p of r.filePaths) { blocks.push(...await mediaFileToBlocks(p)); names.push(path.basename(p)); }
  return { blocks, names };
});
ipcMain.handle('chat', async (event, { history }) => {
  const apiKey = getApiKey();
  if (!apiKey) return { error: 'No ANTHROPIC_API_KEY in env or ~/.bhatbot/config.json' };
  try { return await agentLoop(history, apiKey, (event && event.sender ? event : { sender: { send() {} } })); }
  catch (e) { return { error: String(e && e.message ? e.message : e) }; }
});
ipcMain.on('agent-pause', () => { if (agentState === 'running') agentState = 'paused'; });
ipcMain.on('agent-resume', () => { if (agentState === 'paused') agentState = 'running'; });
ipcMain.on('agent-stop', () => { agentState = 'stopped'; });
ipcMain.on('agent-guidance', (_e, { text }) => { if (text && text.trim()) pendingGuidance.push(text.trim()); });
ipcMain.handle('save-guidance-pref', (_e, text) => saveMemoryEntry('Preferences & Patterns', text));
ipcMain.on('confirm-response', (_e, { id, approved }) => {
  const r = pendingConfirms.get(id);
  if (r) { r(!!approved); pendingConfirms.delete(id); }
});
ipcMain.handle('get-playwright-screenshot', async () => {
  try { if (!page) return null; return (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64'); }
  catch { return null; }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  try {
    createWindow();
    mainWindow.show();
    if (!globalShortcut.register(HOTKEY, toggleWindow)) console.warn('Hotkey failed — may be claimed by another app.');
    startWakeHelper();
    initMcpServer();
    startTelegramBridge();
    scheduleBriefing();
  } catch (e) { console.error('Startup error:', e); }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  try { if (browser) await browser.close(); } catch {}
  try { if (wakeProc) wakeProc.kill(); } catch {}
  try { if (ptyProc) ptyProc.kill(); } catch {}
  try { stopMcpServer(); } catch {}
  try { if (briefingTimer) clearTimeout(briefingTimer); } catch {}
  try { if (telegramBot) telegramBot.stopPolling(); } catch {}
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
