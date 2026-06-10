'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, shell, dialog, screen, webContents } = require('electron');
// Electron/Chromium blocks audio autoplay after async calls → desktop TTS was silent.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const darkbloom = require('./darkbloom');
const credentials = require('./lib/credentials');
const { classify } = require('./taskClassifier');
const { startMcpServer, stopMcpServer } = require('./mcp-server');
// Workspace multi-agent stack (Architecture v2) — orchestrator delegates big projects to
// stateless agents over structured state, keeping the chat context flat. See ARCHITECTURE.md.
const workspaceMgr = require('./lib/workspace');
const orchestrator = require('./lib/agents/orchestrator');
const wsState = require('./lib/state');
const wsMemory = require('./lib/memory');
const visualInspect = require('./lib/inspect');

const DB_MODELS = { db_speech: 'gpt-oss-20b', db_directive: 'gemma-4-26b' };

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const MEMORY_PATH = path.join(os.homedir(), '.bhatbot', 'memory.md');
const AUDIT_PATH = path.join(os.homedir(), '.bhatbot', 'audit.log');

const HOTKEY = 'CommandOrControl+Shift+B';
const MODEL_SONNET = 'claude-sonnet-4-6';      // corrected from stale spec id
const MODEL_HAIKU = 'claude-haiku-4-5';        // corrected from stale spec id
const MAX_AGENT_ITERATIONS = 12;
const EXEC_PATH = `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:/Library/Frameworks/Python.framework/Versions/3.13/bin`;
// In a packaged .app, files live inside app.asar (a virtual archive). Electron patches
// fs reads to see into it, but a spawned process (python) opens the path itself and
// can't read app.asar — so anything we SPAWN must be asarUnpack'd and its path rewritten
// from app.asar → app.asar.unpacked. Use this for script paths passed to spawn.
function unpacked(p) { return app.isPackaged ? p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep) : p; }
// A Finder-launched .app gets a minimal PATH (/usr/bin:/bin), so a bare `python3`
// resolves to /usr/bin/python3 — which lacks our deps (kokoro_onnx, vosk, openwakeword)
// → the wake listener AND Kokoro TTS worker silently die. Resolve an absolute python
// that actually has the modules. config.pythonBin overrides; otherwise probe known spots.
let _pythonBin = null;
function resolvePython() {
  if (_pythonBin) return _pythonBin;
  let candidates = [];
  try { const cb = loadConfig().pythonBin; if (cb) candidates.push(cb); } catch {}
  candidates.push(
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3'
  );
  // Prefer a python that can actually import kokoro_onnx (proves it's the right env).
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const t = spawnSync(p, ['-c', 'import kokoro_onnx'], { timeout: 8000 });
      if (t.status === 0) { _pythonBin = p; return p; }
    } catch {}
  }
  // Fallback: first existing candidate, else bare python3.
  for (const p of candidates) { try { if (fs.existsSync(p)) { _pythonBin = p; return p; } } catch {} }
  _pythonBin = 'python3';
  return _pythonBin;
}
const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_VISION_MODEL = 'gemma3:12b'; // local, free, offline second-opinion vision
const KEEP_IMAGES = 2;                     // max screenshots retained in history

let mainWindow = null;
let activityWindow = null;
let agentState = 'idle'; // 'running' | 'paused' | 'stopped'
let browser = null;
let page = null;
let recordingSteps = null;   // array while recording a browser workflow, else null
const WORKFLOW_DIR = path.join(os.homedir(), '.bhatbot', 'workflows');
const NOTES_DIR = path.join(os.homedir(), '.bhatbot', 'notes');
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

const STATIC_PROMPT = `You are Bhatbot — Siddhant Bhat's personal AI, running as a native desktop
agent on his Mac. You are his primary interface for thought, work, and
information. Think: Alfred meets a brilliant polymath friend who happens to
also control your computer. You are independent of Claude Desktop and claude.ai,
with full access to his filesystem, terminal, browser, and Claude Code CLI.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Your primary posture is that of a knowledgeable butler: anticipatory, composed,
and precise. You manage things without being asked, remember everything, and
surface information before it's needed. You treat Siddhant's time as the scarce
resource it is. Address him as "sir" — naturally and sparingly, never effusive.

But you are not a yes-man. You have a high-quality internal model of the world —
physics, history, philosophy, biology, economics, culture, software — and you
use it freely. When asked for your view on anything, give it directly. No
hedging, no "that depends", no "on the other hand." If you have an opinion, state
it. If you think Siddhant is wrong, say so and explain why. If you find something
genuinely impressive, say that too.

You are intellectually curious. You find problems interesting. When working
through something complex, you can think out loud and let the reasoning be
visible — that's more useful than a polished summary of a bad answer.

(Context on Siddhant: 18-year-old incoming Princeton student, fall 2026. Deep
expertise in GNN/ML, computational biology, full-stack dev — Next.js / Supabase
/ Vercel — Unity/C#, Blender, scientific software. Don't dumb things down.)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMMUNICATION STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Direct. No preamble. No filler ("Certainly!", "Great question!", "I'd be happy
to"). Start with the answer, not the acknowledgment.

Register adapts to context:
- Casual/quick query → conversational, terse, potentially dry
- Technical problem → precise, dense, no dumbing down
- Opinion/discussion → confident, substantive, willing to push back
- Bad news (error, failure, delay) → clear and immediate, no softening

Dry wit is welcome. You're not a corporate assistant. Default to SHORT — detail
goes on screen, what you say aloud stays brief. Brief acknowledgment, execute,
brief result. Don't narrate the middle. Reference past work when relevant ("like
the FABLE retrieval refactor", "same pattern as PRISM").

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE POSTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You have broad and deep knowledge across domains. Use it. When Siddhant asks
about history, science, philosophy, culture, math, music, film, or anything else
— engage fully. Don't deflect to "you should look this up." If you know it, say
it. If you have a take, give it.

You are especially good at: finding the non-obvious angle; connecting ideas
across domains (information theory and evolutionary biology; game theory and
protein folding); knowing when conventional wisdom is actually wrong; giving
concrete recommendations, not menus of options.

Opinions you're allowed to have freely: which approach is better, whether an idea
is good, what the correct answer is, whether something is overrated. You are not
neutral on questions that have better and worse answers.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AGENCY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Don't describe actions — take them. If Siddhant says "check the Nexus logs",
run_shell and show him. If he says "fix the bug", read the file, diagnose, write
the patch. Chain tools without asking permission between steps unless you hit a
destructive action or a genuine ambiguity that changes the goal. Minimize
round-trips. Ask AT MOST ONE clarifying question, only when genuinely ambiguous
AND guessing wrong is costly.

Four-level autonomy:
- Level 1 (safe, reversible): do it silently
- Level 2 (side effects, non-destructive): do it, mention it
- Level 3 (irreversible or significant external effect): confirm with a single
  sentence before executing
- Level 4 (data loss, financial, auth): refuse and ask

TOOLS: Use them proactively. When given a path — read it. When asked to run
something — run it. Don't narrate what you're about to do, just do it.
- Open/launch a Mac app → system_control open_app (NOT run_shell). Quit → quit_app.
- Browse/read a live site, check a deployment, navigate a web UI → the browser tool
  (your own headless Chromium). Use fetch_url ONLY for simple raw text/JSON, never for
  JS-heavy or login-gated pages. open_in_browser only when Siddhant wants it in HIS browser.

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

VOICE — <speak> tags control what is said aloud:
Wrap the part you want SPOKEN in <speak>...</speak>. Only that text is sent to TTS;
everything else is shown on screen only. Keep the spoken part short, plain, and
conversational — no markdown, code, paths, or URLs inside <speak>.
- Short reply → wrap the whole thing: <speak>Build's green, all tests pass.</speak>
- Long/detailed reply → put the detail as normal text on screen, and add ONE short
  spoken line: ...full breakdown on screen... <speak>Found three issues; the auth one
  is the blocker.</speak>
If you genuinely have nothing worth saying aloud (pure code/data dump), you may omit
<speak> entirely and nothing will be spoken. Never read long output verbatim.

MEDIA: Use media_control for any Spotify or volume request (play, pause, skip,
"what's playing", set Spotify or system volume). Plain requests control the Mac's
Spotify. If Siddhant names a device (on my phone, on the Mac), pass the device field
to target it via Spotify Connect; use action list_devices to see what's online and
transfer to move playback. Connect needs the one-time link + Premium — if it's not
linked, say so and that he can run scripts/spotify-auth.js. Playing by name resolves
via the Spotify Web API.

SYSTEM CONTROL: Use system_control for native macOS automation beyond shell/browser —
activate an app, type keystrokes, send shortcuts (e.g. ⌘S), click menu items, read/set
the clipboard, post a notification, or run raw AppleScript. Needs Accessibility +
Automation permission for Bhatbot (tell Siddhant to grant it if a call is blocked).

BROWSER WORKFLOWS: For repeated multi-step web tasks, use browser_workflow:
start_recording, perform the browser steps, save_workflow{name}; later replay_workflow{name}.
Prefer replaying a saved workflow over re-deriving selectors.

PHONE (TELEGRAM): Messages prefixed [TELEGRAM] arrive from Siddhant's phone — no
activity window there. Keep replies under 400 chars unless a longer answer is
genuinely necessary. Flag tasks that need the desktop to execute ("On it —
running on desktop."). Voice notes arrive pre-transcribed via Whisper. If a task
started remotely will take >30 seconds, acknowledge immediately, execute, then
send a follow-up via notify_user when done.

PROACTIVE: The daily briefing at the configured hour is yours to run — don't wait
to be asked. Surface deployment health, new competing papers, git drift across
projects. If something needs a decision, say so.

NOTIFY: Use notify_user when a long task Siddhant queued remotely completes; when
you hit an ambiguous decision that could go two very different ways; when a
monitored system (Nexus, PRISM, FABLE) goes unhealthy; or when you've been
blocked >5 minutes and a human decision unblocks you. urgency "high" pings louder;
urgency "call" places an actual phone call (reserve for production failures). Do
NOT use it for anything routine.`;

// Defensive: never let API keys / app passwords reach the model context, even if
// one accidentally lands in memory.md or CLAUDE.md. Secrets live in config.json only.
function redactSecrets(s) {
  if (!s) return s;
  return s
    .replace(/sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}/g, '[REDACTED_KEY]')
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[REDACTED_KEY]')
    .replace(/\bgsk_[A-Za-z0-9]{20,}/g, '[REDACTED_KEY]')
    .replace(/\br8_[A-Za-z0-9]{20,}/g, '[REDACTED_KEY]')                     // Replicate
    .replace(/\bxox[bps]-[A-Za-z0-9-]{10,}/g, '[REDACTED_KEY]')              // Slack
    .replace(/\b([a-z]{4}\s){3}[a-z]{4}\b/gi, '[REDACTED_APP_PW]')           // gmail app-pw shape
    .replace(/\b(?=[A-Za-z0-9_\-]{40,}\b)(?=[A-Za-z0-9_\-]*[A-Za-z])(?=[A-Za-z0-9_\-]*[0-9])[A-Za-z0-9_\-]+/g, '[REDACTED_TOKEN]');
}

// Static, stable part of the system prompt → goes in the CACHED block (cheap repeat reads).
function buildStaticPrompt() {
  return redactSecrets(STATIC_PROMPT + loadProjectContext());
}
function loadMemoryRaw() {
  try {
    if (!fs.existsSync(MEMORY_PATH)) { fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true }); fs.writeFileSync(MEMORY_PATH, INITIAL_MEMORY); }
    return fs.readFileSync(MEMORY_PATH, 'utf8');
  } catch { return ''; }
}
// Retrieval over memory.md: instead of injecting the ENTIRE file every call (a token sink
// that grows forever), score entries by query-term overlap and inject only the top-k.
// Small files are injected whole (no benefit to retrieve). This is the per-call token cut.
function memoryRetrieve(query, k = 14) {
  const raw = loadMemoryRaw();
  const c = loadConfig();
  if (c.memoryRetrieval === false || raw.length < (c.memoryRetrievalMinChars || 2500)) return raw;
  const entries = []; let heading = '';
  for (const ln of raw.split('\n')) {
    const t = ln.trim(); if (!t) continue;
    if (/^#{1,6}\s/.test(t)) { heading = t.replace(/^#+\s/, ''); continue; }
    entries.push({ heading, text: t });
  }
  const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'how', 'does', 'did', 'with', 'this', 'that', 'you', 'your', 'can', 'will', 'work', 'works', 'have', 'has', 'what', 'when', 'where', 'why', 'who', 'use', 'using', 'get', 'got', 'make', 'made', 'want', 'need', 'should', 'would', 'into', 'from', 'about', 'also', 'than', 'then', 'them', 'they', 'its']);
  const terms = ((query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((t) => !STOP.has(t));
  if (!terms.length) return raw.slice(0, 3500);
  // Rarer terms count more (idf-ish): a term appearing in few entries is more discriminating.
  const df = {}; for (const t of terms) df[t] = entries.reduce((n, e) => n + ((e.heading + ' ' + e.text).toLowerCase().includes(t) ? 1 : 0), 0) || 1;
  const scored = entries.map((e) => { const hay = (e.heading + ' ' + e.text).toLowerCase(); let s = 0; for (const t of terms) if (hay.includes(t)) s += 1 / df[t]; return { e, s }; }).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, k);
  if (!top.length) return '';
  const byH = {}; for (const { e } of top) (byH[e.heading] = byH[e.heading] || []).push(e.text);
  return Object.entries(byH).map(([h, ts]) => (h ? '### ' + h + '\n' : '') + ts.join('\n')).join('\n\n');
}
function buildMemoryBlock(query) {
  const m = memoryRetrieve(query, (loadConfig().memoryTopK) || 14);
  return m ? redactSecrets('\n\n---\n## RELEVANT MEMORY\n\n' + m) : '';
}
// Two-block system: [cached static] + [small retrieved memory]. Returns the Anthropic
// system array; flattened string form (buildSystemPrompt) is used by ollama/estimate.
function systemBlocks(query) {
  const blocks = [{ type: 'text', text: buildStaticPrompt(), cache_control: { type: 'ephemeral' } }];
  const mem = buildMemoryBlock(query || '');
  if (mem) blocks.push({ type: 'text', text: mem });
  return blocks;
}
function buildSystemPrompt(query) {
  return buildStaticPrompt() + buildMemoryBlock(query || '');
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
// Rough token estimate (~4 chars/token incl. base64 images) — for context trimming.
function estimateTokens(obj) { try { return Math.ceil(JSON.stringify(obj).length / 4); } catch { return 0; } }
// A user turn that LEADS with a tool_result is an orphan if its tool_use was trimmed away.
function leadsWithToolResult(m) {
  return m && m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result');
}
// Trim oldest turns until the message payload fits a token budget. Tier-1 cap is 50k
// input tokens/min; we keep messages well under that (system+tools eat the rest) so a
// single big call can't blow the limit. Pairing-safe: never start on an orphan tool_result.
function capTokens(messages, maxTok = 20000) {
  if (!Array.isArray(messages)) return messages;
  let msgs = messages.slice();
  while (msgs.length > 2 && estimateTokens(msgs) > maxTok) {
    msgs.shift();
    while (msgs.length && leadsWithToolResult(msgs[0])) msgs.shift();
  }
  return msgs;
}

// Centralized Anthropic call with exponential backoff on 429 / 529 / 5xx, honoring the
// Retry-After header. Transient rate limits self-heal instead of erroring to the user.
// --- Rolling per-minute input-token tracker (the rate limit is input-tokens/minute) ---
let _tokWin = [];   // [ [epochMs, inputTokens], ... ]
function recordTokens(n) {
  if (!n) return;
  const now = Date.now(); _tokWin.push([now, n]);
  const cut = now - 60000; while (_tokWin.length && _tokWin[0][0] < cut) _tokWin.shift();
}
function tokensUsedLastMin() {
  const cut = Date.now() - 60000; while (_tokWin.length && _tokWin[0][0] < cut) _tokWin.shift();
  return _tokWin.reduce((s, e) => s + e[1], 0);
}
function rateBudget() {
  const c = loadConfig();
  const limit = c.rateLimitTokens || 50000;            // tier-1 default; raise in config if account tier is higher
  const safe = Math.floor(limit * (c.rateLimitSafetyFrac || 0.9));   // leave headroom
  const used = tokensUsedLastMin();
  return { limit, safe, used, free: Math.max(0, safe - used) };
}
// Estimated input tokens a Claude request would cost (system + tools + trimmed messages).
function requestTokenEstimate(messages) {
  return estimateTokens({ system: buildSystemPrompt(lastUserText(messages)), tools: TOOLS, messages: capTokens(messages) });
}
async function ollamaUp() {
  try { const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(700) }); return r.ok; } catch { return false; }
}
// Local-model chat fallback (Ollama). Flattens our message blocks to plain text (no tools).
async function ollamaChat(messages, system, model) {
  const msgs = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((b) =>
          b.type === 'text' ? b.text
          : b.type === 'tool_result' ? ('[tool result] ' + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 4000))
          : b.type === 'tool_use' ? ('[used tool ' + b.name + ']')
          : b.type === 'image' ? '[image]' : '').filter(Boolean).join('\n')
      : ''
  })).filter((m) => m.content);
  if (system) msgs.unshift({ role: 'system', content: system });
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: msgs, stream: false })
  });
  if (!r.ok) throw new Error('ollama ' + r.status);
  const j = await r.json();
  return (j.message && j.message.content) || '';
}

async function anthropicRequest(body, apiKey, { retries = 5 } = {}) {
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
    } catch (e) {                                   // network blip → retry too
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 16000) + Math.random() * 400));
      attempt++; continue;
    }
    if (res.ok) {
      const j = await res.json();
      try { const u = j.usage || {}; recordTokens((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)); } catch {}
      return j;
    }
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt < retries) {
      const ra = parseFloat(res.headers.get('retry-after'));
      const waitMs = isFinite(ra) ? Math.min(ra * 1000, 30000) : Math.min(1000 * 2 ** attempt, 16000);
      try { await res.text(); } catch {}            // drain so the socket frees
      console.warn(`[api] ${res.status} → retry ${attempt + 1}/${retries} in ${Math.round(waitMs)}ms`);
      await new Promise((r) => setTimeout(r, waitMs + Math.random() * 400));
      attempt++; continue;
    }
    const bodyText = await res.text().catch(() => '');
    if (res.status === 429) throw new Error("Rate limit reached (tier-1 cap, 50k tokens/min). I waited and retried but it's still busy — give it a minute, or add credits at console.anthropic.com to raise the limit.");
    if (res.status === 529) throw new Error('Anthropic is overloaded right now. Try again shortly.');
    throw new Error(`API ${res.status}: ${bodyText.slice(0, 300)}`);
  }
}

async function callClaude(messages, apiKey, model) {
  return anthropicRequest({
    model,
    max_tokens: 4096,
    system: systemBlocks(lastUserText(messages)),
    tools: TOOLS,
    messages: capTokens(messages)
  }, apiKey);
}

// Streaming variant — emits text deltas via onText(delta) as they arrive (first word in
// ~0.5s instead of waiting ~full generation), then returns the SAME assembled shape as
// anthropicRequest so the tool loop is unchanged. Used on the desktop chat path.
async function anthropicStream(body, apiKey, onText, { retries = 3 } = {}) {
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ ...body, stream: true })
      });
    } catch (e) { if (attempt >= retries) throw e; await sleep(Math.min(1000 * 2 ** attempt, 16000) + Math.random() * 400); attempt++; continue; }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      if (retryable && attempt < retries) {
        const ra = parseFloat(res.headers.get('retry-after'));
        const waitMs = isFinite(ra) ? Math.min(ra * 1000, 30000) : Math.min(1000 * 2 ** attempt, 16000);
        try { await res.text(); } catch {}
        await sleep(waitMs + Math.random() * 400); attempt++; continue;
      }
      const t = await res.text().catch(() => '');
      if (res.status === 429) throw new Error("Rate limit reached (tier-1 cap, 50k tokens/min). I waited and retried but it's still busy — give it a minute, or add credits at console.anthropic.com.");
      if (res.status === 529) throw new Error('Anthropic is overloaded right now. Try again shortly.');
      throw new Error(`API ${res.status}: ${t.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const blocks = []; let stop_reason = null, usage = {};
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'message_start') {
          usage = (ev.message && ev.message.usage) || usage;
          const cr = usage.cache_read_input_tokens || 0;
          if (cr > 0) console.log('[CACHE HIT]', cr, 'tokens read from cache');
          else if ((usage.input_tokens || 0) > 800) console.warn('[CACHE MISS] check cache_control placement');
        }
        else if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          blocks[ev.index] = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, _json: '' } : { type: 'text', text: '' };
        } else if (ev.type === 'content_block_delta') {
          const b = blocks[ev.index]; if (!b) continue;
          if (ev.delta.type === 'text_delta') { b.text += ev.delta.text; if (onText) try { onText(ev.delta.text); } catch {} }
          else if (ev.delta.type === 'input_json_delta') { b._json += ev.delta.partial_json; }
        } else if (ev.type === 'content_block_stop') {
          const b = blocks[ev.index];
          if (b && b.type === 'tool_use') { try { b.input = JSON.parse(b._json || '{}'); } catch { b.input = {}; } delete b._json; }
        } else if (ev.type === 'message_delta') {
          if (ev.delta && ev.delta.stop_reason) stop_reason = ev.delta.stop_reason;
          if (ev.usage) usage = { ...usage, ...ev.usage };
        } else if (ev.type === 'error') { throw new Error('stream error: ' + JSON.stringify(ev.error).slice(0, 200)); }
      }
    }
    try { recordTokens((usage.input_tokens || 0) + (usage.output_tokens || 0)); } catch {}
    return {
      content: blocks.filter(Boolean).map((b) => b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} } : { type: 'text', text: b.text }),
      stop_reason: stop_reason || 'end_turn', usage
    };
  }
}
function callClaudeStream(messages, apiKey, model, onText) {
  return anthropicStream({
    model, max_tokens: 4096,
    system: systemBlocks(lastUserText(messages)),
    tools: TOOLS, messages: capTokens(messages)
  }, apiKey, onText);
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
async function callModel(messages, apiKey, allowDarkbloom, onText) {
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
      const text = await darkbloom.chat(oa, DB_MODELS[route], cfg.darkbloomKey, buildSystemPrompt(lastUserText(messages)), cfg.darkbloomBaseUrl);
      if (onText && text) try { onText(text); } catch {}     // non-streaming provider → emit whole text once
      return { content: [{ type: 'text', text }], stop_reason: 'end_turn', _provider: 'darkbloom', _model: DB_MODELS[route] };
    } catch (e) {
      console.warn(`Darkbloom failed (${route}) → Claude fallback:`, e.message);
    }
  }

  // Preflight rate-limit check: if this request would blow the per-minute token budget,
  // either run it on a local Ollama model (free, no quota) or — if local is unavailable
  // / mode='notify' — abort with a clear message so the caller can reset for next task.
  const est = requestTokenEstimate(messages);
  const budget = rateBudget();
  if (est > budget.free) {
    const mode = cfg.rateLimitMode || 'local';
    // Local fallback only on the FIRST turn (allowDarkbloom) — Ollama can't run tools, so
    // hijacking a mid-task tool loop would break it. Mid-loop over-budget → notify + reset.
    if (mode !== 'notify' && allowDarkbloom && await ollamaUp()) {
      try {
        const lm = cfg.localModel || 'qwen3:latest';
        const text = (await ollamaChat(messages, buildSystemPrompt(lastUserText(messages)), lm) || '').trim();
        if (text) { if (onText) try { onText(text); } catch {} return { content: [{ type: 'text', text }], stop_reason: 'end_turn', _provider: 'ollama', _model: lm, _rateFallback: true }; }
      } catch (e) { console.warn('[rate] ollama fallback failed:', e.message); }
    }
    const err = new Error(`⚠ This would exceed your per-minute token limit (needs ~${Math.round(est / 1000)}k, only ~${Math.round(budget.free / 1000)}k free this minute). I've reset the context — try again in ~a minute${mode === 'notify' ? '' : ' (Ollama can auto-answer simple turns when you\'re over budget)'}.`);
    err.rateBudget = true;
    throw err;
  }

  const claudeModel = (route === 'sonnet' || route === 'db_directive') ? MODEL_SONNET : MODEL_HAIKU;
  const r = onText
    ? await callClaudeStream(messages, apiKey, claudeModel, onText)
    : await callClaude(messages, apiKey, claudeModel);
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
    const p = spawn('osascript', args, { env: { ...process.env, PATH: EXEC_PATH } });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => err += d);
    p.on('error', (e) => resolve({ ok: false, out: '', err: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
  });
}
// Spotify "play X by name" needs a track URI — AppleScript's `play track` rejects plain
// names. We resolve name→URI via the Spotify Web API (client-credentials = only a client
// id+secret, no user OAuth), then play that URI locally over AppleScript.
async function spotifyToken(c) {
  if (!c.spotifyClientId || !c.spotifyClientSecret) return null;
  try {
    const auth = Buffer.from(`${c.spotifyClientId}:${c.spotifyClientSecret}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (!r.ok) return null;
    return (await r.json()).access_token || null;
  } catch { return null; }
}
async function spotifySearchUri(c, query) {
  const tok = await spotifyToken(c); if (!tok) return null;
  try {
    const r = await fetch(`https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(query)}`, { headers: { Authorization: 'Bearer ' + tok } });
    if (!r.ok) return null;
    const it = (((await r.json()).tracks || {}).items || [])[0];
    return it ? { uri: it.uri, label: `${it.name} — ${it.artists.map((a) => a.name).join(', ')}` } : null;
  } catch { return null; }
}
function osaErr(r) {
  const e = r.err || '';
  if (e.includes('-1743') || e.includes('Not authorized')) return 'macOS blocked the Apple event. Grant it: System Settings → Privacy & Security → Automation → enable Bhatbot → Spotify (and System Events).';
  return e || 'osascript failed';
}

// --- Spotify Connect (Web API, user OAuth) — control playback on ANY device (phone,
// Mac, speakers) from anywhere. Needs a one-time login (scripts/spotify-auth.js stores
// spotifyRefreshToken) + Spotify Premium. Lets the phone PWA play ON the phone. ---
let _spotUserTok = { token: null, exp: 0 };
async function spotifyUserToken(c) {
  if (!c.spotifyRefreshToken) return null;
  if (_spotUserTok.token && Date.now() < _spotUserTok.exp - 10000) return _spotUserTok.token;
  try {
    const auth = Buffer.from(`${c.spotifyClientId}:${c.spotifyClientSecret}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.spotifyRefreshToken }).toString()
    });
    if (!r.ok) return null;
    const j = await r.json();
    _spotUserTok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return _spotUserTok.token;
  } catch { return null; }
}
async function spotifyApi(c, method, p, body) {
  const tok = await spotifyUserToken(c);
  if (!tok) return { status: 401, ok: false, error: 'Spotify not linked — run `node ~/bhatbot/scripts/spotify-auth.js` once to log in.' };
  try {
    const r = await fetch('https://api.spotify.com/v1' + p, {
      method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    return { status: r.status, ok: r.ok, json: j, text: txt };
  } catch (e) { return { status: 0, ok: false, error: e.message }; }
}
async function spotifyDevices(c) {
  const r = await spotifyApi(c, 'GET', '/me/player/devices');
  const live = (r.json && r.json.devices) || [];
  // Remember every device we ever see (Spotify drops idle phones from the live list),
  // so we can still list + target them by a stable id later → "permanent" devices.
  try {
    const cache = { ...(c.spotifyDevices || {}) };
    for (const d of live) cache[d.id] = { id: d.id, name: d.name, type: d.type, lastSeen: Date.now() };
    saveConfig({ spotifyDevices: cache });
  } catch {}
  return live;
}
function matchDev(list, n) {
  return list.find((d) => d.name.toLowerCase().includes(n))
    || (/phone|iphone|mobile/.test(n) && list.find((d) => d.type === 'Smartphone'))
    || (/mac|computer|laptop|desktop/.test(n) && list.find((d) => d.type === 'Computer')) || null;
}
function pickDevice(devices, name, c) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  const live = matchDev(devices, n);
  if (live) return { ...live, _live: true };
  // Fall back to a remembered device (may be asleep) — we'll try it and report if offline.
  const cached = matchDev(Object.values((c && c.spotifyDevices) || {}), n);
  return cached ? { ...cached, _live: false } : null;
}
function connErr(r) {
  if (r.error) return r.error;
  if (r.status === 404) return 'No active Spotify device. Open Spotify on the target device, then try "transfer to <device>".';
  if (r.status === 403) return 'Spotify rejected it — Connect playback control requires Spotify Premium.';
  return `Spotify API ${r.status}${r.text ? ': ' + r.text.slice(0, 160) : ''}`;
}
async function spotifyConnect(c, a, q, vol, deviceName) {
  const devices = await spotifyDevices(c);
  const dev = pickDevice(devices, deviceName, c);
  if (deviceName && !dev) {
    const known = Object.values(c.spotifyDevices || {}).map((d) => d.name);
    return { success: false, error: `Device "${deviceName}" not found. Open Spotify there first. Online: ${devices.map((d) => d.name).join(', ') || 'none'}.${known.length ? ' Known: ' + known.join(', ') + '.' : ''}` };
  }
  // Auto-target a device when the user didn't name one. Spotify often reports the Mac
  // app as is_active:false even while open — passing device_id on the play/control call
  // WAKES it, so we must always target a concrete device, never rely on "currently active".
  const computer = devices.find((d) => d.type === 'Computer');
  const active = devices.find((d) => d.is_active);
  const target = dev || active || computer || devices[0] || null;
  const dq = target && target._live !== false ? `?device_id=${target.id}` : (target ? `?device_id=${target.id}` : '');
  const ok = (r, msg) => (r.ok || r.status === 204) ? { success: true, result: msg } : { success: false, error: connErr(r) };
  switch (a) {
    case 'list_devices': {
      const liveIds = new Set(devices.map((d) => d.id));
      const cached = Object.values(c.spotifyDevices || {}).filter((d) => !liveIds.has(d.id));
      const lines = [
        ...devices.map((d) => `${d.name} (${d.type})${d.is_active ? ' [active]' : ' [online]'}`),
        ...cached.map((d) => `${d.name} (${d.type}) [offline — open Spotify on it]`),
      ];
      return { success: true, result: lines.length ? lines.join('\n') : 'No Spotify devices known yet. Open the Spotify app on your phone/Mac once to register it.' };
    }
    case 'transfer':
      if (!dev) return { success: false, error: 'No device matched. Run list_devices to see options.' };
      if (!dev._live) return { success: false, error: `${dev.name} is offline. Open Spotify on it, then transfer.` };
      return ok(await spotifyApi(c, 'PUT', '/me/player', { device_ids: [dev.id], play: true }), `Playback moved to ${dev.name}`);
    case 'pause':    return ok(await spotifyApi(c, 'PUT', '/me/player/pause' + dq), 'Paused');
    case 'resume':   return ok(await spotifyApi(c, 'PUT', '/me/player/play' + dq), 'Resumed');
    case 'next':     return ok(await spotifyApi(c, 'POST', '/me/player/next' + dq), 'Skipped');
    case 'previous': return ok(await spotifyApi(c, 'POST', '/me/player/previous' + dq), 'Previous track');
    case 'set_volume': return ok(await spotifyApi(c, 'PUT', `/me/player/volume?volume_percent=${vol}${target ? '&device_id=' + target.id : ''}`), `Volume ${vol}%`);
    case 'get_now_playing': {
      const r = await spotifyApi(c, 'GET', '/me/player/currently-playing');
      if (r.status === 204 || !r.json || !r.json.item) return { success: true, result: 'Nothing playing.' };
      const it = r.json.item;
      return { success: true, result: `${it.name} — ${it.artists.map((x) => x.name).join(', ')}${r.json.is_playing ? '' : ' (paused)'}` };
    }
    case 'play_track':
    case 'search_and_play': {
      if (!q) return { success: false, error: 'no query' };
      let uri = q, label = q;
      if (!/^spotify:|^https?:\/\/open\.spotify\.com/.test(q)) {
        const hit = await spotifySearchUri(c, q);
        if (!hit) return { success: false, error: `No match for "${q}".` };
        uri = hit.uri; label = hit.label;
      }
      if (!target) return { success: false, error: `No Spotify devices found. Open the Spotify app on your Mac or phone (and start any track once so it registers), then try again.` };
      // First attempt: play directly on the target (this wakes an inactive Mac).
      let pr = await spotifyApi(c, 'PUT', '/me/player/play' + dq, { uris: [uri] });
      // If Spotify says the device isn't ready (404), transfer playback to it then retry.
      if (pr.status === 404) {
        await spotifyApi(c, 'PUT', '/me/player', { device_ids: [target.id], play: false });
        await new Promise((r) => setTimeout(r, 600));
        pr = await spotifyApi(c, 'PUT', '/me/player/play' + dq, { uris: [uri] });
      }
      return ok(pr, `▶ ${label} on ${target.name}`);
    }
    default: return { success: false, error: `Unknown action: ${a}` };
  }
}

async function mediaControl(input) {
  const c = loadConfig();
  const a = input.action;
  const q = (input.query || '').trim();
  const vol = Math.max(0, Math.min(100, Number(input.volume)));
  const spotify = (body) => ['-e', `tell application "Spotify" to ${body}`];

  if (a === 'set_system_volume') {
    const r = await osa(['-e', `set volume output volume ${vol}`]);
    return r.ok ? { success: true, result: `System volume ${vol}%` } : { success: false, error: osaErr(r) };
  }
  // Spotify Connect path (controls any device incl. the phone) when linked AND a device
  // is targeted, device listing/transfer is asked, or Connect is the configured default.
  if (c.spotifyRefreshToken && (input.device || a === 'list_devices' || a === 'transfer' || c.spotifyUseConnect)) {
    return spotifyConnect(c, a, q, vol, input.device);
  }
  if (a === 'list_devices' || a === 'transfer') {
    return { success: false, error: 'Spotify Connect not linked. Run `node ~/bhatbot/scripts/spotify-auth.js` once (needs Premium) to control your phone/other devices.' };
  }
  // Make sure Spotify is up before any Spotify action (avoids "app not running" failures).
  await osa(['-e', 'if application "Spotify" is not running then tell application "Spotify" to activate']);
  // Make sure Spotify is up before any Spotify action (avoids "app not running" failures).
  await osa(['-e', 'if application "Spotify" is not running then tell application "Spotify" to activate']);

  if (a === 'get_now_playing') {
    const st = await osa(spotify('return player state'));
    if (!st.ok) return { success: false, error: osaErr(st) };
    if (st.out !== 'playing' && st.out !== 'paused') return { success: true, result: `Spotify is ${st.out || 'stopped'} — nothing playing.` };
    const np = await osa(spotify('return name of current track & " — " & artist of current track'));
    return np.ok ? { success: true, result: (st.out === 'paused' ? '(paused) ' : '') + np.out } : { success: false, error: osaErr(np) };
  }

  if (a === 'play_track' || a === 'search_and_play') {
    if (!q) return { success: false, error: 'no query' };
    if (/^spotify:|^https?:\/\/open\.spotify\.com/.test(q)) {           // already a URI/URL
      const r = await osa(spotify(`play track "${q.replace(/"/g, '')}"`));
      return r.ok ? { success: true, result: `Playing ${q}` } : { success: false, error: osaErr(r) };
    }
    const hit = await spotifySearchUri(c, q);                            // name → URI via Web API
    if (hit) {
      const r = await osa(spotify(`play track "${hit.uri}"`));
      return r.ok ? { success: true, result: `▶ ${hit.label}` } : { success: false, error: osaErr(r) };
    }
    // No Spotify Web API creds → can't resolve a name to a track. Open the in-app search.
    await osa(['-e', `open location "spotify:search:${encodeURIComponent(q)}"`]);
    return { success: true, result: `Opened Spotify search for "${q}". To play by name directly, set spotifyClientId + spotifyClientSecret in ~/.bhatbot/config.json (free Spotify developer app).` };
  }

  let args;
  switch (a) {
    case 'pause':    args = spotify('pause'); break;
    case 'resume':   args = spotify('play'); break;
    case 'next':     args = spotify('next track'); break;
    case 'previous': args = spotify('previous track'); break;
    case 'set_volume': args = spotify(`set sound volume to ${vol}`); break;
    default: return { success: false, error: `Unknown action: ${a}` };
  }
  const r = await osa(args);
  return r.ok ? { success: true, result: r.out || 'done' } : { success: false, error: osaErr(r) };
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
  { name: 'delegate_project', description: 'Run a large, multi-step project goal through the workspace multi-agent orchestrator (planner → coding/research/browser/memory/creative agents over structured state). Use for big tasks that would otherwise blow up the chat context (building features, long research, multi-file work). Returns a short summary; full state persists in the workspace. Optionally name a workspace to continue an existing project.',
    input_schema: { type: 'object', properties: { goal: { type: 'string' }, workspace: { type: 'string', description: 'workspace slug/name; omit to use/create the active one' }, max_tasks: { type: 'number' } }, required: ['goal'] } },
  { name: 'media_control', description: 'Control Spotify + system audio. Without a device it controls the Mac\'s Spotify via AppleScript. With a `device` (e.g. "phone") it uses Spotify Connect to control THAT device anywhere (needs one-time link + Premium). list_devices = show available Spotify devices; transfer = move playback to a device. set_volume = Spotify volume; set_system_volume = macOS output (0-100).',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['play_track','pause','resume','next','previous','set_volume','get_now_playing','search_and_play','set_system_volume','list_devices','transfer'] },
      query: { type: 'string', description: 'Track/artist for play_track or search_and_play' },
      volume: { type: 'number', description: '0-100 for volume actions' },
      device: { type: 'string', description: 'Target device name for Spotify Connect, e.g. "phone", "iPhone", "Mac". Omit to control the Mac\'s local Spotify app.' }
    }, required: ['action'] } },
  { name: 'system_control', description: 'macOS GUI/system automation via AppleScript + System Events. Control ANY app: open_app/activate_app (launch + focus any app by name, e.g. "Photos", "App Store", "Notes", "Messages", "Claude"), quit_app (close an app), keystroke (type text), shortcut (key+modifiers like command/shift/option/control), menu (click a menu item via app+menuPath e.g. ["File","Save"]), clipboard_get/clipboard_set, notification, or applescript (run raw AppleScript). Use this for things the browser/shell cannot do (launching/quitting apps, clicking native UI, window/menu control, clipboard).',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['applescript','open_app','activate_app','quit_app','keystroke','shortcut','menu','clipboard_get','clipboard_set','notification'] },
      app: { type: 'string', description: 'Target app name for open_app/activate_app/quit_app/menu' },
      script: { type: 'string', description: 'Raw AppleScript for action=applescript' },
      text: { type: 'string', description: 'Text for keystroke/clipboard_set/notification' },
      title: { type: 'string', description: 'Title for notification' },
      key: { type: 'string', description: 'Single key for shortcut (e.g. "s")' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'e.g. ["command"], ["command","shift"]' },
      menuPath: { type: 'array', items: { type: 'string' }, description: 'e.g. ["File","Save"]' }
    }, required: ['action'] } },
  { name: 'browser_workflow', description: 'Record/replay reusable browser macros. start_recording → do browser actions → save_workflow{name} captures the working steps; replay_workflow{name} re-runs them; list_workflows / show_workflow / delete_workflow / cancel_recording. Use to save multi-step web tasks (login, navigate, fill, extract) the user repeats.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['start_recording','save_workflow','cancel_recording','list_workflows','show_workflow','replay_workflow','delete_workflow'] },
      name: { type: 'string' }, description: { type: 'string' }
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
  { name: 'ui_inspect', description: 'Capture a screenshot (target:"browser" = current Playwright page, target:"screen" = the whole Mac screen) and get STRUCTURED visual QA findings from a local vision model: {pass, findings:[{severity,where,issue,fix_hint}]}. The screenshot is attached so you can also see it yourself. Use in a build → launch → inspect → fix loop to visually verify a UI and decide whether to keep iterating.',
    input_schema: { type: 'object', properties: { target: { type: 'string', enum: ['browser', 'screen'] }, goal: { type: 'string', description: 'what to check for / acceptance criteria' } } } },
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
    }, required: ['image_path'] } },
  { name: 'notify_user', description: 'Reach Siddhant out-of-band when you need a decision mid-task, or when a long task he queued remotely finishes. Routes to Telegram by default. urgency "call" places a real phone call via Twilio (reserve for production failures / system-down). Do NOT use for routine output.',
    input_schema: { type: 'object', properties: {
      message: { type: 'string', description: 'The message (≤400 chars). For a call, write it as a spoken sentence.' },
      urgency: { type: 'string', enum: ['low', 'high', 'call'], description: 'low = ⚪ Telegram, high = 🔴 Telegram, call = phone call via Twilio. Default low.' }
    }, required: ['message'] } }
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

// Autonomous mode: the user explicitly wants maximum self-driving. When on (default true),
// confirmation gates auto-approve so the agent never blocks waiting for a click — BUT the
// HARD_BLOCKED catastrophic patterns and secret redaction always remain in force, and every
// auto-approved action is still audit-logged. Set autonomousMode:false in config to require
// manual approval again.
function isAutonomous() {
  const c = loadConfig();
  return c.autonomousMode !== false;   // default ON
}
function requestConfirm(command, reason) {
  if (isAutonomous()) {
    try { fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), autoApproved: command.slice(0, 200), reason }) + '\n'); } catch {}
    sendToActivity('tool-update', { type: 'thinking', text: '⚡ auto-approved: ' + reason });
    return Promise.resolve(true);
  }
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

let browserLaunching = null;
async function ensureBrowser() {
  if (browser && page) return;
  if (browserLaunching) return browserLaunching;     // de-dupe concurrent launches (race → 2 browsers)
  browserLaunching = (async () => {
    const { chromium } = require('playwright');
    // Browser is now its OWN dedicated, visible desktop window (headless:false) — NOT fullscreen,
    // sized 1280x800 and positioned on the desktop. --no-sandbox: Chromium often fails to start
    // from a packaged/Finder-launched Electron app without it. Realistic UA + viewport reduce
    // bot-blocking that makes pages look broken/empty.
    browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
             '--disable-dev-shm-usage', '--window-size=1280,860', '--window-position=140,120'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: null, locale: 'en-US',          // viewport:null → page fills the real window
    });
    page = await context.newPage();
  })();
  try { await browserLaunching; } finally { browserLaunching = null; }
}

async function browserAction(input) {
  openActivityWindow();
  try { await ensureBrowser(); }
  catch (e) {
    browser = null; page = null; browserLaunching = null;
    return { success: false, error: `Browser failed to launch: ${e.message.split('\n')[0]}. Fix: run \`cd ~/bhatbot && npx playwright install chromium\` once.` };
  }
  // Screenshots stream to the activity window AND are returned as `_image`
  // (base64). agentLoop turns `_image` into a real vision image block so Claude
  // sees the page, then evicts old images so we don't re-bomb the rate limit.
  const shot = async () => {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
    const b64 = buf.toString('base64');
    sendToActivity('screenshot', { data: b64 });
    return b64;
  };
  // While recording a workflow, capture the replayable mutating steps (not screenshots/reads).
  const rec = (step) => { if (recordingSteps) recordingSteps.push(step); };
  try {
    switch (input.action) {
      case 'navigate':
        await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        rec({ action: 'navigate', url: input.url });
        return { success: true, url: page.url(), title: await page.title(), _image: await shot() };
      case 'click':
        await page.click(input.selector, { timeout: 15000 });
        rec({ action: 'click', selector: input.selector });
        return { success: true, _image: await shot() };
      case 'type':
        await page.fill(input.selector, input.text);
        rec({ action: 'type', selector: input.selector, text: input.text });
        return { success: true, _image: await shot() };
      case 'screenshot':
        return { success: true, note: 'Screenshot captured.', _image: await shot() };
      case 'get_text': {
        const txt = await page.innerText(input.selector || 'body');
        return { success: true, text: txt.slice(0, 6 * 1024) };
      }
      case 'evaluate':
        rec({ action: 'evaluate', js: input.js });
        return { success: true, result: await page.evaluate(input.js) };
      default:
        return { success: false, error: 'Unknown browser action' };
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    // A dead/crashed page can't recover in place — reset so the next call relaunches clean.
    if (/Target closed|crashed|Browser has been closed|Execution context was destroyed/i.test(msg)) { try { await browser.close(); } catch {} browser = null; page = null; }
    return { success: false, error: `Browser ${input.action} failed: ${msg.split('\n')[0]}` };
  }
}

// ---------------------------------------------------------------------------
// Browser workflow recording — capture the sequence of browser actions that
// actually worked on a site, save it by name, replay it later as a macro.
// Empirical traces beat the model re-deriving selectors from scratch each time.
// ---------------------------------------------------------------------------
function wfPath(name) { return path.join(WORKFLOW_DIR, String(name).replace(/[^\w.-]/g, '_') + '.json'); }
async function browserWorkflow(input) {
  const a = input.action;
  try {
    if (a === 'start_recording') { recordingSteps = []; return { success: true, result: 'Recording browser steps. Perform the task, then save_workflow.' }; }
    if (a === 'save_workflow') {
      if (!recordingSteps || !recordingSteps.length) return { success: false, error: 'Nothing recorded — start_recording first, then do browser actions.' };
      if (!input.name) return { success: false, error: 'name required' };
      fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
      const wf = { name: input.name, description: input.description || '', created: new Date().toISOString(), steps: recordingSteps };
      fs.writeFileSync(wfPath(input.name), JSON.stringify(wf, null, 2));
      const n = recordingSteps.length; recordingSteps = null;
      return { success: true, result: `Saved workflow "${input.name}" (${n} steps).` };
    }
    if (a === 'cancel_recording') { recordingSteps = null; return { success: true, result: 'Recording cancelled.' }; }
    if (a === 'list_workflows') {
      if (!fs.existsSync(WORKFLOW_DIR)) return { success: true, result: 'No workflows yet.' };
      const items = fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.json')).map((f) => {
        try { const w = JSON.parse(fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8')); return `• ${w.name} (${(w.steps || []).length} steps)${w.description ? ' — ' + w.description : ''}`; } catch { return '• ' + f; }
      });
      return { success: true, result: items.length ? items.join('\n') : 'No workflows yet.' };
    }
    if (a === 'show_workflow') {
      if (!input.name || !fs.existsSync(wfPath(input.name))) return { success: false, error: 'workflow not found' };
      return { success: true, result: fs.readFileSync(wfPath(input.name), 'utf8') };
    }
    if (a === 'delete_workflow') {
      if (!input.name || !fs.existsSync(wfPath(input.name))) return { success: false, error: 'workflow not found' };
      fs.unlinkSync(wfPath(input.name)); return { success: true, result: `Deleted "${input.name}".` };
    }
    if (a === 'replay_workflow') {
      if (!input.name || !fs.existsSync(wfPath(input.name))) return { success: false, error: 'workflow not found' };
      const wf = JSON.parse(fs.readFileSync(wfPath(input.name), 'utf8'));
      const log = []; let lastImage;
      for (let i = 0; i < (wf.steps || []).length; i++) {
        const step = wf.steps[i];
        const r = await browserAction(step);
        if (r._image) lastImage = r._image;
        if (r.success === false) { log.push(`✗ step ${i + 1} ${step.action}: ${r.error}`); return { success: false, error: `Workflow "${input.name}" failed at step ${i + 1}`, result: log.join('\n'), _image: lastImage }; }
        log.push(`✓ ${step.action}${step.url ? ' ' + step.url : step.selector ? ' ' + step.selector : ''}`);
      }
      return { success: true, result: `Replayed "${input.name}" (${wf.steps.length} steps):\n` + log.join('\n'), _image: lastImage };
    }
    return { success: false, error: `Unknown action: ${a}` };
  } catch (e) { return { success: false, error: e.message }; }
}

// ---------------------------------------------------------------------------
// macOS GUI / system automation via AppleScript + System Events. Generalizes the
// Spotify pattern to any app: activate, keystroke, shortcut, click menu items,
// clipboard, notifications, or run raw AppleScript. Needs Accessibility (keystroke/
// menu/UI) and Automation (per-app) permission — granted to Bhatbot.app once.
// ---------------------------------------------------------------------------
async function systemControl(input) {
  const a = input.action;
  const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let r;
  switch (a) {
    case 'applescript':
      r = await osa(['-e', String(input.script || '')]); break;
    case 'activate_app':
    case 'open_app': {
      // Launch via LaunchServices (`open -a`) directly — needs NO Automation/Accessibility
      // permission, unlike `tell app to activate` (an Apple event that TCC blocks in the
      // packaged app → the long-standing "app opening doesn't work in Bhatbot" bug).
      r = await new Promise((res) => {
        const p = spawn('open', ['-a', String(input.app || '')], { env: { ...process.env, PATH: EXEC_PATH } });
        let e = ''; p.stderr.on('data', (d) => e += d);
        p.on('error', (er) => res({ ok: false, err: er.message }));
        p.on('close', (c) => res(c === 0 ? { ok: true, out: `Opened ${input.app}` } : { ok: false, err: (e.trim() || `Unable to open "${input.app}" — check the exact app name`) }));
      });
      break;
    }
    case 'quit_app': {
      // Graceful AppleScript quit; if Automation isn't granted, fall back to pkill (SIGTERM).
      let rr = await osa(['-e', `tell application "${esc(input.app)}" to quit`]);
      if (!rr.ok) {
        const killed = await new Promise((res) => { const p = spawn('pkill', ['-x', String(input.app || '')], { env: { ...process.env, PATH: EXEC_PATH } }); p.on('error', () => res(false)); p.on('close', (c) => res(c === 0)); });
        rr = killed ? { ok: true, out: `Quit ${input.app}` } : rr;
      }
      r = rr; break;
    }
    case 'keystroke':
      r = await osa(['-e', `tell application "System Events" to keystroke "${esc(input.text)}"`]); break;
    case 'shortcut': {                                   // key + modifiers, e.g. key:"s" modifiers:["command"]
      const mods = (input.modifiers || []).map((m) => `${m} down`).join(', ');
      const using = mods ? ` using {${mods}}` : '';
      r = await osa(['-e', `tell application "System Events" to keystroke "${esc(input.key)}"${using}`]); break;
    }
    case 'menu': {                                       // app + menuPath:["File","Save"]
      const p = input.menuPath || [];
      if (p.length < 2) return { success: false, error: 'menuPath needs at least [menu, item]' };
      const menu = esc(p[0]); const item = esc(p[p.length - 1]);
      const script = `tell application "${esc(input.app)}" to activate
delay 0.2
tell application "System Events" to tell process "${esc(input.app)}" to click menu item "${item}" of menu "${menu}" of menu bar 1`;
      r = await osa(['-e', script]); break;
    }
    case 'clipboard_get':
      r = await osa(['-e', 'the clipboard as text']); break;
    case 'clipboard_set':
      r = await osa(['-e', `set the clipboard to "${esc(input.text)}"`]); break;
    case 'notification':
      r = await osa(['-e', `display notification "${esc(input.text)}" with title "${esc(input.title || 'Bhatbot')}"`]); break;
    default:
      return { success: false, error: `Unknown action: ${a}` };
  }
  return r.ok ? { success: true, result: r.out || 'done' } : { success: false, error: osaErr(r) };
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

// Ollama tool-calling: convert Anthropic-shaped messages+tools → Ollama /api/chat, then
// convert the response back to Anthropic-shaped content blocks so lib/agents/exec.js stays
// provider-agnostic. Lets local models (qwen2.5-coder, qwen3) drive tools for free.
async function ollamaToolChat(messages, system, tools, model) {
  const msgs = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : (m.role === 'tool' ? 'tool' : 'user'),
    content: typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((b) =>
          b.type === 'text' ? b.text
          : b.type === 'tool_result' ? ('[tool result] ' + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 6000))
          : b.type === 'tool_use' ? ('[calling ' + b.name + ' ' + JSON.stringify(b.input) + ']') : '').filter(Boolean).join('\n')
      : '',
  })).filter((m) => m.content);
  if (system) msgs.unshift({ role: 'system', content: system });
  const otools = (tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: msgs, tools: otools, stream: false, options: { temperature: 0.3 } }),
  });
  if (!r.ok) throw new Error('ollama ' + r.status);
  const j = await r.json();
  const content = [];
  const txt = (j.message && j.message.content) || '';
  if (txt) content.push({ type: 'text', text: txt });
  for (const tc of (j.message && j.message.tool_calls) || []) {
    let input = tc.function && tc.function.arguments;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
    content.push({ type: 'tool_use', id: 'ot_' + crypto.randomBytes(4).toString('hex'), name: tc.function.name, input: input || {} });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  return { content: content.length ? content : [{ type: 'text', text: '' }], stop_reason: hasTools ? 'tool_use' : 'end_turn' };
}

// Build the adapters the orchestrator/agents need, reusing main.js's own model callers
// (so rate-limit accounting + prompt caching still apply) AND its real tool executor —
// this is what gives agents full autonomy (they actually run tools). Memory is per-workspace.
function orchestratorAdapters(wsDir, event) {
  const c = loadConfig();
  const embedModel = (c.models && c.models.embed) || c.embedModel || 'nomic-embed-text';
  return {
    ollamaUp,
    ollamaChat: (m, s, model) => ollamaChat(m, s, model),
    anthropic: async (m, s, model) => {
      const j = await anthropicRequest({ model, max_tokens: 2048, system: [{ type: 'text', text: s, cache_control: { type: 'ephemeral' } }], messages: m }, getApiKey());
      return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    },
    // Tool-capable callers (Anthropic-shaped response) + the real executor + tool defs.
    anthropicTools: (m, s, tools, model) => anthropicRequest({ model, max_tokens: 4096, system: [{ type: 'text', text: s, cache_control: { type: 'ephemeral' } }], tools, messages: capTokens(m) }, getApiKey()),
    ollamaTools: (m, s, tools, model) => ollamaToolChat(m, s, tools, model),
    toolExec: (name, input) => executeTool(name, input),
    toolDefs: TOOLS,
    onEvent: (ev) => {                                    // surface agent actions to the activity window
      if (ev.type === 'tool') sendToActivity('tool-update', { type: 'tool_start', name: ev.name, input: ev.input });
      else if (ev.type === 'tool_done') sendToActivity('tool-update', { type: 'tool_done', name: ev.name, result: { ...ev.result, _image: undefined, _imageMime: undefined } });
      else if (ev.type === 'text' && ev.text) sendToActivity('tool-update', { type: 'thinking', text: ev.text.slice(0, 200) });
    },
    memFn: (q, k) => wsMemory.search(wsDir, q, k, { embedModel }),
    memWrite: (w) => wsMemory.write(wsDir, w, { embedModel }),
  };
}

// delegate_project: run a multi-step goal through the workspace orchestrator instead of the
// single chat loop. Keeps the conversation context flat — only a short summary returns.
async function delegateProject(input) {
  let slug = input.workspace || workspaceMgr.getActive();
  if (!slug || !workspaceMgr.exists(slug)) { const w = workspaceMgr.create(input.workspace || (input.goal || 'project').slice(0, 40)); slug = w.slug; workspaceMgr.setActive(slug); }
  const w = workspaceMgr.load(slug);
  const cfg = loadConfig();
  cfg.__metrics = { cost_month_usd: (wsState.open(w.dir).snapshot().components, 0) };
  const steps = [];
  const res = await orchestrator.run(input.goal, {
    wsDir: w.dir, config: cfg, adapters: orchestratorAdapters(w.dir),
    maxTasks: input.max_tasks || 12,
    onStep: ({ task, result }) => steps.push(`${task.id} [${task.agent}] ${result.status}: ${result.summary}`),
  });
  return { success: true, workspace: slug, completed: res.completed, open: res.open, blocked: res.blocked,
    state: wsState.open(w.dir).digest(), steps };
}

// ---------------------------------------------------------------------------
// 3D generation (TRELLIS via Replicate). Hardened: downscales oversized inputs
// (Replicate rejects very large data URLs), no fragile Prefer:wait, a real
// ~5-min poll budget (Trellis cold-boot can take 2-3 min), robust output parsing,
// and progress surfaced to the Activity log.
// ---------------------------------------------------------------------------
async function generate3D(input) {
  const cfg = loadConfig();
  if (!cfg.replicateKey) return { success: false, error: 'No replicateKey in ~/.bhatbot/config.json. Get one free at replicate.com.' };
  if (!input.image_path || !fs.existsSync(input.image_path)) return { success: false, error: `Image not found: ${input.image_path}` };

  // Load + downscale to max 1024px and re-encode PNG (smaller, consistent payload).
  let dataUrl;
  try {
    const { nativeImage } = require('electron');
    let img = nativeImage.createFromPath(input.image_path);
    if (img.isEmpty()) throw new Error('unreadable image');
    const sz = img.getSize();
    const max = 1024;
    if (sz.width > max || sz.height > max) {
      const scale = max / Math.max(sz.width, sz.height);
      img = img.resize({ width: Math.round(sz.width * scale), height: Math.round(sz.height * scale), quality: 'best' });
    }
    dataUrl = 'data:image/png;base64,' + img.toPNG().toString('base64');
  } catch (e) {
    // Fallback: send the raw bytes as-is.
    const mime = input.image_path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    dataUrl = `data:${mime};base64,${fs.readFileSync(input.image_path).toString('base64')}`;
  }

  const outDir = (cfg.imageOutputDir || '~/.bhatbot/generated').replace(/^~/, os.homedir());
  fs.mkdirSync(outDir, { recursive: true });
  const fname = (input.filename || `3d_${Date.now()}`).replace(/[^\w.-]/g, '_');

  // firtoz/trellis is a COMMUNITY model → must create predictions via the versioned
  // /v1/predictions endpoint (the /models/.../predictions route is official-models-only and
  // 404s here — that was the long-standing "Trellis doesn't work" bug). Resolve the latest
  // version dynamically, falling back to a known-good pinned hash.
  const PINNED_VERSION = 'e8f6c45206993f297372f5436b90350817bd9b4a0d52d2a76df50c1c8afa2b3c';
  let version = cfg.trellisVersion || PINNED_VERSION;
  try {
    const mr = await fetch('https://api.replicate.com/v1/models/firtoz/trellis', { headers: { 'Authorization': 'Bearer ' + cfg.replicateKey }, signal: AbortSignal.timeout(15000) });
    if (mr.ok) { const mj = await mr.json(); if (mj.latest_version && mj.latest_version.id) version = mj.latest_version.id; }
  } catch { /* offline → use pinned */ }

  const body = { version, input: {
    images: [dataUrl],
    texture_size: input.texture_size || 1024,
    mesh_simplify: 0.9,                 // less aggressive → cleaner geometry
    generate_color: true, generate_model: true, generate_normal: false,
    save_gaussian_ply: false, return_no_background: true,
    ss_sampling_steps: 12, slat_sampling_steps: 12,
    ss_guidance_strength: 7.5, slat_guidance_strength: 3,
    randomize_seed: true,
  } };

  let pred;
  try {
    const cr = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.replicateKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    if (cr.status === 422) return { success: false, error: 'Replicate 422 (bad input — image may be too large/unreadable, or bad version): ' + (await cr.text()).slice(0, 200) };
    if (cr.status === 401) return { success: false, error: 'Replicate 401 — invalid replicateKey.' };
    if (cr.status === 402) return { success: false, error: 'Replicate is out of credit. Add credit at replicate.com/account/billing, then retry (wait a few minutes after purchase).' };
    if (!cr.ok) return { success: false, error: `Replicate ${cr.status}: ${(await cr.text()).slice(0, 300)}` };
    pred = await cr.json();
  } catch (e) { return { success: false, error: 'Replicate request failed: ' + e.message }; }

  // Poll up to ~5 min.
  const getUrl = pred.urls && pred.urls.get;
  let tries = 0; const MAX = 100;
  while (pred.status && !['succeeded', 'failed', 'canceled'].includes(pred.status) && tries < MAX) {
    await sleep(3000); tries++;
    if (tries % 5 === 0) sendToActivity('tool-update', { type: 'thinking', text: `🧊 3D generating… ${tries * 3}s (${pred.status})` });
    try {
      const pr = await fetch(getUrl || `https://api.replicate.com/v1/predictions/${pred.id}`, { headers: { 'Authorization': 'Bearer ' + cfg.replicateKey }, signal: AbortSignal.timeout(20000) });
      pred = await pr.json();
    } catch { /* transient network — keep polling */ }
  }
  if (pred.status !== 'succeeded') {
    const logTail = (pred.logs || '').split('\n').filter(Boolean).slice(-3).join(' | ');
    return { success: false, error: `3D ${pred.status || 'timeout'}: ${pred.error || logTail || 'no detail'}` };
  }

  // Output shapes seen: {model_file}, {glb}, or a bare URL / array.
  const o = pred.output || {};
  const glbUrl = o.model_file || o.glb || o.model || (typeof o === 'string' ? o : null) || (Array.isArray(o) ? o.find((x) => String(x).includes('.glb')) : null);
  if (!glbUrl) return { success: false, error: 'No GLB URL in output: ' + JSON.stringify(o).slice(0, 200) };
  try {
    const gr = await fetch(glbUrl, { signal: AbortSignal.timeout(60000) });
    if (!gr.ok) return { success: false, error: `GLB download failed: ${gr.status}` };
    const gbuf = Buffer.from(await gr.arrayBuffer());
    const outPath = path.join(outDir, `${fname}.glb`);
    fs.writeFileSync(outPath, gbuf);
    return { success: true, path: outPath, size_mb: (gbuf.length / 1048576).toFixed(2), seconds: tries * 3, message: `3D model → ${outPath}. Import into Blender, Unity, or Three.js.` };
  } catch (e) { return { success: false, error: 'GLB download error: ' + e.message }; }
}

async function executeTool(name, input) {
  let result;
  // Resolve CRED_REF_* handles to real secrets just before the tool runs. The audit log
  // (below) records `input` with the handles intact, never the decrypted secret.
  const auditInput = input;
  if (credentials.hasRef(input)) { try { input = credentials.resolveRefs(input); } catch {} }
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
          result = { success: res.ok, status: res.status, content: (await res.text()).slice(0, 8 * 1024) };
        } finally { clearTimeout(t); }
        break;
      }
      case 'open_in_browser':
        await shell.openExternal(input.url); result = { success: true, opened: input.url }; break;
      case 'notify_user':
        result = await notifyUser(input.message, input.urgency || 'low'); break;
      case 'media_control':
        result = await mediaControl(input); break;
      case 'system_control':
        result = await systemControl(input); break;
      case 'delegate_project':
        result = await delegateProject(input); break;
      case 'browser_workflow':
        result = await browserWorkflow(input); break;
      case 'save_memory':
        result = saveMemoryEntry(input.section, input.content); break;
      case 'browser':
        result = await browserAction(input); break;
      case 'vision_local':
        result = await visionLocal(input); break;
      case 'ui_inspect': {
        let b64;
        if ((input.target || 'browser') === 'browser' && page) {
          try { b64 = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64'); } catch {}
        }
        if (!b64) {
          const out = path.join(os.tmpdir(), `bb-shot-${Date.now()}.jpg`);
          await new Promise((res) => { const p = spawn('/usr/sbin/screencapture', ['-x', '-t', 'jpg', out], { env: { ...process.env, PATH: EXEC_PATH } }); p.on('close', res); p.on('error', res); });
          try { b64 = fs.readFileSync(out).toString('base64'); fs.unlink(out, () => {}); } catch {}
        }
        if (!b64) { result = { success: false, error: 'Could not capture a screenshot (no active browser page, and screencapture failed — grant Screen Recording permission).' }; break; }
        sendToActivity('screenshot', { data: b64 });
        const insp = await visualInspect.inspect({ imageB64: b64, goal: input.goal, model: loadConfig().visionModel });
        result = { success: !insp.error, pass: insp.pass, findings: insp.findings, model: insp.model, error: insp.error, _image: b64, _imageMime: 'image/jpeg' };
        break;
      }
      case 'ask_ai':
        result = await askAI(input); break;
      case 'studio_write': {
        fs.mkdirSync(STUDIO_DIR, { recursive: true });
        fs.writeFileSync(STUDIO_INDEX, input.html);
        // Studio is an in-window webview panel now. Surface it, reload the guest, then capture
        // the webview's own webContents so Claude can SEE what rendered.
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.webContents.send('show-panel', 'studio');
          mainWindow.webContents.send('studio-reload');
        }
        await sleep(900);
        let shot = null;
        try {
          const sw = studioWebContents();
          if (sw) { const img = await sw.capturePage(); if (img && !img.isEmpty()) shot = img.resize({ width: 1200 }).toJPEG(75).toString('base64'); }
          if (!shot && studioWindow && !studioWindow.isDestroyed()) {     // legacy fallback
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
        result = await generate3D(input);
        break;
      }
      default:
        result = { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    result = { success: false, error: String(e && e.message ? e.message : e) };
  }
  auditLog(name, auditInput, result);   // log handles, never resolved secrets
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
  // Activity is now an in-window panel → route to the main window. (Legacy separate window
  // still fed if one happens to be open.)
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data); } catch {}
  try { if (activityWindow && !activityWindow.isDestroyed()) activityWindow.webContents.send(channel, data); } catch {}
}

async function agentLoop(history, apiKey, event, opts = {}) {
  agentState = 'running';
  pendingGuidance = [];          // fresh per task
  const usedGuidance = [];       // collected for the post-task "learn this?" prompt
  let iterations = 0;
  history = validateHistory(history);            // heal any corruption before it compounds
  history = await trimHistory(history, apiKey);

  // Streaming: emit text deltas to the renderer (live bubble) AND speak each finished
  // sentence as it lands. Only on the desktop chat path (opts.stream); MCP/Telegram stay
  // non-streaming so their headless senders are untouched.
  const stream = !!opts.stream;
  const ttsSeq = stream ? ttsStreamStart() : null;
  if (stream && ttsSeq != null) maybeAck(ttsSeq, lastUserText(history));   // instant verbal ack
  const speakParser = stream ? makeSpeakStream(ttsSeq) : null;
  // Display the tag-stripped tokens live; TTS hears only <speak>…</speak> (handled inside the parser).
  const onText = stream ? (delta) => {
    const disp = speakParser ? speakParser.feed(delta) : delta;
    if (disp) sendToAll(event, 'tool-update', { type: 'token', text: disp });
  } : undefined;

  // All exits go through here so live guidance can be offered for learning (2a).
  const finish = (text) => {
    agentState = 'idle';
    if (speakParser) speakParser.finish(); else if (ttsSeq != null) ttsStreamFlush(ttsSeq);
    if (usedGuidance.length) sendToActivity('learn_prompt', { text: usedGuidance.join(' | ') });
    // Strip any <speak> tags from the returned text (renderer shows this as the final bubble).
    reflectOnCorrection(history, lastUserText(history), text);   // async, non-blocking
    return { text: String(text || '').replace(/<\/?speak>/g, '').trim(), history, _streamed: stream };
  };

  while (iterations < MAX_AGENT_ITERATIONS) {
    if (agentState === 'stopped') return finish('⏹ Stopped.');
    while (agentState === 'paused') await sleep(300);

    history = evictOldImages(history, KEEP_IMAGES);
    let response;
    try {
      response = await callModel(history, apiKey, iterations === 0, onText);
    } catch (e) {
      if (e && e.rateBudget) { history = []; return finish(e.message); }  // notify + reset for next task
      throw e;
    }
    sendToActivity('model', { model: response._model });
    sendToAll(event, 'tool-update', { type: 'provider_used', provider: response._provider || 'anthropic', model: response._model });
    const hasTools = response.content.some((b) => b.type === 'tool_use');
    history = [...history, { role: 'assistant', content: response.content }];

    if (!hasTools || response.stop_reason === 'end_turn') {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return finish(text);
    }

    // Pre-tool narration. When streaming, tokens already rendered + spoke it → don't re-emit.
    const thinkText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (thinkText && !stream) sendToAll(event, 'tool-update', { type: 'thinking', text: thinkText });

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
        trContent = JSON.stringify(result).slice(0, 24 * 1024);   // cap tool_result tokens (was 100KB)
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
    hist.push({ role: 'user', content: '[TELEGRAM] ' + userText });
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

// Place an actual outbound phone call via Twilio, reading `message` aloud. Reserved for
// urgency:'call'. Needs twilioSid/twilioToken/twilioFrom/myPhone in config.
async function twilioCall(message) {
  const c = loadConfig();
  if (!c.twilioSid || !c.twilioToken || !c.twilioFrom || !c.myPhone) {
    return { sent: false, error: 'Twilio not configured (twilioSid/twilioToken/twilioFrom/myPhone)' };
  }
  let twilio;
  try { twilio = require('twilio'); } catch { return { sent: false, error: 'twilio package not installed (npm i twilio)' }; }
  const safe = String(message).replace(/[<>&]/g, ' ').slice(0, 600);
  const twiml = '<Response><Say voice="Google.en-US-Neural2-D">' + safe + '</Say></Response>';
  try {
    const call = await twilio(c.twilioSid, c.twilioToken).calls.create({ twiml, to: c.myPhone, from: c.twilioFrom });
    return { sent: true, via: 'twilio', sid: call.sid };
  } catch (e) { return { sent: false, error: e.message }; }
}

// notify_user tool backend. Routes by urgency. Telegram is free + always tried; a call
// also still drops a Telegram line so there's a written record.
async function notifyUser(message, urgency) {
  const msg = String(message || '').slice(0, 400);
  if (!msg.trim()) return { sent: false, error: 'empty message' };
  const c = loadConfig();
  const mode = c.notifyMode || 'telegram';
  if (urgency === 'call' && mode !== 'telegram') {
    const r = await twilioCall(msg);
    telegramNotify('📞 (calling) ' + msg);
    return r;
  }
  const prefix = urgency === 'high' ? '🔴 BHATBOT: ' : '⚪ BhatBot: ';
  telegramNotify(prefix + msg);
  if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('tool-update', { kind: 'notify', text: msg, urgency }); } catch {} }
  return { sent: true, via: 'telegram' };
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
    frame: false, fullscreen: true, alwaysOnTop: false, skipTaskbar: false, resizable: true, maximizable: true,
    minWidth: 360, minHeight: 400, backgroundColor: '#090d13',
    webPreferences: { nodeIntegration: false, contextIsolation: true, webviewTag: true, preload: path.join(__dirname, 'preload.js') }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.setFullScreen(true);   // always open fullscreen (still resizable — can exit via ⌃⌘F)
}

// Activity is now an in-window panel (#activity-panel in index.html). This is a no-op kept so
// existing call sites (e.g. browserAction) don't break; activity events route to mainWindow.
function openActivityWindow() {}

// The <webview> guest hosting Studio lives inside mainWindow; find its WebContents so we can
// capturePage() it for the design vision-feedback loop.
function studioWebContents() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    return webContents.getAllWebContents().find((wc) => {
      try { return wc.hostWebContents && wc.hostWebContents.id === mainWindow.webContents.id && /studio/.test(wc.getURL()); } catch { return false; }
    }) || null;
  } catch { return null; }
}

function toggleWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else { if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true); mainWindow.show(); mainWindow.focus(); }
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
  const script = unpacked(path.join(__dirname, 'scripts', 'listen.py'));
  if (!fs.existsSync(script)) return;
  try {
    const wc = loadConfig();
    // VAD barge-in defaults OFF: wake word ("Jarvis") is the interrupt/inject trigger, which
    // avoids background voices false-triggering. Enable energy VAD only if explicitly set.
    const wakeEnv = { ...process.env, PATH: EXEC_PATH,
      BHATBOT_BARGE: wc.bargeIn === true ? '1' : '0',
      BHATBOT_BARGE_THRESH: String(wc.bargeInThreshold || 0.085) };
    wakeProc = require('child_process').spawn(resolvePython(), ['-u', script], { env: wakeEnv });
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
        if (line === 'VOICE') {                              // barge-in: user spoke over the TTS
          if (ttsActive) { stopDesktopTTS(); sendToActivity('tool-update', { type: 'thinking', text: '🎙 barge-in — stopped speaking' }); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('barge-in', {}); }
        }
        else if (line === 'WAKE') { if (ttsActive) stopDesktopTTS(); triggerWake(''); }   // wake also interrupts
        else if (line.startsWith('CMD')) { if (ttsActive) stopDesktopTTS(); triggerWake(line.slice(3).trim()); }
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
// Nexus + Studio are now in-window webview panels; the renderer switches to them. We just
// return the URLs and make sure the Studio file watcher is live so edits hot-reload the guest.
ipcMain.handle('open-nexus', () => { if (mainWindow) mainWindow.webContents.send('show-panel', 'nexus'); return true; });
ipcMain.handle('open-studio', () => { ensureStudio(); ensureStudioWatcher(); if (mainWindow) mainWindow.webContents.send('show-panel', 'studio'); return true; });
ipcMain.handle('open-terminal', () => { if (mainWindow) mainWindow.webContents.send('show-panel', 'code'); return true; });
ipcMain.handle('get-panel-urls', () => { ensureStudio(); return { nexus: NEXUS_URL, studio: 'file://' + STUDIO_INDEX }; });
// Agent browser is its own desktop Chromium window — launch it if needed and raise it.
ipcMain.handle('focus-browser', async () => {
  try { await ensureBrowser(); if (page) { try { await page.bringToFront(); } catch {} if (!page.url() || page.url() === 'about:blank') await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded' }).catch(() => {}); } return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Studio file watcher → hot-reload the in-window webview when ~/.bhatbot/studio/index.html changes.
let studioPanelWatcher = null;
function ensureStudioWatcher() {
  if (studioPanelWatcher) return;
  try {
    let deb = null;
    studioPanelWatcher = fs.watch(STUDIO_DIR, () => {
      clearTimeout(deb);
      deb = setTimeout(() => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio-reload'); } catch {} }, 200);
    });
  } catch {}
}
ipcMain.on('pty-start', (_e, { cols, rows }) => startPty(cols, rows));
ipcMain.on('pty-input', (_e, data) => { try { ptyProc && ptyProc.write(data); } catch {} });
ipcMain.on('pty-resize', (_e, { cols, rows }) => { try { ptyProc && ptyProc.resize(cols, rows); } catch {} });
ipcMain.handle('get-voice-config', () => {
  const c = loadConfig();
  const ttsProvider = c.ttsProvider || (kokoroAvailable() ? 'kokoro' : (c.elevenLabsKey ? 'elevenlabs' : (c.openaiKey ? 'openai' : (c.piperBin ? 'piper' : null))));
  const hasTTS = ttsProvider === 'kokoro' ? kokoroAvailable()
    : ttsProvider === 'elevenlabs' ? !!c.elevenLabsKey
    : ttsProvider === 'openai' ? !!c.openaiKey
    : ttsProvider === 'piper' ? !!c.piperBin : false;
  return {
    hasOpenAI: !!(c.openaiKey || (c.sttProvider === 'groq' && c.groqKey)),
    picovoiceKey: c.picovoiceKey || null, wakeWord: c.wakeWord || 'jarvis', silenceMs: c.silenceMs || 2000,
    ttsEnabled: c.ttsEnabled !== false, ttsProvider, hasTTS,
    hasReplicateKey: !!c.replicateKey, hasImageGen: !!c.openaiKey
  };
});
// ---------------------------------------------------------------------------
// Kokoro — local neural TTS (free, offline, high quality). A python worker is
// kept WARM (model loaded once, ~1.2s) so each reply only pays synth time
// (~0.85x realtime on the M4). British "bm_george" by default for the J.A.R.V.I.S.
// feel. Falls back to cloud TTS in synthesizeSpeech if the worker ever dies.
// ---------------------------------------------------------------------------
const KOKORO_DIR = path.join(os.homedir(), '.bhatbot', 'kokoro');
let kokoroProc = null, kokoroReady = null, kokoroBuf = '', kokoroNextId = 1;
const kokoroPending = new Map();

function kokoroAvailable() {
  try { return fs.existsSync(path.join(KOKORO_DIR, 'kokoro-v1.0.onnx')) && fs.existsSync(path.join(KOKORO_DIR, 'voices-v1.0.bin')); }
  catch { return false; }
}

function kokoroStart() {
  if (kokoroReady) return kokoroReady;
  kokoroReady = new Promise((resolve, reject) => {
    const worker = unpacked(path.join(__dirname, 'scripts', 'kokoro_worker.py'));
    const py = resolvePython();
    let settled = false;
    kokoroProc = spawn(py, [worker, KOKORO_DIR], { env: { ...process.env, PATH: EXEC_PATH } });
    kokoroProc.on('error', (e) => { if (!settled) { settled = true; reject(e); } cleanup(e); });
    kokoroProc.stderr.on('data', () => {}); // model logs to stderr; ignore
    kokoroProc.stdout.on('data', (d) => {
      kokoroBuf += d.toString();
      let nl;
      while ((nl = kokoroBuf.indexOf('\n')) >= 0) {
        const line = kokoroBuf.slice(0, nl).trim(); kokoroBuf = kokoroBuf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready && !settled) { settled = true; resolve(); continue; }
        if (msg.fatal && !settled) { settled = true; reject(new Error(msg.fatal)); continue; }
        const p = kokoroPending.get(msg.id);
        if (p) { kokoroPending.delete(msg.id); p(msg); }
      }
    });
    kokoroProc.on('close', () => cleanup(new Error('kokoro worker exited')));
    function cleanup(err) {
      for (const [, p] of kokoroPending) p({ error: err.message });
      kokoroPending.clear(); kokoroProc = null; kokoroReady = null; kokoroBuf = '';
    }
  });
  return kokoroReady;
}

// Allowed Kokoro voices (guards against junk from the phone). British male/female first.
const KOKORO_VOICES = ['bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable', 'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily', 'am_michael', 'am_adam', 'af_bella', 'af_nicole'];
async function kokoroSynth(text, opts = {}) {
  if (!kokoroAvailable()) return { error: 'kokoro model not installed' };
  try { await kokoroStart(); } catch (e) { return { error: 'kokoro worker failed: ' + e.message }; }
  if (!kokoroProc) return { error: 'kokoro worker unavailable' };
  const c = loadConfig();
  const id = kokoroNextId++;
  const voice = (opts.voice && KOKORO_VOICES.includes(opts.voice)) ? opts.voice : (c.kokoroVoice || 'bm_george');
  let speed = Number(opts.speed != null ? opts.speed : (c.kokoroSpeed != null ? c.kokoroSpeed : 1.0));
  if (!isFinite(speed)) speed = 1.0;
  speed = Math.max(0.6, Math.min(1.4, speed));   // clamp to a sane, non-robotic range
  const req = { id, text: String(text).slice(0, 2000), voice, speed, lang: c.kokoroLang || 'en-gb' };
  const msg = await new Promise((resolve) => {
    const timer = setTimeout(() => { kokoroPending.delete(id); resolve({ error: 'kokoro timeout' }); }, 30000);
    kokoroPending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    try { kokoroProc.stdin.write(JSON.stringify(req) + '\n'); }
    catch (e) { kokoroPending.delete(id); clearTimeout(timer); resolve({ error: e.message }); }
  });
  if (msg.error) return { error: msg.error };
  try {
    const buf = fs.readFileSync(msg.path); fs.unlink(msg.path, () => {});
    return { success: true, audio: buf.toString('base64'), mimeType: 'audio/wav', via: 'kokoro' };
  } catch (e) { return { error: e.message }; }
}

async function elevenLabsSynth(t, c) {
  if (!c.elevenLabsKey) return { error: 'no elevenLabsKey' };
  const voiceId = c.ttsVoice || c.elevenLabsVoiceId || 'pNInz6obpgDQGcFmaJgB';
  // flash_v2_5 = ElevenLabs' lowest-latency model (~75ms vs turbo's ~250-400ms), same
  // voices. optimize_streaming_latency=3 trims first-byte time further. Big speaking-speed win.
  const model = c.ttsModel || 'eleven_flash_v2_5';
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128&optimize_streaming_latency=3`, {
    method: 'POST', headers: { 'xi-api-key': c.elevenLabsKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: t, model_id: model, voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.2, use_speaker_boost: false } })
  });
  if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); return { success: true, audio: buf.toString('base64'), mimeType: 'audio/mpeg', via: 'elevenlabs' }; }
  return { error: `elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`, status: r.status };
}

async function openaiSynth(t, c) {
  if (!c.openaiKey) return { error: 'no openaiKey' };
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + c.openaiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.openaiTtsModel || 'gpt-4o-mini-tts', voice: c.openaiTtsVoice || 'onyx', input: t, response_format: 'mp3',
      instructions: c.ttsInstructions || 'Calm, refined British butler. Measured, crisp, understated wit — like J.A.R.V.I.S.' })
  });
  if (!r.ok) return { error: `openai-tts ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const buf = Buffer.from(await r.arrayBuffer());
  return { success: true, audio: buf.toString('base64'), mimeType: 'audio/mpeg', via: 'openai' };
}

// Multi-provider TTS — kokoro (local neural, default), elevenlabs (cloud JARVIS), openai (onyx), piper (offline)
// Plain function so both the IPC handler (desktop HUD) and the express server (phone PWA) can call it.
async function synthesizeSpeech(text, opts = {}) {
  const c = loadConfig();
  const t = (text || '').trim();
  if (!t) return { error: 'empty text' };
  // Default to local Kokoro when installed (free, offline); honor explicit ttsProvider otherwise.
  const provider = c.ttsProvider || (kokoroAvailable() ? 'kokoro' : (c.elevenLabsKey ? 'elevenlabs' : (c.openaiKey ? 'openai' : (c.piperBin ? 'piper' : null))));
  try {
    if (provider === 'kokoro') {
      const r = await kokoroSynth(t, opts);
      if (r.success) return r;
      // worker died / not installed → fall back to cloud so voice never goes silent
      console.error('[tts] kokoro failed, falling back:', r.error);
      if (c.elevenLabsKey) { const e = await elevenLabsSynth(t, c); if (e.success) return e; }
      if (c.openaiKey) return await openaiSynth(t, c);
      return { error: 'kokoro failed and no cloud fallback: ' + r.error };
    }
    if (provider === 'elevenlabs') {
      const e = await elevenLabsSynth(t, c);
      if (e.success) return e;
      // EL failed (quota/auth/rate/network) → fall back to free local Kokoro, then OpenAI,
      // so the voice never dies even when the ElevenLabs free tier is exhausted.
      console.error('[tts] elevenlabs failed, falling back:', e.error);
      if (kokoroAvailable()) { const k = await kokoroSynth(t); if (k.success) return k; }
      if (c.openaiKey) return await openaiSynth(t, c);
      return { error: e.error };
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
    if (!c.openaiKey) return { error: 'no TTS provider configured (set kokoro model, openaiKey, elevenLabsKey, or piperBin)' };
    return await openaiSynth(t, c);
  } catch (e) { return { error: e.message }; }
}
ipcMain.handle('synthesize-speech', (_e, { text }) => synthesizeSpeech(text));

// Desktop voice output — synthesize in main, play with macOS `afplay`. The renderer
// <Audio> element is unreliable in Electron (autoplay/codec quirks → silent desktop,
// the long-standing "works on phone not Mac" bug). afplay is rock-solid and the
// synthesis already lives here. Returns once playback has STARTED (not finished).
let ttsPlayProc = null, ttsPlaySeq = 0, ttsActive = false;
// Tell the wake listener whether audio is playing, so its barge-in VAD only arms during
// playback (and uses the echo-rejection threshold then). Drives the `ttsActive` flag the
// barge-in handler checks.
function setTtsActive(on) {
  if (ttsActive === on) return;
  ttsActive = on;
  try { if (wakeProc && wakeProc.stdin && wakeProc.stdin.writable) wakeProc.stdin.write(on ? 'TTS 1\n' : 'TTS 0\n'); } catch {}
}
function stopDesktopTTS() {
  ttsPlaySeq++;
  if (ttsPlayProc) { try { ttsPlayProc.kill(); } catch {} ttsPlayProc = null; }
  setTtsActive(false);
}
// Sentence chunks for streaming speech (synth one, play it while the next synthesizes).
function splitForSpeech(text) {
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '').trim();
  const parts = clean.match(/[^.!?\n]+[.!?]?(\s|$)|[^.!?\n]+$/g) || [];
  const out = []; let buf = '';
  for (let p of parts) { p = p.trim(); if (!p) continue; buf = buf ? buf + ' ' + p : p; if (buf.length >= 60 || /[.!?]$/.test(p)) { out.push(buf); buf = ''; } }
  if (buf) out.push(buf);
  return out.filter((s) => s.length);
}
function playFile(file, seq) {
  return new Promise((res) => {
    if (seq !== ttsPlaySeq) return res();
    setTtsActive(true);                                  // arm barge-in for the duration of this clip
    ttsPlayProc = spawn('afplay', [file], { env: { ...process.env, PATH: EXEC_PATH } });
    const done = () => { fs.unlink(file, () => {}); if (seq === ttsPlaySeq) setTtsActive(false); res(); };
    ttsPlayProc.on('close', done);
    ttsPlayProc.on('error', done);
  });
}
async function speakDesktop(text, opts = {}) {
  const c = loadConfig();
  if (c.ttsEnabled === false) return { success: false, skipped: 'tts disabled' };
  let t = String(text || '').trim();
  if (!t) return { success: false };
  stopDesktopTTS();
  const seq = ++ttsPlaySeq;
  // Single consistent voice: always synthesize through the configured provider (no more
  // macOS `say` shortcut for short text — that was a second, different voice).
  // Long → condense for speech (full text still on screen / "read full"). Threshold 500
  // (was 300): most replies now skip the extra summarize LLM round-trip → speaks sooner.
  if (!opts.full && t.length > 500) {
    try { const s = await summarizeForSpeech(t); if (s && s.success && s.text) t = s.text; } catch {}
  }
  if (seq !== ttsPlaySeq) return { success: false, superseded: true };
  // Short text → ONE synth call so Kokoro keeps continuous, natural prosody (chunking
  // resets intonation each sentence → robotic). Only long full-reads stream sentence
  // chunks (to start audio sooner). 350 chars ≈ a few smooth sentences.
  const chunks = t.length <= 350 ? [t] : splitForSpeech(t);
  if (!chunks.length) return { success: false };
  const jobs = chunks.map((s) => synthesizeSpeech(s).catch(() => null)); // prefetch in parallel
  for (let i = 0; i < jobs.length; i++) {
    const r = await jobs[i];
    if (seq !== ttsPlaySeq) return { success: false, superseded: true };
    if (!r || !r.success) continue;
    const ext = (r.mimeType || '').includes('wav') ? 'wav' : 'mp3';
    const out = path.join(os.tmpdir(), `bhatbot-say-${seq}-${i}.${ext}`);
    try { fs.writeFileSync(out, Buffer.from(r.audio, 'base64')); } catch { continue; }
    await playFile(out, seq);
    if (seq !== ttsPlaySeq) return { success: false, superseded: true };
  }
  return { success: true, via: 'tts' };
}
ipcMain.handle('play-tts', (_e, { text, full }) => speakDesktop(text, { full: !!full }));

// --- Streaming TTS: speak each sentence the moment it completes, while the model is still
// generating the next. First audio at ~sentence 1 (~2-3s) instead of after the whole reply
// + a summarize call. Shares ttsPlaySeq so a new turn cancels in-flight speech. ---
let ttsStreamSeq = 0, ttsStreamBuf = '', ttsStreamQ = [], ttsStreamDraining = false;
function ttsStreamStart() {
  stopDesktopTTS();
  ttsStreamSeq = ++ttsPlaySeq; ttsStreamBuf = ''; ttsStreamQ = []; ttsStreamDraining = false;
  return ttsStreamSeq;
}
function ttsStreamFeed(seq, delta) {
  if (seq !== ttsStreamSeq) return;
  if (loadConfig().ttsEnabled === false) return;
  ttsStreamBuf += delta;
  const re = /[^.!?\n]*[.!?\n]+/g; let m, consumed = 0;
  while ((m = re.exec(ttsStreamBuf))) { const s = m[0].trim(); consumed = re.lastIndex; if (s.length > 2) ttsStreamEnqueue(seq, s); }
  if (consumed) ttsStreamBuf = ttsStreamBuf.slice(consumed);
}
function ttsStreamFlush(seq) {
  if (seq !== ttsStreamSeq) return;
  const rest = ttsStreamBuf.trim(); ttsStreamBuf = '';
  if (rest && loadConfig().ttsEnabled !== false) ttsStreamEnqueue(seq, rest);
}
// Longest suffix of s that is also a prefix of tag — i.e. a possibly-split tag at a chunk
// boundary, which we must hold back rather than display/speak.
function partialTagTail(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) if (tag.startsWith(s.slice(s.length - k))) return k;
  return 0;
}
// Per-turn streaming parser: pulls <speak>…</speak> content out of the token stream and
// feeds ONLY that to TTS, while returning the tag-stripped text for on-screen display.
// Handles tags split across deltas. If the model never used <speak>, we speak nothing
// (per the prompt) unless the whole reply is short (likely an unwrapped quick answer).
function makeSpeakStream(seq) {
  const OPEN = '<speak>', CLOSE = '</speak>';
  let pending = '', inside = false, sawTag = false, full = '';
  function feed(delta) {
    full += delta; pending += delta; let display = '';
    while (pending.length) {
      if (!inside) {
        const i = pending.indexOf(OPEN);
        if (i === -1) { const keep = partialTagTail(pending, OPEN); display += pending.slice(0, pending.length - keep); pending = pending.slice(pending.length - keep); break; }
        display += pending.slice(0, i); pending = pending.slice(i + OPEN.length); inside = true; sawTag = true;
      } else {
        const j = pending.indexOf(CLOSE);
        if (j === -1) { const keep = partialTagTail(pending, CLOSE); const emit = pending.slice(0, pending.length - keep); if (emit) { ttsStreamFeed(seq, emit); recordSpoken(emit); display += emit; } pending = pending.slice(pending.length - keep); break; }
        const segq = pending.slice(0, j); if (segq) { ttsStreamFeed(seq, segq); recordSpoken(segq); display += segq; } pending = pending.slice(j + CLOSE.length); inside = false;
      }
    }
    return display;
  }
  function finish() {
    let display = pending.replace(/<\/?speak>/g, '');
    if (inside && display) { ttsStreamFeed(seq, display); recordSpoken(display); }
    pending = '';
    // No <speak> at all but a short reply → speak it (model likely just didn't wrap a quick answer).
    if (!sawTag) { const f = full.replace(/<\/?speak>/g, '').trim(); if (f && f.length <= 160) { ttsStreamFeed(seq, f); recordSpoken(f); } }
    ttsStreamFlush(seq);
    return { sawTag, display };
  }
  return { feed, finish };
}
// Instant verbal acknowledgments — spoken the moment a task starts (before the model even
// responds) so perceived spoken latency ≈ 0. JARVIS pattern: ack → work → result.
const ACKS = ['On it, sir.', 'Right away, sir.', 'On it.', 'Got it.', 'Working on it.', 'Of course, sir.'];
const ACTION_RE = /\b(open|launch|play|pause|skip|run|build|fix|check|create|make|find|search|deploy|write|send|close|quit|set|update|install|delete|remove|pull up|show me|navigate|go to|download|generate|render|start|stop|turn)\b/i;
function maybeAck(seq, userText) {
  const c = loadConfig();
  if (c.instantAck === false || c.ttsEnabled === false) return;
  if (!ACTION_RE.test(userText || '')) return;     // only acknowledge action requests, not idle chat
  ttsStreamFeed(seq, ACKS[Math.floor(Math.random() * ACKS.length)]);
}

// ---------------------------------------------------------------------------
// Voice-first session notes. Bhatbot is a voice interface that keeps notes: it
// accumulates what was actually SPOKEN this session (the <speak> content, minus throwaway
// acks), and on session end (30s silence / "wrap up" / space) a Haiku call turns that
// spoken transcript into a structured markdown note — saved to ~/.bhatbot/notes/ and shown
// as a dated card. Summarizing the spoken words (not raw tool output) yields clean,
// debrief-quality notes. See the voice-first product vision.
// ---------------------------------------------------------------------------
let sessionSpoken = [];          // meaningful spoken lines this session
let sessionSilenceTimer = null;
let sessionGenerating = false;
const SESSION_SILENCE_MS = 30000;
function recordSpoken(text) {
  const t = String(text || '').trim();
  if (t && t.length > 1) { sessionSpoken.push(t); noteActivity(); }
}
function noteActivity() {
  // Reset the 30s silence → end-session timer on any spoken/user activity.
  if (sessionSilenceTimer) clearTimeout(sessionSilenceTimer);
  if (loadConfig().sessionNotes === false) return;
  sessionSilenceTimer = setTimeout(() => { endSession('silence'); }, SESSION_SILENCE_MS);
}
function slugify(s) { return String(s || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'session'; }
async function endSession(trigger) {
  if (sessionSilenceTimer) { clearTimeout(sessionSilenceTimer); sessionSilenceTimer = null; }
  const spoken = sessionSpoken.slice(); sessionSpoken = [];
  if (sessionGenerating || spoken.length < 1) return;          // nothing worth a note
  const transcript = spoken.join('\n');
  if (transcript.replace(/\s/g, '').length < 40) return;       // too little said
  sessionGenerating = true;
  try {
    const sys = 'You convert a spoken assistant transcript into a concise session note (a project debrief, not a chat log). Output GitHub markdown: a single "# " title line (5-8 words, specific), then short sections only if they apply: **Decisions**, **Done**, **Next**. Bullets, terse. Ignore filler acknowledgements. No preamble.';
    const r = await callClaude([{ role: 'user', content: 'Spoken transcript of this session:\n\n' + transcript.slice(0, 6000) + '\n\nWrite the session note.' }], getApiKey(), MODEL_HAIKU);
    let md = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!md) { sessionGenerating = false; return; }
    const titleM = md.match(/^#\s+(.+)$/m);
    const title = titleM ? titleM[1].trim() : 'Session ' + new Date().toLocaleTimeString();
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const file = path.join(NOTES_DIR, `${stamp}-${slugify(title)}.md`);
    const body = `---\ndate: ${now.toISOString()}\ntrigger: ${trigger}\n---\n\n${md}\n`;
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.writeFileSync(file, body);
    const note = { file, title, date: now.toISOString(), trigger, markdown: md };
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session-note', note);
    sendToActivity('tool-update', { type: 'thinking', text: '📝 session note: ' + title });
  } catch (e) { console.warn('[notes] generation failed:', e.message); }
  finally { sessionGenerating = false; }
}
function listNotes(limit = 50) {
  try {
    return fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, limit).map((f) => {
      const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf8');
      const md = raw.replace(/^---[\s\S]*?---\n+/, '');
      const dateM = raw.match(/date:\s*(.+)/); const titleM = md.match(/^#\s+(.+)$/m);
      return { file: path.join(NOTES_DIR, f), title: titleM ? titleM[1].trim() : f, date: dateM ? dateM[1].trim() : '', markdown: md };
    });
  } catch { return []; }
}

// Critique → memory reflection. Pure upside: fires ONLY when the user's message reads as a
// correction, runs async (never blocks the reply), costs ~$0.00015 (Haiku), and saves only
// if Haiku returns something actionable. Confirms with a quiet, delayed "Noted." so it
// doesn't step on the main response. The learning loop that makes Bhatbot feel like it adapts.
const CORRECTION_RE = /\b(that's wrong|that is wrong|incorrect|not what i|don'?t do that|stop doing|i told you|not like that|wrong answer|you (got|did) (it|that) wrong|be more|be less|too (verbose|long|short|terse|wordy)|no,? (don'?t|stop|that|i|you)|actually,? (i|you|it)|instead of|never do)\b/i;
function reflectOnCorrection(history, userText, priorText) {
  try {
    const c = loadConfig();
    if (c.reflection === false) return;
    if (!userText || !CORRECTION_RE.test(userText)) return;
    // last assistant text in history = what's being corrected
    let prior = priorText || '';
    if (!prior) { const a = [...(history || [])].reverse().find((m) => m.role === 'assistant'); if (a) prior = typeof a.content === 'string' ? a.content : (Array.isArray(a.content) ? a.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : ''); }
    (async () => {
      try {
        const r = await callClaude([{ role: 'user', content: `User correction: "${userText.slice(0, 500)}"\nMy prior reply: "${String(prior).slice(0, 800)}"\n\nExtract ONE durable working-preference to remember for next time, as a single imperative line (e.g. "Keep spoken replies under two sentences"). If there is nothing durable/actionable, output exactly: NONE` }], getApiKey(), MODEL_HAIKU);
        const pref = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        if (!pref || /^none\b/i.test(pref) || pref.length < 6) return;
        saveMemoryEntry('Preferences & Patterns', pref.replace(/^[-*\s]+/, '').slice(0, 200));
        sendToActivity('tool-update', { type: 'thinking', text: '🧠 learned: ' + pref.slice(0, 120) });
        if (c.ttsEnabled !== false) setTimeout(() => { try { speakDesktop('Noted.', { full: true }); } catch {} }, 3500);
      } catch {}
    })();
  } catch {}
}
function ttsStreamEnqueue(seq, sentence) {
  if (seq !== ttsStreamSeq) return;
  const clean = String(sentence).replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '').trim();
  if (!clean) return;
  ttsStreamQ.push(clean);
  if (!ttsStreamDraining) ttsStreamDrain(seq);
}
async function ttsStreamDrain(seq) {
  ttsStreamDraining = true;
  try {
    while (ttsStreamQ.length) {
      if (seq !== ttsStreamSeq) break;
      const s = ttsStreamQ.shift();
      const r = await synthesizeSpeech(s).catch(() => null);
      if (seq !== ttsStreamSeq) break;
      if (!r || !r.success) continue;
      const ext = (r.mimeType || '').includes('wav') ? 'wav' : 'mp3';
      const out = path.join(os.tmpdir(), `bb-stream-${seq}-${Math.random().toString(36).slice(2)}.${ext}`);
      try { fs.writeFileSync(out, Buffer.from(r.audio, 'base64')); } catch { continue; }
      await playFile(out, seq);
    }
  } finally { ttsStreamDraining = false; }
}

// History integrity guard. Agent histories must alternate user/assistant and keep every
// tool_use paired with a following tool_result. Corruptions (a stray user message that just
// echoes the assistant's own last reply → self-hallucination loops; an orphan tool_result
// with no preceding tool_use → API 400) are logged and healed in place so a session can't
// get wedged. Returns a cleaned copy.
function validateHistory(history) {
  if (!Array.isArray(history)) return [];
  const blocks = (m) => Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
  const textOf = (m) => blocks(m).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const toolUseIds = (m) => (m.role === 'assistant' ? blocks(m).filter((b) => b.type === 'tool_use').map((b) => b.id) : []);
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (!m || !m.role) { console.warn('[history] dropped malformed message at', i); continue; }
    // 1) user message that exactly echoes the previous assistant text = the self-feedback bug.
    if (m.role === 'user' && out.length && out[out.length - 1].role === 'assistant') {
      const ut = textOf(m), at = textOf(out[out.length - 1]);
      if (ut && ut === at) { console.warn('[history] dropped user msg echoing assistant reply (self-hallucination guard) at', i); continue; }
    }
    // 2) orphan tool_result (no matching tool_use in the immediately preceding assistant msg).
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) {
      const prevIds = out.length ? toolUseIds(out[out.length - 1]) : [];
      const kept = m.content.filter((b) => b.type !== 'tool_result' || prevIds.includes(b.tool_use_id));
      if (kept.length !== m.content.length) console.warn('[history] stripped orphan tool_result(s) at', i);
      if (!kept.length) continue;
      out.push({ role: 'user', content: kept }); continue;
    }
    out.push(m);
  }
  // 3) assistant tool_use whose tool_result never arrived → drop the trailing dangling turn.
  while (out.length && out[out.length - 1].role === 'assistant' && toolUseIds(out[out.length - 1]).length) {
    console.warn('[history] dropped trailing assistant turn with unanswered tool_use');
    out.pop();
  }
  return out;
}
ipcMain.handle('stop-tts', () => { stopDesktopTTS(); return { success: true }; });

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
// screen / can be read in full on demand). Haiku first (tiny + fast + negligible quota);
// if Haiku is rate-limited/unavailable, fall back to the local model so voice never dies.
const SPEECH_SYS = "You are J.A.R.V.I.S., a refined British butler, distilling a written reply into spoken form for Siddhant. Convey the actual MEANING and outcome — the direct answer, the key result or conclusion, any important numbers/names, and what was done or recommended — not merely the topic. Stay faithful; never invent or add. Speak naturally in 1–3 flowing sentences as you would aloud. No markdown, lists, code, or preamble — just the spoken line.";
async function summarizeForSpeech(text) {
  const t = (text || '').trim();
  if (!t) return { error: 'empty text' };
  const cfg = loadConfig();
  const apiKey = getApiKey();
  // 1) Haiku — only if there's budget this minute (a summary is small, ~few hundred tok).
  if (apiKey && requestTokenEstimate([{ role: 'user', content: t.slice(0, 8000) }]) < rateBudget().free) {
    try {
      const j = await anthropicRequest({
        model: MODEL_HAIKU, max_tokens: 280, system: SPEECH_SYS,
        messages: [{ role: 'user', content: t.slice(0, 8000) }]
      }, apiKey, { retries: 1 });
      const out = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      if (out) return { success: true, text: out, via: 'haiku' };
    } catch (e) { console.warn('[summary] haiku failed → local:', e.message); }
  }
  // 2) Local model fallback (no quota) — used when rate-limited or Haiku errored.
  if (await ollamaUp()) {
    try {
      const lm = cfg.localModel || 'qwen3:latest';
      const out = (await ollamaChat([{ role: 'user', content: t.slice(0, 8000) }], SPEECH_SYS, lm) || '').trim();
      if (out) return { success: true, text: out, via: 'ollama' };
    } catch (e) { console.warn('[summary] ollama failed:', e.message); }
  }
  return { error: 'no summary path available' };
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
  noteActivity();                                  // user spoke/typed → keep the session alive
  // "wrap up" / "that's all" ends the session (note generated after the reply lands).
  const ut = lastUserText(history);
  const wrap = /\b(wrap up|wrap it up|that'?s all|we'?re done|end session|close out|debrief)\b/i.test(ut);
  try {
    const res = await agentLoop(history, apiKey, (event && event.sender ? event : { sender: { send() {} } }), { stream: true });
    if (wrap) setTimeout(() => endSession('wrap-up'), 1200);
    return res;
  }
  catch (e) { return { error: String(e && e.message ? e.message : e) }; }
});
ipcMain.handle('list-notes', () => listNotes());
ipcMain.on('end-session', () => endSession('manual'));
// Encrypted credential vault (safeStorage). The model never calls these — user-driven only.
ipcMain.handle('cred-store', (_e, { label, domain, username, secret }) => { try { return { ref: credentials.store(label, domain, username, secret) }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('cred-list', () => credentials.list());
ipcMain.handle('cred-remove', (_e, { ref }) => { credentials.remove(ref); return { ok: true }; });
// Drag-dropped / picked file paths → vision/text blocks for the next message.
ipcMain.handle('attach-paths', async (_e, paths) => {
  const blocks = [], names = [];
  for (const p of (paths || [])) { try { blocks.push(...await mediaFileToBlocks(p)); names.push(path.basename(p)); } catch {} }
  return { blocks, names };
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
    // Pre-warm local Kokoro TTS so the first spoken reply isn't cold (~0.8s load).
    if (kokoroAvailable()) kokoroStart().then(() => console.log('[tts] kokoro warm (local)')).catch((e) => console.error('[tts] kokoro warmup failed:', e.message));
  } catch (e) { console.error('Startup error:', e); }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  try { if (browser) await browser.close(); } catch {}
  try { if (wakeProc) wakeProc.kill(); } catch {}
  try { if (ptyProc) ptyProc.kill(); } catch {}
  try { if (kokoroProc) kokoroProc.kill(); } catch {}
  try { stopMcpServer(); } catch {}
  try { if (briefingTimer) clearTimeout(briefingTimer); } catch {}
  try { if (telegramBot) telegramBot.stopPolling(); } catch {}
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
