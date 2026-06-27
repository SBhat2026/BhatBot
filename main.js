'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, shell, dialog, screen, webContents, systemPreferences, desktopCapturer, powerMonitor } = require('electron');
// Electron/Chromium blocks audio autoplay after async calls → desktop TTS was silent.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const darkbloom = require('./darkbloom');
const credentials = require('./lib/credentials');
const configsec = require('./lib/configsec');          // Phase 4 #1 — plaintext-secret migration + write-time guard
const makePatrol = require('./lib/patrol');            // Feat-2 — ambient health watch → Telegram/call relay
const rstate = require('./lib/runtime-state');         // live state feed: ~/.bhatbot/state.json + events.jsonl
const introspect = require('./lib/introspect');        // Phase 5 — self-portrait (pure telemetry aggregation)
const reflect = require('./lib/reflect');              // Phase 5 — desire engine (bounded Opus, hardcoded prompt)
const narrate = require('./lib/narrate');              // Phase 5 — first-person JARVIS narration of desires
const worldcup = require('./lib/worldcup');               // FIFA WC 2026 live bracket + prediction engine
const news = require('./lib/news');                       // NYT news skim (RSS, no key; Top Stories API if nytApiKey set)
const websearch = require('./lib/websearch');             // web_search — ranked results (Brave/Serper/Tavily if keyed, else free DuckDuckGo)
const { classify } = require('./taskClassifier');
const { startMcpServer, stopMcpServer } = require('./mcp-server');
// Workspace multi-agent stack (Architecture v2) — orchestrator delegates big projects to
// stateless agents over structured state, keeping the chat context flat. See ARCHITECTURE.md.
const workspaceMgr = require('./lib/workspace');
const orchestrator = require('./lib/agents/orchestrator');
const wsState = require('./lib/state');
const wsMemory = require('./lib/memory');
const semantic = require('./lib/semantic');           // #12 — embedding-based semantic/episodic recall (degrades gracefully)
const toolselect = require('./lib/toolselect');        // W1 — per-turn tool retrieval (context-rot prevention)
const { classifyDepth } = require('./lib/depth');       // A3 — per-turn response-depth → max_tokens + directive
const depthmodel = require('./lib/depthmodel');         // Phase 3 #1 — learned depth model (heuristic = fallback)
const taper = require('./lib/taper');                   // Phase 3 #2 — conversation-position ceiling taper
const episodic = require('./lib/episodic');             // Phase 3 #3 — episodic VECTOR recall (read-path only)
const { riskOf } = require('./lib/risk');              // W3 — per-tool key-risk classification (auto|confirm|stepup)
const graph = require('./lib/graph');                  // W4 — knowledge-graph memory (entities + typed edges, multi-hop)
const sandbox = require('./lib/sandbox');              // W6 — worker_threads isolation for community/dynamic plugin tools
const a2a = require('./lib/a2a');                       // W7 — agent-to-agent handoff envelope (future-proof subagent routing)
const subagents = require('./lib/subagents');          // #20 — persistent specialized sub-agents (research/coding/lifeadmin)
const agentTeam = require('./lib/orchestrator');        // C — parallel same-task ensemble + independent app-tester
const planner = require('./lib/planner');               // B1 — decompose a goal into a task DAG for the team
const ambient = require('./lib/ambient');              // #18 — opt-in proactive Calendar/Mail awareness (OFF by default)
const { textHintFromSelector, splitForSpeech, estimateToolCost, stripReasoning } = require('./lib/pure');  // SPLIT_PLAN step 1
const projects = require('./lib/projects');            // #24 — project memory + living auto-summary
const visualInspect = require('./lib/inspect');
const security = require('./lib/security');          // P0.4 — injection sanitizer + daily audit
const notion = require('./lib/notion');               // P3  — Notion long-term memory (degrades gracefully)
const figures = require('./lib/figures');             // data-accurate matplotlib/seaborn figures
const logins = require('./lib/logins');               // domain-keyed login profiles (CRED_REF handles)
const modePrompts = require('./lib/prompts');         // P4  — mode-switching system prompts
const jobsBus = require('./lib/jobs');                // P5  — background job bus (task cards + spoken relay + steering)
const scheduler = require('./lib/scheduler');         // proactive scheduler (recurring/one-off autonomous tasks)
const simulate = require('./lib/simulate');           // physics/chem/math simulation sandbox (scipy/sympy/rdkit/openmm/pyscf…)
const selfheal = require('./lib/selfheal');           // autonomous self-healing (DISABLED by default; verify-gated self_fix loop)
const vanguard = require('./lib/vanguard');           // Phase 1 — unified VANGUARD fleet codename roster (OVERMIND/FORGE/ORACLE/…)
const { createAdmission } = require('./lib/admission'); // Phase 1 — budget-aware fleet admission controller (convoy fix)

const DB_MODELS = { db_speech: 'gpt-oss-20b', db_directive: 'gemma-4-26b' };

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const MEMORY_PATH = path.join(os.homedir(), '.bhatbot', 'memory.md');
const makeAudit = require('./lib/audit');   // SPLIT_PLAN step 2 — audit module (DI factory)
const { AUDIT_PATH, auditLog, readAudit } = makeAudit({ isRemote, estimateToolCost, recordToolCost });

// Tee all console output to ~/.bhatbot/logs/app.log so the terminal CLI (scripts/bhatctl.js)
// and headless tests can watch the real agent's logs + errors without a UI attached. Size-capped
// (truncates at ~5MB) so it can't grow unbounded. Best-effort — never let logging break the app.
const LOG_PATH = path.join(os.homedir(), '.bhatbot', 'logs', 'app.log');
try {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  try { if (fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) fs.writeFileSync(LOG_PATH, ''); } catch {}
  const _logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  const _tee = (orig, level) => (...args) => {
    try {
      const line = args.map((a) => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ');
      _logStream.write(`${new Date().toISOString()} [${level}] ${line}\n`);
    } catch {}
    try { orig(...args); } catch {}
  };
  console.log = _tee(console.log.bind(console), 'log');
  console.warn = _tee(console.warn.bind(console), 'warn');
  console.error = _tee(console.error.bind(console), 'error');
} catch {}

const HOTKEY = 'CommandOrControl+Shift+B';
const MODEL_SONNET = 'claude-sonnet-4-6';      // corrected from stale spec id
const MODEL_HAIKU = 'claude-haiku-4-5';        // corrected from stale spec id
const MAX_AGENT_ITERATIONS = 20;   // step ceiling; complex tasks need headroom to retry/replan
// TIER-2 THROUGHPUT: tools that are READ-ONLY / side-effect-free / order-independent, so when the
// model fires several in one turn they can run CONCURRENTLY (the higher per-minute cap serves the
// burst — proven 4×+ in scripts/parallel-bench). Stateful/mutating tools (browser page, run_shell,
// write_file, vision_click, screen_parse's shared worker, save_memory, system/media_control) are
// deliberately EXCLUDED and always run sequentially in order.
const PARALLEL_SAFE = new Set([
  'read_file', 'list_directory', 'fetch_url', 'web_search', 'news', 'world_cup', 'notion_search',
  'ask_ai', 'keychain_lookup', 'onepassword_lookup', 'predict_function', 'maps', 'molecule', 'weather',
]);
const EXEC_PATH = `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:/Library/Frameworks/Python.framework/Versions/3.13/bin`;
// SPLIT_PLAN step 7: raw shell exec + destructive-command pattern lists live in lib/shell.js now.
// The confirm/autonomous/remote gating that CONSULTS these stays below (woven into IPC/window state).
const { HARD_BLOCKED, CONFIRM_PATTERNS, runShell } = require('./lib/shell')({ EXEC_PATH });
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

// --- Wattage gating: heavy local ML (OmniParser caption model, gemma3 vision) and the recurring
// ambient watcher are battery hogs. powerMonitor.isOnBatteryPower() lets us throttle/skip them on
// battery so the laptop isn't drained by background work. config.powerSaver:false disables gating.
function onBatteryPower() {
  try { return powerMonitor.isOnBatteryPower(); } catch { return false; }
}
function powerSaverOn() {
  try { return loadConfig().powerSaver !== false; } catch { return true; }
}
// True when we should AVOID heavy local compute (on battery + saver enabled).
function shouldSpareWatts() { return powerSaverOn() && onBatteryPower(); }

let mainWindow = null;
let activityWindow = null;
let agentState = 'idle'; // 'running' | 'paused' | 'stopped'
let _lastUserText = '';  // most recent user turn (for the runtime-state snapshot)
let browser = null;
let page = null;
let browserContext = null;   // kept so we can persist cookies/localStorage (storageState) across launches
const BROWSER_STATE = path.join(os.homedir(), '.bhatbot', 'browser-profile.json');
// A REAL on-disk Chrome profile dir (launchPersistentContext). Unlike the storageState blob above,
// a persistent profile keeps Google/2FA sessions signed in across launches reliably (Google often
// rejects a restored storageState as a security risk). Sign in ONCE and it stays signed in.
const BROWSER_PROFILE_DIR = path.join(os.homedir(), '.bhatbot', 'browser-profile-dir');
let recordingSteps = null;   // array while recording a browser workflow, else null

// Persist the browser session (cookies + localStorage) so logins survive across
// launches — youtube/overleaf/spotify etc. usually need no re-login at all.
async function saveBrowserState() {
  try {
    if (!browserContext) return;
    fs.mkdirSync(path.dirname(BROWSER_STATE), { recursive: true });
    await browserContext.storageState({ path: BROWSER_STATE });
  } catch (e) { console.error('[browser] state save failed:', e.message); }
}

// ---------------------------------------------------------------------------
// Browser observer (watch-my-mouse): detect when SIDDHANT acts in the Playwright window so
// the agent (a) WAITS for him to finish before continuing, and (b) LEARNS his steps to reuse.
// An init script installs capture-phase listeners that forward each user event (with a
// generalized selector) to Node via an exposed binding. Agent-driven actions set a page flag
// so they're ignored. Passwords/OTP values are never captured.
// ---------------------------------------------------------------------------
let lastUserActivityTs = 0;      // updated on every human event in the browser window
let userEventBuffer = [];        // recent human steps (learning buffer), generalized selectors
// Consented observation window: BhatBot only "watches to learn" during an explicit, time-boxed
// session the user agreed to (5–10 min). Outside it, human events are still buffered (so the
// agent can yield to your cursor) but NOT narrated/learned-from.
let observeUntil = 0;            // ms epoch; > now ⇒ an active consented observation session
let observeSessionStart = 0;
let observeTimer = null;
function observing() { return Date.now() < observeUntil; }
// Screen-watching session (user-triggered "watch my screen"). Whole-screen, any app. Captures
// periodic frames, describes each with the LOCAL vision model, and buffers ONLY the text notes —
// raw screenshots are never persisted and the describer is told to skip passwords/secrets.
// Nothing reaches long-term memory without explicit approval (action:"save").
let screenWatchUntil = 0;
let screenWatchTimer = null;
let screenWatchTick = null;
let screenWatchBuffer = [];
function watchingScreen() { return Date.now() < screenWatchUntil; }
const OBSERVER_SCRIPT = `(() => {
  if (window.__bhatbotObserver) return; window.__bhatbotObserver = true;
  window.__bhatbotAgentActing = window.__bhatbotAgentActing || false;
  const esc = (s) => { try { return CSS.escape(s); } catch { return String(s).replace(/[^\\w-]/g, '\\\\$&'); } };
  function sel(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + esc(el.id);
    const a = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test'));
    if (a) return '[data-testid="' + a + '"]';
    const nm = el.getAttribute && el.getAttribute('name'); if (nm) return el.tagName.toLowerCase() + '[name="' + nm + '"]';
    const al = el.getAttribute && el.getAttribute('aria-label'); if (al) return el.tagName.toLowerCase() + '[aria-label="' + al + '"]';
    const tag = el.tagName.toLowerCase(), txt = (el.innerText || '').trim().slice(0, 40);
    if ((tag === 'button' || tag === 'a') && txt) return tag + ':has-text("' + txt.replace(/"/g, '') + '")';
    let path = [], n = el;
    while (n && n.nodeType === 1 && path.length < 4) {
      let s = n.tagName.toLowerCase(), p = n.parentElement;
      if (p) { const sib = [...p.children].filter((c) => c.tagName === n.tagName); if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')'; }
      path.unshift(s); n = n.parentElement;
    }
    return path.join(' > ');
  }
  function secretField(t) {
    const meta = ((t && (t.name || t.id || t.autocomplete || '')) || '').toLowerCase();
    return (t && t.type === 'password') || /pass|otp|code|cvv|card|secret|token|pin/.test(meta);
  }
  function emit(type, e) {
    if (window.__bhatbotAgentActing) return;       // ignore agent-driven events
    const t = e.target; if (!t || t.nodeType !== 1) return;
    try {
      const d = { type, selector: sel(t), tag: t.tagName.toLowerCase(), url: location.href, ts: Date.now() };
      if (type === 'input') { const sec = secretField(t); d.secret = sec; if (!sec && t.value != null && String(t.value).length <= 80) d.value = String(t.value); }
      if (type === 'key') d.key = e.key;
      if (window.__bhatbotUserEvent) window.__bhatbotUserEvent(d);
    } catch {}
  }
  document.addEventListener('pointerdown', (e) => emit('click', e), true);
  document.addEventListener('change', (e) => emit('input', e), true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') emit('key', e); }, true);
})();`;
function onUserBrowserEvent(d) {
  if (!d || !d.selector) return;
  lastUserActivityTs = Date.now();
  userEventBuffer.push(d);
  if (userEventBuffer.length > 200) userEventBuffer.shift();
  if (recordingSteps) {            // if a workflow is being recorded, capture HIS steps too
    if (d.type === 'click') recordingSteps.push({ action: 'click', selector: d.selector });
    else if (d.type === 'input' && d.value != null) recordingSteps.push({ action: 'type', selector: d.selector, text: d.value });
  }
  // Only narrate while explicitly observing or recording — otherwise this is just cursor-yield bookkeeping.
  if (observing() || recordingSteps) sendToActivity('tool-update', { type: 'thinking', text: `👤 you ${d.type}${d.value != null ? ' "' + String(d.value).slice(0, 20) + '"' : ''} — noting it` });
}
// Toggle the page-side flag so the observer ignores the agent's own clicks/types.
async function agentActing(on) { try { if (page) await page.evaluate((v) => { window.__bhatbotAgentActing = v; }, on); } catch {} }
// Block until Siddhant has been idle in the browser for idleMs (so we don't fight his cursor).
async function waitForUserIdle(idleMs = 1500, timeoutMs = 120000) {
  const start = Date.now(); let waited = false;
  while (Date.now() - lastUserActivityTs < idleMs) {
    if (Date.now() - start > timeoutMs) break;
    if (!waited) { waited = true; sendToActivity('tool-update', { type: 'thinking', text: '⏸ you’re using the browser — waiting for you to finish…' }); }
    await sleep(300);
  }
  return waited;
}
// Convert the recent human-event buffer into replayable workflow steps (skips secret inputs).
function userEventsToSteps(events) {
  const steps = []; let lastUrl = null;
  for (const d of events) {
    if (d.url && d.url !== lastUrl) { steps.push({ action: 'navigate', url: d.url }); lastUrl = d.url; }
    if (d.type === 'click') steps.push({ action: 'click', selector: d.selector });
    else if (d.type === 'input' && d.value != null && !d.secret) steps.push({ action: 'type', selector: d.selector, text: d.value });
  }
  return steps;
}
// Turn the raw human-event buffer into a digest the agent can narrate + ask about: replayable
// steps, the sites visited (by frequency), and the recent action trace. Secrets are masked.
function hostOf(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } }
function summarizeBrowsing(events) {
  const steps = userEventsToSteps(events);
  const hostCount = {};
  for (const d of events) { const h = hostOf(d.url); if (h) hostCount[h] = (hostCount[h] || 0) + 1; }
  const domains = Object.entries(hostCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([host, count]) => ({ host, count }));
  const recent = events.slice(-40).map((d) => ({ type: d.type, selector: d.selector, value: d.secret ? '«secret»' : d.value, host: hostOf(d.url) }));
  return { stepCount: steps.length, steps: steps.slice(0, 60), domains, recent };
}

const WORKFLOW_DIR = path.join(os.homedir(), '.bhatbot', 'workflows');
const NOTES_DIR = path.join(os.homedir(), '.bhatbot', 'notes');
const pendingConfirms = new Map();
let pendingGuidance = [];   // live feedback queued mid-task (steering)
let nexusWindow = null, studioWindow = null, terminalWindow = null, chessWindow = null, worldCupWindow = null;
let studioWatcher = null, ptyProc = null, wakeProc = null;

const STUDIO_DIR = path.join(os.homedir(), '.bhatbot', 'studio');
const STUDIO_INDEX = path.join(STUDIO_DIR, 'index.html');
const CHESS_HTML = path.join(STUDIO_DIR, 'chess.html');
const NEXUS_URL = 'https://nexusresearch.xyz';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- debugLatency instrumentation. Set debugLatency:true in config to log per-turn timing
// checkpoints (message-received → ack-queued → tts-synth-start → first-audio-playing →
// first-token). Each label logs once per turn so the numbers read as a clean waterfall. ---
let _latT0 = 0, _latSeen = new Set();
function latStart() { _latT0 = Date.now(); _latSeen = new Set(); latMark('message-received'); }
function latMark(label) {
  try {
    if (!_latT0 || !loadConfig().debugLatency) return;
    if (_latSeen.has(label)) return;
    _latSeen.add(label);
    console.log(`[latency] +${String(Date.now() - _latT0).padStart(5)}ms  ${label}`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Config / memory
// ---------------------------------------------------------------------------
// Mint + persist a safeStorage vault handle for a secret value (in-app only).
function vaultStore(label, value) { return credentials.store(label, '', '', value); }

// RAW config: CRED_REF_* handles left INTACT. Used as the write base + by migration so resolved
// plaintext is never re-serialized back to disk.
function loadConfigRaw() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
// Internal write that BYPASSES the plaintext validator — only ever called with ref-only/cleared
// values (migration). Never expose to tool/code-edit paths.
function saveConfigRaw(next) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  _cfgCache = null;
  return next;
}
// Phase 4 #1 — runtime read with CRED_REF_* resolved in-process via safeStorage. Cached by file
// mtime so we don't decrypt on every call (loadConfig is hot). Outside the app (no safeStorage),
// resolveRefs leaves handles untouched (callers fall back to process.env where it matters).
let _cfgCache = null, _cfgRawMtime = -1;
function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (_cfgCache && st.mtimeMs === _cfgRawMtime) return _cfgCache;
    const resolved = credentials.resolveRefs(loadConfigRaw());
    _cfgCache = resolved; _cfgRawMtime = st.mtimeMs;
    return resolved;
  } catch { return loadConfigRaw(); }
}
function saveConfig(patch) {
  // WRITE-TIME guard (Phase 4 #1): a plaintext credential must never land on disk. When the app's
  // safeStorage is up we AUTO-VAULT it (replace with a CRED_REF); otherwise the write is REJECTED
  // (throws PLAINTEXT_CRED_BLOCKED). This also fences self_fix/self_heal out of persisting new keys.
  const safePatch = configsec.sanitizeWrite(patch, credentials.canStore() ? { store: vaultStore } : {});
  const next = { ...loadConfigRaw(), ...safePatch };   // base = RAW (refs intact)
  return saveConfigRaw(next);
}
// One-shot startup migration: encrypt any plaintext secrets into the vault, leave CRED_REF handles.
// Idempotent (ref values skipped); only runs when safeStorage is available.
function migrateSecretsToVault() {
  try {
    if (!credentials.canStore()) return { skipped: 'safeStorage unavailable' };
    const raw = loadConfigRaw();
    const before = configsec.findPlaintext(raw);
    if (!before.length) return { migrated: [], alreadyClean: true };
    const { next, migrated } = configsec.migrate(raw, { store: vaultStore });
    if (migrated.length) saveConfigRaw(next);
    console.log(`[configsec] migrated ${migrated.length} plaintext secret(s) → vault: ${migrated.join(', ')}`);
    const leftover = configsec.findPlaintext(loadConfigRaw());
    if (leftover.length) console.warn(`[configsec] ⚠ ${leftover.length} secret(s) could not be vaulted: ${leftover.map((h) => h.path).join(', ')}`);
    return { migrated, leftover: leftover.map((h) => h.path) };
  } catch (e) { console.warn('[configsec] migration error:', e.message); return { error: e.message }; }
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

const { STATIC_PROMPT } = require('./lib/static-prompt');   // modePrompts stays on ./lib/prompts (separate module)

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
// ===========================================================================
// 3-tier memory. Tier 1 = working (this session's spoken/learned scratchpad, ephemeral).
// Tier 2 = episodic (past session notes in ~/.bhatbot/notes/, recalled by relevance).
// Tier 3 = semantic/long-term (curated memory.md via the lexical retrieval above).
// buildMemoryBlock merges all three into the (uncached) memory system block per query.
// ===========================================================================
const MEM_STOP = new Set(['the', 'and', 'for', 'are', 'was', 'how', 'does', 'did', 'with', 'this', 'that', 'you', 'your', 'can', 'will', 'work', 'works', 'have', 'has', 'what', 'when', 'where', 'why', 'who', 'use', 'using', 'get', 'got', 'make', 'made', 'want', 'need', 'should', 'would', 'into', 'from', 'about', 'also', 'than', 'then', 'them', 'they', 'its', 'bhatbot']);
function memTerms(query) { return ((query || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((t) => !MEM_STOP.has(t)); }

// Tier 2 — recall the most relevant PAST session notes for this query (idf-weighted overlap).
function recallEpisodic(query, k = 3) {
  try {
    const terms = memTerms(query); if (!terms.length) return '';
    if (!fs.existsSync(NOTES_DIR)) return '';
    const files = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.md'));
    if (files.length < 2) return '';                 // nothing worth recalling yet
    const docs = files.map((f) => { try { return { f, txt: fs.readFileSync(path.join(NOTES_DIR, f), 'utf8') }; } catch { return null; } }).filter(Boolean);
    const df = {}; for (const t of terms) df[t] = docs.reduce((n, d) => n + (d.txt.toLowerCase().includes(t) ? 1 : 0), 0) || 1;
    const scored = docs.map((d) => { const hay = d.txt.toLowerCase(); let s = 0; for (const t of terms) if (hay.includes(t)) s += 1 / df[t]; return { d, s }; })
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k);
    if (!scored.length) return '';
    return scored.map(({ d }) => {
      const title = (d.txt.match(/^#\s+(.+)$/m) || [])[1] || d.f.replace(/\.md$/, '');
      const body = d.txt.split('\n').filter((l) => l.trim() && !/^#/.test(l)).slice(0, 4).join(' ').replace(/\s+/g, ' ').slice(0, 280);
      return `- (${title}) ${body}`;
    }).join('\n');
  } catch { return ''; }
}

// Tier 4 — the SHARED Notion bank (Mac + cloud + other agents). Fetched async per turn by
// refreshNotionRecall (Notion's API is async; the memory block is built synchronously) and
// keyed to the query so a stale result is never shown for a different question.
let _notionRecall = { key: '', text: '' };
function notionRecallKey(query) { return (query || '').trim().slice(0, 200); }
async function refreshNotionRecall(query) {
  try {
    if (!notion.isConfigured || !notion.isConfigured()) { _notionRecall = { key: '', text: '' }; return; }
    const key = notionRecallKey(query);
    if (!key || key === _notionRecall.key) return;                 // dedupe identical consecutive turns
    if (!memTerms(key).length) { _notionRecall = { key, text: '' }; return; }
    const hits = await Promise.race([
      notion.searchMemory(key, { limit: loadConfig().notionRecallK || 5 }),
      new Promise((r) => setTimeout(() => r(null), 4000)),          // never block a turn >4s on Notion
    ]);
    const arr = Array.isArray(hits) ? hits : [];
    _notionRecall = { key, text: arr.length ? arr.map((h) => `- ${h.fact}${h.tags ? ` [${h.tags}]` : ''}`).join('\n') : '' };
  } catch { _notionRecall = { key: query || '', text: '' }; }
}

// Tier 5 — SEMANTIC recall (embedding match over durable facts + past turns). Like Notion, the
// search is async so we pre-warm a query-keyed cache that buildMemoryBlock (sync) reads.
let _semanticRecall = { key: '', text: '' };
async function refreshSemanticRecall(query) {
  try {
    if (loadConfig().semanticRecall === false || !semantic.isReady || !semantic.isReady()) { _semanticRecall = { key: '', text: '' }; return; }
    const key = notionRecallKey(query);
    if (!key || key === _semanticRecall.key) return;
    const hits = await Promise.race([
      semantic.search(key, { k: loadConfig().semanticK || 5 }),
      new Promise((r) => setTimeout(() => r(null), 4000)),
    ]);
    const arr = Array.isArray(hits) ? hits : [];
    _semanticRecall = { key, text: arr.length ? arr.map((h) => `- ${h.text}${h.kind === 'episodic' ? ' (past turn)' : ''} (${(h.score || 0).toFixed(2)})`).join('\n') : '' };
  } catch { _semanticRecall = { key: query || '', text: '' }; }
}

// Tier 2 (Phase 3 #3) — EPISODIC VECTOR recall. Pre-warmed like the other async tiers; buildMemoryBlock
// (sync) reads the query-keyed cache. Embeds the query, cosine-ranks past-session notes, injects only
// the top-k (≤10) instead of the lexical idf set — and flags a "seen this before?" hit when the top
// match is a near-duplicate of the current question, so the agent can confirm/extend rather than
// regenerate. Read-path only; never writes a note. Falls back to lexical recallEpisodic on empty.
let _episodicVec = { key: '', text: '', seen: null };
async function refreshEpisodicVec(query) {
  try {
    const c = loadConfig();
    if (c.episodicVectorRecall === false) { _episodicVec = { key: '', text: '', seen: null }; return; }
    const key = notionRecallKey(query);
    if (!key || key === _episodicVec.key) return;                       // dedupe identical consecutive turns
    const embedModel = (c.models && c.models.embed) || c.embedModel || 'nomic-embed-text';
    const k = c.episodicVectorK || 8;
    const scored = await Promise.race([
      episodic.recall({ notesDir: NOTES_DIR, query: key, k, embedModel }),
      new Promise((r) => setTimeout(() => r([]), 4000)),                // never block a turn >4s
    ]);
    const arr = Array.isArray(scored) ? scored : [];
    const seen = episodic.seenBefore(arr, c.episodicSeenThreshold || episodic.SEEN_THRESHOLD);
    _episodicVec = { key, text: episodic.format(arr), seen: seen.hit ? seen : null };
    if (seen.hit) console.log(`[episodic] ↺ seen-before hit (cos=${seen.score.toFixed(3)}): "${seen.entry.title}" — surfacing to agent before generation`);
  } catch { _episodicVec = { key: query || '', text: '', seen: null }; }
}

function buildMemoryBlock(query) {
  const cfg = loadConfig();
  const longTerm = memoryRetrieve(query, cfg.memoryTopK || 14);                              // tier 3
  // tier 2: prefer the pre-warmed VECTOR recall (Phase 3 #3); fall back to lexical recallEpisodic.
  const vecHit = (_episodicVec.text && _episodicVec.key === notionRecallKey(query)) ? _episodicVec.text : '';
  const episodicMem = cfg.episodicRecall === false ? ''
    : (vecHit || recallEpisodic(query, cfg.episodicK || 3));
  const seenBlock = (_episodicVec.seen && _episodicVec.key === notionRecallKey(query))
    ? `\n\n## ⚠ POSSIBLY ANSWERED BEFORE (episodic near-match, cos=${_episodicVec.seen.score.toFixed(2)})\n\nA past session already covered something very close to this: "${_episodicVec.seen.entry.title}" — ${_episodicVec.seen.entry.body}\nConfirm/extend/correct that rather than regenerating from scratch if it still applies.` : '';
  const working = (sessionSpoken && sessionSpoken.length)                                     // tier 1
    ? sessionSpoken.slice(-6).map((s) => '- ' + String(s).slice(0, 160)).join('\n') : '';
  const shared = (_notionRecall.text && _notionRecall.key === notionRecallKey(query)) ? _notionRecall.text : '';  // tier 4
  const semBank = (_semanticRecall.text && _semanticRecall.key === notionRecallKey(query)) ? _semanticRecall.text : '';  // tier 5
  let graphHits = '';                                                                          // tier 6 (W4)
  try { if (cfg.knowledgeGraph !== false && query) { const gq = graph.query(query, { depth: 2, limit: 12 }); if (gq.hits && gq.hits.length) graphHits = gq.hits.map((h) => '- ' + h).join('\n'); } } catch {}
  let out = '';
  if (longTerm) out += '\n\n---\n## RELEVANT MEMORY (long-term)\n\n' + longTerm;
  if (semBank) out += '\n\n## SEMANTIC RECALL (embedding match — facts + past turns)\n\n' + semBank;
  if (graphHits) out += '\n\n## KNOWLEDGE GRAPH (related entities — multi-hop)\n\n' + graphHits;
  if (shared) out += '\n\n## SHARED BANK (Notion — written by any agent/surface)\n\n' + shared;
  if (episodicMem) out += '\n\n## RECALLED FROM PAST SESSIONS (episodic)\n\n' + episodicMem;
  if (seenBlock) out += seenBlock;
  if (working) out += '\n\n## THIS SESSION SO FAR (working)\n\n' + working;
  try { const proj = projects.contextBlock(); if (proj) out += '\n\n' + proj; } catch {}   // #24 active project context
  return out ? redactSecrets(out) : '';
}
// P4 — per-task operating mode. Set at agentLoop entry (router suggestedMode on the
// pipeline path, regex classifier on the cloud path); read by systemBlocks below.
let currentMode = 'executive';
// Live background-job status, injected per call so the chat model can report on / steer
// running work mid-conversation (the foreground concierge never blocks on it).
function jobsStatusBlock() {
  try {
    const act = jobsBus.active();
    if (!act.length) return '';
    const lines = act.map((j) => `- ${j.id} [${j.kind}${j.agent ? '/' + j.agent : ''}] ${j.status}${j.progress ? ' ' + Math.round(j.progress * 100) + '%' : ''} — ${j.name}${j.note ? ' · ' + j.note : ''}`);
    return '\n\n---\n## BACKGROUND JOBS (live right now)\n' + lines.join('\n')
      + '\nThese run in the background while you chat. When Siddhant asks how work is going, answer from this list. When he wants to redirect, stop, or skip background work, call manage_jobs (guide/cancel) — do not just acknowledge.';
  } catch { return ''; }
}
// Four-block system: [cached static] + [mode prompt] + [small retrieved memory] + [live jobs].
// The mode block goes AFTER the cache_control block so prompt-cache hits survive mode switches
// (system blocks concatenate, so this is semantically identical to prepending).
// Live date/time — AFTER the cached static block so the prompt cache survives, giving the
// tool-less fast path accurate temporal grounding (was answering with a stale date).
function nowBlock() {
  try { return 'Current date & time: ' + new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) + '.'; }
  catch { return ''; }
}
// Live API-spend awareness so the model can self-govern (the "calculate cost, then chunk"
// behaviour Siddhant asked for). Placed AFTER the cached static block so cache hits survive.
function costBlock() {
  try {
    const c = loadConfig(); if (c.costAwareness === false) return '';
    const t = costToday(); if (!t || !t.calls) return '';
    const cap = c.dailyBudgetUsd ? ` of a $${c.dailyBudgetUsd} daily budget` : '';
    const over = c.dailyBudgetUsd && t.usd >= c.dailyBudgetUsd;
    let split = '';
    try {
      const bm = Object.entries(t.byModel || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([m, u]) => `${m} $${u.toFixed(3)}`).join(', ');
      const bt = Object.entries(t.byTool || {}).sort((a, b) => b[1] - a[1]).slice(0, 2)
        .map(([m, u]) => `${m} $${u.toFixed(3)}`).join(', ');
      if (bm) split += ` By model: ${bm}.`;
      if (bt) split += ` Paid tools: ${bt}.`;
    } catch {}
    return `API spend today: $${t.usd.toFixed(3)}${cap} across ${t.calls} calls.` + split
      + (over ? ' OVER BUDGET — prefer the local Ollama pipeline and Haiku, batch independent tool calls, skip vision/browser unless essential, and tell Siddhant if a task needs the budget raised.'
              : ' Size up big tasks before starting: estimate the tool-call/vision load, chunk anything heavy, and batch independent calls.');
  } catch { return ''; }
}
function systemBlocks(query) {
  const blocks = [{ type: 'text', text: buildStaticPrompt(), cache_control: { type: 'ephemeral' } }];
  const nb = nowBlock(); if (nb) blocks.push({ type: 'text', text: nb });
  const cb = costBlock(); if (cb) blocks.push({ type: 'text', text: cb });
  const modeP = modePrompts.selectModePrompt({ suggestedMode: currentMode });
  if (modeP) blocks.push({ type: 'text', text: modeP });
  const mem = buildMemoryBlock(query || '');
  if (mem) blocks.push({ type: 'text', text: mem });
  const jb = jobsStatusBlock();
  if (jb) blocks.push({ type: 'text', text: jb });
  return blocks;
}
function buildSystemPrompt(query) {
  return buildStaticPrompt() + '\n\n' + costBlock() + modePrompts.selectModePrompt({ suggestedMode: currentMode }) + buildMemoryBlock(query || '') + jobsStatusBlock();
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------
function chooseModel(lastUserMessage) {
  let model, task;
  if (overBudget()) { model = MODEL_HAIKU; task = 'budget'; }
  else {
    const sonnet = [
      /write.*prompt/i, /claude.?code/i, /architect/i, /refactor/i, /debug/i,
      /explain.*why/i, /design/i, /strategy/i, /research/i, /paper/i,
      /how.*work/i, /optimize/i, /plan/i, /review/i,
      // Multi-step web/automation: haiku fumbles these (login loops, wrong selectors). Route up.
      /log\s?in|sign\s?in|sign up|log into|account/i, /\bbrowser\b|navigate|website|web ?page/i,
      /google (?:sheet|doc|drive|calendar)|gmail|fill (?:out|in)|book|order|checkout|purchase/i,
      /step.?by.?step|multi.?step|then.*then|after that/i,
      // Live-data / sports questions: route up so the model reliably picks the right tool
      // (world_cup / web_search) instead of haiku answering from stale memory.
      /world cup|bracket|standings?|who'?s winning|tournament|fixtures?|matchup|\bodds\b|what.*watch|worth watching|\binsights?\b/i
    ];
    const hit = sonnet.some((p) => p.test(lastUserMessage || ''));
    model = hit ? MODEL_SONNET : MODEL_HAIKU; task = hit ? 'reasoning' : 'simple';
    // TELEMETRY NUDGE (Phase 1, Deliverable #3): router.jsonl now DRIVES, not just records. If the
    // cheap 'simple' route has been getting corrected a lot, the regex is under-calling it — escalate.
    if (model === MODEL_HAIKU && task === 'simple' && routeCorrectionRate('simple') > 0.34) {
      model = MODEL_SONNET; task = 'simple-nudged';
    }
  }
  _lastModel = model; _lastRouterTask = task;       // remembered for router telemetry (#13)
  return model;
}

// ---------------------------------------------------------------------------
// Claude API (prompt caching GA — cache_control, no beta header needed)
// ---------------------------------------------------------------------------
// Rough token estimate (~4 chars/token incl. base64 images) — for context trimming.
// Estimate input tokens. CRITICAL: images are billed by DIMENSIONS (~1.6k tokens for a large
// image), NOT by their base64 length — so counting the base64 string as length/4 over-estimates
// a single image as ~400k tokens and falsely trips the per-minute rate limiter on any vision /
// image-generation turn. We strip image payloads from the JSON and add a flat ~1600 each.
function estimateTokens(obj) {
  try {
    let imgTokens = 0;
    const s = JSON.stringify(obj, (k, v) => {
      if (v && typeof v === 'object' && v.type === 'image' && v.source) { imgTokens += 1600; return '[IMG]'; }
      if ((k === '_image' || k === 'data') && typeof v === 'string' && v.length > 2000) { imgTokens += 1600; return '[IMG]'; }
      return v;
    });
    return Math.ceil(s.length / 4) + imgTokens;
  } catch { return 0; }
}
// A user turn that LEADS with a tool_result is an orphan if its tool_use was trimmed away.
function leadsWithToolResult(m) {
  return m && m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result');
}
// Trim oldest turns until the message payload fits a token budget. Tier-1 cap is 50k
// input tokens/min; we keep messages well under that (system+tools eat the rest) so a
// single big call can't blow the limit. Pairing-safe: never start on an orphan tool_result.
function capTokens(messages, maxTok = 32000) {   // tier-2 headroom → keep more conversation in working memory (was 20k)
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
// --- Rolling per-minute, PER-MODEL token tracker. Anthropic enforces BOTH input-tokens/min (ITPM)
// AND output-tokens/min (OTPM), and the caps differ per model (Sonnet's are far higher than
// Haiku's). A single global input bucket (the old design) ignored OTPM entirely — the likeliest
// throttle on long, generation-heavy turns — and wasted Sonnet's headroom. We now track in+out per
// model in separate rolling 60s windows. ---
const _win = { in: {}, out: {} };          // { in: { model: [[ts,n],…] }, out: {…} }
function _winPush(bucket, model, n) {
  if (!n) return;
  const now = Date.now(); const key = model || 'default';
  const arr = (bucket[key] = bucket[key] || []); arr.push([now, n]);
  const cut = now - 60000; while (arr.length && arr[0][0] < cut) arr.shift();
}
function _winSum(bucket, model) {
  const key = model || 'default'; const arr = bucket[key]; if (!arr) return 0;
  const cut = Date.now() - 60000; while (arr.length && arr[0][0] < cut) arr.shift();
  return arr.reduce((s, e) => s + e[1], 0);
}
function recordTokens(model, inTok, outTok) { _winPush(_win.in, model, inTok); _winPush(_win.out, model, outTok); }
// Tier-2 per-model caps (ITPM / OTPM). Conservative within the published tier-2 ranges
// (ITPM 100K–450K, OTPM 8K–90K). Override per model via config.rateLimits[model] = {itpm,otpm}.
const RATE_LIMITS = {
  'claude-sonnet-4-6': { itpm: 450000, otpm: 90000 },
  'claude-haiku-4-5':  { itpm: 100000, otpm: 50000 },
  'claude-opus-4-8':   { itpm: 100000, otpm: 16000 },
};
function rateLimitsFor(model) {
  const c = loadConfig();
  const override = (c.rateLimits && c.rateLimits[model]) || {};
  const base = RATE_LIMITS[model] || RATE_LIMITS[MODEL_HAIKU];
  // legacy single knob still respected as an ITPM floor if someone set it
  const itpm = override.itpm || base.itpm || c.rateLimitTokens || 100000;
  const otpm = override.otpm || base.otpm || 0;        // 0 ⇒ OTPM untracked for this model
  return { itpm, otpm };
}
function rateBudget(model = MODEL_HAIKU) {
  const c = loadConfig();
  const frac = c.rateLimitSafetyFrac || 0.9;           // leave headroom
  const { itpm, otpm } = rateLimitsFor(model);
  const inSafe = Math.floor(itpm * frac);
  const outSafe = otpm ? Math.floor(otpm * frac) : Infinity;
  const inUsed = _winSum(_win.in, model);
  const outUsed = _winSum(_win.out, model);
  const inFree = Math.max(0, inSafe - inUsed);
  const outFree = outSafe === Infinity ? Infinity : Math.max(0, outSafe - outUsed);
  return {
    model, itpm, otpm,
    inSafe, inUsed, inFree, outSafe, outUsed, outFree,
    // back-compat aliases (callers that predate OTPM read .safe/.used/.free as the INPUT budget)
    limit: itpm, safe: inSafe, used: inUsed, free: inFree,
  };
}
// --- Real per-model cost ledger (token→USD), persisted per day in ~/.bhatbot/costs.json ---
// Unlike the old crude "audit lines × $0.004", this prices ACTUAL usage from each API
// response (incl. cache read/write tiers), so chooseModel + the cost system-block can make
// genuine budget-aware decisions ("calculate the cost, then chunk").
const MODEL_PRICES = {                              // USD / 1M tokens: [input, output, cacheWrite, cacheRead]
  'claude-opus-4-8':   [15, 75, 18.75, 1.50],
  'claude-sonnet-4-6': [3, 15, 3.75, 0.30],
  'claude-haiku-4-5':  [1, 5, 1.25, 0.10],
  // Cross-provider TEXT-offload models (Phase 2, Deliverable #4) — no cache tiers, so cacheWrite/
  // cacheRead mirror input (unused in practice; offload usage carries only input/output tokens).
  'gpt-4o-mini':       [0.15, 0.60, 0.15, 0.15],
  'gemini-2.0-flash':  [0.10, 0.40, 0.10, 0.10],
};
const COSTS_PATH = path.join(os.homedir(), '.bhatbot', 'costs.json');
function priceFor(model) {
  if (!model) return MODEL_PRICES[MODEL_HAIKU];
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const bare = model.replace(/^claude-/, '');
  const k = Object.keys(MODEL_PRICES).find((m) => m.replace(/^claude-/, '') === bare || model.includes(m.replace(/^claude-/, '')));
  return MODEL_PRICES[k] || MODEL_PRICES[MODEL_HAIKU];
}
function costOf(model, u) {
  if (!u) return 0;
  const [pin, pout, pcw, pcr] = priceFor(model);
  return ((u.input_tokens || 0) * pin + (u.output_tokens || 0) * pout
    + (u.cache_creation_input_tokens || 0) * pcw + (u.cache_read_input_tokens || 0) * pcr) / 1e6;
}
function recordCost(model, usage) {
  try {
    const usd = costOf(model, usage); if (!usd) return;
    let led = {}; try { led = JSON.parse(fs.readFileSync(COSTS_PATH, 'utf8')); } catch {}
    const d = today();
    led[d] = led[d] || { usd: 0, calls: 0, byModel: {} };
    led[d].usd += usd; led[d].calls += 1;
    const mk = (model || 'unknown').replace(/^claude-/, '');
    led[d].byModel[mk] = (led[d].byModel[mk] || 0) + usd;
    const cut = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);   // prune >60d
    for (const k of Object.keys(led)) if (k < cut) delete led[k];
    fs.mkdirSync(path.dirname(COSTS_PATH), { recursive: true });
    fs.writeFileSync(COSTS_PATH, JSON.stringify(led));
  } catch {}
}
function costToday() {
  try { const led = JSON.parse(fs.readFileSync(COSTS_PATH, 'utf8')); return led[today()] || { usd: 0, calls: 0, byModel: {} }; }
  catch { return { usd: 0, calls: 0, byModel: {} }; }
}
// Per-TOOL spend (paid generation tools) folded into the SAME daily ledger so the cost number is
// the whole picture — model tokens + FLUX/TRELLIS/image-gen — not just the LLM.
function recordToolCost(tool, usd) {
  try {
    if (!usd) return;
    let led = {}; try { led = JSON.parse(fs.readFileSync(COSTS_PATH, 'utf8')); } catch {}
    const d = today();
    led[d] = led[d] || { usd: 0, calls: 0, byModel: {} };
    led[d].usd += usd;
    led[d].toolUsd = (led[d].toolUsd || 0) + usd;
    led[d].byTool = led[d].byTool || {};
    led[d].byTool[tool] = (led[d].byTool[tool] || 0) + usd;
    fs.mkdirSync(path.dirname(COSTS_PATH), { recursive: true });
    fs.writeFileSync(COSTS_PATH, JSON.stringify(led));
  } catch {}
}
function overBudget() { const c = loadConfig(); return !!(c.dailyBudgetUsd && costToday().usd >= c.dailyBudgetUsd); }

// --- Learned-router telemetry (#13) — log each routing decision so routing can be tuned with
// DATA (latency/cost/correction-rate per task class) instead of guessed heuristics. Append-only;
// chooseModel records the decision, finish() fills in latency+cost, reflectOnCorrection flags a
// correction. routerStats() aggregates; no behavior change yet — this is the measurement layer. ---
const ROUTER_LOG = path.join(os.homedir(), '.bhatbot', 'router.jsonl');
let _lastModel = null, _lastRouterTask = null;
// W1 — per-turn tool subset. agentLoop sets this once (relevant tools for the turn) and clears it in
// finish(); every Claude tool-loop call reads it via activeTools(). null ⇒ full catalog (default,
// and the graceful fallback when retrieval is off / unavailable / low-confidence).
let _activeTools = null;
function activeTools() { return _activeTools || TOOLS; }
// W2 — last LLM step's usage, captured right after every Claude call so the per-tool audit entry
// can be tagged with the model + token cost of the step that invoked it. {model,tin,tout,usd}.
let _lastUsage = null;
function noteUsage(model, u) {
  try {
    if (!u) return;
    _lastUsage = {
      model: (model || '').replace(/^claude-/, ''),
      tin: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      tout: u.output_tokens || 0,
      usd: +costOf(model, u).toFixed(5),
    };
  } catch {}
}
function logRouterDecision(e) {
  try { fs.mkdirSync(path.dirname(ROUTER_LOG), { recursive: true }); fs.appendFileSync(ROUTER_LOG, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n'); } catch {}
}
function markRouterCorrected() { if (_lastRouterTask) logRouterDecision({ taskType: _lastRouterTask, model: _lastModel, corrected: true }); }
function routerStats() {
  try {
    const rows = fs.readFileSync(ROUTER_LOG, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const agg = {};
    for (const r of rows) {
      const k = (r.taskType || '?') + ' → ' + String(r.model || '?').replace(/^claude-/, '');
      agg[k] = agg[k] || { decisions: 0, corrected: 0, ms: 0, usd: 0 };
      if (r.corrected) agg[k].corrected++; else { agg[k].decisions++; agg[k].ms += r.ms || 0; agg[k].usd += r.usd || 0; }
    }
    return Object.entries(agg).map(([route, v]) => ({ route, decisions: v.decisions, corrected: v.corrected,
      correctionRate: v.decisions ? +(v.corrected / v.decisions).toFixed(2) : 0,
      avgMs: v.decisions ? Math.round(v.ms / v.decisions) : 0, usd: +v.usd.toFixed(4) }))
      .sort((a, b) => b.decisions - a.decisions);
  } catch { return []; }
}
// Cached per-taskType correction rate from router.jsonl telemetry (Phase 1, Deliverable #3). Lets
// chooseModel learn from its own mistakes (escalate routes that get corrected a lot) instead of only
// logging them. Cached 60s — the log only grows, no need to re-read per turn.
let _rcrCache = null, _rcrAt = 0;
function routeCorrectionRate(taskType) {
  try {
    if (!_rcrCache || Date.now() - _rcrAt > 60000) {
      _rcrCache = {};
      for (const r of routerStats()) {
        const tt = String(r.route || '').split(' → ')[0].trim();
        const p = _rcrCache[tt] || { d: 0, c: 0 };
        p.d += r.decisions || 0; p.c += r.corrected || 0;
        _rcrCache[tt] = p;
      }
      _rcrAt = Date.now();
    }
    const e = _rcrCache[taskType];
    if (!e || (e.d + e.c) < 12) return 0;          // need a sample before trusting the signal
    return e.c / (e.d + e.c);
  } catch { return 0; }
}

// Estimated input tokens a Claude request would cost (system + tools + trimmed messages).
function requestTokenEstimate(messages) {
  return estimateTokens({ system: buildSystemPrompt(lastUserText(messages)), tools: TOOLS, messages: capTokens(messages) });
}
// Token-budget hardening: the per-minute caps are ROLLING 60s windows, so if a step would
// exceed either the INPUT or OUTPUT budget we can wait for old usage to age out, then continue —
// turning a hard abort into a brief pause. Returns true once both `needIn` input and `needOut`
// output tokens are free for `model` (or false on timeout).
function budgetOk(model, needIn, needOut) {
  const b = rateBudget(model);
  return b.inFree >= needIn && (b.outFree === Infinity || b.outFree >= needOut);
}
async function waitForBudget(model, needIn, needOut = 0, maxWaitMs = 75000) {
  const start = Date.now(); let announced = false;
  while (Date.now() - start < maxWaitMs) {
    if (budgetOk(model, needIn, needOut)) return true;
    if (!announced) {
      const b = rateBudget(model);
      const which = b.inFree < needIn ? `${Math.round(needIn / 1000)}k in` : `${Math.round(needOut / 1000)}k out`;
      sendToActivity('tool-update', { type: 'thinking', text: `⏳ pacing for the ${model.replace(/^claude-/, '')} rate limit — continuing in a moment (${which} needed)` });
      announced = true;
    }
    await sleep(3000);
  }
  return budgetOk(model, needIn, needOut);
}
async function ollamaUp() {
  try { const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(700) }); return r.ok; } catch { return false; }
}
// VANGUARD admission controller (Phase 1) — shared token-reservation ledger over the SAME rolling
// rate windows as the main preflight (rateBudget). Sub-agent calls acquire/release through this so
// concurrent suits self-throttle to live budget instead of convoying into the rate limit together.
const admission = createAdmission({
  freeBudget: (m) => rateBudget(m),
  sleep,
  log: (t) => { try { sendToActivity('tool-update', { type: 'thinking', text: t }); } catch {} },
});
// Live fleet width = how many ~4k-output suits the current OTPM budget can carry (clamped [3,12]).
// Replaces the old hardcoded parallel caps; the per-request admission reservation does the fine pacing.
function fleetWidth(model = MODEL_SONNET, perAgentOut = 4096) {
  try { return admission.width(model, perAgentOut, { min: 3, max: 24 }); } catch { return 3; }   // Phase 5: cap raised 12→24 (always-plugged desktop); admission still paces against live OTPM
}
// qwen3-family models burn seconds on <think> tokens before answering — for an assistant
// reply that's pure mute latency. Ollama honors `think:false` for them (unknown fields are
// ignored elsewhere); the /no_think soft switch in the system prompt covers older runtimes.
function isThinkingModel(model) { return /^qwen3/i.test(String(model || '')); }
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
  const noThink = isThinkingModel(model);
  if (system || noThink) msgs.unshift({ role: 'system', content: (system || '') + (noThink ? '\n/no_think' : '') });
  const body = { model, messages: msgs, stream: false };
  if (noThink) body.think = false;
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('ollama ' + r.status);
  const j = await r.json();
  // Strip any residual think block so it never reaches the user/TTS.
  return ((j.message && j.message.content) || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
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
      try { const u = j.usage || {}; recordTokens(body.model, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), u.output_tokens || 0); recordCost(body.model, u); noteUsage(body.model, u); } catch {}
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
    if (res.status === 429) throw new Error("Rate limit reached (per-model ITPM/OTPM cap). I waited and retried but it's still busy — give it a minute, or raise rateLimits in config / your Anthropic tier.");
    if (res.status === 529) throw new Error('Anthropic is overloaded right now. Try again shortly.');
    throw new Error(`API ${res.status}: ${bodyText.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Depth LEARNING (OTPM optimization). The static depth tiers (depth.js) over-allocate output room
// for some turns and clip others. Here EVERY response becomes a training row: we log the predicted
// depth tier, the max_tokens we allocated, the tokens the model ACTUALLY produced, and whether it
// clipped (stop_reason==='max_tokens'). depthCal() then learns a right-sized ceiling per tier from
// that dataset (p90 of real usage + margin; grown when clipping is frequent). The learned ceilings
// feed back into classifyDepth → tighter OTPM budgeting and cheaper long conversations, while a
// genuinely big answer still earns room because clipping pushes its tier's ceiling back up.
const DEPTH_LOG = path.join(os.homedir(), '.bhatbot', 'depth.jsonl');
let _recentOut = [];                                   // rolling window of recent output sizes (this process)
function rollingPriorOut() { return _recentOut.length ? Math.round(_recentOut.reduce((a, b) => a + b, 0) / _recentOut.length) : 0; }
function logDepthOutcome(d, resp, surface) {
  try {
    const u = (resp && resp.usage) || {};
    const out = u.output_tokens || 0; if (!out) return;
    // Phase 3 #1: enrich the row with the LEARNING FEATURES (carried on d.feats by sizeTurn) so the
    // learned depth model can train on real signal — query length, intent/tier, position, prior-out
    // rolling mean, correction flag — not just tier+alloc. Legacy rows (no feats) still parse fine.
    const f = d.feats || {};
    const row = { ts: Date.now(), depth: d.depth, alloc: d.maxTokens, out,
      clipped: (resp.stop_reason === 'max_tokens') ? 1 : 0, surface: surface || '?',
      qlen: f.qlen || 0, f_ack: f.f_ack || 0, f_detail: f.f_detail || 0, f_deep: f.f_deep || 0,
      position: f.position || 0, priorOut: f.priorOut || 0, correction: f.correction || 0,
      taper: d.taperFactor != null ? d.taperFactor : 1, src: d.source || 'heuristic' };
    fs.mkdirSync(path.dirname(DEPTH_LOG), { recursive: true });
    fs.appendFileSync(DEPTH_LOG, JSON.stringify(row) + '\n');
    _recentOut.push(out); if (_recentOut.length > 8) _recentOut.shift();   // feed next turn's priorOut
    try { depthmodel.maybeRetrain({ logPath: DEPTH_LOG }); } catch {}        // auto-retrain every 500 rows
  } catch {}
}
// Cached learned ceilings (recomputed at most every 60s — the log only grows, no need per-call).
let _depthCal = null, _depthCalAt = 0;
function depthCal() {
  try {
    if (_depthCal && Date.now() - _depthCalAt < 60000) return _depthCal;
    const TIERS = require('./lib/depth').TIERS;
    let rows = [];
    try {
      const lines = fs.readFileSync(DEPTH_LOG, 'utf8').trim().split('\n');
      rows = lines.slice(-600).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
    const byTier = {};
    for (const r of rows) { (byTier[r.depth] = byTier[r.depth] || []).push(r); }
    const cal = {};
    for (const tier of Object.keys(TIERS)) {
      const rs = byTier[tier] || [];
      if (rs.length < 8) continue;                       // need a sample before trusting it
      const outs = rs.map((r) => r.out).sort((a, b) => a - b);
      const p90 = outs[Math.min(outs.length - 1, Math.floor(outs.length * 0.9))];
      const clipRate = rs.reduce((s, r) => s + (r.clipped || 0), 0) / rs.length;
      const def = TIERS[tier].maxTokens;
      // Right-size to p90 + 30% margin; round to 128. Clipping (model wanted more) overrides upward.
      let ceil = Math.ceil((p90 * 1.3) / 128) * 128;
      if (clipRate > 0.12) ceil = Math.max(ceil, Math.round(def * 1.5));   // frequently truncated → grow
      // Never collapse below a usable floor for the tier, never exceed 2× its static default.
      ceil = Math.max(Math.min(def, 256), Math.min(ceil, def * 2));
      cal[tier] = ceil;
    }
    _depthCal = cal; _depthCalAt = Date.now();
    return cal;
  } catch { return {}; }
}
// Predicted output size for a turn = its (learned) depth ceiling. Used by the OTPM preflight so
// generation-heavy turns pace against the output cap, not just context-heavy ones.
function predictedOutputTokens(userText) {
  try { return classifyDepth(userText, depthCal()).maxTokens; } catch { return 1024; }
}

// Phase 3 — unified per-turn sizing. The LEARNED depth model (lib/depthmodel) is the PRIMARY ceiling
// when it has ≥200 rows and a confident fit; otherwise the classifyDepth+depthCal HEURISTIC is the
// silent fallback (no error surfaced). The conversation-position TAPER then decays the ceiling on long
// threads, suspended on a genuinely-new-task signal. Every decision logs its taper factor + source.
let _lastDepth = { depth: 'conversational', taperFactor: 1, source: 'heuristic', position: 1 };  // for HUD
function userTurnCount(messages) { try { return (messages || []).filter((m) => m && m.role === 'user').length || 1; } catch { return 1; } }
function sizeTurn(ut, messages) {
  const base = classifyDepth(ut, depthCal());                 // heuristic tier + ceiling (the fallback)
  let out = { depth: base.depth, maxTokens: base.maxTokens, directive: base.directive };
  try {
    const position = userTurnCount(messages);
    let correction = 0; try { correction = CORRECTION_RE.test(ut || '') ? 1 : 0; } catch {}
    const feats = {
      qlen: Math.ceil((ut || '').length / 4),
      f_ack: base.depth === 'ack' ? 1 : 0, f_detail: base.depth === 'detailed' ? 1 : 0, f_deep: base.depth === 'deep' ? 1 : 0,
      position, priorOut: rollingPriorOut(), depth: base.depth, correction,
    };
    // 1) learned model (primary) — null ⇒ keep heuristic ceiling
    let source = 'heuristic';
    const pred = depthmodel.predict(feats);
    if (pred && pred.maxTokens > 0) { out.maxTokens = pred.maxTokens; source = `model(c=${pred.confidence.toFixed(2)})`; }
    // 2) conversation-position taper (explicit multiplier; also a model feature via `position`)
    const tap = taper.factor({ position, text: ut, tier: base.depth });
    const sizedBefore = out.maxTokens;
    out.maxTokens = Math.max(256, Math.round(out.maxTokens * tap.factor));
    out.feats = feats; out.taperFactor = tap.factor; out.taperReset = tap.reset; out.source = source;
    _lastDepth = { depth: base.depth, taperFactor: tap.factor, source, position, reset: tap.reset };
    if (loadConfig().depthDebug) console.log(`[depth] tier=${base.depth} pos=${position} src=${source} base=${base.maxTokens} sized=${sizedBefore} taper=${tap.factor.toFixed(2)}${tap.reset ? ' RESET(' + tap.reason + ')' : ''} → max_tokens=${out.maxTokens}`);
    // surface to the VANGUARD HUD (best-effort; renderer ignores if no panel)
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('depth-update', _lastDepth); } catch {}
  } catch {}
  return out;
}

// Clip-aware continuation (Phase 1, Deliverable #4). When a response hit its max_tokens ceiling
// while generating PROSE (no tool_use in the content — a clipped tool call can't be safely resumed,
// its JSON args are truncated), transparently continue it as ONE logical answer with a raised
// ceiling. The INITIAL clip is logged by the caller as a strong "needs more" depth signal before
// this runs. Bounded (maxRounds, CLIP_HARD_CAP, skips trivial output) so it can't loop or run away,
// and only continues while OTPM budget is actually free. `reissue(contMessages, round)` performs one
// more (tool-less, text-only) model call and returns its response, or null to decline.
const CLIP_HARD_CAP = 12000;   // ceiling for a single continued answer's per-round output budget
async function continueClipped(resp, reissue, { maxRounds = 2 } = {}) {
  let r = resp, rounds = 0;
  while (r && r.stop_reason === 'max_tokens' && rounds < maxRounds) {
    const blocks = r.content || [];
    if (blocks.some((b) => b.type === 'tool_use')) break;          // never resume a clipped tool call
    const soFar = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (soFar.trim().length < 40) break;                           // nothing meaningful to continue
    rounds++;
    const next = await reissue([
      { role: 'assistant', content: blocks },
      { role: 'user', content: 'Continue your previous answer EXACTLY where it was cut off. Do not repeat or re-introduce anything already written — pick up mid-sentence if needed.' },
    ], rounds);
    if (!next) break;                                              // reissue declined (e.g. no budget)
    const addText = (next.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    r = { content: [{ type: 'text', text: soFar + addText }], stop_reason: next.stop_reason, usage: r.usage, _continued: rounds };
  }
  return r;
}

async function callClaude(messages, apiKey, model) {
  const ut = lastUserText(messages);
  const d = sizeTurn(ut, messages);          // Phase 3 — learned ceiling (heuristic fallback) + position taper
  const r0 = await anthropicRequest({
    model,
    max_tokens: d.maxTokens,
    // directive is a TRAILING block (after the cache_control'd static prompt) so per-turn sizing
    // never invalidates the prompt cache.
    system: [...systemBlocks(ut), { type: 'text', text: d.directive }],
    tools: activeTools(),
    // validateHistory AFTER capTokens: trimming can re-orphan a tool_use/tool_result pair.
    // This is the single chokepoint every Claude tool-loop call shares, so the API can never
    // see an unpaired tool_use (the recurring "tool_use without tool_result" 400), no matter
    // which entry point (chat/voice/telegram/cloud-bridge/pacing re-entry) built the messages.
    messages: validateHistory(capTokens(messages))
  }, apiKey);
  logDepthOutcome(d, r0, 'tool');            // every response → dataset; clipped:1 = the "needs more" signal
  if (d.depth === 'ack') return r0;          // trivial exchange — never worth continuing
  // Clip-aware auto-retry: if it truncated on prose, finish the thought (tool-less, budget-gated).
  return continueClipped(r0, async (cont, round) => {
    const raised = Math.min(d.maxTokens * (round + 1), CLIP_HARD_CAP);
    if (!budgetOk(model, 0, raised)) return null;
    return anthropicRequest({
      model, max_tokens: raised,
      system: [...systemBlocks(ut), { type: 'text', text: d.directive }],
      messages: validateHistory(capTokens([...messages, ...cont]))   // tool-less: continuation is pure text
    }, apiKey);
  });
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
      if (res.status === 429) throw new Error("Rate limit reached (per-model ITPM/OTPM cap). I waited and retried but it's still busy — give it a minute, or raise rateLimits in config / your Anthropic tier.");
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
    try { recordTokens(body.model, (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), usage.output_tokens || 0); recordCost(body.model, usage); noteUsage(body.model, usage); } catch {}
    return {
      content: blocks.filter(Boolean).map((b) => b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} } : { type: 'text', text: b.text }),
      stop_reason: stop_reason || 'end_turn', usage
    };
  }
}
async function callClaudeStream(messages, apiKey, model, onText) {
  const ut = lastUserText(messages);
  const d = sizeTurn(ut, messages);          // Phase 3 — learned ceiling (heuristic fallback) + position taper
  const r0 = await anthropicStream({
    model, max_tokens: d.maxTokens,
    system: [...systemBlocks(ut), { type: 'text', text: d.directive }],
    // see callClaude: re-validate AFTER capTokens so trimming can't re-orphan a tool pair.
    tools: activeTools(), messages: validateHistory(capTokens(messages))
  }, apiKey, onText);
  logDepthOutcome(d, r0, 'tool-stream');      // every response → dataset; clipped:1 = the "needs more" signal
  if (d.depth === 'ack') return r0;
  // Clip-aware auto-retry — continuation tokens stream straight on via onText (seamless to the user).
  return continueClipped(r0, async (cont, round) => {
    const raised = Math.min(d.maxTokens * (round + 1), CLIP_HARD_CAP);
    if (!budgetOk(model, 0, raised)) return null;
    return anthropicStream({
      model, max_tokens: raised,
      system: [...systemBlocks(ut), { type: 'text', text: d.directive }],
      messages: validateHistory(capTokens([...messages, ...cont]))   // tool-less continuation
    }, apiKey, onText);
  });
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
// Cross-provider TEXT offload rung (Phase 1, Deliverable #3). Used by callModel when the Anthropic
// per-minute window is the binding constraint on a TOOL-LESS turn: run the turn on OpenAI (key live,
// fast) then Gemini as a fallback — neither touches the Anthropic quota. Returns {text,provider,model}
// or null if no provider is configured/available. Tool turns never come here (those providers can't
// run the tool loop). This is the live-path home for the offload chains lib/router.js only modeled.
// Phase 2, Deliverable #4 — when an offload response omits usage, estimate tokens from text length
// (~4 chars/token) so EVERY offloaded call is still recorded in the ledger, never silently $0.
function estOffloadUsage(flatMsgs, system, outText) {
  const inChars = (system || '').length + (flatMsgs || []).reduce((a, m) => a + (m.content || '').length, 0);
  return { input_tokens: Math.ceil(inChars / 4), output_tokens: Math.ceil((outText || '').length / 4) };
}

async function offloadText(messages, system) {
  const c = loadConfig();
  const flat = (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : ''),
  })).filter((m) => m.content);
  if (!flat.length) return null;
  if (c.openaiKey) {
    try {
      const model = c.openaiModel || 'gpt-4o-mini';
      const msgs = system ? [{ role: 'system', content: system }, ...flat] : flat;
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.openaiKey },
        body: JSON.stringify({ model, messages: msgs }), signal: AbortSignal.timeout(60000),
      });
      const j = await r.json();
      if (r.ok) { const t = j.choices?.[0]?.message?.content || ''; if (t.trim()) {
        const u = j.usage ? { input_tokens: j.usage.prompt_tokens || 0, output_tokens: j.usage.completion_tokens || 0 } : estOffloadUsage(flat, system, t);
        recordCost(model, u);   // Deliverable #4: offload calls now hit the same daily ledger as Anthropic
        console.log('[rate] offloaded to openai'); return { text: t, provider: 'openai', model }; } }
    } catch (e) { console.warn('[rate] openai offload failed:', e.message); }
  }
  if (c.geminiKey) {
    try {
      const model = c.geminiModel || 'gemini-2.0-flash';
      const contents = flat.map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] }));
      const body = { contents }; if (system) body.systemInstruction = { parts: [{ text: system }] };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.geminiKey },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
      });
      const j = await r.json();
      if (r.ok) { const t = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''; if (t.trim()) {
        const um = j.usageMetadata || {};
        const u = (um.promptTokenCount != null) ? { input_tokens: um.promptTokenCount || 0, output_tokens: um.candidatesTokenCount || 0 } : estOffloadUsage(flat, system, t);
        recordCost(model, u);   // Deliverable #4: offload calls now hit the same daily ledger as Anthropic
        console.log('[rate] offloaded to gemini'); return { text: t, provider: 'gemini', model }; } }
    } catch (e) { console.warn('[rate] gemini offload failed:', e.message); }
  }
  return null;
}

async function callModel(messages, apiKey, allowDarkbloom, onText) {
  const cfg = loadConfig();
  const route = classify(lastUserText(messages));
  const dbReady = cfg.darkbloomEnabled && cfg.darkbloomKey;
  // Tool tasks MUST go to Claude — local/Darkbloom providers are single-shot and can't run
  // tools, so falling back to them on a tool task silently produces tool-less garbage (e.g. a
  // truncated "<s") and the task never executes. For these, never substitute a local model:
  // pace-and-wait for the budget instead. (Auto-bypass-Ollama-for-tools, applied at the model layer.)
  const toolish = looksLikeToolTask(lastUserText(messages));

  if (allowDarkbloom && !toolish && dbReady && (route === 'db_speech' || route === 'db_directive')) {
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

  // The model is chosen BEFORE the preflight so the rate check uses that model's OWN per-minute
  // caps (Sonnet's are ~4× Haiku's) instead of a single global number.
  let claudeModel = (route === 'sonnet' || route === 'db_directive') ? MODEL_SONNET : MODEL_HAIKU;

  // Preflight rate-limit check: if this request would blow the per-minute INPUT or OUTPUT budget,
  // either run it on a local Ollama model (free, no quota) or — if local is unavailable
  // / mode='notify' — abort with a clear message so the caller can reset for next task.
  // estOut = the learned/predicted output size for this turn (depth calibration), so OTPM-heavy
  // generation turns pace too, not just big-context ones.
  let est = requestTokenEstimate(messages);
  let estOut = predictedOutputTokens(lastUserText(messages));
  // OTPM-AWARE ROUTING (Phase 1, Deliverable #3): when OUTPUT is the binding constraint, Sonnet's
  // 90k OTPM beats Haiku's 50k — so a Haiku-routed turn whose predicted output would crowd Haiku's
  // live output window upgrades to Sonnet when Sonnet has materially more output headroom right now.
  // (Skipped under the daily $ governor, which forces Haiku.)
  if (claudeModel === MODEL_HAIKU && !overBudget()) {
    const hB = rateBudget(MODEL_HAIKU), sB = rateBudget(MODEL_SONNET);
    if (estOut > hB.outFree && sB.outFree > estOut && sB.outFree > hB.outFree) {
      claudeModel = MODEL_SONNET; _lastModel = MODEL_SONNET; _lastRouterTask = 'otpm-upgrade';
    }
  }
  let budget = rateBudget(claudeModel);
  if (est > budget.inFree || (budget.outFree !== Infinity && estOut > budget.outFree)) {
    const mode = cfg.rateLimitMode || 'local';
    // First-turn simple queries → answer locally on Ollama (free, no quota). Not mid-task
    // (Ollama can't run tools, so hijacking a tool loop would break it).
    if (mode === 'local' && allowDarkbloom && !toolish && await ollamaUp()) {
      try {
        const lm = cfg.localModel || 'qwen3:latest';
        const text = (await ollamaChat(messages, buildSystemPrompt(lastUserText(messages)), lm) || '').trim();
        if (text) { if (onText) try { onText(text); } catch {} return { content: [{ type: 'text', text }], stop_reason: 'end_turn', _provider: 'ollama', _model: lm, _rateFallback: true }; }
      } catch (e) { console.warn('[rate] ollama fallback failed:', e.message); }
    }
    // CROSS-PROVIDER TEXT OFFLOAD (Phase 1, Deliverable #3): Anthropic is the binding constraint and
    // this is a tool-less turn → spread it onto OpenAI/Gemini (no Anthropic quota) instead of stalling.
    // Brings the offload rungs that previously lived only in the unused lib/router.js into the LIVE path.
    if (allowDarkbloom && !toolish) {
      const off = await offloadText(messages, buildSystemPrompt(lastUserText(messages)));
      if (off && off.text) { if (onText) try { onText(off.text); } catch {} return { content: [{ type: 'text', text: off.text }], stop_reason: 'end_turn', _provider: off.provider, _model: off.model, _rateFallback: true }; }
    }
    // HARDENING: if the step fits within the per-minute caps, WAIT for the rolling windows to
    // drain and then continue — long multi-step tasks pause ~a minute instead of aborting.
    if (est <= budget.inSafe && (budget.outSafe === Infinity || estOut <= budget.outSafe)) {
      if (await waitForBudget(claudeModel, est, estOut)) { budget = rateBudget(claudeModel); }
    }
    // If still over on INPUT (request alone bigger than the cap, or wait timed out) → trim the
    // context harder and re-estimate before giving up.
    if (est > rateBudget(claudeModel).inFree) {
      messages = capTokens(messages, Math.max(6000, Math.floor(budget.inSafe * 0.5)));
      est = requestTokenEstimate(messages);
      if (est <= budget.inSafe) await waitForBudget(claudeModel, est, estOut);
    }
    budget = rateBudget(claudeModel);
    if (est > budget.inFree || (budget.outFree !== Infinity && estOut > budget.outFree)) {
      const overOut = budget.outFree !== Infinity && estOut > budget.outFree;
      const err = new Error(overOut
        ? `⚠ This step would emit ~${Math.round(estOut / 1000)}k output tokens, over your ${claudeModel.replace(/^claude-/, '')} ~${Math.round(budget.outSafe / 1000)}k/min OUTPUT cap even after pacing. Retry in a minute, or raise rateLimits.${claudeModel}.otpm in config.`
        : `⚠ This step needs ~${Math.round(est / 1000)}k input tokens, over your ${claudeModel.replace(/^claude-/, '')} ~${Math.round(budget.inSafe / 1000)}k/min cap even after pacing. I've reset the context — retry in a minute, or raise rateLimits.${claudeModel}.itpm in config.`);
      err.rateBudget = true;
      throw err;
    }
  }

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
function osaErr(r) {
  const e = r.err || '';
  if (e.includes('-1743') || e.includes('Not authorized')) return 'macOS blocked the Apple event. Grant it: System Settings → Privacy & Security → Automation → enable Bhatbot → Spotify (and System Events).';
  return e || 'osascript failed';
}

// Media tools (Spotify local + Connect + system volume) extracted to tools/media.js (SPLIT_PLAN
// step 7, C 2/2). osa/osaErr stay here (shared w/ browser+system) and are injected via ctx.
const { mediaControl } = require('./tools/media')({ loadConfig, saveConfig, osa, osaErr });

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const MEMORY_SECTIONS = ['Personal', 'Active Projects', 'Preferences & Patterns', 'Decisions Log', 'Recurring Tasks', 'Notes'];

const TOOLS = require('./lib/tools-schema')({ MEMORY_SECTIONS });

// Phase 2, Deliverable #2 — STARTUP VALIDATION: every DAG role's tool-allowlist must reference
// only real, live tools. A role assigned only phantom tools would silently run tool-less. Warn
// loudly on a mismatch; NEVER block launch (wrapped in try/catch, log-only).
try {
  const { validateRoleTools } = require('./lib/agents/roles');
  const v = validateRoleTools(TOOLS.map((t) => t.name));
  if (v.ok) console.log(`[roles] ✓ tool-allowlist validation passed (${TOOLS.length} live tools; all role tools resolve)`);
  else { console.warn(`[roles] ⚠ ${v.missing.length} role tool reference(s) not in the live catalog — those agents will run WITHOUT those tools:`);
    for (const m of v.missing) console.warn(`[roles]   ⚠ ${m.role}.${m.scope}: "${m.name}" is not a live tool`); }
} catch (e) { console.warn('[roles] tool-allowlist validation skipped:', e.message); }

// shell safety: HARD_BLOCKED / CONFIRM_PATTERNS / runShell moved to lib/shell.js (SPLIT_PLAN step 7),
// constructed near EXEC_PATH at the top. The confirm/autonomous/remote gates that consult them remain below.
// auditLog / readAudit / redactForAudit / AUDIT_PATH moved to lib/audit.js (SPLIT_PLAN step 2);
// constructed near the top via makeAudit({ isRemote, estimateToolCost, recordToolCost }).

// Self-improvement loop (#21): mine the audit log for RECURRING tool failures, then have Claude
// Code DRAFT a fix as a reviewable diff (plan mode → never edits files). Siddhant is the merge
// gate. Turns "notice bug → describe it → prompt CC" into "CC already drafted a fix, review it."
async function selfImproveScan(opts = {}) {
  const fails = readAudit(800).filter((e) => e && e.ok === false);
  if (!fails.length) return { success: true, result: 'No tool failures in the recent audit log — nothing to improve.' };
  const groups = {};
  for (const e of fails) {
    const errKey = String(e.result || '').toLowerCase().replace(/\d+/g, '#').replace(/[^a-z #]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const k = e.tool + ' :: ' + errKey;
    groups[k] = groups[k] || { tool: e.tool, sample: e.result, args: e.args, count: 0 };
    groups[k].count++;
  }
  const ranked = Object.values(groups).sort((a, b) => b.count - a.count);
  const top = ranked[0];
  const minCount = opts.minCount || 3;
  if (!top || top.count < minCount) return { success: true, result: `Top recurring failure (${top ? top.tool + ' ×' + top.count : 'none'}) is below the ${minCount}× threshold — not drafting a fix.`, groups: ranked.slice(0, 5) };
  if (opts.dryRun) return { success: true, result: `Would draft a fix for ${top.tool} (${top.count}× — "${String(top.sample).slice(0, 80)}")`, groups: ranked.slice(0, 5) };
  const proj = process.env.BHATBOT_PROJECT || path.join(os.homedir(), 'bhatbot');
  const prompt = `The tool "${top.tool}" in this codebase has failed ${top.count} times recently with errors like: "${String(top.sample).slice(0, 220)}" (example redacted args: ${String(top.args).slice(0, 220)}). Find the likely root cause in the code and propose a precise fix as a unified diff, with a one-paragraph rationale. Investigate read-only; do NOT modify files — output the proposed diff only.`;
  // --permission-mode plan → Claude Code investigates + proposes WITHOUT applying edits.
  const r = await runShell('claude -p ' + JSON.stringify(prompt) + ' --permission-mode plan', proj, 300000);
  const out = (r && (r.stdout || r.result)) || (r && r.error) || '(no output)';
  const dir = path.join(os.homedir(), '.bhatbot', 'self-improve'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${String(top.tool).replace(/[^\w]/g, '_')}.md`);
  fs.writeFileSync(file, `# Self-improve draft — ${top.tool} (${top.count} failures)\n\nSample error: ${top.sample}\n\n---\n\n${out}`);
  try { telegramNotify(`🛠 Drafted a fix for recurring "${top.tool}" failures (${top.count}×). Review (not applied): ${file}`); } catch {}
  sendToActivity('tool-update', { type: 'thinking', text: `🛠 self-improve: drafted a fix for ${top.tool} → ${file}` });
  return { success: true, result: `Drafted a REVIEWABLE fix for ${top.tool} (${top.count} failures) → ${file}. Not applied — review the diff and apply if it's good.`, file, top: { tool: top.tool, count: top.count } };
}

// ── World Cup 2026 tool ───────────────────────────────────────────────────────
function _wcResolve(snap, q) {
  if (!q) return null;
  const s = String(q).trim().toLowerCase();
  for (const g of snap.groups) for (const t of g.teams) {
    if (t.abbr.toLowerCase() === s) return t.abbr;
    if (String(t.name).toLowerCase() === s || String(t.name).toLowerCase().includes(s)) return t.abbr;
  }
  return String(q).toUpperCase();   // assume it's already an abbreviation
}
async function worldCupTool(input) {
  const action = input.action || 'open';
  try {
    // DEFAULT + standings/live/report/open: just open the live standings page in a browser.
    // Zero Monte-Carlo, zero data fed back to the model → cheapest path for the common
    // "what's the World Cup update / standings / scores" ask. The page auto-updates live.
    if (['open', 'report', 'standings', 'scores', 'update'].includes(action)) {
      try { shell.openExternal(worldcup.STANDINGS_URL); } catch {}
      return { success: true, result: 'Opened the live World Cup standings & scores in your browser. The page auto-updates with current group tables and in-progress matches — no need for me to read them out.' };
    }
    // INFORMATIVE: live state + a recommended match to watch + key insights + web buzz. Use this
    // for "what should I watch / what's happening with the game / give me insights / fill me in".
    // No Monte-Carlo; one ESPN pull + one Google-News scan. Form YOUR opinion from this signal.
    if (['watch', 'insights', 'recommend', 'brief', 'live', 'whatshappening'].includes(action)) {
      const b = await worldcup.watchBrief({ maxBuzz: 5 });
      return { success: true, result: worldcup.formatWatch(b), brief: b };
    }
    // predict / group only need standings + Elo → snapshot with sims:0 (skips the heavy sim).
    if (action === 'predict') {
      const snap = await worldcup.snapshot({ ttlMs: 60000, sims: 0 });
      const a = _wcResolve(snap, input.home), b = _wcResolve(snap, input.away);
      if (!a || !b) return { success: false, error: 'need home and away teams' };
      const p = worldcup.predict(snap.elo, a, b, { home: true });
      return { success: true, result: `${a} vs ${b}: ${a} ${(p.pHome * 100).toFixed(0)}% / draw ${(p.pDraw * 100).toFixed(0)}% / ${b} ${(p.pAway * 100).toFixed(0)}% (expected goals ${p.la.toFixed(2)}–${p.lb.toFixed(2)})`, prediction: p };
    }
    if (action === 'group') {
      const snap = await worldcup.snapshot({ ttlMs: 60000, sims: 0 });
      const g = snap.tables.find((t) => t.label.toUpperCase() === String(input.label || '').toUpperCase());
      if (!g) return { success: false, error: `group ${input.label} not found (A–L)` };
      const lines = g.table.map((r, i) => `${i + 1}. ${r.name} — ${r.Pts} pts (${r.W}-${r.D}-${r.L}, GD ${r.GD >= 0 ? '+' : ''}${r.GD})`);
      return { success: true, result: `Group ${g.label}\n` + lines.join('\n') };
    }
    // odds is the ONLY action that pays for the Monte-Carlo simulation (title/advancement odds).
    if (action === 'odds') {
      const snap = await worldcup.snapshot({ ttlMs: 60000, sims: Number(input.sims) || 4000 });
      const ranked = Object.entries(snap.odds).sort((a, b) => b[1].W - a[1].W).slice(0, 12);
      return { success: true, result: 'Title odds (Monte-Carlo):\n' + ranked.map(([ab, o]) => `${ab}: ${(o.W * 100).toFixed(1)}% to win, ${(o.F * 100).toFixed(1)}% final`).join('\n') };
    }
    // unknown action → open the page
    try { shell.openExternal(worldcup.STANDINGS_URL); } catch {}
    return { success: true, result: 'Opened the live World Cup standings in your browser.' };
  } catch (e) { return { success: false, error: 'world_cup: ' + (e.message || String(e)) }; }
}

// ── Self-healing: BhatBot fixes its own code via Claude Code, gated by a verify command ─────────
// Self-awareness (the problem) + the means to fix (Claude Code) + a SAFETY NET (verify must pass,
// else git-revert). apply:false = draft only. apply:true requires a clean working tree so a failed
// fix can be cleanly reverted without clobbering unrelated work.
async function selfFix(input) {
  const proj = process.env.BHATBOT_PROJECT || path.join(os.homedir(), 'bhatbot');
  const problem = String(input.problem || '').trim();
  if (!problem) return { success: false, error: 'self_fix needs a `problem` description' };
  const verify = String(input.verify || '').trim();
  const fileHint = input.files ? `\nFocus on: ${input.files}` : '';

  if (!input.apply) {   // draft-only (safe default), mirrors self_improve
    const prompt = `In this repo, diagnose and propose a fix for: ${problem}${fileHint}\n${verify ? `The fix is correct when \`${verify}\` exits 0.` : ''}\nInvestigate read-only; output a precise unified diff + one-paragraph rationale. Do NOT modify files.`;
    const r = await runShell('claude -p ' + JSON.stringify(prompt) + ' --permission-mode plan', proj, 300000);
    const out = (r && (r.stdout || r.result)) || (r && r.error) || '(no output)';
    const dir = path.join(os.homedir(), '.bhatbot', 'self-improve'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-selffix.md`);
    fs.writeFileSync(file, `# self_fix draft\n\nProblem: ${problem}\nVerify: ${verify || '(none)'}\n\n---\n\n${out}`);
    return { success: true, result: `Drafted a fix (not applied) → ${file}`, file };
  }

  if (!verify) return { success: false, error: 'apply mode requires a `verify` command (exit 0 = fixed)' };
  // Safety: refuse on a dirty tree so a failed fix reverts cleanly.
  const dirty = await runShell('git status --porcelain', proj, 15000);
  if ((dirty.stdout || '').trim()) return { success: false, error: 'working tree is dirty — commit or stash first so a failed self-fix can be reverted safely.' };

  const maxRounds = Math.max(1, Math.min(4, Number(input.maxRounds) || 2));
  const rounds = [];
  let lastVerify = '';
  for (let i = 1; i <= maxRounds; i++) {
    sendToActivity('tool-update', { type: 'thinking', text: `🩺 self-fix round ${i}/${maxRounds}: ${problem.slice(0, 60)}` });
    const prompt = `Fix this in the current repo: ${problem}${fileHint}\nThe fix is verified when this command exits 0:\n  ${verify}\n${lastVerify ? `\nThe previous attempt still failed verification with:\n${lastVerify.slice(0, 1500)}\n` : ''}Make the minimal necessary edits to the source files. Do not run the verify command yourself.`;
    const cc = await runShell('claude -p ' + JSON.stringify(prompt) + ' --permission-mode acceptEdits', proj, 300000);
    const v = await runShell(verify, proj, 300000);
    lastVerify = ((v.stdout || '') + '\n' + (v.stderr || '')).trim();
    const passed = v.success && (v.exitCode === 0 || v.exitCode == null);
    rounds.push({ round: i, passed, cc: (cc.stdout || cc.error || '').slice(-400), verify: lastVerify.slice(-600) });
    if (passed) {
      const diff = await runShell('git --no-pager diff --stat', proj, 15000);
      try { telegramNotify(`🩺 self-fix succeeded (round ${i}): ${problem.slice(0, 80)}`); } catch {}
      sendToActivity('tool-update', { type: 'thinking', text: `✅ self-fix passed verify in round ${i}` });
      return { success: true, result: `Fixed + verified in round ${i}. Changes (review & commit):\n${(diff.stdout || '').slice(0, 1000)}`, rounds, applied: true };
    }
  }
  // All rounds failed → revert to the clean baseline.
  await runShell('git checkout -- . && git clean -fd', proj, 30000);
  sendToActivity('tool-update', { type: 'thinking', text: `↩ self-fix failed ${maxRounds}× — reverted to clean state` });
  return { success: false, error: `Could not fix in ${maxRounds} round(s); reverted to clean state.`, rounds };
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
// Remote-execution guard. Incremented while a turn is driven from the phone / Tailscale
// funnel (headless, no human at the keyboard). Destructive shell (rm/rmdir/trash) is then
// NEVER auto-approved — even with autonomousMode on — because nobody is present to confirm.
// Local desktop use is unaffected. Set config.remoteAllowDestructive:true to opt back in.
let remoteDepth = 0;
function isRemote() { return remoteDepth > 0; }
// opts.forceHuman (W3 stepup tier): never silently auto-approve even under autonomousMode — a human
// must actively confirm via the card. opts.remoteOk (W3 confirm tier): routine mutations requested
// over the AUTHENTICATED remote channel (mcpToken is the boundary) are allowed + audited, not denied
// — only stepup/destructive-shell deny over remote (no human to verify code-mod/credentials/rm).
function requestConfirm(command, reason, opts = {}) {
  if (isRemote() && !opts.remoteOk && loadConfig().remoteAllowDestructive !== true) {
    try { fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), remoteDenied: command.slice(0, 200), reason }) + '\n'); } catch {}
    sendToActivity('tool-update', { type: 'thinking', text: '⛔ remote destructive command denied (no human to confirm): ' + reason });
    return Promise.resolve(false);
  }
  if (isAutonomous() && !opts.forceHuman) {
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

// runShell now provided by lib/shell.js (constructed at top). The web-handling helpers continue below.
// --- Web-handling helpers: real geolocation, auto-dismiss popups, persist window position ----
// Real lat/long so "show results near you" / store locators / weather actually localize (Chromium
// otherwise blocks the geolocation prompt → sites fall back to a wrong/empty location). Cached in
// config; override by setting config.geo = {latitude,longitude}.
let _geoCache = null;
async function browserGeo() {
  const c = loadConfig();
  if (c.geo && typeof c.geo.latitude === 'number') return { latitude: c.geo.latitude, longitude: c.geo.longitude };
  if (_geoCache) return _geoCache;
  try {
    const r = await fetch('http://ip-api.com/json/?fields=lat,lon,city', { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    if (j && typeof j.lat === 'number') {
      _geoCache = { latitude: j.lat, longitude: j.lon };
      saveConfig({ geo: { latitude: j.lat, longitude: j.lon, city: j.city || '' } });
      return _geoCache;
    }
  } catch {}
  return null;
}

// Cookie/consent/GDPR banners that otherwise cover content and break clicks. Best-effort: click the
// first visible accept/allow control. Disable with config.autoDismissBanners=false.
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler', '#truste-consent-button', '.fc-cta-consent', '#sp_message_iframe',
  '[aria-label="Accept all"]', '[aria-label="Accept all cookies"]', 'button[aria-label*="accept" i]',
  'button:has-text("Accept all")', 'button:has-text("Allow all")', 'button:has-text("I agree")',
  'button:has-text("Agree")', 'button:has-text("Got it")', 'button:has-text("Accept cookies")',
  'button:has-text("Accept")', 'button:has-text("I accept")', 'button:has-text("Continue")',
];
async function dismissInterruptions(p) {
  if (!p || loadConfig().autoDismissBanners === false) return;
  for (const sel of CONSENT_SELECTORS) {
    try {
      const el = await p.$(sel);
      if (el && await el.isVisible().catch(() => false)) { await el.click({ timeout: 1200 }).catch(() => {}); break; }
    } catch {}
  }
}

// Attach per-page handlers: auto-accept JS dialogs (alert/confirm/beforeunload) so they don't
// freeze Playwright, and keep the observer flag honest.
function attachPageHandlers(p) {
  try {
    p.on('dialog', async (dlg) => {
      try { sendToActivity('tool-update', { type: 'thinking', text: `🔔 page dialog (${dlg.type()}): "${(dlg.message() || '').slice(0, 60)}" — auto-accepted` }); } catch {}
      try { await dlg.accept(); } catch { try { await dlg.dismiss(); } catch {} }
    });
  } catch {}
}

// Persist the browser window's position/size so it reopens where you left it (you can shove it
// aside while it runs and it stays there). Read via CDP — Chromium owns the real OS window.
async function saveBrowserBounds() {
  try {
    if (!browser || !page || !browserContext) return;
    const cdp = await browserContext.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    await cdp.detach().catch(() => {});
    if (bounds && bounds.width > 200 && bounds.height > 200 && bounds.windowState !== 'minimized')
      saveConfig({ browserBounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } });
  } catch {}
}
let _boundsDeb = null;
function scheduleSaveBounds() { clearTimeout(_boundsDeb); _boundsDeb = setTimeout(() => { saveBrowserBounds(); }, 3000); }

let browserLaunching = null;
async function ensureBrowser() {
  if (browserContext && page) return;
  if (browserLaunching) return browserLaunching;     // de-dupe concurrent launches (race → 2 browsers)
  browserLaunching = (async () => {
    const { chromium } = require('playwright');
    // Browser is its OWN dedicated, visible desktop window (headless:false) — NOT fullscreen, sized
    // 1280x860 and positioned on the desktop. --no-sandbox: Chromium often fails to start from a
    // packaged/Finder-launched Electron app without it. Realistic UA + viewport reduce bot-blocking.
    // Restore where you last left the window (movable/resizable — shove it aside, it stays put).
    const sb = loadConfig().browserBounds;
    const winArgs = (sb && sb.width > 200 && sb.height > 200)
      ? [`--window-size=${Math.round(sb.width)},${Math.round(sb.height)}`, `--window-position=${Math.round(sb.left)},${Math.round(sb.top)}`]
      : ['--window-size=1280,860', '--window-position=140,120'];
    const geo = await browserGeo();              // real coords → location-aware results work
    // PERSISTENT profile (vs a throwaway context): the on-disk profile dir keeps Google/2FA logins
    // alive across launches, so signing into siddhantpramod2008@gmail.com once (incl. the 2FA step)
    // sticks. Combines launch args + context opts in one call.
    const freshProfile = !fs.existsSync(BROWSER_PROFILE_DIR);
    fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
    browserContext = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
             '--disable-dev-shm-usage', ...winArgs],
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: null, locale: 'en-US',          // viewport:null → page fills the real window
      permissions: ['geolocation'],             // auto-grant the location prompt instead of stalling
      ...(geo ? { geolocation: geo } : {}),
    });
    browser = browserContext.browser();         // null for persistent contexts — expected; close via the context
    // Auto-handle JS dialogs on every page/tab (popups otherwise block the agent).
    browserContext.on('page', (p) => attachPageHandlers(p));
    // Watch-my-mouse: forward Siddhant's in-page actions to Node, and install the listeners on
    // every page/navigation. Best-effort — a failure here must not block the browser.
    try {
      await browserContext.exposeBinding('__bhatbotUserEvent', (src, detail) => onUserBrowserEvent(detail));
      await browserContext.addInitScript(OBSERVER_SCRIPT);
    } catch (e) { console.error('[browser] observer install failed:', e.message); }
    page = browserContext.pages()[0] || await browserContext.newPage();
    attachPageHandlers(page);
    // First ever launch of the profile → land on Google sign-in (email prefilled) so Siddhant just
    // completes the one-time 2FA; after that the persistent profile stays signed in.
    if (freshProfile) {
      const acct = (loadConfig().browserAccount || '').trim();
      const url = acct
        ? 'https://accounts.google.com/AccountChooser?Email=' + encodeURIComponent(acct) + '&continue=' + encodeURIComponent('https://mail.google.com/')
        : 'https://accounts.google.com/';
      page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  })();
  try { await browserLaunching; } finally { browserLaunching = null; }
}

// Selector drift is the Achilles' heel of DOM replay. When a learned selector no longer matches,
// fall back to the vision stack (OmniParser → vision_click) using a text hint mined from the
// selector — so a stale workflow self-heals instead of silently failing.
async function visionClickByText(hint) {
  if (!hint || !omniAvailable()) return false;
  try {
    const p = await screenParse({ target: 'browser', query: hint, semantics: false });
    const el = p && p.success && (p.elements || [])[0];
    if (!el || !el.click) return false;
    const r = await visionClick({ target: 'browser', x: el.click.x, y: el.click.y });
    return !!(r && r.success);
  } catch { return false; }
}


// ---------------------------------------------------------------------------
// Browser workflow recording — capture the sequence of browser actions that
// actually worked on a site, save it by name, replay it later as a macro.
// Empirical traces beat the model re-deriving selectors from scratch each time.
// ---------------------------------------------------------------------------
function wfPath(name) { return path.join(WORKFLOW_DIR, String(name).replace(/[^\w.-]/g, '_') + '.json'); }

// browser_observe — the watch-my-mouse surface. The agent uses this to check whether Siddhant
// is interacting, to wait for him, and to LEARN the steps he just performed into a workflow.
async function browserObserve(input) {
  const a = input.action || 'status';
  const idleMs = input.idleMs || 1500;
  const sinceMs = lastUserActivityTs ? Date.now() - lastUserActivityTs : Infinity;
  if (a === 'status') {
    return { success: true, userActive: sinceMs < idleMs, lastActivityMsAgo: isFinite(sinceMs) ? sinceMs : null,
      observing: observing(), observeSecondsLeft: observing() ? Math.round((observeUntil - Date.now()) / 1000) : 0,
      bufferedSteps: userEventBuffer.length,
      recent: userEventBuffer.slice(-8).map((d) => ({ type: d.type, selector: d.selector, value: d.secret ? '«secret»' : d.value })) };
  }
  // --- Consented observation session: only run AFTER asking Siddhant for a 5–10 min window. ---
  if (a === 'start') {
    let minutes = Number(input.minutes || 7);
    if (!isFinite(minutes)) minutes = 7;
    minutes = Math.max(1, Math.min(15, minutes));
    try { await ensureBrowser(); if (page) await page.bringToFront().catch(() => {}); }
    catch (e) { return { success: false, error: 'Could not open the browser window: ' + e.message }; }
    userEventBuffer = [];
    observeSessionStart = Date.now();
    observeUntil = Date.now() + minutes * 60 * 1000;
    if (observeTimer) clearTimeout(observeTimer);
    observeTimer = setTimeout(() => {
      observeUntil = 0; observeTimer = null;
      sendToActivity('tool-update', { type: 'thinking', text: `👀 observation window ended — ${userEventBuffer.length} steps captured. Ask me to review what I learned.` });
    }, minutes * 60 * 1000);
    sendToActivity('tool-update', { type: 'thinking', text: `👀 observing your browsing for ${minutes} min — go ahead.` });
    return { success: true, observing: true, minutes,
      result: `Watching your browsing for ${minutes} minutes in the BhatBot browser window. Do your normal task — I capture the steps (passwords/OTPs excluded) and will ASK before saving anything. Call browser_observe{review} when done, or {stop} to end early.` };
  }
  if (a === 'stop') {
    const had = observing();
    observeUntil = 0; if (observeTimer) { clearTimeout(observeTimer); observeTimer = null; }
    return { success: true, stopped: had, bufferedSteps: userEventBuffer.length,
      result: had ? `Stopped observing. Captured ${userEventBuffer.length} steps — call review to see them.` : 'No active observation session (buffer still available to review).' };
  }
  if (a === 'review') {
    const digest = summarizeBrowsing(userEventBuffer);
    if (!digest.stepCount && !digest.domains.length) return { success: true, ...digest, note: 'Nothing captured yet — start an observation session first.' };
    return { success: true, ...digest, note: 'Narrate these to Siddhant in plain English and ASK which to remember. Then call browser_observe{save, items:[...]} with ONLY the ones he approves.' };
  }
  if (a === 'save') {
    const items = Array.isArray(input.items) ? input.items.filter(Boolean) : (input.item ? [input.item] : []);
    if (!items.length) return { success: false, error: 'Pass items: an array of approved facts/habits (plain English) to remember.' };
    const saved = [];
    for (const it of items.slice(0, 12)) {
      const r = saveMemoryEntry('Preferences & Patterns', `[browsing] ${String(it).slice(0, 280)}`);
      if (r.success) saved.push(it);
      try { notion.appendMemory({ fact: String(it).slice(0, 280), tags: ['browsing', 'observed'], source: 'agent', confidence: 0.8 }); } catch {}
      try { wsMemory.add && wsMemory.add(String(it), { kind: 'browsing-habit' }); } catch {}
    }
    // Optionally also persist the captured steps as a replayable workflow.
    let wfNote = '';
    if (input.name) {
      const steps = userEventsToSteps(userEventBuffer);
      if (steps.length) {
        fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
        fs.writeFileSync(wfPath(input.name), JSON.stringify({ name: input.name, description: input.description || 'Learned from observed browsing', created: new Date().toISOString(), source: 'observed', steps }, null, 2));
        wfNote = ` Also saved a replayable workflow "${input.name}" (${steps.length} steps).`;
      }
    }
    if (input.clear !== false) userEventBuffer = [];
    return { success: true, saved, result: `Remembered ${saved.length} habit${saved.length === 1 ? '' : 's'} to long-term memory.${wfNote}` };
  }
  if (a === 'wait') { const waited = await waitForUserIdle(idleMs, input.timeoutMs || 120000); return { success: true, waited, idleNow: (Date.now() - lastUserActivityTs) >= idleMs }; }
  if (a === 'clear') { userEventBuffer = []; return { success: true, result: 'Observation buffer cleared.' }; }
  if (a === 'learn') {
    const steps = userEventsToSteps(userEventBuffer);
    if (!steps.length) return { success: false, error: 'Nothing observed yet — do the task in the browser window first, then learn.' };
    if (!input.name) return { success: true, learned: steps.length, steps, note: 'Pass a name to SAVE these as a replayable workflow.' };
    fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
    const wf = { name: input.name, description: input.description || 'Learned from Siddhant’s actions', created: new Date().toISOString(), source: 'observed', steps };
    fs.writeFileSync(wfPath(input.name), JSON.stringify(wf, null, 2));
    try { notion.appendMemory({ fact: `Learned browser workflow "${input.name}" (${steps.length} steps) from watching Siddhant`, tags: ['workflow', 'observed'], source: 'agent', confidence: 0.85 }); } catch {}
    const n = steps.length; userEventBuffer = [];
    return { success: true, result: `Learned + saved workflow "${input.name}" (${n} steps) from your actions. Replay it with browser_workflow{replay_workflow}.` };
  }
  return { success: false, error: `unknown action: ${a}` };
}

// screen_observe — user-triggered "watch my screen". Mirrors browser_observe but for the WHOLE
// Mac screen (any app). Consent is the spoken/typed command itself. Captures a frame every ~25s,
// gets a SHORT text description from the local vision model, and buffers it. Raw screenshots are
// NOT persisted; the describer is told to ignore passwords/secrets. Nothing is written to
// long-term memory without explicit approval (action:"save").
async function describeScreenFrame() {
  const cap = await captureScreenPng();
  if (cap.error) return { error: cap.error };
  const model = loadConfig().visionModel || OLLAMA_VISION_MODEL;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, images: [cap.b64],
        prompt: 'In ONE concise sentence, describe what the user is doing on screen (active app + task). Do NOT transcribe any passwords, verification codes, card numbers, or personal secrets — describe the activity only.' })
    });
    if (!res.ok) return { error: `Ollama ${res.status} (is it running with ${model}?)` };
    const j = await res.json();
    return { text: (j.response || '').trim().replace(/\s+/g, ' ').slice(0, 240) };
  } catch (e) { return { error: e.message }; }
}

async function screenObserve(input) {
  const a = input.action || 'status';
  if (a === 'status') {
    return { success: true, watching: watchingScreen(),
      secondsLeft: watchingScreen() ? Math.round((screenWatchUntil - Date.now()) / 1000) : 0,
      observations: screenWatchBuffer.length, recent: screenWatchBuffer.slice(-6) };
  }
  if (a === 'start') {
    let minutes = Number(input.minutes || 7); if (!isFinite(minutes)) minutes = 7;
    minutes = Math.max(1, Math.min(30, minutes));
    const everyMs = Math.max(10, Math.min(60, Number(input.everySeconds || 25))) * 1000;
    screenWatchBuffer = [];
    screenWatchUntil = Date.now() + minutes * 60 * 1000;
    if (screenWatchTimer) clearTimeout(screenWatchTimer);
    if (screenWatchTick) clearInterval(screenWatchTick);
    const tick = async () => {
      if (!watchingScreen()) return;
      const f = await describeScreenFrame();
      if (f.text) {
        screenWatchBuffer.push({ t: new Date().toLocaleTimeString(), text: f.text });
        sendToActivity('tool-update', { type: 'thinking', text: `🖥️ ${f.text}` });
      }
    };
    screenWatchTick = setInterval(tick, everyMs);
    tick();
    screenWatchTimer = setTimeout(() => {
      screenWatchUntil = 0;
      if (screenWatchTick) { clearInterval(screenWatchTick); screenWatchTick = null; }
      sendToActivity('tool-update', { type: 'thinking', text: `🖥️ screen-watch ended — ${screenWatchBuffer.length} notes. Ask me to review what I learned.` });
    }, minutes * 60 * 1000);
    sendToActivity('tool-update', { type: 'thinking', text: `🖥️ watching your screen for ${minutes} min — go ahead.` });
    return { success: true, watching: true, minutes,
      result: `Watching your whole screen for ${minutes} min — I note what you're doing every ${everyMs / 1000}s (no screenshots saved, passwords/secrets skipped). Call screen_observe{review} when done, or {stop} to end early.` };
  }
  if (a === 'stop') {
    const had = watchingScreen();
    screenWatchUntil = 0;
    if (screenWatchTimer) { clearTimeout(screenWatchTimer); screenWatchTimer = null; }
    if (screenWatchTick) { clearInterval(screenWatchTick); screenWatchTick = null; }
    return { success: true, stopped: had, observations: screenWatchBuffer.length,
      result: had ? `Stopped watching. ${screenWatchBuffer.length} notes captured — call review to see them.` : 'No active screen-watch (buffer still reviewable).' };
  }
  if (a === 'snapshot') {
    const f = await describeScreenFrame();
    if (f.error) return { success: false, error: 'capture/describe failed: ' + f.error };
    return { success: true, observation: f.text };
  }
  if (a === 'review') {
    if (!screenWatchBuffer.length) return { success: true, observations: 0, note: 'Nothing captured yet — start a screen-watch first.' };
    return { success: true, observations: screenWatchBuffer.length,
      notes: screenWatchBuffer.map((o) => `${o.t}: ${o.text}`),
      note: 'Narrate these to Siddhant in plain English and ASK which to remember. Then call screen_observe{save, items:[...]} with ONLY the ones he approves.' };
  }
  if (a === 'save') {
    const items = Array.isArray(input.items) ? input.items.filter(Boolean) : (input.item ? [input.item] : []);
    if (!items.length) return { success: false, error: 'Pass items: an array of approved facts/habits (plain English) to remember.' };
    const saved = [];
    for (const it of items.slice(0, 12)) {
      const r = saveMemoryEntry('Preferences & Patterns', `[screen] ${String(it).slice(0, 280)}`);
      if (r.success) saved.push(it);
      try { notion.appendMemory({ fact: String(it).slice(0, 280), tags: ['screen', 'observed'], source: 'agent', confidence: 0.8 }); } catch {}
      try { wsMemory.add && wsMemory.add(String(it), { kind: 'screen-habit' }); } catch {}
    }
    if (input.clear !== false) screenWatchBuffer = [];
    return { success: true, saved, result: `Remembered ${saved.length} thing${saved.length === 1 ? '' : 's'} from watching your screen.` };
  }
  if (a === 'clear') { screenWatchBuffer = []; return { success: true, result: 'Screen-watch buffer cleared.' }; }
  return { success: false, error: `unknown action: ${a}` };
}


// ---------------------------------------------------------------------------
// smart_login — domain-keyed sign-in with phone-assisted 2FA.
//   1. Look up the saved login profile for the host (or use inline username/credRef).
//   2. Fill + submit the FIRST factor (username + password) via the existing browser login.
//   3. If a SECOND factor is needed:
//        • TOTP secret on file  → generate the code, fill it, submit  (no interruption).
//        • otherwise            → call + text Siddhant, BLOCK for his reply (code or
//                                  "approved"), then fill the code / re-check the page.
// Target is the Playwright window (most reliable). Real browsers/native apps fall back to
// system_control (AppleScript/keystroke) — see the tool description.
// ---------------------------------------------------------------------------
const OTP_SEL = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[id*="code" i], input[name*="token" i], input[name*="2fa" i], input[inputmode="numeric"], input[type="tel"]';
async function pageNeeds2FA() {
  try {
    if (!page) return false;
    if (await page.$(OTP_SEL)) return true;
    const body = (await page.innerText('body').catch(() => '')) || '';
    return /(verification code|2-step|two-?factor|authenticator|one-?time|enter the code|6-digit|approve.*(sign|log)|check your phone)/i.test(body);
  } catch { return false; }
}
async function fillOtpAndSubmit(code) {
  const f = await page.$(OTP_SEL);
  if (!f) return false;
  await f.fill(String(code));
  const SUBMIT = 'button[type="submit"], input[type="submit"], button:has-text("Verify"), button:has-text("Continue"), button:has-text("Next"), button:has-text("Submit")';
  const btn = await page.$(SUBMIT);
  if (btn) await btn.click().catch(() => {}); else await f.press('Enter').catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  return true;
}
// --- Native typing helpers (for app / real-browser logins, outside the Playwright window) ---
// Secrets are typed via the clipboard (Cmd+V) — reliable for ANY character, no AppleScript
// keystroke escaping pitfalls — then the clipboard is wiped immediately so the secret doesn't
// linger on the pasteboard.
const appStr = (s) => '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
async function nativePaste(text) {
  await osa(['-e', 'set the clipboard to ' + appStr(text)]);
  await sleep(150);
  await osa(['-e', 'tell application "System Events" to keystroke "v" using {command down}']);
  await sleep(150);
}
async function nativeKey(code) { await osa(['-e', 'tell application "System Events" to key code ' + code]); }   // 48=Tab 36=Return 53=Esc
async function nativeClearClipboard() { await osa(['-e', 'set the clipboard to ""']); }
const BROWSER_APPS = { chrome: 'Google Chrome', safari: 'Safari', edge: 'Microsoft Edge', arc: 'Arc', firefox: 'Firefox', brave: 'Brave Browser' };

// Universal login for NATIVE apps and REAL browsers (Chrome/Safari/Arc/…), i.e. ANY app — not
// just the Playwright window. Opens the target, types credentials via the clipboard, then runs
// the SAME phone-assisted 2FA flow as smart_login. Best-effort: when OmniParser is available it
// uses vision (screen_parse → vision_click) to focus the right field; otherwise it falls back to
// the universal username → Tab → password → Enter pattern that fits the vast majority of forms.
async function nativeLogin(input) {
  const ref = input.url || input.host;
  const prof = ref ? logins.get(ref) : null;
  const username = input.username || (prof && prof.username) || '';
  let password = input.credRef || '';
  if (!password && prof && prof.credRef) { try { password = credentials.resolve(prof.credRef); } catch (e) { return { success: false, error: 'could not resolve stored password handle: ' + e.message }; } }
  if (!password) return { success: false, error: 'no password available (profile has no credRef and none passed inline)' };
  let totpSecret = input.totpRef || '';
  if (!totpSecret && prof && prof.totpRef) { try { totpSecret = credentials.resolve(prof.totpRef); } catch {} }
  const twoFactor = input.twoFactor || (prof && prof.twoFactor) || 'auto';
  const url = input.url || (prof && prof.url);

  // 1) Launch the target.
  let opened;
  if (input.target === 'app' || input.target === 'native') {
    if (!input.app) return { success: false, error: 'target "app" needs app:"<App Name>"' };
    opened = await systemControl({ action: 'open_app', app: input.app });
    if (opened && opened.success === false) return opened;
  } else {
    const key = String(input.browser || input.target || 'chrome').toLowerCase();
    const app = BROWSER_APPS[key] || input.browser || 'Google Chrome';
    if (!url) return { success: false, error: 'need a url to open in the browser' };
    opened = await new Promise((res) => { const p = spawn('open', ['-a', app, url], { env: { ...process.env, PATH: EXEC_PATH } }); p.on('error', (e) => res({ success: false, error: 'could not open ' + app + ': ' + e.message })); p.on('close', (c) => res({ success: c === 0, app })); });
    if (opened.success === false) return opened;
  }
  await sleep(input.loadMs || 3000);

  // 2) Vision-assisted focus of the username/email field (skip silently if unavailable).
  if (omniAvailable() && input.vision !== false) {
    try {
      const parsed = await screenParse({ target: 'screen', semantics: false });
      if (parsed.success) {
        const el = (parsed.elements || []).find((e) => /e-?mail|user\s?name|username|phone|account|sign ?in|log ?in/i.test(e.content || ''));
        if (el && el.click) { await visionClick({ target: 'screen', x: el.click.x, y: el.click.y }); await sleep(450); }
      }
    } catch {}
  }

  // 3) Type credentials: username → Tab → password → Enter.
  if (username) { await nativePaste(username); await sleep(200); await nativeKey(48); await sleep(300); }
  await nativePaste(password);
  await nativeClearClipboard();
  await sleep(250);
  await nativeKey(36);                       // Return → submit first factor
  await sleep(input.afterSubmitMs || 3500);

  // 4) Second factor.
  if (twoFactor === 'none') return { success: true, stage: 'first_factor', note: 'First factor entered; profile says no 2FA. Verify on screen.' };

  // (a) Silent TOTP.
  if (totpSecret && twoFactor !== 'phone') {
    try {
      const OTPAuth = require('otpauth');
      const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(String(totpSecret).replace(/\s+/g, '').toUpperCase()) }).generate();
      await nativePaste(code); await nativeClearClipboard(); await sleep(150); await nativeKey(36);
      await sleep(2500);
      return { success: true, stage: 'complete', note: 'Logged in (TOTP 2FA entered silently). Verify on screen.' };
    } catch { /* fall through to phone */ }
  }

  // (b) Decide whether 2FA is needed (vision OCR), then phone-assist.
  let needs = twoFactor === 'phone';
  if (!needs && omniAvailable() && input.vision !== false) {
    try { const p2 = await screenParse({ target: 'screen', semantics: false }); if (p2.success) needs = (p2.elements || []).some((e) => /(verification|2-step|two-?factor|authenticat|one-?time|enter.*code|6-digit|check your phone|approve)/i.test(e.content || '')); } catch {}
  }
  if (!needs && twoFactor === 'auto') return { success: true, stage: 'complete', note: 'Credentials entered; no 2FA prompt detected. Verify on screen.' };

  const site = (() => { try { return new URL(url || '').hostname; } catch { return input.app || ref || 'the app'; } })();
  const ask = `BhatBot is signing you into ${site}. Password is in. It needs the 2FA code — reply with the code (or "approved" if you just tapped a push prompt).`;
  await notifyUser(ask, 'call', { awaitReply: true, taskId: 'login-2fa' });
  await twilioSMS(ask).catch(() => {});
  sendToActivity('tool-update', { type: 'thinking', text: `🔐 ${site}: first factor in — waiting for your 2FA code by phone…` });
  const code = await awaitTwoFactorCode(input.waitMs || 150000);
  if (!code) return { success: false, stage: 'awaiting_2fa', error: 'No 2FA reply within the wait window. Reply with the code and re-run, or finish in the app.' };
  if (code !== 'APPROVED') { await nativePaste(code); await nativeClearClipboard(); await sleep(150); await nativeKey(36); }
  await sleep(2000);
  return { success: true, stage: 'complete', note: `Signed into ${site} (phone 2FA). Verify on screen.` };
}

const NATIVE_LOGIN_TARGET = /^(app|native|chrome|safari|edge|arc|firefox|brave)$/i;
async function smartLogin(input) {
  // Native app / real browser → keystroke-driven login (vision-assisted) instead of Playwright.
  if (input.target && NATIVE_LOGIN_TARGET.test(input.target)) return nativeLogin(input);
  // Resolve a saved profile by url/host; inline fields override it.
  const ref = input.url || input.host;
  const prof = ref ? logins.get(ref) : null;
  if (!prof && !input.credRef) return { success: false, error: `No saved login for "${ref}" and no credRef given. Save one with manage_logins{action:"set"} (store the password in the vault first), or pass username+credRef inline.` };
  const url = input.url || (prof && prof.url);
  const username = input.username || (prof && prof.username) || '';
  // credRef fields arrive ALREADY resolved to the real secret (executeTool resolves CRED_REF_*
  // in the input). For a saved profile, resolve its stored handle here, in-process.
  let password = input.credRef || '';
  if (!password && prof && prof.credRef) { try { password = credentials.resolve(prof.credRef); } catch (e) { return { success: false, error: 'could not resolve stored password handle: ' + e.message }; } }
  if (!password) return { success: false, error: 'no password available (profile has no credRef and none passed inline)' };
  let totpSecret = input.totpRef || '';
  if (!totpSecret && prof && prof.totpRef) { try { totpSecret = credentials.resolve(prof.totpRef); } catch {} }
  const twoFactor = input.twoFactor || (prof && prof.twoFactor) || 'auto';

  // Step 1 — first factor.
  const first = await browserAction({ action: 'login', url, username, credRef: password });
  if (!first.success) return first;
  saveBrowserState();
  // No 2FA detected and login looks complete → done.
  if (first.loginLikelyComplete && !(await pageNeeds2FA())) {
    return { success: true, stage: 'complete', note: 'Logged in (no 2FA needed).', url: page && page.url(), _image: first._image };
  }

  // Step 2 — second factor.
  if (twoFactor === 'none') return { success: true, stage: 'first_factor', note: 'First factor submitted; profile says no 2FA.', _image: first._image };

  // (a) Silent TOTP if we have the secret.
  if (totpSecret && twoFactor !== 'phone') {
    try {
      const OTPAuth = require('otpauth');
      const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(String(totpSecret).replace(/\s+/g, '').toUpperCase()) }).generate();
      const filled = await fillOtpAndSubmit(code);
      if (filled) {
        saveBrowserState();
        const stillPw = await page.$('input[type="password"]:not([type="hidden"])').catch(() => null);
        const ok = !(await pageNeeds2FA()) && !stillPw;
        return { success: true, stage: ok ? 'complete' : 'twofactor_submitted', note: ok ? 'Logged in (TOTP 2FA done silently).' : 'TOTP submitted; verify the result.', url: page && page.url(), _image: await page.screenshot({ type: 'jpeg', quality: 60 }).then((b) => b.toString('base64')).catch(() => undefined) };
      }
    } catch (e) { /* fall through to phone */ }
  }

  // (b) Phone-assisted: call + text Siddhant, then block for his reply.
  const site = (() => { try { return new URL(url || page.url()).hostname; } catch { return ref || 'the site'; } })();
  const ask = `BhatBot is signing you into ${site}. Password is in. It needs the 2FA code — reply with the code (or "approved" if you just tapped a push prompt).`;
  await notifyUser(ask, 'call', { awaitReply: true, taskId: 'login-2fa' });   // rings + texts (Telegram record)
  await twilioSMS(ask).catch(() => {});                                        // explicit text too, per request
  sendToActivity('tool-update', { type: 'thinking', text: `🔐 ${site}: first factor in — waiting for your 2FA code by phone…` });
  const code = await awaitTwoFactorCode(input.waitMs || 150000);
  if (!code) return { success: false, stage: 'awaiting_2fa', error: `No 2FA reply within the wait window. Reply with the code and re-run smart_login, or finish in the browser window.`, _image: first._image };
  if (code !== 'APPROVED') await fillOtpAndSubmit(code);
  else await page.waitForTimeout(1500).catch(() => {});   // push approval — give the page a beat to advance
  saveBrowserState();
  const stillPw2 = await page.$('input[type="password"]:not([type="hidden"])').catch(() => null);
  const ok2 = !(await pageNeeds2FA()) && !stillPw2;
  return { success: true, stage: ok2 ? 'complete' : 'twofactor_submitted', note: ok2 ? `Logged into ${site} (phone 2FA done).` : 'Second factor submitted; verify the result.', url: page && page.url(), _image: await page.screenshot({ type: 'jpeg', quality: 60 }).then((b) => b.toString('base64')).catch(() => undefined) };
}

// ---------------------------------------------------------------------------
// macOS GUI / system automation via AppleScript + System Events. Generalizes the
// Spotify pattern to any app: activate, keystroke, shortcut, click menu items,
// clipboard, notifications, or run raw AppleScript. Needs Accessibility (keystroke/
// menu/UI) and Automation (per-app) permission — granted to Bhatbot.app once.
// ---------------------------------------------------------------------------
const { systemControl } = require('./tools/system')({ spawn, osa, osaErr, EXEC_PATH });
// Browser tools (browserAction + browserWorkflow) extracted to tools/browser.js (SPLIT_PLAN step 6).
// page/browser/context + ensureBrowser stay HERE (the single source of truth); the module reaches
// them only via these accessor/reset closures — which reassign main's own `let`s — so state can't
// drift. recordingSteps is likewise main-owned (onUserBrowserEvent writes it too) via rec* closures.
const { browserAction, browserWorkflow } = require('./tools/browser')({
  getPage: () => page,
  resetBrowser: () => { browser = null; page = null; browserContext = null; browserLaunching = null; },
  closeBrowser: async () => { try { await (browserContext || browser).close(); } catch {} },
  ensureBrowser, saveBrowserState, dismissInterruptions, visionClickByText, scheduleSaveBounds,
  agentActing, waitForUserIdle, sendToActivity, openActivityWindow, loadConfig,
  recGet: () => recordingSteps,
  recPush: (step) => { if (recordingSteps) recordingSteps.push(step); },
  recStart: () => { recordingSteps = []; },
  recStop: () => { recordingSteps = null; },
  WORKFLOW_DIR, wfPath,
});

// Vision tools (screen_parse / vision_click / vision_local) live in tools/vision.js (B-c). The heavy
// OmniParser worker + screen capture + Playwright page stay here and are injected (getPage closes
// over the mutable `page`). Thin wrappers below keep every internal caller unchanged. Deps resolve
// via hoisting at call time (omniRequest/captureScreenPng/screenPoints/omniAvailable defined below).
const vision = require('./tools/vision')({
  getPage: () => page, ensureBrowser, captureScreenPng, screenPoints, omniRequest, omniAvailable,
  sleep, sendToActivity, loadConfig, ollamaUrl: OLLAMA_URL, visionModelDefault: OLLAMA_VISION_MODEL,
});
const screenParse = (input) => vision.screenParse(input);
const visionClick = (input) => vision.visionClick(input);
const visionLocal = (input) => vision.visionLocal(input);

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
  // SoT mirror: Notion is the authoritative durable store. Fire-and-forget + deduped so a fact
  // written from the Mac and from the cloud doesn't diverge into two copies.
  try { notion.appendMemory({ fact: content, tags: [section.toLowerCase().replace(/[^a-z]+/g, '-')], source: 'agent' }); } catch {}
  try { semantic.upsert({ text: content, kind: 'semantic', meta: { section } }).catch(() => {}); } catch {}   // #12 embedding store
  try { graphIngest(content); } catch {}   // W4 — extract entity/relation triples (async, fire-and-forget)
  return { success: true, saved: `${section}: ${content}` };
}

// W4 — pull knowledge-graph triples out of a saved fact with a cheap Haiku pass and fold them into
// the graph. Async + fire-and-forget so it never blocks the save. Gated by config.knowledgeGraph.
async function graphIngest(content) {
  try {
    if (loadConfig().knowledgeGraph === false) return;
    const text = String(content || '').trim();
    if (text.length < 8) return;
    const sys = 'Extract knowledge-graph triples from this fact about Siddhant. Return ONLY JSON: {"triples":[{"subject","predicate","object","subjectType","objectType"}]}. Types ∈ person|project|tool|org|place|concept|event|thing. Canonical short names ("Siddhant" not "I"). Skip non-factual text. Max 6 triples; empty array if none.';
    const r = await anthropicRequest({ model: MODEL_HAIKU, max_tokens: 500, system: sys, messages: [{ role: 'user', content: text.slice(0, 1000) }] }, getApiKey(), { retries: 1 });
    const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const j = parseJsonLoose(txt);
    if (j && Array.isArray(j.triples) && j.triples.length) {
      const res = graph.ingest(j.triples);
      if (res.added) sendToActivity('tool-update', { type: 'thinking', text: `🕸 knowledge graph +${res.added} relation${res.added > 1 ? 's' : ''}` });
    }
  } catch {}
}

// Write-through reconcile: pull recent AUTHORITATIVE facts from Notion into the local memory.md
// cache, so facts the cloud wrote while the Mac slept appear locally too. Append-only and
// de-duplicated against the current file — it never deletes, so divergence can only shrink.
async function syncMemoryFromNotion() {
  try {
    if (!notion.isConfigured || !notion.isConfigured() || !notion.recentMemory) return;
    const recent = await notion.recentMemory({ limit: 80 });
    if (!recent || !recent.length) return;
    let md = fs.existsSync(MEMORY_PATH) ? fs.readFileSync(MEMORY_PATH, 'utf8') : INITIAL_MEMORY;
    const haveNorm = md.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const missing = recent.filter((m) => m.fact && norm(m.fact) && !haveNorm.includes(norm(m.fact)));
    if (!missing.length) return;
    const SECTION = '## Notes';
    const idx = md.indexOf(SECTION);
    if (idx === -1) return;
    const insertAt = idx + SECTION.length;
    const lines = missing.slice(0, 40).map((m) => `- ${(m.date || '').slice(0, 10) || today()}: [notion] ${m.fact}`).join('\n');
    md = md.slice(0, insertAt) + '\n' + lines + '\n' + md.slice(insertAt + 1);
    fs.writeFileSync(MEMORY_PATH, md);
    try { for (const m of missing.slice(0, 40)) semantic.upsert({ text: m.fact, kind: 'semantic', meta: { section: 'Notes', source: 'notion' } }).catch(() => {}); } catch {}
    sendToActivity('tool-update', { type: 'thinking', text: `🔄 reconciled ${missing.length} fact(s) from Notion into local memory.` });
  } catch {}
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
  const noThink = isThinkingModel(model);
  if (system || noThink) msgs.unshift({ role: 'system', content: (system || '') + (noThink ? '\n/no_think' : '') });
  const otools = (tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const body = { model, messages: msgs, tools: otools, stream: false, options: { temperature: 0.3 } };
  if (noThink) body.think = false;
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
    // Cross-provider offload callers (plain text, no tools) — spread agent load off the
    // Anthropic per-minute cap. Flatten any block-shaped content to plain strings.
    openaiChat: async (m, s, model) => {
      if (!c.openaiKey) throw new Error('no openaiKey');
      const msgs = m.map((x) => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: typeof x.content === 'string' ? x.content : JSON.stringify(x.content) }));
      if (s) msgs.unshift({ role: 'system', content: s });
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.openaiKey },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: msgs }), signal: AbortSignal.timeout(60000)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || `openai ${r.status}`);
      return j.choices?.[0]?.message?.content || '';
    },
    geminiChat: async (m, s, model) => {
      if (!c.geminiKey) throw new Error('no geminiKey');
      const contents = m.map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: typeof x.content === 'string' ? x.content : JSON.stringify(x.content) }] }));
      const body = { contents };
      if (s) body.systemInstruction = { parts: [{ text: s }] };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.geminiKey },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || `gemini ${r.status}`);
      return j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
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

// delegate_project: run a multi-step goal through the workspace orchestrator IN THE
// BACKGROUND. Returns immediately so the chat stays a responsive foreground concierge —
// the old await-to-completion here is what used to freeze chat for the whole project.
// Up to 3 agent tasks run in parallel; each is a job card (lib/jobs.js → Activity panel)
// and completions are spoken aloud. Steering/cancel comes back in via manage_jobs.
async function delegateProject(input) {
  let slug = input.workspace || workspaceMgr.getActive();
  if (!slug || !workspaceMgr.exists(slug)) { const w = workspaceMgr.create(input.workspace || (input.goal || 'project').slice(0, 40)); slug = w.slug; workspaceMgr.setActive(slug); }
  const w = workspaceMgr.load(slug);
  const cfg = loadConfig();
  cfg.__metrics = { cost_month_usd: (wsState.open(w.dir).snapshot().components, 0) };
  const project = jobsBus.create({ name: (input.goal || 'project').slice(0, 100), kind: 'project', workspace: slug });
  runProjectDetached(project.id, w, cfg, input);          // intentionally NOT awaited
  return {
    success: true, started: true, background: true, job_id: project.id, workspace: slug,
    note: 'Project launched in the background (up to 3 agents in parallel). Task cards stream to the Activity panel and completions are announced aloud as they land. Tell Siddhant it is underway in ONE short sentence and end your turn — do NOT wait for results. Check on or steer it later via manage_jobs.'
  };
}

// Detached project runner: maps orchestrator task lifecycle onto the job bus.
async function runProjectDetached(projectId, w, cfg, input) {
  const taskJobs = new Map();   // orchestrator task id -> job id
  const toolCount = new Map();  // job id -> tool events seen (drives coarse progress)
  jobsBus.update(projectId, { status: 'running', note: 'planning…' });
  const jobFor = (t) => {
    let jid = taskJobs.get(t.id);
    if (!jid) { jid = jobsBus.create({ name: t.goal.slice(0, 100), kind: 'task', agent: t.agent, parent: projectId }).id; taskJobs.set(t.id, jid); }
    return jid;
  };
  try {
    const res = await orchestrator.run(input.goal, {
      wsDir: w.dir, config: cfg, adapters: orchestratorAdapters(w.dir),
      maxTasks: input.max_tasks || 12, concurrency: fleetWidth(),   // Phase 1 — live budget-driven width (was hardcoded 3)
      shouldStop: () => jobsBus.isCancelled(projectId),
      getGuidance: () => jobsBus.takeGuidance(projectId),
      onTask: (t, phase, extra) => {
        const jid = jobFor(t);   // 'queued' phase just materializes the card
        if (phase === 'start') jobsBus.update(jid, { status: 'running', progress: 0.05, note: 'agent started' });
        else if (phase === 'event' && extra) {
          const n = (toolCount.get(jid) || 0) + (extra.type === 'tool' ? 1 : 0);
          toolCount.set(jid, n);
          const note = extra.type === 'tool' ? `⟳ ${extra.name}`
            : extra.type === 'tool_done' ? `${extra.name} ${extra.result && extra.result.success === false ? '✗' : '✓'}`
            : String(extra.text || '').slice(0, 120);
          jobsBus.update(jid, { progress: Math.min(0.9, 0.1 + n * 0.12), note });
        } else if (phase === 'done' && extra) {
          jobsBus.update(jid, {
            status: extra.status === 'ok' || extra.status === 'partial' ? 'done' : extra.status === 'needs_input' ? 'blocked' : 'failed',
            progress: 1, note: String(extra.summary || '').slice(0, 160)
          });
        }
      },
    });
    const summary = `${res.completed} task${res.completed === 1 ? '' : 's'} completed${res.open ? `, ${res.open} still open` : ''}${res.blocked ? ' — one needs your input' : ''}`;
    jobsBus.update(projectId, { status: res.cancelled ? 'cancelled' : res.blocked ? 'blocked' : 'done', note: summary });
  } catch (e) {
    jobsBus.update(projectId, { status: 'failed', note: String((e && e.message) || e).slice(0, 200) });
  }
}

// manage_jobs tool — the chat model's control plane over background work.
function manageJobs(input) {
  if (input.action === 'list') return { success: true, active: jobsBus.active().length, jobs: jobsBus.list().slice(-30) };
  const j = input.job_id ? jobsBus.get(input.job_id) : null;
  if (!j) return { success: false, error: 'unknown or missing job_id — call manage_jobs{action:"list"} first' };
  if (input.action === 'cancel') {
    jobsBus.requestCancel(j.id);
    return { success: true, cancelled: j.id, note: 'queued subtasks dropped; in-flight agent calls finish but their results are discarded' };
  }
  if (input.action === 'guide') {
    if (!input.guidance) return { success: false, error: 'guidance text required' };
    const target = j.kind === 'task' && j.parent ? j.parent : j.id;   // steering rides on the project
    jobsBus.addGuidance(target, input.guidance);
    return { success: true, guided: target, note: 'applied as a constraint to all subsequent tasks of this project' };
  }
  return { success: false, error: 'unknown action: ' + input.action };
}

// Job bus → Activity cards + plain-English relay. Every update repaints that task's card
// (job-update IPC); meaningful transitions also get a 🛰 line in chat and — queued, so
// lines never talk over each other or an active turn — spoken aloud.
const jobRelayQ = [];
let jobRelayDraining = false;
jobsBus.onUpdate(({ event, job }) => {
  const say = jobRelayLine(event, job);
  sendToActivity('job-update', { ...job, say });
  if (say) {
    sendToActivity('tool-update', { type: 'thinking', text: '🛰 ' + say });
    jobRelayQ.push(say);
    drainJobRelay();
  }
});
function jobRelayLine(event, job) {
  if (event !== 'updated') return '';
  const agent = job.agent ? job.agent.charAt(0).toUpperCase() + job.agent.slice(1) : 'An';
  if (job.kind === 'task') {
    const left = jobsBus.active().filter((x) => x.kind === 'task').length;
    const tail = left ? ` ${left} task${left === 1 ? '' : 's'} still running.` : '';
    if (job.status === 'done') return `${agent} agent finished: ${job.note || job.name}.${tail}`;
    if (job.status === 'failed') return `${agent} agent failed: ${job.note || job.name}.${tail}`;
    if (job.status === 'blocked') return `${agent} agent needs your input: ${job.note || job.name}`;
    return '';
  }
  if (job.status === 'done') return `Background project finished, sir — ${job.note || job.name}.`;
  if (job.status === 'failed') return `Background project failed: ${job.note || job.name}.`;
  if (job.status === 'blocked') return `The background project is waiting on you: ${job.note || job.name}.`;
  if (job.status === 'cancelled') return 'Background project cancelled, sir.';
  return '';
}
async function drainJobRelay() {
  if (jobRelayDraining) return;
  jobRelayDraining = true;
  try {
    while (jobRelayQ.length) {
      const line = jobRelayQ.shift();
      if (loadConfig().ttsEnabled === false) continue;
      if (agentState !== 'idle') continue;                 // chat is foreground — text-only relay
      // Don't clip a reply that's still being spoken; wait for the stream to finish (bounded).
      let waited = 0;
      while ((ttsActive || ttsStreamQ.length || ttsStreamDraining) && waited < 15000) { await sleep(400); waited += 400; }
      if (agentState !== 'idle') continue;
      await speakDesktop(line).catch(() => {});
    }
  } finally { jobRelayDraining = false; }
}

// ---------------------------------------------------------------------------
// 3D generation (TRELLIS via Replicate). Hardened: downscales oversized inputs
// (Replicate rejects very large data URLs), no fragile Prefer:wait, a real
// ---------------------------------------------------------------------------
// generate_image — PLUGGABLE provider. Routes a prompt to the best backend:
//   • openai    → GPT Image (best instruction-following; default). Model from cfg.imageGenModel
//                 (default gpt-image-2, auto-falls back to gpt-image-1 if the account lacks it).
//   • flux      → Black Forest Labs FLUX Pro via Replicate (highest quality). Needs replicateKey.
//   • flux-fast → FLUX schnell via Replicate (cheap/fast draft tier).
// provider:"auto" (default) picks by quality: low→flux-fast, high→flux, else openai — but only
// uses Replicate when a replicateKey is present, otherwise everything stays on OpenAI.
// NOTE: Fable-class models intentionally NOT wired here (held back for security); revisit later.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2D image → printable 3D mesh (STL), or 3D model (GLB/OBJ) → STL. Deterministic,
// local, offline. Backed by scripts/mesh_tool.py in the dedicated mesh venv.
//   extrude → silhouette solid (logos/stamps/keychains/cookie-cutters)
//   relief  → grayscale height-map / lithophane
//   convert → existing model (e.g. a TRELLIS .glb) → STL
// ---------------------------------------------------------------------------
const MESH_PY = path.join(os.homedir(), '.bhatbot', 'mesh-venv', 'bin', 'python');
// Open a 3D file (STL/GLB/OBJ) in an INTERACTIVE in-app three.js viewer — its own desktop
// window (orbit / zoom / pan), offline. The model bytes are streamed over IPC once the
// viewer signals ready (no file:// fetch / CSP issues).
let viewerWindow = null, pendingModel = null;
function openInteractive3D(p) {
  try {
    if (!p || !fs.existsSync(p)) return;
    const ext = path.extname(p).slice(1).toLowerCase();
    const data = fs.readFileSync(p).toString('base64');
    const info = (fs.statSync(p).size / 1048576).toFixed(2) + ' MB';
    pendingModel = { data, ext, name: path.basename(p), info };
    if (viewerWindow && !viewerWindow.isDestroyed()) {
      viewerWindow.show(); viewerWindow.focus();
      viewerWindow.webContents.send('model', pendingModel);
      return;
    }
    viewerWindow = new BrowserWindow({
      width: 920, height: 740, x: 180, y: 100, title: 'Bhatbot 3D Viewer',
      backgroundColor: '#0a0f17', fullscreen: false, alwaysOnTop: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'src', 'preload-viewer.js') },
    });
    viewerWindow.loadFile(path.join(__dirname, 'src', 'viewer.html'));
    viewerWindow.on('closed', () => { viewerWindow = null; });
  } catch (e) { console.warn('[viewer]', e.message); }
}
ipcMain.on('viewer-ready', (e) => { try { if (pendingModel) e.sender.send('model', pendingModel); } catch {} });
// Creation tools (image / image→3D / printable STL) live in tools/creation.js (B-b decomposition).
// Electron window glue (openStudioWindow/openInteractive3D) + lazy lastImagePath are injected; the
// thin wrappers below keep existing call sites unchanged. Deps resolve via hoisting at call time.
const creation = require('./tools/creation')({
  loadConfig, sleep, sendToActivity, openStudioWindow, openInteractive3D,
  getLastImagePath: () => lastImagePath, runChild,
  studioDir: STUDIO_DIR, studioIndex: STUDIO_INDEX, meshPy: MESH_PY,
  meshScript: path.join(__dirname, 'scripts', 'mesh_tool.py'),
});
const generateImage = (input) => creation.generateImage(input);
const generate3D = (input) => creation.generate3D(input);
const makePrintable = (input) => creation.makePrintable(input);

// --- Molecule / protein 3D viewer (3Dmol.js interactive + RDKit + PyMOL stills) ---
const SIM_PY = path.join(os.homedir(), '.bhatbot', 'sim-venv', 'bin', 'python');
const PYMOL_BIN = '/opt/homebrew/bin/pymol';
const MOL_DIR = path.join(os.homedir(), '.bhatbot', 'molecules');
// Generic child-process runner (captures stdout/stderr; not the safety-gated run_shell) for the
// scientific helpers that emit JSON. Resolves rather than rejects so callers degrade cleanly.
function runChild(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let proc; try { proc = spawn(cmd, args, { env: { ...process.env, PATH: EXEC_PATH } }); }
    catch (e) { return resolve({ code: 1, stdout: '', stderr: String(e.message || e) }); }
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    const to = setTimeout(() => { try { proc.kill(); } catch {} }, opts.timeoutMs || 60000);
    proc.on('close', (code) => { clearTimeout(to); resolve({ code, stdout: out, stderr: err }); });
    proc.on('error', (e) => { clearTimeout(to); resolve({ code: 1, stdout: out, stderr: String(e.message || e) }); });
  });
}
const molecule = require('./lib/molecule')({
  simPython: SIM_PY, pymolBin: PYMOL_BIN, dataDir: MOL_DIR,
  scriptPath: path.join(__dirname, 'scripts', 'mol_prep.py'), run: runChild,
});
let molWindow = null, pendingMol = null;
function openMoleculeWindow(payload) {
  pendingMol = payload;
  if (molWindow && !molWindow.isDestroyed()) { molWindow.show(); molWindow.focus(); try { molWindow.webContents.send('molecule', pendingMol); } catch {} return; }
  molWindow = new BrowserWindow({
    width: 960, height: 760, x: 160, y: 90, title: 'Bhatbot Molecule Viewer',
    backgroundColor: '#0a0f17', webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'src', 'preload-molecule.js') },
  });
  molWindow.loadFile(path.join(__dirname, 'src', 'molecule.html'));
  molWindow.on('closed', () => { molWindow = null; });
}
ipcMain.on('molecule-ready', (e) => { try { if (pendingMol) e.sender.send('molecule', pendingMol); } catch {} });

// --- FABLE / ProtFunc tie-in: predict protein FUNCTION → SEE it on the saliency-colored structure ---
const protfunc = require('./lib/protfunc')({ getUrl: () => { try { return (loadConfig().protfunc && loadConfig().protfunc.url) || ''; } catch { return ''; } } });

// --- Maps (Leaflet + OSM by default; Google geocoding when config.maps.googleKey present) ---
const maps = require('./lib/maps')({
  getKey: () => { try { return (loadConfig().maps && loadConfig().maps.googleKey) || ''; } catch { return ''; } },
  getMapId: () => { try { return (loadConfig().maps && loadConfig().maps.mapId) || ''; } catch { return ''; } },
});
let mapsWindow = null, pendingMap = null, mapRenderedCb = null;
function openMapsWindow(payload) {
  pendingMap = payload;
  if (mapsWindow && !mapsWindow.isDestroyed()) { mapsWindow.show(); mapsWindow.focus(); try { mapsWindow.webContents.send('map', pendingMap); } catch {} return; }
  mapsWindow = new BrowserWindow({
    width: 1000, height: 760, x: 150, y: 80, title: 'Bhatbot Maps',
    backgroundColor: '#0a0f17', webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'src', 'preload-maps.js') },
  });
  mapsWindow.loadFile(path.join(__dirname, 'src', 'maps.html'));
  mapsWindow.on('closed', () => { mapsWindow = null; });
}
ipcMain.on('map-ready', (e) => { try { if (pendingMap) e.sender.send('map', pendingMap); } catch {} });
ipcMain.on('map-rendered', () => { if (mapRenderedCb) { const cb = mapRenderedCb; mapRenderedCb = null; cb(); } });
// In-window interactive route planner bridges (geocode + waypoint routing) — reuse the SAME
// backend as the maps tool (Google when keyed, OSM/OSRM free otherwise). No CORS/UA issues.
ipcMain.handle('maps-geocode', async (_e, q) => { try { return { ok: true, ...(await maps.geocode(q)) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('maps-route-path', async (_e, points, mode) => { try { return { ok: true, ...(await maps.routePath(points, mode)) }; } catch (e) { return { ok: false, error: e.message }; } });

// Open the map AND capture a PNG snapshot once it's fully drawn → inline "visualization" the agent
// can return as an image (chat/phone), not just the desktop window. Resolves base64 PNG or null.
function openMapsWindowSnapshot(payload) {
  openMapsWindow(payload);
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return; done = true; mapRenderedCb = null;
      try {
        await new Promise((r) => setTimeout(r, 350));   // let the final paint settle
        const img = await mapsWindow.webContents.capturePage();
        if (img.isEmpty()) return resolve(null);
        // Downscale + JPEG so the inline vision block stays well under model image limits
        // (a raw 1000×760 PNG is ~6MB; this is ~100-200KB).
        resolve(img.resize({ width: 900 }).toJPEG(78).toString('base64'));
      } catch { resolve(null); }
    };
    mapRenderedCb = finish;
    setTimeout(finish, 7000);   // hard fallback if the renderer never signals
  });
}

// Transient failure signatures worth one automatic retry (network/load races, not logic errors).
const TRANSIENT_RE = /(timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|Target closed|Execution context|navigation|detached|not attached|temporarily|overloaded|try again|\b50[234]\b|\b429\b)/i;
// Only auto-retry IDEMPOTENT reads — never an action with side effects (a double click /
// submit / write / shell could do real damage). Pure fetches and page reads are safe.
function isRetryableTool(name, input) {
  if (name === 'fetch_url' || name === 'ui_inspect' || name === 'vision_local') return true;
  if (name === 'web_search' || name === 'news') return true;
  if (name === 'read_file' || name === 'list_directory') return true;
  if (name === 'browser') return ['navigate', 'get_text', 'screenshot'].includes(input && input.action);
  return false;
}

// VANGUARD-paced Anthropic call for every fleet/ensemble/sub-agent request (Phase 1). Replaces the
// raw anthropicRequest in the injected deps so each suit (a) RESERVES its estimated in/out budget on
// the shared admission ledger and waits if the live rolling window can't fit it yet — killing the
// convoy where N suits drained the OTPM window at once and all rate-limited together — and (b) gets
// the same clip-aware auto-continue the main turn has. Reservation is ALWAYS released, even on error.
async function pacedSubagentRequest(body, apiKey, opts) {
  const model = body.model || MODEL_SONNET;
  const needIn = Math.max(1, estimateTokens(body));
  const needOut = body.max_tokens || 4096;
  await admission.acquire(model, needIn, needOut, { label: 'suit' });
  try {
    const r0 = await anthropicRequest(body, apiKey, opts);
    if (r0 && r0.stop_reason === 'max_tokens') logDepthOutcome({ depth: 'detailed', maxTokens: needOut }, r0, 'fleet'); // suit clip = "needs more" signal
    return continueClipped(r0, async (cont, round) => {
      const raised = Math.min(needOut * (round + 1), CLIP_HARD_CAP);
      if (!budgetOk(model, 0, raised)) return null;
      return anthropicRequest({ ...body, max_tokens: raised, tools: undefined, messages: [...body.messages, ...cont] }, apiKey, opts); // tool-less continuation
    });
  } finally {
    admission.release(model, needIn, needOut);
  }
}

// Deps injected into persistent sub-agents (#20) and every fleet system: the (paced) scoped model
// call, the full tool registry (sub-agents filter it to their allowlist), executeTool, the key,
// and the model ids. onStep surfaces the VANGUARD codename for the suit.
function subagentDeps() {
  return {
    anthropicRequest: pacedSubagentRequest, executeTool, toolDefs: TOOLS, apiKey: getApiKey(),
    models: { sonnet: MODEL_SONNET, haiku: MODEL_HAIKU },
    onStep: (name, tool) => sendToActivity('tool-update', { type: 'thinking', text: `🤝 ${vanguard.codename(name)} → ${tool}` }),
  };
}

// Lean summary model call for project memory (#24) — minimal system so it's cheap.
const projectSummarize = async (prompt) => {
  const j = await anthropicRequest({ model: MODEL_HAIKU, max_tokens: 400, system: 'You write tight, factual project summaries.', messages: [{ role: 'user', content: prompt }] }, getApiKey());
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
};

// edit_file (Phase 1, Deliverable #1) — surgical single-string patch. Safety posture: the file must
// already exist + be readable; old_string must match exactly (unique unless replace_all); a 0/>1
// match is a FAILED patch that changes nothing; the write is atomic (temp file + rename on the same
// filesystem) so a crash mid-write can never leave a half-written file. NOT in PARALLEL_SAFE — two
// concurrent edits to the same file would race. Returns a compact diff preview.
function editFileDiff(oldStr, newStr) {
  const minus = String(oldStr).split('\n').map((l) => '- ' + l);
  const plus = String(newStr).split('\n').map((l) => '+ ' + l);
  return [...minus, ...plus].join('\n').slice(0, 2000);
}
function applyEdit(input) {
  const fp = input && input.path;
  const oldStr = input && input.old_string;
  const newStr = input && input.new_string;
  if (!fp) return { success: false, error: 'path required' };
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') return { success: false, error: 'old_string and new_string must both be strings' };
  if (oldStr === newStr) return { success: false, error: 'old_string and new_string are identical — nothing to change' };
  if (oldStr === '') return { success: false, error: 'old_string is empty — use write_file to create/replace a file' };
  let orig;
  try { orig = fs.readFileSync(fp, 'utf8'); }
  catch (e) { return { success: false, error: `cannot read ${fp}: ${e.message}. Use write_file to create a new file.` }; }
  const count = orig.split(oldStr).length - 1;
  if (count === 0) return { success: false, error: 'old_string not found — file unchanged. Read the file and match exactly, including whitespace/indentation.' };
  if (count > 1 && !input.replace_all) return { success: false, error: `old_string matches ${count} times — not unique. Add surrounding context to disambiguate, or pass replace_all:true.` };
  const updated = input.replace_all ? orig.split(oldStr).join(newStr) : orig.replace(oldStr, newStr);
  const tmp = `${fp}.bbtmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, updated);
    fs.renameSync(tmp, fp);                                   // atomic replace; orig untouched until this point
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    return { success: false, error: `write failed (file left unchanged): ${e.message}` };
  }
  return { success: true, path: fp, replacements: input.replace_all ? count : 1, diff: editFileDiff(oldStr, newStr) };
}

async function executeTool(name, input) {
  let result;
  const __auditT0 = Date.now();
  // Resolve CRED_REF_* handles to real secrets just before the tool runs. The audit log
  // (below) records `input` with the handles intact, never the decrypted secret.
  const auditInput = input;
  if (credentials.hasRef(input)) { try { input = credentials.resolveRefs(input); } catch {} }
  // W3 — key-risk gate. Classify the tool and route high-risk tiers through the confirm machinery
  // BEFORE running. 'auto' falls straight through (run_shell included — its inner command-level gate
  // is stronger). 'confirm' honours autonomousMode locally + the remote guard; 'stepup' forces a
  // human even under autonomy. Decline → a clean tool_result error (still audited below).
  const __tier = riskOf(name, input, isRemote() ? 'remote' : 'desktop');
  if (__tier === 'confirm' || __tier === 'stepup') {
    const label = name + (input && input.path ? ` ${input.path}` : input && input.action ? ` (${input.action})` : '');
    const approved = await requestConfirm(label, `${name} — ${__tier === 'stepup' ? 'high-risk (code/secret), human required' : 'mutating action'}`, { forceHuman: __tier === 'stepup', remoteOk: __tier === 'confirm' });
    if (!approved) {
      const result = { success: false, error: `Declined by ${__tier} gate: ${name}.` };
      auditLog(name, auditInput, result, Date.now() - __auditT0, _lastUsage);
      return result;
    }
  }
  const maxAttempts = isRetryableTool(name, input) ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
      case 'edit_file':
        result = applyEdit(input); break;
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
      case 'make_printable':
        result = await makePrintable(input); break;
      case 'notify_user':
        result = await notifyUser(input.message, input.urgency || 'low', { awaitReply: !!input.awaitReply, taskId: input.taskId }); break;
      case 'keychain_lookup':
        result = keychainLookup(input); break;
      case 'onepassword_lookup':
        result = onePasswordLookup(input); break;
      case 'generate_totp':
        result = generateTotp(input); break;
      case 'make_figure': {
        const py = resolvePython();
        if (input.action === 'analyze') result = figures.analyze({ data: input.data, pythonBin: py });
        else if (input.action === 'oneshot' || input.action === 'auto') {
          result = figures.oneShot({ data: input.data, goal: input.goal, n: input.n, formats: input.formats, pythonBin: py });
          // Mirror the working recipe to the shared Notion bank (fire-and-forget) so it's durable
          // and visible to every agent — the "Notion recipe cache" surface.
          if (result && result.success && !result.recipeHit && notion.isConfigured()) {
            const kinds = (result.specs || []).map((s) => s.kind).join(', ');
            const cols = (result.figures && result.figures[0] && result.figures[0].spec) ? Object.values(result.figures[0].spec).filter(Boolean).join('/') : '';
            notion.appendMemory({ fact: `Figure recipe [${result.signature}]: ${kinds} for ${input.goal || 'data'} (${cols})`, tags: ['figure-recipe'], source: 'tool', confidence: 0.7 }).catch(() => {});
          }
        }
        else result = figures.render({ data: input.data, spec: input.spec, code: input.code, formats: input.formats, filename: input.filename, pythonBin: py });
        break;
      }
      case 'simulate': {
        if ((input.action || 'run') === 'capabilities') result = simulate.capabilities();
        else result = await simulate.run({ code: input.code, timeoutMs: input.timeoutMs });
        break;
      }
      case 'math_reason': {
        const m = input.model && /sonnet|haiku|opus/.test(input.model) ? 'anthropic/' + input.model : input.model;
        result = await simulate.mathReason({ task: input.task || input.problem, model: m, maxSteps: input.maxSteps, apiKey: getApiKey(), timeoutMs: input.timeoutMs });
        break;
      }
      case 'molecule': {
        if ((input.action || 'view') === 'render') {
          const out = path.join(MOL_DIR, `render-${Date.now()}.png`);
          try {
            const png = await molecule.renderStill(input, out);
            const b64 = fs.readFileSync(png).toString('base64');
            result = { success: true, path: png, _image: b64, _imageMime: 'image/png', message: `PyMOL ray-traced still → ${png}` };
          } catch (e) { result = { success: false, error: e.message }; }
        } else {
          try {
            const payload = await molecule.prepare(input);
            openMoleculeWindow(payload);
            const p = payload.props;
            const propStr = p ? ` — ${p.formula}, MW ${p.mw}, logP ${p.logp}, HBD ${p.hbd}, HBA ${p.hba}, TPSA ${p.tpsa}` : '';
            result = { success: true, kind: payload.kind, label: payload.label, source: payload.source, props: p || undefined, resolvedSmiles: payload.resolvedSmiles,
              message: `Opened ${payload.kind === 'protein' ? 'protein' : 'molecule'} ${payload.label} in the 3D viewer (${payload.style} style)${propStr}.` };
          } catch (e) { result = { success: false, error: e.message }; }
        }
        break;
      }
      case 'predict_function': {
        try {
          const show = input.show_structure !== false;
          const a = await protfunc.analyze({ sequence: input.sequence, uniprotId: input.uniprot_id || '', taxon: input.taxon || 'auto', withStructure: show });
          // Open the saliency-colored structure if we got one.
          let viz = null;
          const sal = a.saliency;
          if (show && sal && sal.pdb) {
            const kind = sal.coloring || 'plddt'; // 'saliency' (importance) | 'plddt' (confidence)
            openMoleculeWindow({
              format: 'pdb', data: sal.pdb, kind: 'protein',
              label: (input.uniprot_id ? input.uniprot_id.toUpperCase() : 'protein') + ` (${a.length} aa)`,
              source: 'FABLE · ' + sal.source, colorBy: 'bfactor', bfactorKind: kind, style: 'saliency',
              functions: { predictions: a.predictions, organism: a.organism, taxonApplied: a.taxonApplied, warning: a.warning },
            });
            viz = { source: sal.source, kind };
          }
          const top = a.predictions.slice(0, 8).map((p) => `${p.name} (${Math.round(p.prob * 100)}%)`);
          const lines = [
            `FABLE predicted function${a.organism ? ' — ' + a.organism : ''} (${a.length} aa):`,
            ...(top.length ? top.map((t, i) => `  ${i + 1}. ${t}`) : ['  (no terms above threshold)']),
          ];
          if (viz) lines.push(`Opened the structure (${viz.source}) in the 3D viewer, colored by ${viz.kind === 'saliency' ? 'per-residue importance' : 'pLDDT confidence (saliency was flat)'}.`);
          else if (show) lines.push('(structure unavailable — give a uniprot_id for the AlphaFold model)');
          if (a.warning) lines.push(`⚠ ${a.warning}`);
          result = { success: true, length: a.length, organism: a.organism, predictions: a.predictions.slice(0, 12),
            warning: a.warning || undefined, structure: viz || undefined, message: lines.join('\n') };
        } catch (e) { result = { success: false, error: e.message }; }
        break;
      }
      case 'maps': {
        try {
          const payload = await maps.prepare(input);
          // Snapshot the rendered map so it shows inline (chat/phone) — the interactive window opens too.
          const snap = await openMapsWindowSnapshot(payload);
          console.log('[maps] snapshot', snap ? Math.round(snap.length / 1024) + 'KB jpeg' : 'none (window-only)', '| backend:', payload.googleKey ? ('google' + (payload.mapId ? ' vector(' + payload.mapId + ')' : '')) : 'leaflet/osm');
          const img = snap ? { _image: snap, _imageMime: 'image/jpeg' } : {};
          if (payload.kind === 'route') {
            result = { success: true, kind: 'route', distance_km: payload.distance_km, duration_min: payload.duration_min, mode: payload.mode, ...img,
              message: `Directions ${payload.from.label.split(',')[0]} → ${payload.to.label.split(',')[0]}: ${payload.distance_km} km, about ${payload.duration_min} min by ${payload.mode}. Map open.` };
          } else {
            result = { success: true, kind: 'point', label: payload.label, source: payload.source, ...img,
              message: `Showing ${payload.label} on the map.` };
          }
        } catch (e) { result = { success: false, error: e.message }; }
        break;
      }
      case 'request_permissions': {
        const p = await ensurePermissions({ openSettings: true, force: true });
        let primed = [];
        try { primed = primeAppAutomation(true) || []; } catch {}   // re-surface Automation prompts for all driven apps
        result = { success: true, screenRecording: p.screen, accessibility: p.accessibility, allGranted: p.ok, automationApps: primed,
          note: (p.ok ? 'Screen + Accessibility granted. ' : 'Opened System Settings → Privacy; toggle BhatBot on for the missing ones. ') + `Also requested Automation for ${primed.join(', ') || 'the connected apps'} — approve each prompt as it appears (and check System Settings → Privacy & Security → Automation).` };
        break;
      }
      case 'manage_schedule': {
        const act = input.action || 'list';
        if (act === 'list') result = { success: true, schedules: scheduler.list().map((s) => ({ id: s.id, title: s.title, kind: s.kind, at: s.at, everyMs: s.everyMs, runAt: s.runAt, nextRun: s.nextRun ? new Date(s.nextRun).toISOString() : null, enabled: s.enabled, lastRun: s.lastRun })) };
        else if (act === 'remove') result = scheduler.remove(input.id);
        else if (act === 'enable') result = scheduler.setEnabled(input.id, true);
        else if (act === 'disable') result = scheduler.setEnabled(input.id, false);
        else if (act === 'run') {
          const s = scheduler.list().find((x) => x.id === input.id);
          if (!s) result = { error: 'no schedule with id ' + input.id };
          else { runScheduledTask(s); result = { success: true, started: s.id }; }
        } else if (act === 'add') {
          const p = { ...input };
          // Convenience: "in N minutes/hours" → a one-off runAt; everyMinutes/everyHours → interval.
          if (input.inMinutes != null) { p.kind = 'once'; p.runAt = new Date(Date.now() + Number(input.inMinutes) * 60000).toISOString(); }
          else if (input.inHours != null) { p.kind = 'once'; p.runAt = new Date(Date.now() + Number(input.inHours) * 3600000).toISOString(); }
          if (input.everyMinutes != null) { p.kind = 'interval'; p.everyMs = Number(input.everyMinutes) * 60000; }
          else if (input.everyHours != null) { p.kind = 'interval'; p.everyMs = Number(input.everyHours) * 3600000; }
          result = scheduler.add(p);
          if (result.success) startScheduler();   // ensure the tick loop is live
        } else result = { error: 'unknown action: ' + act };
        break;
      }
      case 'smart_login':
        result = await smartLogin(input); break;
      case 'manage_logins': {
        try {
          if (input.action === 'list') result = { success: true, logins: logins.list() };
          else if (input.action === 'get') result = { success: true, profile: logins.get(input.host || input.url) || null };
          else if (input.action === 'delete') result = { success: logins.remove(input.host || input.url), removed: input.host };
          else if (input.action === 'set') {
            // Use auditInput for the secret fields: executeTool already replaced any CRED_REF_*
            // in `input` with the real secret — we must persist the HANDLE, not the plaintext.
            const saved = logins.set({ ...input, credRef: auditInput.credRef, totpRef: auditInput.totpRef });
            // Mirror to the shared Notion bank (best-effort) so other agents/surfaces know the site is set up.
            try { notion.appendMemory({ fact: `Login profile saved for ${saved.host} (user ${saved.username || '—'}, 2FA ${saved.twoFactor})`, tags: ['login', saved.host], source: 'agent', confidence: 0.9 }); } catch {}
            result = { success: true, profile: { host: saved.host, username: saved.username, url: saved.url, twoFactor: saved.twoFactor, hasPassword: !!saved.credRef, hasTotp: !!saved.totpRef } };
          } else result = { success: false, error: 'unknown action' };
        } catch (e) { result = { success: false, error: e.message }; }
        break;
      }
      case 'notion_write':
        result = await notion.appendMemory(input); break;
      case 'notion_search': {
        const hits = await notion.searchMemory(input.query, { limit: input.limit || 5 });
        result = Array.isArray(hits)
          ? { success: true, results: hits, formatted: hits.length ? hits.map((h) => `• ${h.fact}${h.tags ? ` [${h.tags}]` : ''}${h.date ? ` (${h.date})` : ''}`).join('\n') : 'No matches in Notion memory.' }
          : hits;   // {skipped} or {error}
        break;
      }
      case 'notion_log_activity':
        result = await notion.logActivity(input); break;
      case 'media_control':
        result = await mediaControl(input); break;
      case 'system_control':
        result = await systemControl(input); break;
      case 'delegate_project':
        result = await delegateProject(input); break;
      case 'manage_jobs':
        result = manageJobs(input); break;
      case 'browser_workflow':
        result = await browserWorkflow(input); break;
      case 'browser_observe':
        result = await browserObserve(input); break;
      case 'self_improve':
        result = await selfImproveScan(input || {}); break;
      case 'project': {
        const a = input.action;
        const slugOf = () => (input.name ? projects.slugify(input.name) : projects.activeSlug());
        if (a === 'open') {
          const rec = projects.open(input.name || 'Project');
          if (!rec) { result = { success: false, error: 'Could not open project.' }; break; }
          try { notion.updateProjectState({ projectName: rec.name, status: rec.status, facts: (rec.highlights || []).slice(-5) }); } catch {}
          result = { success: true, slug: rec.slug, name: rec.name, status: rec.status, summary: rec.summary || '(new project)', result: `Opened project "${rec.name}". I'll keep a running summary of it.` };
          break;
        }
        if (a === 'list') { result = { success: true, projects: projects.list() }; break; }
        if (a === 'status') { const r = projects.active(); result = r ? { success: true, name: r.name, slug: r.slug, status: r.status, summary: r.summary, highlights: (r.highlights || []).slice(-5) } : { success: true, active: null, result: 'No active project.' }; break; }
        if (a === 'note') { const slug = slugOf(); if (!slug) { result = { success: false, error: 'No active project — open one first.' }; break; } projects.note(slug, input.text || '', input.kind || 'note'); result = { success: true, result: 'Noted.' }; break; }
        if (a === 'summary') {
          const slug = slugOf(); if (!slug) { result = { success: false, error: 'No active project — open one first.' }; break; }
          const summary = await projects.updateSummary(slug, { summarize: projectSummarize });
          try { const r = projects.get(slug); notion.updateProjectState({ projectName: r.name, status: 'active', facts: [summary] }); } catch {}
          result = { success: true, summary }; break;
        }
        if (a === 'close') { const slug = slugOf(); if (!slug) { result = { success: false, error: 'No project to close.' }; break; } projects.close(slug); result = { success: true, closed: slug, result: 'Project closed.' }; break; }
        result = { success: false, error: 'unknown project action: ' + a };
        break;
      }
      case 'ambient': {
        const a = input.action;
        if (a === 'status') { result = { success: true, ...ambient.sources() }; break; }
        if (a === 'scan') { const r = await ambient.scan(); result = { success: !r.error, ...r, digest: ambient.digest(r.signals || []) }; break; }
        if (a === 'read' || a === 'peek') { const r = await ambient.scanSource(input.source || 'mail', { hours: Number(input.hours) || 0 }); result = { success: !r.error, ...r }; break; }
        if (a === 'enable' || a === 'disable') {
          const cur = loadConfig().ambient || {};
          const next = { ...cur, enabled: a === 'enable' };
          if (input.source) next.sources = { ...(cur.sources || {}), [input.source]: a === 'enable' };
          saveConfig({ ambient: next });
          if (a === 'enable') startAmbient(); else if (_ambientTimer) { clearInterval(_ambientTimer); _ambientTimer = null; }
          result = { success: true, ambient: next, result: `Ambient awareness ${a}d${input.source ? ' for ' + input.source : ''}.` };
          break;
        }
        result = { success: false, error: 'unknown ambient action: ' + a };
        break;
      }
      case 'subagent': {
        const act = input.action || 'list';
        if (act === 'list') { result = { success: true, agents: subagents.list() }; break; }
        if (act === 'history') { result = { success: true, agent: input.agent, history: subagents.history(input.agent || '') }; break; }
        if (act === 'reset') { result = subagents.reset(input.agent || ''); break; }
        if (act === 'run') {
          if (!input.agent || !input.task) { result = { success: false, error: 'agent and task required' }; break; }
          if (input.background) {
            sendToActivity('tool-update', { type: 'thinking', text: `🤝 ${input.agent} sub-agent started (parallel): ${String(input.task).slice(0, 80)}` });
            subagents.run(input.agent, input.task, subagentDeps(), { maxSteps: input.maxSteps })
              .then((r) => { const msg = `🤝 ${input.agent} done: ${String(r.result || r.error || '').slice(0, 300)}`; sendToActivity('tool-update', { type: 'thinking', text: msg }); try { telegramNotify(msg); } catch {} })
              .catch((e) => sendToActivity('tool-update', { type: 'thinking', text: `🤝 ${input.agent} failed: ${e.message}` }));
            result = { success: true, started: input.agent, background: true, result: `${input.agent} sub-agent is working in the background — I'll report when it finishes.` };
            break;
          }
          result = await subagents.run(input.agent, input.task, subagentDeps(), { maxSteps: input.maxSteps });
          break;
        }
        if (act === 'handoff') {   // W7 — standardized A2A envelope around a sub-agent dispatch
          if (!input.agent || !input.task) { result = { success: false, error: 'agent and task required' }; break; }
          const env = a2a.makeEnvelope({ from: input.from || 'main', to: input.agent, task: input.task, context: input.context, artifacts: input.artifacts });
          const localAgents = subagents.list().map((a) => a.name);
          const done = await a2a.handoff(env, {
            localAgents,
            run: (to, taskStr, opts) => subagents.run(to, taskStr, subagentDeps(), opts),
            opts: { maxSteps: input.maxSteps },
            onStatus: (e) => sendToActivity('tool-update', { type: 'thinking', text: `🛰 A2A ${e.from}→${e.to}: ${e.status}` }),
          });
          result = { success: done.status === 'completed', envelopeId: done.id, status: done.status, result: done.result, error: done.status === 'failed' ? (done.history.slice(-1)[0] || {}).note : undefined };
          break;
        }
        if (act === 'a2a_log') { result = { success: true, handoffs: a2a.recent(input.n || 20) }; break; }
        result = { success: false, error: 'unknown subagent action: ' + act };
        break;
      }
      case 'agent_team': {
        const act = input.action;
        if (act === 'ensemble') {
          if (!input.task) { result = { success: false, error: 'task required' }; break; }
          const roles = (input.roles && input.roles.length ? input.roles.map((r) => r.name) : ['implementer', 'skeptic', 'synthesizer']);
          fleetSeed(roles.map((r) => ({ id: r, role: r, task: input.task })));   // live in the Vanguard panel
          sendToActivity('tool-update', { type: 'thinking', text: `👥 ensemble (parallel: ${roles.join(', ')}): ${String(input.task).slice(0, 80)}` });
          result = await agentTeam.ensemble(input.task, subagentDeps(), { roles: input.roles, maxSteps: input.maxSteps, onUpdate: (u) => fleetBroadcast(u) });
          fleetDone();
          break;
        }
        if (act === 'test_app') {
          if (!input.target) { result = { success: false, error: 'target (url or app name) required' }; break; }
          fleetSeed([{ id: 'tester', role: 'tester', task: 'test ' + input.target }]);
          sendToActivity('tool-update', { type: 'thinking', text: `🧪 independent tester → ${String(input.target).slice(0, 80)}` });
          result = await agentTeam.testApp(input.target, input.goal, subagentDeps(), { maxSteps: input.maxSteps, onUpdate: (u) => fleetBroadcast(u) });
          fleetDone();
          break;
        }
        result = { success: false, error: 'unknown agent_team action: ' + act + ' (use ensemble | test_app)' };
        break;
      }
      case 'fleet': {
        const tasks = input.tasks;
        if (!Array.isArray(tasks) || !tasks.length) { result = { success: false, error: 'tasks: array of {role, task} required' }; break; }
        const norm = tasks.slice(0, fleetWidth()).map((t, i) => ({ id: 'suit-' + (i + 1), role: t.role || ('suit-' + (i + 1)), task: t.task, tools: Array.isArray(t.tools) ? t.tools : undefined }));
        fleetAgents.clear();
        norm.forEach((t) => fleetAgents.set(t.id, { id: t.id, role: t.role, codename: vanguard.codename(t.role), task: t.task, status: 'queued', step: '', text: '', feedback: [] }));
        // Launch the Vanguard panel + seed the cards, then run all suits in parallel with live relay.
        try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.webContents.send('fleet-update', { phase: 'start', agents: norm.map((t) => ({ id: t.id, role: t.role, codename: vanguard.codename(t.role), task: t.task })) }); mainWindow.webContents.send('show-panel', 'vanguard'); } } catch {}
        sendToActivity('tool-update', { type: 'thinking', text: `🦾 VANGUARD: ${norm.length} suits launched (${norm.map((t) => vanguard.codename(t.role)).join(', ')})` });
        result = await agentTeam.fleet(norm, subagentDeps(), {
          maxSteps: input.maxSteps,
          maxParallel: fleetWidth(),                 // Phase 1 — budget-driven upper bound (admission paces the rest)
          onUpdate: (p) => fleetBroadcast(p),
          drainFeedback: (id) => fleetDrainFeedback(id),
          shouldStop: (id) => fleetShouldStop(id),
        });
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fleet-update', { phase: 'done' }); } catch {}
        break;
      }
      case 'plan_and_run': {
        if (!input.goal) { result = { success: false, error: 'goal required' }; break; }
        const p = await planner.plan(input.goal, { anthropicRequest, apiKey: getApiKey(), models: { sonnet: MODEL_SONNET } },
          { maxSteps: input.maxSteps, maxParallel: input.maxParallel || fleetWidth() });   // Phase 1 — live budget-driven width
        if (input.dryRun) { result = { success: true, dryRun: true, plan: { steps: p.steps, rationale: p.rationale, layers: p.layers.map((l) => l.map((s) => s.id)) } }; break; }
        // Skeptic PRE-FLIGHT: review the plan before committing agents to it; adopt a corrected plan
        // if the skeptic returns one, and surface any warnings.
        if (!p.fallback && p.steps.length > 1 && input.critique !== false) {
          try {
            const crit = await planner.critique(input.goal, p.steps, { anthropicRequest, apiKey: getApiKey(), models: { sonnet: MODEL_SONNET } });
            if (crit.warnings && crit.warnings.length) sendToActivity('tool-update', { type: 'thinking', text: '🧐 plan review: ' + crit.warnings.join(' · ') });
            if (crit.revisedSteps && crit.revisedSteps.length) { p.steps = crit.revisedSteps; p.layers = planner.layers(crit.revisedSteps); sendToActivity('tool-update', { type: 'thinking', text: '🧐 adopted a revised plan from the skeptic' }); }
          } catch {}
        }
        // Seed the Vanguard panel with ALL steps, then run layer-by-layer (parallel within a layer),
        // feeding each step the results of the upstream steps it depends on.
        fleetAgents.clear();
        p.steps.forEach((s) => fleetAgents.set(s.id, { id: s.id, role: s.role, codename: vanguard.codename(s.role), task: s.task, status: 'queued', step: '', text: '', feedback: [] }));
        try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.webContents.send('fleet-update', { phase: 'start', agents: p.steps.map((s) => ({ id: s.id, role: s.role, codename: vanguard.codename(s.role), task: s.task })) }); mainWindow.webContents.send('show-panel', 'vanguard'); } } catch {}
        sendToActivity('tool-update', { type: 'thinking', text: `🧠 plan: ${p.steps.length} steps in ${p.layers.length} layer(s)${p.fallback ? ' (fallback)' : ''}` });
        const doneResults = {};
        const plDeps = { anthropicRequest, apiKey: getApiKey(), models: { sonnet: MODEL_SONNET } };
        const MAX_FIX = 2;   // autonomous self-fix attempts per failed step before escalating to Siddhant
        for (const layer of p.layers) {
          const upstream = (s) => s.dependsOn.length ? '\n\nUpstream results you build on:\n' + s.dependsOn.map((d) => `[${d}] ${String(doneResults[d] || '(none)').slice(0, 1500)}`).join('\n\n') : '';
          const tasks = layer.map((s) => ({ id: s.id, role: s.role, tools: s.tools, task: s.task + upstream(s) }));
          const layerOut = await agentTeam.fleet(tasks, subagentDeps(), {
            maxSteps: input.suitSteps,
            onUpdate: (u) => fleetBroadcast(u),
            drainFeedback: (id) => fleetDrainFeedback(id),
            shouldStop: (id) => fleetShouldStop(id),
          });
          // AUTONOMOUS RECOVERY: a hard-failed step gets diagnosed + retried by BhatBot itself —
          // alerting Siddhant on SERIOUS issues but continuing to fix without waiting for him; only
          // escalating ("needs your input") after MAX_FIX attempts are exhausted.
          // Soft-failure verify: a step that "finished" but didn't really satisfy its task is flagged
          // as an error so the same self-heal loop recovers it (catches hallucinated "done").
          const verifyIfOn = async (a, s) => {
            if (a.error || input.verify === false) return a;
            const v = await planner.verifyStep({ task: s.task }, a.result, plDeps);
            if (!v.ok) { fleetBroadcast({ id: s.id, role: s.role, status: 'working', note: '✗ verify: ' + v.reason }); return { ...a, error: true, result: 'verification failed: ' + v.reason + ' | output: ' + String(a.result || '').slice(0, 500) }; }
            return a;
          };
          for (let i = 0; i < layer.length; i++) {
            const s = layer[i];
            let a = await verifyIfOn((layerOut.agents || []).find((x) => x.id === s.id) || {}, s);
            let attempt = 0;
            while (a.error && !fleetShouldStop(s.id) && attempt < MAX_FIX) {
              attempt++;
              const diag = await planner.diagnose({ task: s.task }, a.result, plDeps);
              if (diag.severity === 'serious') {
                const msg = `⚠ Agent "${s.role}" hit a serious issue (${diag.reason}). Self-fixing — attempt ${attempt}/${MAX_FIX}; I'll keep working on it.`;
                sendToActivity('tool-update', { type: 'thinking', text: msg }); try { telegramNotify(msg); } catch {} try { speakDesktop(`Heads up, sir. ${s.role} hit a serious snag — I'm on it.`); } catch {}
              }
              fleetBroadcast({ id: s.id, role: s.role, status: 'working', note: (diag.severity === 'serious' ? '⚠ ' : '↻ ') + 'self-fix: ' + diag.reason });
              const fixOut = await agentTeam.fleet([{ id: s.id, role: s.role, tools: s.tools, task: diag.fix + upstream(s) }], subagentDeps(), {
                onUpdate: (u) => fleetBroadcast(u), drainFeedback: (id) => fleetDrainFeedback(id), shouldStop: (id) => fleetShouldStop(id),
              });
              a = await verifyIfOn((fixOut.agents || [])[0] || a, s);   // re-verify the fixed result too
            }
            if (a.error) {
              const msg = `⚠ Agent "${s.role}" is still failing after ${MAX_FIX} self-fix attempts — needs your input.`;
              sendToActivity('tool-update', { type: 'thinking', text: msg }); try { telegramNotify(msg); } catch {} try { speakDesktop(`Sir, ${s.role} is stuck after a couple of fixes — I could use your input.`); } catch {}
              fleetBroadcast({ id: s.id, role: s.role, status: 'failed', note: msg });
            }
            doneResults[s.id] = a.result;
          }
        }
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fleet-update', { phase: 'done' }); } catch {}
        result = { success: true, mode: 'plan_and_run', goal: input.goal, rationale: p.rationale, steps: p.steps.map((s) => ({ id: s.id, role: s.role, result: doneResults[s.id] })) };
        break;
      }
      case 'screen_observe':
        result = await screenObserve(input); break;
      case 'play_chess': {
        if (input.variant === 'atomic' || input.variant === 'standard') {
          result = openChessApplet(input.variant);
          if (result && result.success) result.result = `${input.variant === 'atomic' ? 'Atomic' : 'Standard'} chess applet is open — full legal-move enforcement${input.variant === 'atomic' ? ' with exploding captures' : ''}. Make your move.`;
        } else {
          result = openChessWindow(input.difficulty);
          if (result && result.success) result.result = `Chess board is open${input.difficulty ? ` (${input.difficulty})` : ''} — make your move.`;
        }
        break;
      }
      case 'save_memory':
        if (input.action === 'query') {   // W4 — multi-hop graph lookup over saved entities/relations
          const gq = graph.query(input.content || input.query || '', { depth: input.depth || 2, limit: 24 });
          result = { success: true, relations: gq.hits, seeds: gq.seeds, ...graph.stats() };
          break;
        }
        result = saveMemoryEntry(input.section, input.content); break;
      case 'plugin': {   // W6 — sandboxed execution of user/community plugin tools
        const plugins = Array.isArray(loadConfig().plugins) ? loadConfig().plugins : [];
        if ((input.action || 'list') === 'list') {
          result = { success: true, plugins: plugins.map((p) => ({ name: p.name, description: p.description || '', allow: p.allow || [] })) };
          break;
        }
        const p = plugins.find((x) => x && x.name === input.name);
        if (!p) { result = { success: false, error: `no plugin named "${input.name}". Define it in config.plugins.` }; break; }
        const r = await sandbox.runPlugin(p, input.input || {});
        result = r.success ? { success: true, result: r.result } : { success: false, error: r.error };
        break;
      }
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
      case 'screen_parse': {
        // Wattage gate: the semantics:true caption pass loads a heavy ML model (~60s, hot GPU).
        // On battery (power-saver on) force it off — detection still works, just no icon captions.
        let spIn = input;
        if (input.semantics && shouldSpareWatts()) {
          spIn = { ...input, semantics: false };
          sendToActivity('tool-update', { type: 'thinking', text: '🔋 on battery — skipping the slow icon-caption pass (semantics off) to save power' });
        }
        result = await screenParse(spIn); break;
      }
      case 'vision_click':
        result = await visionClick(input); break;
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
      case 'generate_image':
        result = await generateImage(input); break;
      case 'generate_3d': {
        result = await generate3D(input);
        break;
      }
      case 'world_cup':
        result = await worldCupTool(input || {}); break;
      case 'news': {
        const nr = await news.skim({ section: (input && input.section) || 'world', limit: Math.min(Number(input && input.limit) || 6, 15), apiKey: loadConfig().nytApiKey || process.env.NYT_API_KEY || '' });
        result = nr.error ? { success: false, error: nr.error } : { success: true, result: news.format(nr), items: nr.items };
        break;
      }
      case 'web_search': {
        const sr = await websearch.search({ query: input && input.query, limit: input && input.limit, config: loadConfig() });
        if (sr.ok) {
          if (sr.usd) recordToolCost('web_search', sr.usd);   // only the keyed providers cost anything; DDG is $0
          result = { success: true, result: websearch.format(sr), items: sr.items, provider: sr.provider };
        } else result = { success: false, error: sr.error };
        break;
      }
      case 'self_fix':
        result = await selfFix(input || {}); break;
      case 'self_heal': {
        const a = (input && input.action) || 'status';
        if (a === 'status') { result = { success: true, ...selfheal.status(loadConfig) }; break; }
        if (a === 'enable' || a === 'disable') {
          const cur = loadConfig().selfHeal || {};
          saveConfig({ selfHeal: { ...cur, enabled: a === 'enable' } });
          if (a === 'enable') startSelfHeal(); else stopSelfHeal();
          result = { success: true, result: `Autonomous self-healing ${a}d.`, ...selfheal.status(loadConfig) };
          break;
        }
        if (a === 'queue') {
          const q = selfheal.enqueue({ problem: input.problem, verify: input.verify, source: 'manual' }, loadConfig);
          result = { success: !q.skipped, ...q };
          break;
        }
        if (a === 'run') { result = { success: true, ...(await selfheal.tick(loadConfig, selfHealDeps())) }; break; }
        result = { success: false, error: 'unknown self_heal action: ' + a };
        break;
      }
      case 'self_reflect': {
        // PROACTIVE self-reflection: introspect → (scope filter) → reflect (Opus) → narrate. Surfaces
        // OPINIONS only; never triggers self_fix/self_improve. Pipeline degrades gracefully on sparse telemetry.
        const scope = (input && input.scope) || 'all';
        const depth = (input && input.depth) || 'full';
        const focus = (input && input.focus) || '';
        const toolNames = TOOLS.map((t) => t.name);
        let roleNames = []; try { roleNames = Object.keys(require('./lib/agents/roles').ROLES); } catch {}
        const portrait = introspect.buildSelfPortrait({ toolNames, roleNames, repoDir: __dirname });
        // scope → keep only that dimension (+ always history + gaps so continuity/honesty survive)
        const dimMap = { performance: 'performance', capability: 'capabilities', knowledge: 'knowledge', structural: 'structure' };
        let scoped = portrait;
        if (scope !== 'all' && dimMap[scope]) scoped = { generated_at: portrait.generated_at, [dimMap[scope]]: portrait[dimMap[scope]], history: portrait.history, _gaps: portrait._gaps };
        const rf = await reflect.reflect(scoped, { anthropicRequest, apiKey: getApiKey(), focus, scope });
        if (rf.error && !rf.desires.length) { result = { success: false, error: 'reflection failed: ' + rf.error, portrait_gaps: portrait._gaps }; break; }
        const drillish = /how (would|do|did) you|implement|build it|go deeper|more detail|walk me through/i.test(focus);
        let text;
        if (drillish) { let schematic = ''; try { schematic = fs.readFileSync(path.join(__dirname, 'BHATBOT_SCHEMATIC.md'), 'utf8'); } catch {} text = await narrate.drill(rf.desires, { focus, anthropicRequest, apiKey: getApiKey(), schematic }); }
        else text = narrate.render(rf.desires, { mode: depth === 'brief' ? 'top' : 'full' });
        result = { success: true, result: text, desires: rf.desires, scope };
        break;
      }
      default:
        result = { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    result = { success: false, error: String(e && e.message ? e.message : e) };
  }
    // Auto-retry once on a transient failure of an idempotent read (network blip, page race).
    if (result && result.success === false && attempt < maxAttempts && TRANSIENT_RE.test(String(result.error || ''))) {
      sendToActivity('tool-update', { type: 'thinking', text: `↻ ${name}: transient error, retrying…` });
      await sleep(500 * attempt);
      continue;
    }
    break;
  }
  // P0.4 — sanitize EXTERNAL content before it can enter model context. Internal tool
  // output (our own files, vault, notion) is trusted; web/shell/page text is not.
  try {
    if (result) {
      if (name === 'fetch_url' && typeof result.content === 'string') result.content = security.sanitizeExternalContent(result.content, 'web:' + String(input.url || '').slice(0, 80));
      else if (name === 'run_shell') {
        if (typeof result.stdout === 'string') result.stdout = security.sanitizeExternalContent(result.stdout, 'shell');
        if (typeof result.stderr === 'string') result.stderr = security.sanitizeExternalContent(result.stderr, 'shell');
      } else if (name === 'browser' && typeof result.text === 'string') result.text = security.sanitizeExternalContent(result.text, 'browser');
      else if (name === 'web_search' && typeof result.result === 'string') result.result = security.sanitizeExternalContent(result.result, 'web-search');
    }
  } catch {}
  auditLog(name, auditInput, result, Date.now() - __auditT0, _lastUsage);   // log handles + LLM-step telemetry, never resolved secrets
  return result;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------
function sendToAll(chatEvent, channel, data) {
  // chatEvent.sender is the chat renderer — which IS the main window during a desktop chat,
  // and the in-window Activity panel is that same renderer. So sending here is enough; do NOT
  // also route through sendToActivity()→mainWindow or every token/tool-row renders TWICE
  // (the "I'll create a I'll create a…" duplication bug). Only mirror to a legacy standalone
  // activity window if one is somehow open AND it isn't the same webContents we just sent to.
  const sender = chatEvent && chatEvent.sender;
  try { sender && sender.send(channel, data); } catch {}
  try {
    if (activityWindow && !activityWindow.isDestroyed() && activityWindow.webContents !== sender)
      activityWindow.webContents.send(channel, data);
  } catch {}
  pushActivity(channel, data);
}
function sendToActivity(channel, data) {
  // Direct callers (briefing, barge-in, studio/3D progress, MCP/Telegram tasks) — these are NOT
  // also routed via sendToAll, so a single send to the main renderer is correct (no double).
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data); } catch {}
  try { if (activityWindow && !activityWindow.isDestroyed()) activityWindow.webContents.send(channel, data); } catch {}
  pushActivity(channel, data);
}

// FLEET (VANGUARD) live registry — id → live card state; the renderer's Vanguard panel mirrors it,
// and per-agent feedback typed in that panel lands in each suit's queue (drained mid-run by runRole).
const fleetAgents = new Map();
const agentWindows = new Map();   // id → pop-out monitor BrowserWindow (Manus-style live screen)
// Phase 4 — shared FLEET LOG: a bounded ring of every agent's live activity, so BhatBot is the hub
// that (a) keeps cross-agent situational awareness in one place and (b) RELAYS each line to the cloud
// brain → other bots/surfaces (phone PWA, Telegram, sibling executors). recentFleetLog() exposes it.
const fleetLog = [];
function recentFleetLog(n = 20) { return fleetLog.slice(-n); }
function relayAgentLog(payload) {
  try {
    if (!payload || !payload.id) return;
    const line = payload.step || payload.text || payload.status || (payload.tool && ('→ ' + payload.tool)) || '';
    if (!line) return;
    const entry = { id: payload.id, role: payload.role || (fleetAgents.get(payload.id) || {}).role || '', codename: payload.codename, line: String(line).slice(0, 240), ts: Date.now() };
    fleetLog.push(entry); if (fleetLog.length > 200) fleetLog.shift();
    // relay to the cloud brain so other bots see what each agent is doing (fire-and-forget; no-op if offline)
    try { if (_cloudBridge && _cloudBridge.send) _cloudBridge.send({ type: 'agentlog', entry }); } catch {}
  } catch {}
}
function fleetBroadcast(payload) {
  if (payload && payload.id) {
    const cur = fleetAgents.get(payload.id) || { id: payload.id, feedback: [] };
    fleetAgents.set(payload.id, { ...cur, ...payload, feedback: cur.feedback || [], ts: Date.now() });
  }
  relayAgentLog(payload);   // hub: capture + relay each agent's log to the cloud → other bots
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fleet-update', payload); } catch {}
  // mirror to any open per-agent monitor windows (each filters to its own id)
  for (const [, w] of agentWindows) { try { if (w && !w.isDestroyed()) w.webContents.send('fleet-update', payload); } catch {} }
}
// Open a dedicated live-monitor window for one agent (its own "screen" — current step, rolling log,
// latest output, and any image the agent is looking at). Mirrors Manus/computer-use monitoring.
function openAgentWindow(id) {
  const asset = path.join(__dirname, 'assets', 'agentmon.html');
  if (!fs.existsSync(asset)) return { success: false, error: 'agentmon.html missing' };
  let w = agentWindows.get(id);
  if (w && !w.isDestroyed()) { w.show(); w.focus(); return { success: true }; }
  w = new BrowserWindow({
    width: 560, height: 680, resizable: true, minWidth: 360, minHeight: 360,
    title: 'Agent · ' + id, backgroundColor: '#0a0f17',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload-agentmon.js') },
  });
  w.loadFile(asset, { query: { id } });
  agentWindows.set(id, w);
  w.on('closed', () => agentWindows.delete(id));
  // push the current snapshot once loaded so a mid-run pop-out isn't blank
  w.webContents.once('did-finish-load', () => { const a = fleetAgents.get(id); if (a) { try { w.webContents.send('fleet-update', a); } catch {} } });
  return { success: true };
}
ipcMain.handle('open-agent-window', (_e, id) => openAgentWindow(id));
function fleetDrainFeedback(id) {
  const a = fleetAgents.get(id);
  if (!a || !a.feedback || !a.feedback.length) return [];
  return a.feedback.splice(0);
}
// Seed the Vanguard panel with a set of agents + surface it (used by fleet, plan_and_run, ensemble, test_app).
function fleetSeed(agents) {
  fleetAgents.clear();
  agents.forEach((a) => fleetAgents.set(a.id, { id: a.id, role: a.role, task: a.task, status: 'queued', step: '', text: '', feedback: [] }));
  try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.webContents.send('fleet-update', { phase: 'start', agents: agents.map((a) => ({ id: a.id, role: a.role, task: a.task })) }); mainWindow.webContents.send('show-panel', 'vanguard'); } } catch {}
}
function fleetDone() { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fleet-update', { phase: 'done' }); } catch {} }
ipcMain.handle('fleet-feedback', (_e, { id, text }) => {
  const a = fleetAgents.get(id);
  if (!a) return { ok: false, error: 'no such agent' };
  a.feedback = a.feedback || []; a.feedback.push(String(text || ''));
  fleetBroadcast({ id, role: a.role, status: a.status, note: '📨 feedback queued' });
  return { ok: true };
});
// BhatBot/Siddhant keep full control: stop a single agent mid-run (checked by runRole each step).
ipcMain.handle('fleet-control', (_e, { id, action }) => {
  const a = fleetAgents.get(id);
  if (!a) return { ok: false };
  if (action === 'stop') { a.stopped = true; fleetBroadcast({ id, role: a.role, status: 'stopping', note: '⏹ stopping…' }); }
  return { ok: true };
});
function fleetShouldStop(id) { const a = fleetAgents.get(id); return !!(a && a.stopped); }

// Activity ring buffer — mirrors tool/thinking events so the phone's Activity tab can poll
// them (the phone has no IPC). Both sendToActivity and the chat path (sendToAll) feed it.
// Activity ring + live state feed live in lib/runtime-state.js now (Phase 4 split). state.json
// (live snapshot) + events.jsonl (structured log) are the direct line to BhatBot's current state.
const pushActivity = rstate.pushActivity;
const getActivity = rstate.getActivity;

// Public funnel host (for Twilio webhooks + the phone's "open this URL"). Detected from
// Tailscale, cached in config.publicHost. Returns bare host (no scheme), or '' if unknown.
let _publicHost = null;
function getPublicHost() {
  if (_publicHost) return _publicHost;
  const c = loadConfig();
  if (c.publicHost) { _publicHost = String(c.publicHost).replace(/^https?:\/\//, '').replace(/\/+$/, ''); return _publicHost; }
  try {
    const out = require('child_process').execSync('tailscale status --json', { timeout: 4000 }).toString();
    const dns = (JSON.parse(out).Self || {}).DNSName || '';
    const host = dns.replace(/\.$/, '');
    if (host) { _publicHost = host; saveConfig({ publicHost: host }); return host; }
  } catch {}
  return '';
}

// ---------------------------------------------------------------------------
// Fast planning preamble. For a non-trivial action request, BhatBot quickly drafts a short
// plan, SPEAKS a one-line summary of it (read-out), shows the full checklist in the activity
// window, and then EXECUTES immediately — Siddhant can steer in real time via the guidance box
// (pendingGuidance, folded into each step) without ever having to approve first.
// ---------------------------------------------------------------------------
const PLAN_VERBS = /\b(open|launch|run|build|fix|create|make|find|search|deploy|write|send|set|update|install|delete|remove|download|generate|render|automate|sign ?in|log ?in|login|organi[sz]e|refactor|analy[sz]e|set up|configure|integrate|wire|implement|migrate|test|schedule|scrape|extract|summari[sz]e|plot|chart|figure)\b/i;
function needsPlan(text) {
  if (loadConfig().planPreamble === false) return false;
  const t = (text || '').trim();
  if (t.length < 35) return false;                                   // trivial / chit-chat
  if (/^\s*(what|why|who|when|where|which|how|is|are|can|could|do|does|did)\b/i.test(t) && t.length < 90) return false; // a plain question
  const verbs = (t.match(new RegExp(PLAN_VERBS.source, 'gi')) || []).length;
  const multi = /\b(and then|after that|then|next|also)\b/i.test(t) || /[;,].*\b\w+\b.*[;,]/.test(t) || verbs >= 2;
  return verbs >= 1 && (multi || t.length > 120);
}
function parseJsonLoose(s) { const m = String(s || '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
async function quickPlan(taskText, apiKey) {
  const system = `You are BhatBot's fast planner. Draft a SHORT execution plan for Siddhant's request.
Return ONLY JSON: {"steps":["<imperative action>", ...3-6 items],"spoken":"<=2 sentences, plain spoken English summarizing your approach — no markdown, no numbered list>"}
Steps = concrete actions/tools BhatBot will take, each under 12 words. No preamble, JSON only.`;
  try {
    const r = await anthropicRequest({ model: MODEL_HAIKU, max_tokens: 400,
      system: [{ type: 'text', text: system }],
      messages: [{ role: 'user', content: String(taskText || '').slice(0, 2000) }] }, apiKey, { retries: 1 });
    const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const j = parseJsonLoose(txt);
    if (!j || !Array.isArray(j.steps) || !j.steps.length) return null;
    return { steps: j.steps.slice(0, 6).map((s) => String(s).slice(0, 120)), spoken: String(j.spoken || '').slice(0, 320) };
  } catch { return null; }
}
function appendToLastUser(history, text) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;
    const c = history[i].content;
    if (typeof c === 'string') history[i] = { role: 'user', content: c + '\n\n' + text };
    else if (Array.isArray(c)) history[i] = { role: 'user', content: [...c, { type: 'text', text }] };
    return true;
  }
  return false;
}

async function agentLoop(history, apiKey, event, opts = {}) {
  agentState = 'running';
  _userSpokeSinceOpen = true;     // Feat-1: the user engaged → don't pop the idle briefing offer
  try { _lastUserText = lastUserText(history) || _lastUserText; } catch {}
  try { rstate.event('turn', { text: String(_lastUserText).slice(0, 160) }); } catch {}
  const _turnT0 = Date.now(); const _usd0 = costToday().usd;   // router telemetry (#13)
  pendingGuidance = [];          // fresh per task
  const usedGuidance = [];       // collected for the post-task "learn this?" prompt
  let iterations = 0;
  history = validateHistory(history);            // heal any corruption before it compounds
  history = await trimHistory(history, apiKey);

  // P4 — select the operating mode for this task: the local router's classification when
  // the pipeline escalated to us, else the zero-cost regex classifier on the task text.
  currentMode = opts.suggestedMode || modePrompts.classifyMode(lastUserText(history));
  sendToActivity('tool-update', { type: 'thinking', text: '🎛 mode: ' + currentMode });

  // Passive auto-recall from the shared Notion bank — fold relevant facts (written by the Mac,
  // the cloud backend, or any other agent) into the memory block before we answer. Bounded to 4s.
  await Promise.all([refreshNotionRecall(lastUserText(history)), refreshSemanticRecall(lastUserText(history)), refreshEpisodicVec(lastUserText(history))]);

  // W1 — context-rot prevention: inject only the tools relevant to THIS turn (top-k by embedding
  // similarity + a small always-present CORE set), computed ONCE here and reused across every
  // tool-loop step (never swap mid-loop). null ⇒ full catalog (no key / low confidence / disabled).
  _activeTools = null;
  if (loadConfig().toolRetrieval !== false) {
    try {
      const sel = await toolselect.select(lastUserText(history), TOOLS, { k: Number(loadConfig().toolRetrievalK) || 12 });
      if (sel && sel.tools && sel.tools.length) {
        _activeTools = sel.tools;
        sendToActivity('tool-update', { type: 'thinking', text: `🧰 tools: ${sel.tools.length}/${TOOLS.length} selected for this turn` });
        try { fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), toolSelect: sel.tools.length, of: TOOLS.length, names: sel.names }) + '\n'); } catch {}
      }
    } catch { /* retrieval is best-effort; fall back to full catalog */ }
  }

  // Streaming: emit text deltas to the renderer (live bubble) AND speak each finished
  // sentence as it lands. Only on the desktop chat path (opts.stream); MCP/Telegram stay
  // non-streaming so their headless senders are untouched.
  const stream = !!opts.stream;
  // The chat handler pre-opens the TTS stream (opts.ttsSeq) so the ack speaks at message
  // receipt, before history validation/trim — reuse it; only self-start on other entry points.
  const ttsSeq = stream ? (opts.ttsSeq != null ? opts.ttsSeq : ttsStreamStart()) : null;
  if (stream && ttsSeq != null && opts.ttsSeq == null) maybeAck(ttsSeq, lastUserText(history));   // instant verbal ack
  const speakParser = stream ? makeSpeakStream(ttsSeq) : null;
  // opts.onToken: a raw-delta sink (phone streaming) that captures the reply WITHOUT desktop TTS —
  // lets the Twilio path start speaking the first sentence before the full reply is generated.
  const capture = typeof opts.onToken === 'function' ? opts.onToken : null;
  // Display the tag-stripped tokens live; TTS hears only <speak>…</speak> (handled inside the parser).
  const onText = (stream || capture) ? (delta) => {
    latMark('first-token');
    const disp = speakParser ? speakParser.feed(delta) : delta;
    if (disp && stream) sendToAll(event, 'tool-update', { type: 'token', text: disp });
    if (capture) try { capture(delta); } catch {}
  } : undefined;

  // Fast plan + read-out (desktop voice path). Draft a quick plan, SPEAK a summary, show the
  // checklist, and inject it as execution context — then run without waiting for approval.
  // Siddhant steers live via the guidance box (folded into each step below).
  if (stream && !opts.suggestedMode && needsPlan(lastUserText(history))) {
    try {
      const plan = await quickPlan(lastUserText(history), apiKey);
      if (plan) {
        sendToAll(event, 'tool-update', { type: 'plan', steps: plan.steps, spoken: plan.spoken });
        sendToActivity('plan', { steps: plan.steps, spoken: plan.spoken });
        if (ttsSeq != null) ttsStreamFeed(ttsSeq, plan.spoken);   // read the plan aloud
        appendToLastUser(history, `[EXECUTION PLAN — you have ALREADY spoken this summary to Siddhant aloud; do NOT re-read or restate it. Execute these steps now, in order, and incorporate any "[Live guidance from Siddhant]" notes as they arrive. Keep spoken output to brief progress + the final result.]\n` + plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
      }
    } catch { /* planning is best-effort; never block execution */ }
  }

  // All exits go through here so live guidance can be offered for learning (2a).
  const finish = (text) => {
    agentState = 'idle';
    _activeTools = null;   // W1 — drop the per-turn tool subset so out-of-loop calls see the full catalog
    if (speakParser) speakParser.finish(); else if (ttsSeq != null) ttsStreamFlush(ttsSeq);
    if (usedGuidance.length) sendToActivity('learn_prompt', { text: usedGuidance.join(' | ') });
    // Strip any <speak> tags from the returned text (renderer shows this as the final bubble).
    reflectOnCorrection(history, lastUserText(history), text);   // async, non-blocking
    try { logRouterDecision({ taskType: _lastRouterTask || currentMode, model: _lastModel, ms: Date.now() - _turnT0, usd: +(costToday().usd - _usd0).toFixed(5) }); } catch {}   // #13
    const clean = stripReasoning(String(text || '')).replace(/<\/?speak>/g, '').trim();
    // #12 episodic memory is now recorded centrally in _dispatchTurnInner (covers fastReply +
    // pipeline-local too, which used to be dropped — starving the W5 fine-tune loop). Not here.
    // #24 project memory: if a project is open, record the turn + cheaply refresh its living summary.
    try { const slug = projects.activeSlug(); if (slug) { projects.recordTurn(slug, lastUserText(history), clean); projects.maybeAutoSummarize(slug, { summarize: projectSummarize }).catch(() => {}); } } catch {}
    return { text: clean, history, _streamed: stream };
  };

  // Step budget: headroom for complex tasks that diagnose + retry across several approaches.
  // Configurable (agentMaxSteps); never below the default so a stale low value can't throttle.
  const maxIters = Math.max(Number(loadConfig().agentMaxSteps) || 0, MAX_AGENT_ITERATIONS);
  while (iterations < maxIters) {
    if (agentState === 'stopped') return finish('⏹ Stopped.');
    while (agentState === 'paused') await sleep(300);

    history = evictOldImages(history, KEEP_IMAGES);
    history = validateHistory(history);   // heal any mid-loop tool_use/result corruption (interruptions) before each call
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

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    // Execute ONE tool end-to-end: emit start, run, emit done (+ inline visuals), return its
    // tool_result block. A thrown tool used to escape the loop, leaving the assistant tool_use with
    // NO matching tool_result → the next API call 400s. Always resolve to a result so pairing holds.
    const runOneTool = async (block) => {
      sendToAll(event, 'tool-update', { type: 'tool_start', name: block.name, input: block.input });
      let result;
      try { result = await executeTool(block.name, block.input); }
      catch (e) { result = { success: false, error: 'tool threw: ' + (e && e.message || String(e)) }; }
      // Jarvis HUD: surface visuals inline in chat — generated images / design renders /
      // explicit screenshots as holo-cards, and 3D outputs as an in-chat spinning model.
      const showImage = result._image && (['generate_image', 'make_figure', 'simulate', 'studio_write', 'ui_inspect', 'screen_parse', 'vision_click', 'molecule', 'maps'].includes(block.name)
        || (block.name === 'browser' && block.input && block.input.action === 'screenshot'));
      const model3d = (block.name === 'generate_3d' || block.name === 'make_printable') && result.success && result.path ? result.path : undefined;
      sendToAll(event, 'tool-update', {
        type: 'tool_done', name: block.name,
        result: { ...result, _image: undefined, _imageMime: undefined },
        preview: showImage ? { image: result._image, mime: result._imageMime || 'image/jpeg' } : undefined,
        model3d
      });
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
      return { type: 'tool_result', tool_use_id: block.id, content: trContent, is_error: result.success === false };
    };

    // TIER-2 THROUGHPUT: if the model fired several INDEPENDENT read-only tools this turn, run them
    // CONCURRENTLY (order preserved by map); otherwise keep the safe sequential path for anything
    // stateful/mutating. Results stay in tool_use order so pairing/validation is unaffected.
    let toolResults;
    if (toolUses.length > 1 && toolUses.every((b) => PARALLEL_SAFE.has(b.name))) {
      sendToAll(event, 'tool-update', { type: 'thinking', text: `⚡ running ${toolUses.length} reads in parallel` });
      toolResults = await Promise.all(toolUses.map(runOneTool));
    } else {
      toolResults = [];
      for (const block of toolUses) toolResults.push(await runOneTool(block));
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
  // Budget exhausted — don't dead-end. One final tool-less turn so the user gets a concrete
  // progress report + the next action instead of a bare "max iterations" stub.
  history = [...history, { role: 'user', content: '[You have reached the step budget for this turn. Do NOT call any more tools. In one or two short sentences (spoken) plus a brief on-screen list, tell me concretely: what you accomplished, what remains, and the single next action to finish it.]' }];
  try {
    const r = await callModel(history, apiKey, false, onText);
    history = [...history, { role: 'assistant', content: r.content }];
    const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return finish(text || '⚠ Reached the step budget for this turn — partial progress above.');
  } catch { return finish('⚠ Reached the step budget for this turn.'); }
}

// ===========================================================================
// MULTI-AGENT PIPELINE — local-first orchestration on Ollama (router → planner →
// executor → critic → delivery), escalating to the Claude agentLoop for cloud-class
// work or on repeated local failure. Off by default (config.pipeline.enabled);
// when on, the chat handler routes through runPipeline instead of straight to Claude.
// Design goal: powerful yet computationally cheap — keep the small router resident,
// load the 12B planner only when needed, watch RAM, cap KV cache via num_ctx tiers.
// ===========================================================================
const OLLAMA_API = `${OLLAMA_URL}/api`;
const CTX_TIERS = { router: 4096, local: 8192, critic: 16384, executor: 65536, planner: 131072, fullRepo: 262144 };
// LATENCY-CRITICAL (measured 2026-06-12): the router model re-prefills any system prompt it
// hasn't just seen (~23s for the 8KB persona on gemma3n) and llama.cpp only reuses the
// longest COMMON PREFIX of the previous call. So every router-model call — classify, simple
// answer, warm-up — MUST share the identical static system (+ the same num_ctx, since a
// num_ctx change restarts the runner). Per-query bits (memory/jobs/mode) ride in the PROMPT,
// whose prefill is small. Result: one prefill at boot, ~0.9s first token thereafter.
function localSystemPrefix() { return buildStaticPrompt(); }
// SLIM on purpose (measured 2026-06-12): gemma3n prefills ~150 tok/s, so every KB of
// per-query prompt is ~2s of mute time — the full mode+memory+jobs stack (2-4KB) pushed
// simple replies to 7-26s. The persona is already in the cached static prefix; only a few
// high-signal memory lines + active-job one-liners ride along. Local simple = quick Q&A;
// anything needing deep context classifies complex/cloud and gets the full blocks there.
function localDynamicBlocks(query) {
  const cfg = loadConfig();
  let out = '';
  try {
    const mem = memoryRetrieve(query || '', cfg.localMemoryTopK || 4);
    if (mem) out += '## RELEVANT MEMORY\n' + mem.slice(0, cfg.localMemoryCap || 600) + '\n';
  } catch {}
  try { const jb = jobsStatusBlock(); if (jb) out += jb.slice(0, 500) + '\n'; } catch {}
  return out ? redactSecrets(out) : '';
}

// Resolve a desired model to one that's actually installed (cached). gemma3n:e4b →
// qwen3:latest if not yet pulled; gemma3:12b is present. Avoids 404s on missing tags.
let _ollamaModels = null, _ollamaModelsAt = 0;
async function installedModels() {
  if (_ollamaModels && Date.now() - _ollamaModelsAt < 60000) return _ollamaModels;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    _ollamaModels = (j.models || []).map((m) => m.name); _ollamaModelsAt = Date.now();
  } catch { _ollamaModels = []; }
  return _ollamaModels;
}
async function resolveModel(want, fallbacks) {
  const have = await installedModels();
  const has = (n) => have.some((m) => m === n || m.split(':')[0] === n.split(':')[0]);
  for (const cand of [want, ...(fallbacks || [])]) if (cand && has(cand)) return cand;
  return want;   // last resort — let Ollama error rather than silently misroute
}
function pipelineCfg() {
  const p = (loadConfig().pipeline) || {};
  return {
    enabled: p.enabled === true,
    routerModel: p.routerModel || 'gemma3n:e4b',
    plannerModel: p.plannerModel || 'gemma3:12b',
    executorModel: p.executorModel || 'gemma3:12b',
    criticModel: p.criticModel || 'gemma3n:e4b',
    maxSteps: p.maxSteps || 12
  };
}

// The local Ollama pipeline can't reliably run the desktop tool set (it returned garbage on
// tool tasks in testing). So it's reserved for SIMPLE work — basic questions / quick fact
// checks — and ANYTHING that looks like it needs a tool bypasses straight to Claude. Broad on
// purpose: erring toward Claude is the desired behavior. The local gemma router is no longer
// trusted to detect tool use.
function looksLikeToolTask(text) {
  const t = String(text || '').toLowerCase();
  if (/[~/][\w.]|\b[\w-]+\.(png|jpe?g|pdf|txt|md|json|csv|js|ts|py|stl|obj|glb|mp3|wav|docx?|xlsx?|key|pages)\b/.test(t)) return true;  // paths / filenames
  // Live/current-data questions are tool tasks too (world_cup / web_search / weather) — they must
  // NOT be shunted to the tool-less local/Darkbloom fast path, which answers from stale training.
  if (/\bworld cup\b|\bstandings?\b|\bbracket\b|\bodds\b|who'?s winning|\bscores?\b|\bfixtures?\b|\bmatchup\b|right now|\btoday\b|currently|\blatest\b|live (?:score|match|game|update)|what.*\bwatch\b|worth watching|the (?:game|match)\b|\binsights?\b|fill me in|\bweather\b|\bstock|\bprice\b|\bnews\b|\bheadlines?\b/.test(t)) return true;
  return /\b(open|launch|quit|close|play|pause|skip|resume|search|google|browse|navigate|go to|website|url|click|type|screenshot|screen|capture|delete|remove|create|make|build|write|edit|save|move|rename|copy|file|folder|directory|\bls\b|\bcd\b|run|exec|shell|command|terminal|deploy|install|update|git|commit|push|email|gmail|inbox|send|calendar|event|schedule|remind|reminder|note|notes|message|imessage|text|spotify|playlist|song|music|track|volume|login|log in|sign in|download|upload|generate|image|picture|logo|render|3d|stl|print|figure|plot|graph|chart|simulate|notion|app\b|browser|playwright|spreadsheet|document)\b/.test(t);
}

// Natural-language toggle for the pipeline, usable from any entry point (desktop,
// phone, Telegram). Returns a reply string if it handled a toggle, else null.
function maybeTogglePipeline(text) {
  const m = String(text || '').match(/\b(enable|turn on|disable|turn off)\s+(the\s+)?(local\s+)?(multi-?agent\s+)?pipeline\b/i);
  if (!m) return null;
  const on = /enable|on/i.test(m[1]);
  const p = loadConfig().pipeline || {}; p.enabled = on; saveConfig({ pipeline: p });
  if (on) warmRouter();
  return `Local multi-agent pipeline ${on ? 'enabled' : 'disabled'}, sir.`;
}

// Preload the router into RAM so the FIRST classification is ~0.7s, not the ~5s cold load.
// keep_alive:-1 keeps it resident thereafter. Fire-and-forget, safe if Ollama is down.
let _routerWarmed = false;
async function warmRouter() {
  if (_routerWarmed) return; _routerWarmed = true;
  try {
    if (!(await ollamaUp())) { _routerWarmed = false; return; }
    const model = await resolveModel(pipelineCfg().routerModel, ['qwen3:latest', 'gemma3:12b']);
    // Warm with the SAME system + num_ctx every router-model call uses → the big static
    // prefill is paid here at boot, and classify/simple-answer first tokens stay ~1s.
    await ollamaGenerate(model, 'ok', { num_ctx: CTX_TIERS.local, keep_alive: -1, timeoutMs: 90000, system: localSystemPrefix() });
    console.log('[pipeline] router warmed (static prefix prefilled):', model);
  } catch { _routerWarmed = false; }
}

// One-shot Ollama generate with explicit RAM levers (num_ctx caps KV cache, num_gpu
// forces Metal, keep_alive controls resident time). Used by every pipeline stage.
async function ollamaGenerate(model, prompt, opts = {}) {
  const { system, num_ctx = CTX_TIERS.router, keep_alive = -1, format } = opts;
  const noThink = isThinkingModel(model);
  const body = { model, prompt, stream: false, options: { num_ctx, num_gpu: 99 }, keep_alive };
  if (system || noThink) body.system = (system || '') + (noThink ? '\n/no_think' : '');
  if (noThink) body.think = false;     // qwen3: skip <think> tokens — pure latency for replies
  if (format) body.format = format;   // 'json' → Ollama constrains output to valid JSON
  const r = await fetch(`${OLLAMA_API}/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs || 120000)
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  const j = await r.json();
  return (j.response || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}
// Streaming variant — onDelta(text) fires per chunk so the renderer + TTS get the first
// tokens in ~1s instead of after full generation (the local simple path's 5s-budget fix).
async function ollamaGenerateStream(model, prompt, opts = {}, onDelta) {
  const { system, num_ctx = CTX_TIERS.router, keep_alive = -1 } = opts;
  const noThink = isThinkingModel(model);
  const body = { model, prompt, stream: true, options: { num_ctx, num_gpu: 99 }, keep_alive };
  if (system || noThink) body.system = (system || '') + (noThink ? '\n/no_think' : '');
  if (noThink) body.think = false;
  const r = await fetch(`${OLLAMA_API}/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs || 120000)
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.response) { full += j.response; if (onDelta) try { onDelta(j.response); } catch {} }
    }
  }
  return full.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}
// Local models inherit the <speak> instructions and often emit the tags literally. Pull
// them out: `display` = tag-free text for chat, `spoken` = the wrapped line if present
// (else the whole thing) for TTS.
function extractSpeakText(s) {
  const t = stripReasoning(String(s || ''));   // never show/speak leaked <thinking>/meta narration
  const m = t.match(/<speak>([\s\S]*?)<\/speak>/i);
  const display = t.replace(/<\/?speak>/gi, '').trim();
  return { display, spoken: (m ? m[1] : display).trim() };
}
function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch {}
  const m = String(s).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// macOS free-RAM check — gate loading the 12B planner so we don't thrash/swap.
function checkRamPressure() {
  return new Promise((resolve) => {
    try {
      exec('vm_stat', { timeout: 2000 }, (err, stdout) => {
        if (err) return resolve(true);
        let freePages = 0; const pg = (stdout.match(/page size of (\d+)/) || [])[1] || 4096;
        for (const l of stdout.split('\n')) { const m = l.match(/Pages (free|speculative|inactive):\s+(\d+)/); if (m) freePages += parseInt(m[2]); }
        resolve((freePages * pg) / 1048576 > 1500);   // need ≥1.5GB reclaimable to load 12B
      });
    } catch { resolve(true); }
  });
}

// Stage 1 — Router (small, resident). simple | complex | cloud.
async function routerClassify(message) {
  const cfg = pipelineCfg();
  const model = await resolveModel(cfg.routerModel, ['qwen3:latest', 'gemma3:12b']);
  try {
    // Hard 6s cap: a cold/stuck router must not sit mute past the voice budget — the catch
    // below escalates to the cloud path, which streams + already has the ack playing.
    // System = the SHARED static prefix (see localSystemPrefix) so this call reuses the
    // boot-time prefill; the classifier instructions ride in the prompt (format:'json'
    // still hard-constrains the output shape).
    const out = await ollamaGenerate(model, `Classify the REQUEST below into one JSON object, nothing else.
{"path":"simple|complex|cloud","reason":"<one sentence>","estimatedSteps":<1-20>,"needsFullContext":<bool>,"needsTools":<bool>,"suggestedMode":"ops|research|executive"}
simple: single-turn answer, no tools, no code.
complex: multi-step, tools, code gen, file ops.
cloud: >200K tokens, high stakes, vision, or anything needing the full desktop tool set.
suggestedMode — ops: deploy/shell/file mutation; research: analysis/writing/science; executive: general/triage/chat.

REQUEST: ${message}`, {
      num_ctx: CTX_TIERS.local, keep_alive: -1, format: 'json', timeoutMs: 6000,
      system: localSystemPrefix()
    });
    const parsed = parseJsonLoose(out) || { path: 'cloud', reason: 'parse fail', estimatedSteps: 1, needsTools: true };
    if (!['ops', 'research', 'executive'].includes(parsed.suggestedMode)) parsed.suggestedMode = modePrompts.classifyMode(message);
    return parsed;
  } catch (e) { return { path: 'cloud', reason: 'router error: ' + e.message, needsTools: true, suggestedMode: modePrompts.classifyMode(message) }; }
}

async function plannerPass(message, classification) {
  const cfg = pipelineCfg();
  const model = await resolveModel(cfg.plannerModel, ['gemma3:12b', 'qwen3:latest']);
  const ctx = classification.needsFullContext ? CTX_TIERS.fullRepo : CTX_TIERS.planner;
  let projectCtx = '';
  try { const md = path.join(process.env.BHATBOT_PROJECT || os.homedir(), 'CLAUDE.md'); if (fs.existsSync(md)) projectCtx = fs.readFileSync(md, 'utf8').slice(0, 8000); } catch {}
  const system = `You are the PLANNER stage of BhatBot. Decompose the task into ordered steps.
Output ONLY valid JSON, no markdown.${projectCtx ? `\n## Project context\n${projectCtx}` : ''}
{"steps":[{"action":"<desc>","tool":"<tool_name>|null","input":"<what to pass>","validation":"<success condition>"}],"contextNeeded":<tokens>}`;
  try {
    // 45s cap: a cold 12B load must not hold the turn hostage — null → caller escalates to
    // the (streaming, already-acked) cloud path instead of grinding on a slower local plan.
    const out = await ollamaGenerate(model, message, { num_ctx: ctx, keep_alive: 300, format: 'json', system, timeoutMs: 45000 });
    const p = parseJsonLoose(out);
    if (p && Array.isArray(p.steps) && p.steps.length) return p;
  } catch (e) { console.warn('[pipeline] planner failed:', e.message); return null; }
  return { steps: [{ action: message, tool: null, input: message, validation: 'any output' }] };
}

async function compressStepOutput(output) {
  const s = String(output || '');
  if (s.length < 2000) return s;
  const cfg = pipelineCfg();
  const model = await resolveModel(cfg.criticModel, ['qwen3:latest', 'gemma3:12b']);
  try { return await ollamaGenerate(model, s.slice(0, 20000), { num_ctx: CTX_TIERS.executor, system: 'Compress to the essential facts in under 300 words.' }); }
  catch { return s.slice(0, 2000); }
}

async function executorStep(step, previousResults) {
  // Real tool steps run on BhatBot's actual tool layer (same as Claude uses).
  if (step.tool && TOOLS.some((t) => t.name === step.tool)) {
    try {
      let input = step.input;
      if (typeof input === 'string') { const j = parseJsonLoose(input); if (j) input = j; }
      const r = await executeTool(step.tool, input);
      const failed = r && r.success === false;
      return { output: typeof r === 'string' ? r : JSON.stringify(r), failed, error: failed ? (r.error || 'tool failed') : null };
    } catch (e) { return { output: '', failed: true, error: e.message }; }
  }
  // Reasoning/codegen steps run on the local executor model.
  const cfg = pipelineCfg();
  const model = await resolveModel(cfg.executorModel, ['gemma3:12b', 'qwen3:latest']);
  const ctxParts = [];
  for (const r of previousResults) ctxParts.push('Prior: ' + (await compressStepOutput(r.output)).slice(0, 1200));
  try {
    const out = await ollamaGenerate(model, String(step.input || step.action), {
      num_ctx: CTX_TIERS.executor, keep_alive: 300,
      system: `${ctxParts.join('\n')}\n\nExecute this step. Return ONLY the output, no commentary.`
    });
    return { output: out, failed: false };
  } catch (e) { return { output: '', failed: true, error: e.message }; }
}

async function criticValidate(plan, results) {
  const cfg = pipelineCfg();
  const model = await resolveModel(cfg.criticModel, ['qwen3:latest', 'gemma3:12b']);
  const summary = results.map((r, i) => `${plan.steps[i] ? plan.steps[i].action : 'step'}: ${String(r.output || '').slice(0, 200)}`).join('\n');
  try {
    const out = await ollamaGenerate(model, summary, {
      num_ctx: CTX_TIERS.critic, format: 'json',
      system: `Validate these outputs against the plan. JSON only.\nPlan: ${plan.steps.map((s) => s.action).join(' → ')}\n{"allPassed":true|false,"failedSteps":[],"summary":"<one sentence>"}`
    });
    return parseJsonLoose(out) || { allPassed: true, summary: 'Completed' };
  } catch { return { allPassed: true, summary: 'Completed' }; }
}

// Stage orchestrator. Returns { text, history, _provider } matching agentLoop's shape so the
// chat handler is interchangeable. event/opts forwarded to agentLoop on cloud escalation.
async function runPipeline(history, apiKey, event, opts = {}) {
  const cfg = pipelineCfg();
  const userMessage = lastUserText(history);
  let cls = null;   // router classification — carried into agentLoop on escalation (mode prompt)
  const escalate = (why) => { sendToActivity('tool-update', { type: 'thinking', text: '⤴ pipeline → Claude (' + why + ')' }); return agentLoop(history, apiKey, event, { ...opts, suggestedMode: cls && cls.suggestedMode }); };

  if (!cfg.enabled || !(await ollamaUp())) return agentLoop(history, apiKey, event, opts);

  // Hard bypass: anything that smells like a tool task goes straight to Claude — don't trust
  // the local router to catch it (it didn't). Saves the router round-trip too.
  if (looksLikeToolTask(userMessage)) return escalate('tool task → Claude');

  cls = await routerClassify(userMessage);
  sendToActivity('tool-update', { type: 'thinking', text: `🧭 router: ${cls.path} — ${cls.reason || ''}` });

  // Anything touching the desktop tool set, vision, or high stakes → Claude (full tools + safety).
  if (cls.path === 'cloud' || cls.needsTools || /image|tool_result/.test(JSON.stringify(history.slice(-1)))) return escalate(cls.path === 'cloud' ? 'cloud-class' : 'needs tools');

  if (cls.path === 'simple') {
    const model = await resolveModel(cfg.routerModel, ['qwen3:latest', 'gemma3:12b']);
    try {
      // STREAM the local answer: first tokens render + speak in ~1s instead of after full
      // generation (the old one-shot path also sent tokens on a 'chat-token' channel that
      // nothing listened to — the reply only appeared when the whole turn returned).
      // makeSpeakStream gives the same <speak>-tag handling + sentence TTS as the cloud path.
      const parser = (opts.stream && opts.ttsSeq != null) ? makeSpeakStream(opts.ttsSeq) : null;
      const onDelta = (d) => {
        latMark('first-token');
        const disp = parser ? parser.feed(d) : d;
        if (disp) { try { event && event.sender && event.sender.send('tool-update', { type: 'token', text: disp }); } catch {} }
      };
      // Same static system prefix as classify/warm-up (prefix-cache hit → ~1s first token);
      // the per-query memory/jobs/mode context rides in the prompt where prefill is cheap.
      const dyn = localDynamicBlocks(userMessage);
      const text = await ollamaGenerateStream(model, (dyn ? dyn + '\n\n' : '') + 'USER MESSAGE: ' + userMessage, { num_ctx: CTX_TIERS.local, keep_alive: -1, system: localSystemPrefix() }, onDelta);
      if (parser) parser.finish();
      if (text) {
        const { display, spoken } = extractSpeakText(text);   // strip any literal <speak> tags
        const cleanDisplay = stripReasoning(display);   // local models leak <thinking>/meta — never show it
        if (opts.stream && opts.ttsSeq == null) speakDesktop(stripReasoning(spoken));   // non-handler callers keep the old voice path
        return { text: cleanDisplay, history: [...history, { role: 'assistant', content: cleanDisplay }], _provider: 'pipeline-local', _streamed: !!(opts.stream && opts.ttsSeq != null) };
      }
    } catch (e) { console.warn('[pipeline] simple failed:', e.message); }
    return escalate('local simple failed');
  }

  // Complex work always goes to Claude now (the local plan→execute path was unreliable and the
  // user wants the pipeline only for simple Q&A / fact checks). Claude also does the cost-aware
  // chunking for big tasks (see the COMPLEX-TASK BUDGETING note in the system prompt).
  return escalate('complex → Claude');

  // (Dead code below — kept for reference; the local complex pipeline is intentionally disabled.)
  // eslint-disable-next-line no-unreachable
  if (!(await checkRamPressure())) return escalate('RAM pressure');
  sendToActivity('tool-update', { type: 'thinking', text: '🧠 planning locally…' });   // visible feedback while the 12B loads
  const plan = await plannerPass(userMessage, cls);
  if (!plan) return escalate('planner timeout/error');
  if (plan.steps.length > cfg.maxSteps) return escalate('plan too large');
  sendToActivity('tool-update', { type: 'thinking', text: `📋 plan: ${plan.steps.length} steps` });
  const results = [];
  for (const step of plan.steps) {
    let r = await executorStep(step, results);
    if (r.failed) { const retry = await executorStep(step, results); if (retry.failed) return escalate('step failed: ' + step.action); r = retry; }
    results.push(r);
  }
  const validation = await criticValidate(plan, results);
  if (!validation.allPassed) return escalate('critic rejected');
  const full = extractSpeakText(results.map((r, i) => `### ${plan.steps[i].action}\n${r.output}`).join('\n\n')).display;
  if (opts.stream) {                                           // speak the critic's summary aloud
    const line = validation.summary || full;
    if (opts.ttsSeq != null) { ttsStreamFeed(opts.ttsSeq, line); ttsStreamFlush(opts.ttsSeq); }
    else speakDesktop(line);
  }
  return { text: full, history: [...history, { role: 'assistant', content: full }], _provider: 'pipeline-local', _summary: validation.summary };
}

// ===========================================================================
// FAST CONVERSATIONAL PATH (Pass 37, 2026-06-12) — near-human chat latency.
// Measured: the local pipeline's "simple" path makes TWO serial gemma3n calls
// (classify JSON, then answer) and the model generates at ~28 tok/s, so even
// fully warm a one-line reply took ~6s; a cold system-prompt prefill cost ~12s.
// Streaming Claude Haiku with NO tools and the server-cached static system block
// gives a first token in ~0.6s and a full reply in ~1-2s. So: route obvious
// conversation to Haiku directly, route obvious tool-work straight to the full
// agent (skipping the local router hop), and only let genuinely ambiguous turns
// pay for the LLM router. Heavy/agentic work still runs through agentLoop and
// can be dispatched to background jobs while the chat stays responsive.
// ===========================================================================

// Zero-cost heuristic pre-router. 'chat' = pure conversation, answer instantly with
// streaming Haiku (no tools). 'action' = clearly needs tools/code/files → full agent.
// 'unsure' = let the existing LLM router / pipeline decide. Deliberately CONSERVATIVE:
// only returns 'chat' when there is no tool signal at all, so we never strand an action
// on a tool-less reply.
// Live speaking-speed control by voice/text — "speak slower", "talk faster", "slow down your
// voice". Nudges config.ttsSpeed by 0.04 (clamped 0.7–1.2) and persists it; because synth reads
// ttsSpeed per-utterance, the very next spoken line (this confirmation) uses the new speed — no
// restart. Conservative patterns so "slow down the build" / "speed up the script" don't trip it.
function maybeAdjustSpeed(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.split(/\s+/).length > 8) return null;   // only short, command-shaped utterances
  const slower = /\b(speak|talk|read|say (?:it|that))\b.{0,14}\b(slow|slower|slowly)\b/.test(t)
    || /\bslow (?:down )?(?:your |the )?voice\b/.test(t) || /\b(?:speak|talk) more slowly\b/.test(t)
    || /^(?:please\s+|hey\s+)?slow down[.!]?$/.test(t);
  const faster = /\b(speak|talk|read|say (?:it|that))\b.{0,14}\b(fast|faster|quick|quicker|quickly)\b/.test(t)
    || /\bspeed up (?:your |the )?voice\b/.test(t) || /\b(?:speak|talk) more quickly\b/.test(t)
    || /^(?:please\s+|hey\s+)?(?:speed up|talk faster)[.!]?$/.test(t);
  if (!slower && !faster) return null;
  const c = loadConfig();
  const cur = Number(c.ttsSpeed) || 1.05;
  const next = Math.max(0.7, Math.min(1.2, +(cur + (faster ? 0.04 : -0.04)).toFixed(2)));
  if (next === cur) return faster ? 'Already at my briskest, sir.' : 'That is as measured as I get, sir.';
  saveConfig({ ttsSpeed: next });
  sendToActivity('tool-update', { type: 'thinking', text: `🗣 speaking speed → ${next}` });
  return faster ? 'Picking up the pace, sir.' : 'Slowing down, sir.';
}

function quickRoute(text, history = []) {
  const t = String(text || '').trim();
  if (!t) return 'unsure';
  // Continuing a tool thread (last turns carry tool_use/tool_result) → not idle chat.
  try { if (/tool_result|tool_use/.test(JSON.stringify(history.slice(-2)))) return 'unsure'; } catch {}
  // Hard tool signals: code fence, URL, unix path, or a filename with an extension.
  if (/```|https?:\/\/|(^|\s)[~./][\w./-]*\/[\w.-]+|\b[\w-]+\.(js|ts|py|md|json|html|css|sh|png|jpg|jpeg|pdf|stl|glb|csv|txt|yml|yaml|toml)\b/i.test(t)) return 'action';
  if (ACTION_RE.test(t)) return 'action';
  if (/\b(email|e-mail|calendar|spotify|browser|browse|screenshot|terminal|shell|command|repo|commit|push|deploy|3d|image|stl|workflow|password|log\s?in|automate|notes?|reminder|file|folder|directory|studio|nexus|code)\b/i.test(t)) return 'action';
  // Live/current-data questions (World Cup, scores, standings, odds, predictions, weather…) need a
  // tool — they must hit the full agent, NOT the tool-less chat fast-path (which answers from stale
  // training and leaked the "next World Cup is 2026" reply). looksLikeToolTask carries these terms.
  if (looksLikeToolTask(t)) return 'action';
  const words = t.split(/\s+/).length;
  // Short and question-/chat-shaped, no action signal → just talk.
  if (words <= 40 && (/\?\s*$/.test(t) || /\b(what|who|why|how|when|which|whose|explain|tell me|do you|are you|did you|can you|could you|would you|your|you'?re|hi|hey|hello|thanks|thank you|good (morning|afternoon|evening|night)|how are you|what'?s up|nice|cool|ok|okay|yes|no|sure)\b/i.test(t)))
    return 'chat';
  if (words <= 18) return 'chat';   // very short utterance with no tool signal → conversational
  return 'unsure';
}

// Concierge fast reply: ONE streaming Haiku completion, no tools, server-cached static
// system block. First token ~0.6s. Returns agentLoop's shape so callers are interchangeable.
async function fastReply(history, apiKey, event, opts = {}) {
  const stream = !!opts.stream, ttsSeq = opts.ttsSeq;
  const parser = (stream && ttsSeq != null) ? makeSpeakStream(ttsSeq) : null;
  const onText = stream ? (delta) => {
    latMark('first-token');
    const disp = parser ? parser.feed(delta) : delta;
    if (disp) { try { event && event.sender && event.sender.send('tool-update', { type: 'token', text: disp }); } catch {} }
  } : null;
  sendToAll(event, 'tool-update', { type: 'provider_used', provider: 'anthropic', model: MODEL_HAIKU });
  // Right-size the fast (no-tools) path too: learned depth ceiling, capped at 2048 since this path
  // is for quick conversational replies — a trivial "ack" no longer reserves 1024 output tokens.
  const ut = lastUserText(history);
  const d = sizeTurn(ut, history);           // Phase 3 — learned ceiling + position taper (fast no-tools path)
  const r = await anthropicStream({
    model: MODEL_HAIKU, max_tokens: Math.min(d.maxTokens, 2048),
    system: [...systemBlocks(ut), { type: 'text', text: d.directive }],   // cache_control'd static block → cheap + low TTFT
    messages: capTokens(history)                    // NO tools → faster first token, no tool-decision detour
  }, apiKey, onText);
  logDepthOutcome({ depth: d.depth, maxTokens: Math.min(d.maxTokens, 2048), feats: d.feats, taperFactor: d.taperFactor, source: d.source }, r, 'fast');
  if (parser) parser.finish(); else if (stream && ttsSeq != null) ttsStreamFlush(ttsSeq);
  const text = stripReasoning(r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')).replace(/<\/?speak>/g, '').trim();
  return { text, history: [...history, { role: 'assistant', content: text }], _provider: 'anthropic', _model: MODEL_HAIKU, _streamed: !!(stream && ttsSeq != null) };
}

// Serialize ALL turns. agentLoop/pipeline mutate module-level globals (mcpHistory,
// agentState, currentMode, ttsStream*, pendingGuidance); two turns at once (e.g. an MCP/API
// task overlapping a wake-word-triggered desktop turn) interleave on those and corrupt the
// result — the source of the truncated "<s"/"I" replies seen in testing. This chain runs each
// turn to completion before the next starts; concurrent callers queue instead of clobbering.
// #12/W5 — centralized episodic capture. EVERY reply path (fastReply, pipeline-local, agentLoop,
// remote/MCP via runAgentHeadless→dispatchTurn) funnels through _dispatchTurnInner, so recording
// here once captures all turns — not just the tool-using ones agentLoop.finish() used to log.
// Fire-and-forget; the store caps + evicts oldest episodic first so durable semantic facts survive.
function recordEpisode(userText, replyText, surface) {
  try {
    const u = String(userText || '').trim();
    const a = String(replyText || '').replace(/<\/?speak>/g, '').trim();
    if (u && a) semantic.upsert({ text: `User: ${u.slice(0, 400)}\nAssistant: ${a.slice(0, 800)}`, kind: 'episodic', meta: { surface: surface || 'desktop' } }).catch(() => {});
  } catch {}
}

let _turnChain = Promise.resolve();
function dispatchTurn(history, apiKey, event, opts = {}) {
  const job = () => _dispatchTurnInner(history, apiKey, event, opts);
  const p = _turnChain.then(job, job);     // run regardless of how the previous turn settled
  _turnChain = p.then(() => {}, () => {});  // never let a rejection break the chain
  return p;
}

// Single entry point every chat surface (desktop, phone, MCP, Telegram) routes through.
// quickRoute first (free); only fall to the LLM router/pipeline when genuinely unsure.
async function _dispatchTurnInner(history, apiKey, event, opts = {}) {
  const userText = lastUserText(history);
  // Live speaking-speed intent — handled inline (no tool/agent hop) so the spoken confirmation
  // itself plays at the freshly-saved speed.
  const spd = maybeAdjustSpeed(userText);
  if (spd) return { text: spd, history: [...history, { role: 'assistant', content: spd }], _provider: 'local', _model: 'intent' };
  const surface = opts.stream ? 'desktop' : 'headless';
  let res;
  if (loadConfig().fastChat !== false) {
    const qr = quickRoute(userText, history);
    if (qr === 'chat') {
      try { res = await fastReply(history, apiKey, event, opts); }
      catch (e) { console.warn('[fast] reply failed → agent:', e.message); }   // fall through to full agent
    } else if (qr === 'action') {
      res = await agentLoop(history, apiKey, event, opts);   // obvious tool-work: skip the local router hop
    }
  }
  if (!res) {
    res = pipelineCfg().enabled
      ? await runPipeline(history, apiKey, event, opts)
      : await agentLoop(history, apiKey, event, opts);
  }
  if (res && res.text) recordEpisode(userText, res.text, surface);
  return res;
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
  const toggle = maybeTogglePipeline(instruction);
  if (toggle) return { text: toggle };
  if (opts.reset) mcpHistory = [];
  let instr = String(instruction || '');
  // Inbound SMS: sanitize the body (P0.4) and, if notify_user(awaitReply) registered
  // pending questions, attach them so the model resumes the right task with this answer.
  if (/^\[SMS\b/i.test(instr)) {
    // A login is blocking on a 2FA code → route this reply straight to it, don't run the agent.
    if (deliverTwoFactorCode(instr)) return { text: '✓ 2FA code received — continuing the login.' };
    instr = security.sanitizeExternalContent(instr, 'sms');
    const pend = takePendingReplies();
    if (pend.length) {
      instr += '\n\n[You previously asked and are awaiting a reply — this SMS answers one of these. Resume that task now: '
        + pend.map((p) => `(${p.taskId}) "${p.message.slice(0, 200)}"`).join(' | ') + ']';
    }
  }
  const blocks = Array.isArray(opts.blocks) ? opts.blocks : [];
  mcpHistory.push({ role: 'user', content: blocks.length ? [{ type: 'text', text: instr }, ...blocks] : instr });
  sendToActivity('tool-update', { type: 'thinking', text: '📱 remote task: ' + instr.slice(0, 200) });
  remoteDepth++;                                       // mark this as a no-human-present remote turn
  try {
    const ev = { sender: { send() {} } };
    const res = await dispatchTurn(mcpHistory, apiKey, ev, {});
    mcpHistory = res.history;
    if (mcpHistory.length > 40) mcpHistory = mcpHistory.slice(-40);
    return { text: res.text };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  } finally {
    remoteDepth--;
  }
}

// Desktop screenshot for the phone Control tab — screencapture (silent), downscaled to
// ≤1280px wide via nativeImage so the payload stays phone-friendly over the funnel.
async function captureScreenJpeg() {
  const out = path.join(os.tmpdir(), `bb-screen-${Date.now()}.jpg`);
  return new Promise((resolve) => {
    exec(`screencapture -x -t jpg "${out}"`, { timeout: 8000 }, (err) => {
      try {
        if (err) return resolve({ error: err.message });
        const { nativeImage } = require('electron');
        let img = nativeImage.createFromPath(out);
        fs.unlink(out, () => {});
        if (img.isEmpty()) return resolve({ error: 'capture failed (grant Screen Recording permission to BhatBot)' });
        const sz = img.getSize();
        if (sz.width > 1280) img = img.resize({ width: 1280 });
        resolve({ image: img.toJPEG(70).toString('base64'), mime: 'image/jpeg', w: Math.min(sz.width, 1280) });
      } catch (e) { resolve({ error: e.message }); }
    });
  });
}
// Phone control passthrough — same tools the agent already has via /chat, so the token
// gate (not this list) is the real boundary; the list just keeps the surface explicit.
const PHONE_CONTROL_TOOLS = new Set(['system_control', 'media_control', 'run_shell', 'manage_jobs']);
async function phoneControl(tool, input) {
  if (!PHONE_CONTROL_TOOLS.has(tool)) return { success: false, error: `tool not allowed from phone control: ${tool}` };
  remoteDepth++;                                       // phone Control tab → no-human-present
  try { return await executeTool(tool, input || {}); }
  finally { remoteDepth--; }
}

// Connect to the cloud backend as its Mac executor. When config.cloudUrl + config.cloudToken
// are set, the Mac dials out to the cloud over a WebSocket and runs computer-only tools the
// cloud agent dispatches (shell, AppleScript, browser, screen). This is what makes the phone
// fully capable while keeping the cloud as the always-on brain. No-op if not configured.
let _cloudBridge = null, _caffeinate = null;
function startCloudBridge() {
  try {
    const c = loadConfig();
    if (!c.cloudUrl || !c.cloudToken) return;
    // Keep the Mac reachable so the phone can always wake/use it: prevent system sleep while
    // bridged. `caffeinate -s` only holds sleep off on AC power (so it won't drain on battery),
    // which means "keep it plugged in → phone can always reach it." Disable: cloudKeepAwake:false.
    if (c.cloudKeepAwake !== false && process.platform === 'darwin' && !_caffeinate) {
      try { _caffeinate = spawn('caffeinate', ['-s'], { env: { ...process.env, PATH: EXEC_PATH } }); _caffeinate.on('exit', () => { _caffeinate = null; }); }
      catch {}
    }
    const bridge = require('./lib/cloud-bridge');
    _cloudBridge = bridge.start({
      url: c.cloudUrl,
      token: c.cloudToken,
      // Mark cloud-dispatched tools as REMOTE (no human at the keyboard) so the same guard that
      // protects the phone/funnel path applies — destructive shell won't silently auto-approve.
      executeTool: async (tool, input) => { remoteDepth++; try { return await executeTool(tool, input); } finally { remoteDepth--; } },
      log: (m) => { try { console.log(m); sendToActivity('tool-update', { type: 'thinking', text: m }); } catch {} },
    });
  } catch (e) { console.warn('[cloud-bridge] start failed:', e.message); }
}
// First-open-of-the-day brief, fetched from the cloud (server-gated to once/day across all
// surfaces — whichever of phone/computer opens first speaks it). Spoken via the desktop voice.
// Feat-1 — BRIEFING ON DEMAND. No auto-delivered briefing. Instead, when the app opens and Siddhant
// hasn't said anything within a short idle window, BhatBot proactively OFFERS one (spoken + on-screen),
// listing the kinds; he picks (or declines), and the agent delivers only the chosen kind. The static
// prompt tells the model to ask which if he says yes without specifying.
let _userSpokeSinceOpen = false, _briefingOffered = false;
function offerBriefingOnOpen() {
  try {
    const c = loadConfig();
    if (c.briefingOfferOnOpen === false) return;            // opt-out
    const delayMs = Math.max(5, Number(c.briefingOfferDelaySec) || 25) * 1000;
    setTimeout(() => {
      if (_userSpokeSinceOpen || _briefingOffered) return;  // he already engaged → don't interrupt
      _briefingOffered = true;
      const offer = 'Would you like a briefing, sir? I can pull recent news, your important emails, recent texts, or recent calls — just tell me which, or say no.';
      sendToActivity('tool-update', { type: 'thinking', text: '🗞️ ' + offer });
      try { speakDesktop(offer, { full: true }); } catch {}
    }, delayMs);
  } catch {}
}
async function maybeMorningBrief() {
  try {
    const c = loadConfig();
    if (!c.cloudUrl || !c.cloudToken) return;
    const r = await fetch(`${c.cloudUrl.replace(/\/+$/, '')}/api/${c.cloudToken}/morning`, {
      headers: { Authorization: 'Bearer ' + c.cloudToken }, signal: AbortSignal.timeout(45000),
    }).then((x) => x.json()).catch(() => null);
    if (r && r.fresh && r.text) {
      sendToActivity('tool-update', { type: 'thinking', text: '☀️ morning brief:\n' + r.text });
      try { speakDesktop(r.text, { full: true }); } catch {}
    }
  } catch {}
}
async function initMcpServer() {
  if (pipelineCfg().enabled) warmRouter();   // preload the local router so the first hop is fast
  const c = loadConfig();
  if (c.mcpEnabled === false) return;
  let token = c.mcpToken;
  if (!token) { token = crypto.randomBytes(24).toString('hex'); saveConfig({ mcpToken: token }); }
  const port = c.mcpPort || 8788;
  try {
    await startMcpServer({
      port, token, runAgent: runAgentHeadless, transcribe: transcribeAudio,
      synthesize: synthesizeSpeech, synthUlaw: synthesizeUlaw, summarize: summarizeForSpeech, media: mediaBytesToBlocks,
      voiceTurn, voiceBegin, voicePoll, endVoiceCall, getActivity, nexusUrl: NEXUS_URL, ownerPhone: c.myPhone,
      twilioAuthToken: c.twilioToken, jobs: jobsBus, control: phoneControl, screenshot: captureScreenJpeg,
      // Phone-call speech-recognition tuning (see gatherTwiml). All optional in config.json.
      voice: { hints: c.voiceHints, speechModel: c.voiceSpeechModel, speechTimeout: c.voiceSpeechTimeout,
        timeout: c.voiceTimeout, enhanced: c.voiceEnhanced, language: c.voiceLanguage,
        // Opt-in real-time Media Streams path (WebSocket audio). Default OFF → proven Gather path.
        mediaStreams: c.voiceMediaStreams === true }
    });
    writeClaudeMcpConfig();                       // so the embedded Claude Code can use BhatBot's MCP tools
    console.log(`[mcp] listening on http://127.0.0.1:${port}/mcp/${token}`);
    console.log(`[app] phone PWA at  http://127.0.0.1:${port}/app/${token}`);
    { const h = getPublicHost(); if (h) console.log(`[sms] Twilio Messaging webhook → https://${h}/sms/${token}/incoming`); }
    const host = getPublicHost();
    if (host) console.log(`[app] open on phone:  https://${host}/app/${token}`);
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
    // A login is blocking on a 2FA code → route this reply to it instead of the agent.
    if (deliverTwoFactorCode(userText)) { telegramBot.sendMessage(chatId, '✓ 2FA code received — continuing the login.'); return; }
    userText = security.sanitizeExternalContent(userText, 'telegram');   // P0.4

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

// ---------------------------------------------------------------------------
// Twilio two-way voice — a real phone CONVERSATION, not a one-shot announcement.
// BhatBot calls you, greets you in the JARVIS voice (his own TTS, played to the
// call), then listens (<Gather speech>), runs the agent on what you say, and
// speaks the reply — looping until you say goodbye / hang up. The webhook routes
// live on the same express/funnel server (mcp-server.js); main.js owns the agent
// turn + speech synthesis so the call uses the same voice as the desktop.
// ---------------------------------------------------------------------------
const voiceCalls = new Map();   // CallSid → { history:[], turns:0 }
const VOICE_BYE = /\b(good ?bye|bye bye|that'?s all|hang up|end (the )?call|nothing else|i'?m done|talk later|see you)\b/i;

// ── Live phone-call turn engine ───────────────────────────────────────────────────────────
// Two-tier for low latency: SIMPLE (conversational) turns — most of a call — get a fast
// tool-less streamed reply inline; COMPLEX (tool-needing) turns run the full agent in the
// BACKGROUND while the caller hears filler ("Let me think…" / "uhh, one moment"), and the reply
// then streams out sentence-by-sentence as it generates (voicePoll). No dead air either way.
const VOICE_FILLERS = ['Mm, one moment, sir.', 'Uh, let me see…', 'Still with you, sir…', 'Just a moment more…', 'Hm, nearly there…'];
function nextFiller(st) { const f = VOICE_FILLERS[(st._fi || 0) % VOICE_FILLERS.length]; st._fi = (st._fi || 0) + 1; return f; }
function clampSpoken(t) { let s = String(t || '').replace(/[*_`#>\[\]]/g, '').replace(/\s+/g, ' ').trim(); if (s.length > 700) s = s.slice(0, 697) + '…'; return s; }

// Pull complete sentences off the streaming buffer once they're long enough to be worth speaking —
// progressive playback without choppy micro-clips. flush=true emits whatever remains at the end.
function drainSentences(st, { flush = false } = {}) {
  const out = []; const buf = st._buf || '';
  const RE = /[^.!?…]+[.!?…]+(?:["')\]]+)?/g; let m, last = 0;
  while ((m = RE.exec(buf))) { const sent = m[0].trim(); if (sent.length >= 12) { out.push(sent); last = RE.lastIndex; } }
  let rem = buf.slice(last);
  if (flush && rem.trim()) { out.push(rem.trim()); rem = ''; }
  st._buf = rem;
  return out;
}

// Tool-less fast reply for conversational turns (low latency, no agent/tool loop).
async function voiceFastReply(history) {
  const sys = systemBlocks(lastUserText(history)) + '\n\n[PHONE CALL: answer in ONE or two short spoken sentences, plain text, no lists.]';
  const r = await anthropicStream({ model: MODEL_HAIKU, max_tokens: 320, system: sys, messages: capTokens(history) }, getApiKey(), null);
  return clampSpoken(r.content.filter((b) => b.type === 'text').map((b) => b.text).join(' '));
}

// Begin a spoken turn:
//   { mode:'reply', text, hangup }   — speak now (greeting, simple turn, or bye)
//   { mode:'thinking', filler }      — computing in the background; call voicePoll() until ready
async function voiceBegin(callSid, speech, greeting) {
  let st = voiceCalls.get(callSid);
  if (!st) { st = { history: [], turns: 0 }; voiceCalls.set(callSid, st); }
  st.turns++;
  if (st.turns > 30) return { mode: 'reply', text: 'We have spoken a good while, sir. I shall ring off now. Goodbye.', hangup: true };
  const said = String(speech || '').trim();
  if (!said) { const g = String(greeting || 'Good evening, sir. How may I help?').trim(); st.history.push({ role: 'assistant', content: g }); return { mode: 'reply', text: g, hangup: false }; }
  if (VOICE_BYE.test(said) && said.length < 40) return { mode: 'reply', text: 'Very good, sir. Goodbye.', hangup: true };
  st.history.push({ role: 'user', content: '[PHONE CALL — reply in 1-2 short spoken sentences, no markdown, no lists] ' + said });
  if (st.history.length > 24) st.history = st.history.slice(-24);

  // SIMPLE → fast tool-less reply inline (most calls; ~1–2s, no filler needed).
  if (!looksLikeToolTask(said)) {
    try {
      const text = await voiceFastReply(st.history);
      st.history.push({ role: 'assistant', content: text });
      return { mode: 'reply', text: text || 'Yes, sir?', hangup: false };
    } catch { /* fall through to the full agent on any hiccup */ }
  }

  // COMPLEX → run the full agent in the BACKGROUND, streaming sentences into st._chunks.
  st._buf = ''; st._chunks = []; st._done = false; st._fi = 0; st._polls = 0;
  const ev = { sender: { send() {} } };
  st._pending = (async () => {
    try {
      const res = await agentLoop(st.history, getApiKey(), ev, { onToken: (d) => { st._buf += d; for (const s of drainSentences(st)) st._chunks.push(clampSpoken(s)); } });
      st.history = (res.history || st.history).slice(-24);
      for (const s of drainSentences(st, { flush: true })) st._chunks.push(clampSpoken(s));
      if (!st._chunks.length) st._chunks.push(clampSpoken(res.text) || 'Done, sir.');
    } catch { st._chunks.push('Forgive me sir, I ran into an error.'); }
    finally { st._done = true; }
  })();
  return { mode: 'thinking', filler: 'Let me think for a moment, sir.' };
}

// Poll a thinking turn → the next thing to speak:
//   { ready:true, text, more }   — speak text; more=true → keep playing (don't listen yet)
//   { ready:false, filler }      — nothing ready yet; play filler, then poll again
function voicePoll(callSid) {
  const st = voiceCalls.get(callSid);
  if (!st) return { ready: true, text: '', more: false };
  st._polls = (st._polls || 0) + 1;
  if (st._polls > 40) return { ready: true, text: st._done ? '' : 'Apologies sir, that is taking longer than expected — I will follow up shortly.', more: false };
  if (st._chunks && st._chunks.length) {
    const text = st._chunks.shift();
    const more = st._chunks.length > 0 || !st._done;
    return { ready: true, text, more };
  }
  if (st._done) return { ready: true, text: '', more: false };
  return { ready: false, filler: nextFiller(st) };
}

// Back-compat single-shot (drains the whole turn) in case the old webhook path is ever used.
async function voiceTurn(callSid, speech, greeting) {
  const b = await voiceBegin(callSid, speech, greeting);
  if (b.mode === 'reply') return { text: b.text, hangup: b.hangup };
  const st = voiceCalls.get(callSid);
  if (st && st._pending) { try { await st._pending; } catch {} }
  const parts = []; let p;
  while ((p = voicePoll(callSid)) && p.ready) { if (p.text) parts.push(p.text); if (!p.more) break; }
  return { text: parts.join(' ') || 'Done, sir.', hangup: false };
}
function endVoiceCall(callSid) { if (callSid) voiceCalls.delete(callSid); }

// Place an actual outbound phone call via Twilio. Reserved for urgency:'call'. If the
// public funnel host is reachable, the call becomes a two-way JARVIS-voice conversation
// (webhook-driven, his own TTS). Without a host it degrades to a one-shot spoken message.
async function twilioCall(message) {
  const c = loadConfig();
  if (!c.twilioSid || !c.twilioToken || !c.twilioFrom || !c.myPhone) {
    return { sent: false, error: 'Twilio not configured (twilioSid/twilioToken/twilioFrom/myPhone)' };
  }
  let twilio;
  try { twilio = require('twilio'); } catch { return { sent: false, error: 'twilio package not installed (npm i twilio)' }; }
  const client = twilio(c.twilioSid, c.twilioToken);
  const greeting = String(message).slice(0, 600);
  const host = getPublicHost();
  try {
    if (host && c.mcpToken) {
      // Two-way: point Twilio at our webhook, which plays the JARVIS voice + gathers speech.
      // machineDetection=DetectMessageEnd → if voicemail answers, the webhook fires at the
      // BEEP with AnsweredBy=machine_end_*, and /voice/incoming leaves a JARVIS-voice
      // voicemail instead of gathering. Humans resolve in ~3-5s and get the conversation.
      const url = `https://${host}/voice/${c.mcpToken}/incoming?msg=${encodeURIComponent(greeting)}`;
      const call = await client.calls.create({
        url, method: 'POST', to: c.myPhone, from: c.twilioFrom,
        machineDetection: 'DetectMessageEnd', machineDetectionTimeout: 30,
        statusCallback: `https://${host}/voice/${c.mcpToken}/status`, statusCallbackEvent: ['completed']
      });
      return { sent: true, via: 'twilio-conversation', sid: call.sid };
    }
    // Fallback: one-shot announcement (no public host to host the conversation webhook).
    const safe = greeting.replace(/[<>&]/g, ' ');
    const twiml = '<Response><Say voice="Google.en-US-Neural2-D">' + safe + '</Say></Response>';
    const call = await client.calls.create({ twiml, to: c.myPhone, from: c.twilioFrom });
    return { sent: true, via: 'twilio', sid: call.sid };
  } catch (e) { return { sent: false, error: e.message }; }
}

// notify_user tool backend. Routes by urgency. Telegram is free + always tried; a call
// also still drops a Telegram line so there's a written record.
// Read a password from the macOS login Keychain via the built-in `security` CLI (no native
// dep, unlike keytar). macOS may prompt ONCE to allow access to an item another app created.
// CANNOT read iCloud Keychain (Safari) or Chrome's own encrypted store — those are off-limits
// to any third-party process by design. Returns {username,password} or null.
function keychainRead(service, account) {
  const pwOf = (type) => {
    const args = [type, '-s', service, '-w']; if (account) args.push('-a', account);
    const r = spawnSync('security', args, { encoding: 'utf8', timeout: 8000 });
    return (r.status === 0 && r.stdout != null) ? r.stdout.replace(/\n$/, '') : null;
  };
  const password = pwOf('find-internet-password') ?? pwOf('find-generic-password');
  if (password == null) return null;
  let username = account || '';
  if (!username) {
    for (const type of ['find-internet-password', 'find-generic-password']) {
      const r = spawnSync('security', [type, '-s', service], { encoding: 'utf8', timeout: 8000 });
      const m = (r.stdout || '').match(/"acct"<blob>="([^"]*)"/); if (m) { username = m[1]; break; }
    }
  }
  return { username, password };
}
function keychainLookup(input) {
  const service = input.service;
  if (!service) return { success: false, error: 'service required' };
  const got = keychainRead(service, input.account || '');
  if (!got) return { success: false, error: `No accessible Keychain entry for "${service}"${input.account ? ' / ' + input.account : ''}. Only login-keychain items that allow BhatBot are readable; Safari/iCloud & Chrome stores are not.` };
  try {
    const ref = credentials.store('keychain:' + service, service, got.username, got.password);
    return { success: true, ref, service, username: got.username, note: 'Password stored under a CRED_REF handle. Pass `ref` as credRef to browser login; never request the raw password.' };
  } catch (e) { return { success: false, error: 'vault store failed (run inside the app): ' + e.message }; }
}
// 1Password lookup via the `op` CLI. The raw secret is stored straight into the vault and
// only the CRED_REF_* handle is returned — the model never sees the password.
function onePasswordLookup(input) {
  const item = String(input.item || '').trim();
  if (!item) return { success: false, error: 'item required' };
  const env = { ...process.env, PATH: EXEC_PATH };
  const probe = spawnSync('op', ['--version'], { env, encoding: 'utf8', timeout: 8000 });
  if (probe.error || probe.status !== 0) {
    return { success: false, error: '1Password CLI (`op`) not found. Install with `brew install 1password-cli`, then enable "Integrate with 1Password CLI" in the 1Password app settings.' };
  }
  const args = ['item', 'get', item, '--format', 'json', '--reveal'];
  if (input.vault) args.push('--vault', String(input.vault));
  const r = spawnSync('op', args, { env, encoding: 'utf8', timeout: 25000 });
  if (r.status !== 0) {
    const err = (r.stderr || '').trim();
    if (/not signed in|no account|authentication|authorization|session/i.test(err)) {
      return { success: false, error: 'op is not signed in. Run `op signin` in a terminal (or enable the 1Password desktop-app CLI integration), then retry.' };
    }
    return { success: false, error: ('op failed: ' + (err || 'unknown error')).slice(0, 300) };
  }
  let j; try { j = JSON.parse(r.stdout); } catch { return { success: false, error: 'Could not parse op output.' }; }
  const fields = j.fields || [];
  const pw = fields.find((f) => f.purpose === 'PASSWORD' || f.id === 'password');
  const user = fields.find((f) => f.purpose === 'USERNAME' || f.id === 'username');
  if (!pw || !pw.value) return { success: false, error: `No password field on 1Password item "${item}".` };
  try {
    const domain = (j.urls && j.urls[0] && j.urls[0].href) || '';
    const ref = credentials.store('1password:' + item, domain, user ? user.value : '', pw.value);
    security.auditEvent('credential', { source: '1password', item, ref });
    return { success: true, ref, item, username: user ? user.value : '', domain, note: 'Password stored under a CRED_REF handle. Pass `ref` as credRef to browser login; never request the raw password.' };
  } catch (e) { return { success: false, error: 'vault store failed (run inside the app): ' + e.message }; }
}
function generateTotp(input) {
  const secret = String(input.credRef || input.secret || '').replace(/\s+/g, '').toUpperCase();   // credRef already resolved to the secret
  if (!secret) return { success: false, error: 'credRef (or secret) required' };
  try {
    const OTPAuth = require('otpauth');
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
    return { success: true, code, valid_for_seconds: 30 - (Math.floor(Date.now() / 1000) % 30) };
  } catch (e) { return { success: false, error: 'TOTP failed (is the secret valid base32?): ' + e.message }; }
}

// Send an SMS via Twilio. Two-way: replies come back through /sms/:token/incoming.
async function twilioSMS(message) {
  const c = loadConfig();
  if (!c.twilioSid || !c.twilioToken || !c.twilioFrom || !c.myPhone) return { sent: false, error: 'Twilio not configured' };
  let twilio; try { twilio = require('twilio'); } catch { return { sent: false, error: 'twilio not installed' }; }
  try {
    const m = await twilio(c.twilioSid, c.twilioToken).messages.create({ body: String(message).slice(0, 1500), to: c.myPhone, from: c.twilioFrom });
    return { sent: true, via: 'sms', sid: m.sid };
  } catch (e) { return { sent: false, error: e.message }; }
}

// ---- Pending-reply store: notify_user(awaitReply) registers a question; the inbound SMS
// webhook pops it and resumes the task with the answer attached. ----
const PENDING_REPLIES_PATH = path.join(os.homedir(), '.bhatbot', 'pending_replies.json');
function loadPendingReplies() { try { return JSON.parse(fs.readFileSync(PENDING_REPLIES_PATH, 'utf8')); } catch { return {}; } }
function savePendingReplies(p) { try { fs.mkdirSync(path.dirname(PENDING_REPLIES_PATH), { recursive: true }); fs.writeFileSync(PENDING_REPLIES_PATH, JSON.stringify(p, null, 2)); } catch {} }
// Pop ALL pending entries on an inbound SMS (a reply may answer any of them; the model
// disambiguates from the attached question text). Entries older than 24h are dropped.
function takePendingReplies() {
  const p = loadPendingReplies();
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const items = Object.entries(p)
    .map(([taskId, v]) => ({ taskId, ...v }))
    .filter((it) => { const t = Date.parse(it.ts || ''); return !isFinite(t) || t > cutoff; });
  if (Object.keys(p).length) savePendingReplies({});
  return items;
}

// ---- Two-factor wait: smart_login fills the FIRST factor, then (if the 2FA can't be done
// silently via TOTP) calls + texts Siddhant and BLOCKS here until his phone reply arrives with
// the code. Inbound SMS/Telegram are routed to deliverTwoFactorCode() before the normal agent. ----
let twoFactorWaiter = null;     // { resolve } while a login is awaiting a code, else null
function awaitTwoFactorCode(timeoutMs = 150000) {
  return new Promise((resolve) => {
    twoFactorWaiter = { resolve };
    setTimeout(() => { if (twoFactorWaiter) { const w = twoFactorWaiter; twoFactorWaiter = null; w.resolve(null); } }, timeoutMs);
  });
}
// Returns true if it consumed the message (a 2FA wait was active). A 4–8 digit run = the code;
// "approved"/"done"/"yes" = a push-style approval (no code → resolve with the literal token).
function deliverTwoFactorCode(text) {
  if (!twoFactorWaiter) return false;
  const s = String(text || '');
  const m = s.match(/\b(\d{4,8})\b/);
  const approve = /\b(approved?|done|yes|ok|confirm(ed)?|tapped|allowed)\b/i.test(s);
  if (!m && !approve) return false;
  const w = twoFactorWaiter; twoFactorWaiter = null;
  w.resolve(m ? m[1] : 'APPROVED');
  return true;
}

// Smart channel routing by urgency + time of day (quiet hours 23:00–07:00):
//   info/low → Telegram · medium → SMS (Telegram if quiet) · high → SMS regardless ·
//   call → voice call (quiet → "(URGENT)" SMS). Telegram always keeps a written record.
// opts.awaitReply registers a pending question keyed by opts.taskId for the SMS loop.
// Every attempt is logged to the daily audit file.
async function notifyUser(message, urgency, opts = {}) {
  const msg = String(message || '').slice(0, 1500);
  if (!msg.trim()) return { sent: false, error: 'empty message' };
  urgency = urgency === 'info' ? 'low' : (urgency || 'low');
  const hour = new Date().getHours();
  const quiet = hour >= 23 || hour < 7;
  let taskId = null;
  if (opts.awaitReply) {
    taskId = String(opts.taskId || 'task_' + Date.now().toString(36)).replace(/[^\w.-]/g, '_').slice(0, 60);
    const p = loadPendingReplies();
    p[taskId] = { message: msg.slice(0, 500), ts: new Date().toISOString() };
    savePendingReplies(p);
  }
  const mirror = () => { if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('tool-update', { kind: 'notify', text: msg, urgency }); } catch {} } };
  const done = (r) => {
    security.auditEvent('notify', { urgency, quiet, via: r && r.via, ok: !!(r && r.sent), awaitReply: !!opts.awaitReply, taskId, downgraded: r && r.downgraded, msg: msg.slice(0, 120) });
    if (taskId && r) r.taskId = taskId;
    return r;
  };

  if (urgency === 'call') {
    if (quiet) {                                   // don't ring at night — URGENT text instead
      const s = await twilioSMS('🔴 (URGENT — quiet hours, did not call) BhatBot: ' + msg);
      telegramNotify('📵 (quiet hours → SMS instead of call) ' + msg);
      return done(s.sent ? { ...s, downgraded: 'quiet-hours' } : { sent: true, via: 'telegram', smsError: s.error, downgraded: 'quiet-hours' });
    }
    const r = await twilioCall(msg);
    telegramNotify((r.sent ? '📞 (called you) ' : '📞 (call failed → ') + msg + (r.sent ? '' : ') ' + (r.error || '')));
    return done(r.sent ? r : { sent: true, via: 'telegram', callError: r.error });
  }

  if (urgency === 'high' || (urgency === 'medium' && !quiet)) {
    const r = await twilioSMS((urgency === 'high' ? '🔴 ' : '🟡 ') + 'BhatBot: ' + msg);
    telegramNotify((urgency === 'high' ? '🔴 ' : '🟡 ') + 'BhatBot: ' + msg);   // record + fallback
    mirror();
    return done(r.sent ? r : { sent: true, via: 'telegram', smsError: r.error });
  }

  // low / info / medium-during-quiet-hours → Telegram only
  telegramNotify((urgency === 'medium' ? '🟡 (quiet hours) ' : '⚪ ') + 'BhatBot: ' + msg);
  mirror();
  return done({ sent: true, via: 'telegram', ...(urgency === 'medium' ? { downgraded: 'quiet-hours' } : {}) });
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
  // Notion task queue (P3) — prepend open tasks to the briefing when configured.
  let notionTasks = '';
  try {
    const t = await notion.getOpenTasks({ limit: 10 });
    if (Array.isArray(t) && t.length) {
      notionTasks = 'Open tasks from the Notion queue (mention the top ones):\n'
        + t.map((x) => `- ${x.title}${x.priority ? ` [P:${x.priority}]` : ''}${x.dueDate ? ` (due ${x.dueDate})` : ''}${x.projectName ? ` — ${x.projectName}` : ''}`).join('\n') + '\n\n';
    }
  } catch {}
  const prompt = `Morning brief — ONLY the most pressing things, nothing else. Open with a short greeting, then exactly these three, each 1–2 short bullets, terse and spoken-friendly:
1. NEWS: call the news tool (section world) and give me the 2–3 headlines that genuinely matter today — the gist, not every story.
2. IMPORTANT EMAILS: call ambient action "read" source "mail" and tell me which unread emails look genuinely worth my attention — report ONLY the sender + subject the tool returns (no body is available — do NOT invent contents, deadlines, or amounts). Skip newsletters/promos/automated. If mail can't be read, say so in a few words and move on.
3. ONE INTERESTING THING you came across — a genuine discovery worth my time (a notable article, development, or insight from the news/web), not filler.
No website checks, no git status, no task lists. Flag anything truly urgent with ⚠.`;
  try {
    const res = await agentLoop([{ role: 'user', content: prompt }], getApiKey(), { sender: { send() {} } });
    const text = res.text || 'briefing produced no output';
    const note = text.slice(0, 220).replace(/"/g, '\\"');
    try { spawn('osascript', ['-e', `display notification "${note}" with title "Bhatbot Briefing" sound name "Ping"`]); } catch {}
    try { speakDesktop(text, { full: true }); } catch {}   // ONE voice: ElevenLabs via speakDesktop, never macOS say
    telegramNotify('☀️ Morning briefing:\n\n' + text);
    sendToActivity('tool-update', { type: 'thinking', text: '☀️ briefing:\n' + text });
  } catch (e) { console.error('[briefing] failed:', e.message); }
  briefingTimer = setTimeout(runBriefing, 24 * 60 * 60 * 1000);   // next day
}

// ---------------------------------------------------------------------------
// Proactive scheduler — ticks every 30s, runs any due schedule through the agent
// headlessly (like the briefing), then announces/notifies + reschedules. This is what lets
// BhatBot act on its own: reminders, recurring checks, "do X every morning / in 30 min".
// ---------------------------------------------------------------------------
let schedulerTimer = null, schedulerRunning = new Set(), schedulerBusy = false;
// Ambient awareness (#18): opt-in proactive monitoring of Calendar/Mail. OFF unless
// config.ambient.enabled — never schedules otherwise, so no permission prompts. Surfaces only
// NEW, deduped, redacted, non-quiet-hours signals via the existing out-of-band channels.
let _ambientTimer = null;
function startAmbient() {
  try {
    if (!ambient.isEnabled()) return;                 // master switch OFF → do nothing
    const cfg = ambient.loadConfig();
    const everyMs = Math.max(5, Number(cfg.intervalMin) || 30) * 60 * 1000;
    if (_ambientTimer) clearInterval(_ambientTimer);
    const tick = async () => {
      try {
        if (shouldSpareWatts()) return;                 // on battery + power-saver → skip background poll
        const res = await ambient.scan();
        if (!res || res.skipped || !res.signals || !res.signals.length) return;
        const brief = ambient.digest(res.signals);
        if (!brief) return;
        try { telegramNotify('🛰 ' + brief); } catch {}
        try { sendToActivity('tool-update', { type: 'thinking', text: '🛰 ambient: ' + brief.replace(/\n/g, ' ').slice(0, 200) }); } catch {}
        ambient.markSurfaced(res.signals);
      } catch (e) { console.error('[ambient] tick failed:', e.message); }
    };
    _ambientTimer = setInterval(tick, everyMs);
    setTimeout(tick, 15000);   // first pass once perms/window settle
    console.log('[ambient] started (every ' + (everyMs / 60000) + 'm)');
  } catch (e) { console.error('[ambient] start failed:', e.message); }
}

// --- Autonomous self-healing (#self_heal) — DISABLED unless config.selfHeal.enabled. ----------
// Wires the policy engine (lib/selfheal) to the real fixer (selfFix / Claude Code), git, notify,
// and the idle/clean-tree probes. Runs ONLY while the agent is idle; one fix at a time.
const SELF_HEAL_PROJ = process.env.BHATBOT_PROJECT || path.join(os.homedir(), 'bhatbot');
let _selfHealTimer = null;
function selfHealDeps() {
  return {
    runFix: selfFix,                                   // existing verify-gated Claude Code fixer
    notify: (t) => { try { telegramNotify(t); } catch {} try { sendToActivity('tool-update', { type: 'thinking', text: t }); } catch {} },
    runShell,
    proj: SELF_HEAL_PROJ,
    readAudit: () => { try { return readAudit(500); } catch { return []; } },
    probe: async () => {
      let treeClean = false;
      try { const r = await runShell('git status --porcelain', SELF_HEAL_PROJ, 15000); treeClean = !((r.stdout || '').trim()); } catch {}
      return { idle: agentState === 'idle', treeClean };
    },
  };
}
// Self-tests trigger: if the most recent smoke/eval run logged a FAIL recently, queue a fix whose
// verify re-runs that suite (so the fix is proven against the real failing test).
function scanSelfTestLogs() {
  const cfg = selfheal.cfgFrom(loadConfig);
  if (!cfg.triggers.selfTests) return;
  for (const [file, cmd] of [['SMOKE_LOG.md', 'npm run smoke'], ['EVAL_LOG.md', 'npm run eval']]) {
    try {
      const txt = fs.readFileSync(path.join(SELF_HEAL_PROJ, file), 'utf8');
      const sections = txt.split(/\n## /).filter(Boolean);
      const last = sections[sections.length - 1]; if (!last) continue;
      if (!/\bFAIL\b/.test(last)) continue;                       // latest run was clean
      const tsM = last.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
      const when = tsM ? new Date(tsM[1]).getTime() : 0;
      if (when && Date.now() - when > cfg.windowMin * 60 * 1000) continue;   // stale failure
      const fails = (last.match(/FAIL \*\*([^*]+)\*\*/g) || []).map((s) => s.replace(/FAIL \*\*|\*\*/g, '')).join(', ');
      selfheal.enqueue({ key: 'selftest:' + file + ':' + (tsM ? tsM[1] : ''), source: 'selfTests',
        problem: `The ${file.replace('_LOG.md', '').toLowerCase()} self-test suite is failing (${fails || 'see log'}). Diagnose and fix the underlying code so the suite passes.`,
        verify: `node scripts/verify-syntax.js && ${cmd}` }, loadConfig);
    } catch {}
  }
}
async function selfHealTick() {
  if (!selfheal.enabled(loadConfig)) return;
  if (agentState !== 'idle') return;                   // never fix mid-task
  try { scanSelfTestLogs(); } catch {}
  try {
    const r = await selfheal.tick(loadConfig, selfHealDeps());
    if (r && r.fixed) {
      console.log('[self-heal]', r.changed);
      // Feat-2 — relay what it fixed. Crash-sourced fixes are urgent → also call.
      const summary = `🔧 Self-repair: fixed an issue${r.changed ? ' (' + String(r.changed).slice(0, 200) + ')' : ''}. Verified and kept locally.`;
      try { telegramNotify(summary); } catch {}
      if (r.source === 'runtimeErrors' || r.urgent) { try { notifyUser(summary, 'call'); } catch {} }
    }
  } catch (e) { console.error('[self-heal] tick failed:', e.message); }
}
function startSelfHeal() {
  if (!selfheal.enabled(loadConfig)) { console.log('[self-heal] disabled (config.selfHeal.enabled !== true)'); return; }
  if (_selfHealTimer) return;
  _selfHealTimer = setInterval(selfHealTick, 15 * 60 * 1000);   // scan + at most one fix every 15m
  console.log('[self-heal] enabled — watching for mistakes (15m cycle, 1 fix at a time, never pushes)');
  setTimeout(selfHealTick, 60 * 1000);
}
function stopSelfHeal() { if (_selfHealTimer) { clearInterval(_selfHealTimer); _selfHealTimer = null; } console.log('[self-heal] stopped'); }
// Feat-2 — ambient proactive defaults + patrol. Self-heal auto-FIXES (verify-gated, auto-revert,
// never pushes); patrol MONITORS health and RELAYS to Telegram (calls if urgent). Both enabled by
// default per Siddhant's request; toggle via config.selfHeal.enabled / config.patrol.enabled.
let _crashCount = 0;
function crashCount() { return _crashCount; }
function enableProactiveDefaults() {
  try {
    const c = loadConfigRaw();
    const patch = { selfHeal: { ...(c.selfHeal || {}), enabled: true },
                    patrol: { intervalMin: 5, batteryAware: false, ...(c.patrol || {}), enabled: (c.patrol && c.patrol.enabled === false) ? false : true } };
    saveConfig(patch);
    console.log('[proactive] self-heal + patrol enabled (toggle: config.selfHeal.enabled / config.patrol.enabled)');
  } catch (e) { console.warn('[proactive] enable failed:', e.message); }
}
let _patrol = null;
function startPatrol() {
  try {
    _patrol = makePatrol({
      loadConfig, telegramNotify,
      notifyUser: (m, u) => notifyUser(m, u || 'call'),
      cloudConnected: () => !!(_cloudBridge && _cloudBridge.connected && _cloudBridge.connected()),
      selfhealStatus: () => { try { return selfheal.status(loadConfig); } catch { return {}; } },
      crashCount,
      // Always-plugged desktop → monitor aggressively. Battery-awareness is opt-IN now (default off).
      shouldSpare: () => (loadConfig().patrol || {}).batteryAware === true ? shouldSpareWatts() : false,
      snapshot: () => { try { return rstate.snapshot(); } catch { return {}; } },
      recentEvents: (n) => { try { return rstate.recentEvents(n); } catch { return []; } },
      log: (m) => console.log(m),
    });
    _patrol.start();
  } catch (e) { console.warn('[patrol] start failed:', e.message); }
}
// Runtime-crash trigger: an uncaught error is a mistake worth fixing. Guarded (enabled + trigger).
process.on('uncaughtException', (e) => {
  _crashCount++;
  try { rstate.event('error', { kind: 'uncaughtException', message: String(e && e.message || e).slice(0, 300) }); } catch {}
  console.error('[uncaught]', e && e.stack || e);
  try { selfheal.enqueue({ key: 'crash:' + String(e && e.message).slice(0, 60), source: 'runtimeErrors', problem: 'BhatBot threw an uncaught exception: ' + (e && e.stack ? e.stack.slice(0, 600) : String(e)) + '. Find and fix the root cause.', verify: 'node scripts/verify-syntax.js' }, loadConfig); } catch {}
});
process.on('unhandledRejection', (e) => {
  _crashCount++;
  try { rstate.event('error', { kind: 'unhandledRejection', message: String(e && e.message || e).slice(0, 300) }); } catch {}
  console.error('[unhandledRejection]', e && e.stack || e);
  try { selfheal.enqueue({ key: 'reject:' + String(e && e.message).slice(0, 60), source: 'runtimeErrors', problem: 'BhatBot had an unhandled promise rejection: ' + (e && e.stack ? e.stack.slice(0, 600) : String(e)) + '. Find and fix the root cause.', verify: 'node scripts/verify-syntax.js' }, loadConfig); } catch {}
});

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(tickScheduler, 30000);
  console.log('[scheduler] started (30s tick), ' + scheduler.list().length + ' schedule(s) loaded');
  setTimeout(tickScheduler, 4000);   // catch anything already overdue shortly after boot
}
async function tickScheduler() {
  if (schedulerBusy) return;                       // SERIAL: never run two scheduled tasks at once
  if (agentState !== 'idle') return;               // PRECEDENCE: yield to a live foreground turn; retry next tick
  let due = [];
  try { due = scheduler.due(Date.now()); } catch { return; }
  if (!due.length) return;
  // Idempotency: nextRun is a fixed past instant for daily/weekly/once and advanced by markRan,
  // so an overdue job (Mac was asleep) fires exactly ONCE on wake — no missed-tick storm.
  schedulerBusy = true;
  try {
    for (const s of due) {
      if (agentState !== 'idle') break;            // user started interacting → defer the rest to next tick
      if (schedulerRunning.has(s.id)) continue;
      schedulerRunning.add(s.id);
      try { await runScheduledTask(s); } catch {} finally { schedulerRunning.delete(s.id); }
    }
  } finally { schedulerBusy = false; }
}
async function runScheduledTask(s) {
  try {
    sendToActivity('tool-update', { type: 'thinking', text: '⏰ running scheduled: ' + s.title });
    const prompt = `[Scheduled task "${s.title}"] ${s.prompt}\n\nThis is a proactive/autonomous run (no one is watching the screen). Do the task, then reply with a SHORT spoken-style summary of what you did or found.`;
    const res = await agentLoop([{ role: 'user', content: prompt }], getApiKey(), { sender: { send() {} } });
    const text = (res && res.text) || 'done';
    if (s.announce !== false) { try { sayLocal(text.slice(0, 600)); } catch {} }
    if (s.notify !== false) { try { telegramNotify('⏰ ' + s.title + ':\n\n' + text); } catch {} }
    sendToActivity('tool-update', { type: 'thinking', text: '⏰ ' + s.title + ' → ' + text.slice(0, 200) });
    try { notion.logActivity({ event: 'scheduled: ' + s.title, tool: 'scheduler', result: text.slice(0, 200) }); } catch {}
  } catch (e) {
    console.error('[scheduler] task failed:', s.id, e.message);
    try { telegramNotify('⚠️ Scheduled task "' + s.title + '" failed: ' + e.message); } catch {}
  } finally {
    scheduler.markRan(s.id, Date.now());   // advance/disable AFTER running so a crash mid-run retries next tick
  }
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

// --- Chess (playable game window; rules engine inline, Stockfish online API for the AI) ---
function openChessWindow(difficulty) {
  try {
    fs.mkdirSync(STUDIO_DIR, { recursive: true });
    const asset = path.join(__dirname, 'assets', 'chess.html');
    if (fs.existsSync(asset)) fs.copyFileSync(asset, CHESS_HTML);   // keep the playable copy fresh
  } catch {}
  if (!fs.existsSync(CHESS_HTML)) return { success: false, error: 'chess.html asset is missing.' };
  if (chessWindow && !chessWindow.isDestroyed()) { chessWindow.show(); chessWindow.focus(); }
  else {
    chessWindow = new BrowserWindow({
      width: 720, height: 840, resizable: true, maximizable: true, minWidth: 380, minHeight: 480,
      title: 'BhatBot Chess', backgroundColor: '#0a0f17', webPreferences: { contextIsolation: true }
    });
    chessWindow.loadFile(CHESS_HTML);
    chessWindow.on('closed', () => { chessWindow = null; });
  }
  const diff = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : null;
  if (diff) {
    const wc = chessWindow.webContents;
    const apply = () => wc.executeJavaScript(`(()=>{const s=document.getElementById('diff'); if(s){s.value=${JSON.stringify(diff)}; s.dispatchEvent(new Event('change'));}})()`).catch(() => {});
    if (wc.isLoading()) wc.once('did-finish-load', apply); else apply();
  }
  return { success: true };
}

// Offline chess applet (standard + atomic), full legal-move enforcement (chess.js + lib/chessatomic).
// Loaded straight from assets/ so its ./vendor/ deps resolve; variant passed via query string.
let chessAppletWindow = null;
function openChessApplet(variant) {
  const asset = path.join(__dirname, 'assets', 'chessapplet.html');
  if (!fs.existsSync(asset)) return { success: false, error: 'chessapplet.html asset is missing.' };
  const v = variant === 'atomic' ? 'atomic' : 'standard';
  if (chessAppletWindow && !chessAppletWindow.isDestroyed()) { chessAppletWindow.show(); chessAppletWindow.focus(); chessAppletWindow.loadFile(asset, { query: { variant: v } }); return { success: true }; }
  chessAppletWindow = new BrowserWindow({
    width: 600, height: 760, resizable: true, minWidth: 420, minHeight: 560,
    title: 'BhatBot Chess — ' + v, backgroundColor: '#0a0f17', webPreferences: { contextIsolation: true },
  });
  chessAppletWindow.loadFile(asset, { query: { variant: v } });
  chessAppletWindow.on('closed', () => { chessAppletWindow = null; });
  return { success: true };
}

// --- Live World Cup 2026 viewer (auto-refreshing bracket + odds) ---
function openWorldCupWindow() {
  const asset = path.join(__dirname, 'assets', 'worldcup.html');
  if (!fs.existsSync(asset)) return { success: false, error: 'worldcup.html asset missing' };
  if (worldCupWindow && !worldCupWindow.isDestroyed()) { worldCupWindow.show(); worldCupWindow.focus(); return { success: true }; }
  worldCupWindow = new BrowserWindow({
    width: 1040, height: 860, resizable: true, minWidth: 520, minHeight: 480,
    title: 'World Cup 2026', backgroundColor: '#090d13',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload-worldcup.js') }
  });
  worldCupWindow.loadFile(asset);
  worldCupWindow.on('closed', () => { worldCupWindow = null; });
  return { success: true };
}
// Snapshot for the viewer — adds per-match win/draw/loss predictions for the upcoming fixtures.
ipcMain.handle('wc-snapshot', async () => {
  try {
    const s = await worldcup.snapshot({ ttlMs: 30000, sims: 6000 });
    const preds = {};
    for (const m of s.upcoming.slice(0, 12)) preds[m.id] = worldcup.predict(s.elo, m.home.abbr, m.away.abbr, { home: true });
    // strip the heavy raw match list the viewer doesn't need; keep what it renders
    return { fetchedAt: s.fetchedAt, stages: s.stages, matches: s.matches, tables: s.tables, odds: s.odds, live: s.live, upcoming: s.upcoming, preds };
  } catch (e) { return { error: e.message || String(e) }; }
});

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

// Generate a fresh MCP config so the EMBEDDED Claude Code can call BhatBot's own tools (run_task,
// status) over the local MCP server. Written to ~/.bhatbot (outside the repo → token never leaks);
// loaded via `claude --mcp-config`. Regenerated each launch so a rotated token always matches.
const CLAUDE_MCP_CONFIG = path.join(os.homedir(), '.bhatbot', 'claude-mcp.json');
function writeClaudeMcpConfig() {
  try {
    const c = loadConfig();
    if (c.mcpEnabled === false || !c.mcpToken) return null;
    const port = c.mcpPort || 8788;
    const cfg = { mcpServers: { bhatbot: { type: 'http', url: `http://127.0.0.1:${port}/mcp/${c.mcpToken}` } } };
    fs.mkdirSync(path.dirname(CLAUDE_MCP_CONFIG), { recursive: true });
    fs.writeFileSync(CLAUDE_MCP_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    return CLAUDE_MCP_CONFIG;
  } catch (e) { console.error('[claude-mcp] config write failed:', e.message); return null; }
}

function startPty(cols, rows) {
  if (ptyProc) { try { ptyProc.kill(); } catch {} ptyProc = null; }
  const pty = require('node-pty');
  const shell = process.env.SHELL || '/bin/zsh';
  const cwd = process.env.BHATBOT_PROJECT || os.homedir();
  // Launch Claude Code wired to BhatBot's MCP server (falls back to plain claude if unavailable).
  const mcpCfg = writeClaudeMcpConfig();
  const claudeCmd = mcpCfg ? `claude --mcp-config ${JSON.stringify(mcpCfg)}` : 'claude';
  ptyProc = pty.spawn(shell, ['-lc', `${claudeCmd} || exec ` + shell], {
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
      BHATBOT_BARGE_THRESH: String(wc.bargeInThreshold || 0.085),
      // Speaker-gated wake (#10/#19): only Siddhant's voice triggers it, and it learns his voice
      // online from each wake. "auto" gates once a profile exists; fail-opens if resemblyzer absent.
      BHATBOT_SPEAKER_GATE: wc.speakerGate != null ? String(wc.speakerGate) : 'auto',
      BHATBOT_SPEAKER_ADAPT: wc.speakerAdapt === false ? '0' : '1',
      BHATBOT_VOICEID_VENV: path.join(os.homedir(), '.bhatbot', 'voiceid-venv'),
      ...(wc.speakerThreshold != null ? { BHATBOT_SPEAKER_THRESH: String(wc.speakerThreshold) } : {}),
      ...(wc.micDevice != null ? { BHATBOT_MIC_DEVICE: String(wc.micDevice) } : {}) };
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
          if (ttsActive || agentState === 'running') {
            bargeInInterrupt();                              // stop speaking AND abort the turn → listen
            sendToActivity('tool-update', { type: 'thinking', text: '🎙 barge-in — stopped, listening' });
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('barge-in', {});
          }
        }
        else if (line === 'WAKE') { bargeInInterrupt(); triggerWake(''); }   // a spoken wake preempts the current turn
        else if (line.startsWith('CMD')) { bargeInInterrupt(); triggerWake(line.slice(3).trim()); }
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
    ttsSpeed: c.ttsSpeed != null ? c.ttsSpeed : 1.05,
    hasReplicateKey: !!c.replicateKey, hasImageGen: !!c.openaiKey
  };
});
// Live speaking-speed from the settings slider. Clamped to ElevenLabs' 0.7–1.2 range; read per
// utterance in elevenLabsSynth, so no restart needed. Returns the saved value.
ipcMain.handle('set-tts-speed', (_e, v) => {
  const n = Math.max(0.7, Math.min(1.2, Number(v) || 1.05));
  saveConfig({ ttsSpeed: n });
  return n;
});

// D — voice customizability. Read/write the JARVIS voice character live (synth reads config
// per-utterance, so a change takes effect on the very next spoken line — no restart).
ipcMain.handle('get-voice-settings', () => {
  const c = loadConfig();
  return { ...jarvisVoiceSettings(c), provider: c.ttsProvider || (c.elevenLabsKey ? 'elevenlabs' : null),
    voiceId: c.ttsVoice || c.elevenLabsVoiceId || 'pNInz6obpgDQGcFmaJgB', hasElevenLabs: !!c.elevenLabsKey };
});
const VOICE_SETTING_KEYS = {
  ttsStability: [0, 1], ttsSimilarity: [0, 1], ttsStyle: [0, 1], ttsSpeed: [0.7, 1.2],
};
ipcMain.handle('set-voice-setting', (_e, { key, value }) => {
  if (key === 'ttsSpeakerBoost') { const b = !!value; saveConfig({ ttsSpeakerBoost: b }); return { key, value: b }; }
  const range = VOICE_SETTING_KEYS[key];
  if (!range) return { error: 'unknown voice setting: ' + key };
  const n = Math.max(range[0], Math.min(range[1], Number(value)));
  if (!isFinite(n)) return { error: 'invalid value' };
  saveConfig({ [key]: n });
  return { key, value: n };
});

// Build/improve the JARVIS voice clone from audio sample files via ElevenLabs Instant Voice Cloning
// (POST /v1/voices/add, multipart). On success returns the new voice_id; caller persists it as the
// active voice so the next line uses the clone. Needs config.elevenLabsKey.
async function elevenLabsAddVoice(name, filePaths) {
  const c = loadConfig();
  if (!c.elevenLabsKey) return { error: 'no elevenLabsKey — set it in config to clone a voice' };
  if (!filePaths || !filePaths.length) return { error: 'no sample files' };
  try {
    const form = new FormData();
    form.append('name', name || 'JARVIS');
    form.append('description', 'BhatBot JARVIS voice (Instant Voice Clone from imported samples)');
    for (const fp of filePaths) {
      const buf = fs.readFileSync(fp);
      form.append('files', new Blob([buf]), path.basename(fp));
    }
    const r = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST', headers: { 'xi-api-key': c.elevenLabsKey }, body: form,
    });
    if (!r.ok) return { error: `elevenlabs ${r.status}: ${(await r.text()).slice(0, 240)}` };
    const j = await r.json();
    return { success: true, voiceId: j.voice_id, name: name || 'JARVIS' };
  } catch (e) { return { error: e.message }; }
}
ipcMain.handle('import-voice-samples', async () => {
  const c = loadConfig();
  if (!c.elevenLabsKey) return { error: 'Set elevenLabsKey in config first to clone a voice.' };
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const pick = await dialog.showOpenDialog(win, {
    title: 'Pick JARVIS voice samples (clean speech, 1–5 min total)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'webm'] }],
  });
  if (pick.canceled || !pick.filePaths.length) return { canceled: true };
  const out = await elevenLabsAddVoice('JARVIS', pick.filePaths);
  if (out.success) {
    // Make the new clone the active voice immediately (both keys synth reads).
    saveConfig({ ttsProvider: 'elevenlabs', ttsVoice: out.voiceId, elevenLabsVoiceId: out.voiceId });
  }
  return out;
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

// ---------------------------------------------------------------------------
// OmniParser worker (vision-driven desktop control, item 2). Persistent like kokoro: load the
// detection model once, then parse screenshots into a structured element map (type + caption +
// bbox) and click elements by coordinate. Runs under OmniParser's OWN venv (heavy ML deps),
// NOT resolvePython. The dir is external (excluded from the app bundle).
// ---------------------------------------------------------------------------
function omniDir() { return (loadConfig().omniparserDir || path.join(os.homedir(), 'bhatbot', 'OmniParser')); }
function omniPython() { return loadConfig().omniparserPython || path.join(omniDir(), '.venv', 'bin', 'python3'); }
function omniAvailable() { try { return fs.existsSync(path.join(omniDir(), 'weights', 'icon_detect', 'model.pt')) && fs.existsSync(omniPython()); } catch { return false; } }
let omniProc = null, omniReady = null, omniBuf = '', omniNextId = 1;
const omniPending = new Map();
function omniStart() {
  if (omniReady) return omniReady;
  omniReady = new Promise((resolve, reject) => {
    if (!omniAvailable()) { omniReady = null; return reject(new Error('OmniParser not installed (need ' + omniDir() + ' + its .venv)')); }
    const worker = unpacked(path.join(__dirname, 'scripts', 'omniparser_worker.py'));
    let settled = false;
    omniProc = spawn(omniPython(), [worker, omniDir()], { env: { ...process.env, PATH: EXEC_PATH } });
    omniProc.on('error', (e) => { if (!settled) { settled = true; reject(e); } cleanup(e); });
    omniProc.stderr.on('data', () => {});   // library noise → ignore
    omniProc.stdout.on('data', (d) => {
      omniBuf += d.toString();
      let nl;
      while ((nl = omniBuf.indexOf('\n')) >= 0) {
        const line = omniBuf.slice(0, nl).trim(); omniBuf = omniBuf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event === 'started' && !settled) { settled = true; resolve(); continue; }
        const p = omniPending.get(msg.id);
        if (p) { omniPending.delete(msg.id); p(msg); }
      }
    });
    omniProc.on('close', () => cleanup(new Error('omniparser worker exited')));
    function cleanup(err) { for (const [, p] of omniPending) p({ ok: false, error: err.message }); omniPending.clear(); omniProc = null; omniReady = null; omniBuf = ''; }
  });
  return omniReady;
}
function omniRequest(req, timeoutMs = 120000) {
  return new Promise(async (resolve) => {
    try { await omniStart(); } catch (e) { return resolve({ ok: false, error: e.message }); }
    if (!omniProc) return resolve({ ok: false, error: 'omniparser worker unavailable' });
    const id = omniNextId++;
    const timer = setTimeout(() => { omniPending.delete(id); resolve({ ok: false, error: 'omniparser timeout' }); }, timeoutMs);
    omniPending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    omniProc.stdin.write(JSON.stringify({ id, ...req }) + '\n');
  });
}
// Capture full-screen PNG (no downscale) for OmniParser. screencapture -x = silent main display.
function captureScreenPng() {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `bb-omni-${Date.now()}.png`);
    exec(`screencapture -x -t png "${out}"`, { timeout: 8000 }, (err) => {
      if (err) return resolve({ error: err.message });
      try { const b64 = fs.readFileSync(out).toString('base64'); fs.unlink(out, () => {}); resolve({ b64 }); }
      catch (e) { resolve({ error: e.message }); }
    });
  });
}
// Logical screen size in POINTS (CGEvent click space). Retina-independent of capture pixels.
function screenPoints() { try { const { screen } = require('electron'); const s = screen.getPrimaryDisplay().size; return { w: s.width, h: s.height }; } catch { return { w: 0, h: 0 }; } }


// Allowed Kokoro voices (guards against junk from the phone). British male/female first.
const KOKORO_VOICES = ['bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable', 'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily', 'am_michael', 'am_adam', 'af_bella', 'af_nicole'];
async function kokoroSynth(text, opts = {}) {
  if (!kokoroAvailable()) return { error: 'kokoro model not installed' };
  try { await kokoroStart(); } catch (e) { return { error: 'kokoro worker failed: ' + e.message }; }
  if (!kokoroProc) return { error: 'kokoro worker unavailable' };
  const c = loadConfig();
  const id = kokoroNextId++;
  const voice = (opts.voice && KOKORO_VOICES.includes(opts.voice)) ? opts.voice : (c.kokoroVoice || 'bm_george');
  let speed = Number(opts.speed != null ? opts.speed : (c.kokoroSpeed != null ? c.kokoroSpeed : (c.ttsSpeed != null ? c.ttsSpeed : 1.05)));
  if (!isFinite(speed)) speed = 1.05;
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

// Quota/auth-dead cooldown: tested 2026-06-12, an exhausted ElevenLabs quota 401s in ~250ms
// — but that's 250ms added to EVERY spoken sentence before the fallback kicks in. Mark the
// provider dead for 10 min on quota/auth failures and skip straight to Kokoro/OpenAI.
let _elDeadUntil = 0;
// ElevenLabs CONCURRENCY GUARD. EL subscriptions cap concurrent requests (6 on this plan); a burst of
// simultaneous synths (multiple surfaces speaking at startup) all fired before the first 429 set the
// cooldown → "concurrent_limit_exceeded" storm. Serialize EL requests through a small limiter so at
// most `ttsMaxConcurrent` (default 2, well under the cap) run at once; queued calls re-check the
// cooldown AFTER acquiring, so once one request 429s, the rest bail instantly instead of piling on.
function _makeLimiter(max) {
  let active = 0; const q = [];
  const pump = () => {
    if (active >= max || !q.length) return;
    active++; const { fn, res, rej } = q.shift();
    Promise.resolve().then(fn).then((v) => { active--; res(v); pump(); }, (e) => { active--; rej(e); pump(); });
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); pump(); });
}
let _elLimiter = null;
function elLimit(fn) {
  if (!_elLimiter) _elLimiter = _makeLimiter(Math.max(1, Number(loadConfig().ttsMaxConcurrent) || 2));
  return _elLimiter(fn);
}

// ONE source of truth for the JARVIS voice character (used by both the MP3 desktop path and the
// μ-law phone path). JARVIS = composed, precise, dry — so: higher stability (even, unflappable),
// strong similarity (hold the British clone timbre), LOW style (deadpan; theatrics ruin the wit),
// measured speed. Every field is config-overridable live (D1 voice-customizability hooks here).
function jarvisVoiceSettings(c) {
  return {
    stability: c.ttsStability != null ? c.ttsStability : 0.45,
    similarity_boost: c.ttsSimilarity != null ? c.ttsSimilarity : 0.85,
    style: c.ttsStyle != null ? c.ttsStyle : 0.22,        // dry deadpan; raise only if it sounds flat
    use_speaker_boost: c.ttsSpeakerBoost != null ? c.ttsSpeakerBoost : true,
    speed: Math.max(0.7, Math.min(1.2, Number(c.ttsSpeed) || 1.0)),  // deliberate, unhurried butler pace
  };
}

async function elevenLabsSynth(t, c, opts = {}) {
  if (!c.elevenLabsKey) return { error: 'no elevenLabsKey' };
  if (Date.now() < _elDeadUntil) return { error: 'elevenlabs cooling down (quota/auth)', cooldown: true };
  const voiceId = c.ttsVoice || c.elevenLabsVoiceId || 'pNInz6obpgDQGcFmaJgB';
  // flash_v2_5 = ElevenLabs' lowest-latency model (~75ms vs turbo's ~250-400ms), same
  // voices. optimize_streaming_latency=3 trims first-byte time further. Big speaking-speed win.
  const model = c.ttsModel || 'eleven_flash_v2_5';
  // (1) Cadence: flash/turbo v2.5 honor SSML <break>; v3 does not, so gate on the model.
  const supportsBreaks = c.ttsCadence !== false && /flash|turbo/i.test(model);
  const text = humanizeCadence(t, { breaks: supportsBreaks });
  // (3) Tuned conversational delivery — lower stability + a touch of style = livelier prosody
  // variation (less monotone); speaker_boost adds presence/warmth. All config-overridable.
  const vs = jarvisVoiceSettings(c);
  const body = { text, model_id: model, voice_settings: vs };
  // (2) Request stitching — give the model the surrounding sentences so prosody flows across
  // streamed chunks instead of resetting (no choppy "new sentence, fresh intonation" feel).
  if (opts.previousText) body.previous_text = String(opts.previousText).slice(-400);
  if (opts.nextText) body.next_text = String(opts.nextText).slice(0, 400);
  return elLimit(async () => {
    if (Date.now() < _elDeadUntil) return { error: 'elevenlabs cooling down (quota/auth)', cooldown: true };   // a queued sibling already 429'd
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128&optimize_streaming_latency=3`, {
      method: 'POST', headers: { 'xi-api-key': c.elevenLabsKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); return { success: true, audio: buf.toString('base64'), mimeType: 'audio/mpeg', via: 'elevenlabs' }; }
    const errText = (await r.text()).slice(0, 200);
    if (r.status === 401 || r.status === 429 || /quota_exceeded/.test(errText)) _elDeadUntil = Date.now() + 600000;
    return { error: `elevenlabs ${r.status}: ${errText}`, status: r.status };
  });
}

// Synthesize directly to 8kHz μ-law (Twilio Media Streams' native format) — no MP3 decode/transcode
// needed; the bytes drop straight into Twilio media frames. ElevenLabs JARVIS voice only (strict).
async function synthesizeUlaw(text, opts = {}) {
  const c = loadConfig();
  const t = String(text || '').trim();
  if (!t) return { error: 'empty text' };
  if (!c.elevenLabsKey) return { error: 'no elevenLabsKey (ElevenLabs voice is required for calls)' };
  if (Date.now() < _elDeadUntil) return { error: 'elevenlabs cooling down', cooldown: true };
  const voiceId = c.ttsVoice || c.elevenLabsVoiceId || 'pNInz6obpgDQGcFmaJgB';
  const model = c.ttsModel || 'eleven_flash_v2_5';
  const supportsBreaks = c.ttsCadence !== false && /flash|turbo/i.test(model);
  const body = {
    text: humanizeCadence(normalizeForSpeech(t), { breaks: supportsBreaks }),
    model_id: model,
    voice_settings: jarvisVoiceSettings(c),
  };
  if (opts.previousText) body.previous_text = String(opts.previousText).slice(-400);
  try {
    return await elLimit(async () => {                              // share the concurrency guard with the desktop path
      if (Date.now() < _elDeadUntil) return { error: 'elevenlabs cooling down', cooldown: true };
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000&optimize_streaming_latency=4`, {
        method: 'POST', headers: { 'xi-api-key': c.elevenLabsKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.ok) return { success: true, ulaw: Buffer.from(await r.arrayBuffer()) };
      const errText = (await r.text()).slice(0, 200);
      if (r.status === 401 || r.status === 429 || /quota_exceeded/.test(errText)) _elDeadUntil = Date.now() + 600000;
      return { error: `elevenlabs ${r.status}: ${errText}`, status: r.status };
    });
  } catch (e) { return { error: e.message }; }
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

// Make text sound HUMAN when spoken: expand symbols to words, say filenames/domains with
// "dot", reduce paths to their basename, strip markdown/code/URLs that read as gibberish.
// Applied ONLY on the audio path (synthesizeSpeech) — the on-screen text keeps its symbols.
function normalizeForSpeech(input) {
  let s = stripReasoning(String(input || ''));                 // never voice leaked <thinking>/meta
  // 1. Things that should never be read aloud.
  s = s.replace(/```[\s\S]*?```/g, ' ');                       // fenced code blocks
  s = s.replace(/`([^`]+)`/g, '$1');                           // inline code → its text
  s = s.replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1');             // [label](url) / ![alt](src) → label
  s = s.replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ');   // bare URLs (visual, not spoken)
  // 2. Markdown emphasis / structure → plain text.
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');                    // bold
  s = s.replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2');          // italic
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');                    // headers
  s = s.replace(/^\s*>\s?/gm, '');                             // blockquote
  s = s.replace(/^\s*([-*•]|\d+\.)\s+/gm, '');                 // list markers (-, *, •, 1.)
  // 3. File paths → just the basename ("~/.bhatbot/main.js" → "main.js"); the dirs are noise.
  //    Anchored to ~, .. or / after whitespace/start so dates like 6/12/2026 aren't mangled.
  s = s.replace(/(^|\s)((?:~|\.\.?)?\/(?:[\w.@%+-]+\/)+[\w.@%+-]*)/g, (_m, pre, p) => pre + (p.replace(/\/+$/, '').split('/').pop() || ''));
  // 4. Common abbreviations → spoken form.
  s = s.replace(/\be\.g\.,?/gi, 'for example,').replace(/\bi\.e\.,?/gi, 'that is,')
       .replace(/\betc\.?/gi, 'etcetera').replace(/\bvs\.?/gi, 'versus')
       .replace(/\bw\/\s/gi, 'with ').replace(/\baka\b/gi, 'also known as');
  // 4b. Domain/common abbreviations spoken in full (stats tables etc. read as letters otherwise).
  s = s.replace(/\bpts\b/gi, 'points').replace(/\bpt\b/g, 'point')
       .replace(/\bGD\b/g, 'goal difference').replace(/\bGF\b/g, 'goals for').replace(/\bGA\b/g, 'goals against')
       .replace(/\bxG\b/g, 'expected goals').replace(/\bapprox\.?/gi, 'approximately')
       .replace(/\bno\.\s?(?=\d)/gi, 'number ').replace(/\bmins\b/gi, 'minutes').replace(/\bhrs\b/gi, 'hours');
  // 5. Currency: "$5"→"5 dollars", "$5.99"→"5 dollars and 99 cents", "$1,200"→"1200 dollars".
  s = s.replace(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g, (_m, dollars, cents) => {
    const d = dollars.replace(/,/g, '');
    return d + (d === '1' ? ' dollar' : ' dollars') + (cents ? ' and ' + cents + ' cents' : '');
  });
  // 5b. Numeric RANGE with en/em dash → "to" ("xG 1.6–1.1" → "1.6 to 1.1", "2018–2022"). Plain
  //     hyphens are left alone (scores/records like 2-1 stay as the model wrote them).
  s = s.replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2');
  // 5c. Decimals → "X point Y" so percentages/ratios are unambiguous ("57.5%" → "57 point 5
  //     percent"). Runs AFTER currency (which already consumed $5.99) and BEFORE the dot→"dot"
  //     rule; digit.digit never hits the "dot" rule, only letter-adjacent dots do.
  s = s.replace(/(\d)\.(\d)/g, '$1 point $2');
  // 6. In-token dots → "dot" when the next char is a LETTER (filenames/domains/emails:
  //    "main.js"→"main dot js", "gmail.com"→"gmail dot com", "2008.co"→"2008 dot co", "co.uk"→
  //    "co dot uk"). Decimals like 3.5 (digit.digit) stay → TTS says "three point five"; and a
  //    sentence-ending period (followed by space/EOL, not a letter) stays as a natural pause.
  s = s.replace(/([A-Za-z0-9])\.(?=[A-Za-z])/g, '$1 dot ');
  // 7. Symbols → words.
  s = s.replace(/&/g, ' and ').replace(/%/g, ' percent')
       .replace(/(\S)@(\S)/g, '$1 at $2').replace(/\s@\s/g, ' at ')
       .replace(/#(\d+)/g, 'number $1').replace(/#/g, ' hash ')
       .replace(/\s\+\s/g, ' plus ').replace(/(\w)\s*=\s*(\w)/g, '$1 equals $2')
       .replace(/([A-Za-z])\/([A-Za-z])/g, '$1 slash $2')      // TCP/IP, and/or
       .replace(/°/g, ' degrees').replace(/\$(?=[A-Za-z])/g, '')
       .replace(/[~^|<>*$]/g, ' ');                            // leftover markup → space
  // 8. Tidy whitespace; keep ., ! ? ; : for natural pausing.
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
  return s || String(input || '').trim();
}

// Cadence humanization — make spoken delivery feel like a person talking, not a reader.
// `breaks` = true emits ElevenLabs SSML <break> tags (flash/turbo v2.5 support up to 3s; v3
// does NOT, so it's gated). breaks = false (kokoro/openai) leans on punctuation, which every
// neural TTS already interprets as timing. Kept CONSERVATIVE: ElevenLabs warns that excessive
// <break> use destabilizes prosody, so we cap how many we inject. Voice-cadence research:
// ellipses/dashes = micro-pauses, a beat after an opening discourse marker ("Right, …") reads
// as natural breathing, and a slightly longer beat between sentences mimics a real speaker.
const DISCOURSE_LEAD = /^(right|so|well|now|look|listen|honestly|actually|alright|okay|ok|hmm|ah|oh|sure|of course|indeed|very well|certainly)\b[,]?\s+/i;
function humanizeCadence(input, { breaks = false } = {}) {
  let s = String(input || '');
  if (!s) return s;
  const SHORT = breaks ? '<break time="0.2s"/>' : ',';
  const MED = breaks ? '<break time="0.3s"/>' : ' …';
  // Opening discourse marker → a brief beat after it ("Right, on it." → "Right,⟨beat⟩ on it.")
  s = s.replace(DISCOURSE_LEAD, (m) => m.replace(/[,\s]+$/, '') + (breaks ? SHORT + ' ' : ', '));
  // Ellipses = a trailing-off pause; em/en dashes and " - " = a mid-thought beat.
  s = s.replace(/\s*\.\.\.+\s*/g, breaks ? ' ' + MED + ' ' : ' … ');
  s = s.replace(/\s*[—–]\s*/g, breaks ? ' ' + SHORT + ' ' : ', ');
  s = s.replace(/\s+-\s+/g, breaks ? ' ' + SHORT + ' ' : ', ');
  if (breaks) {
    // NOTE: we deliberately do NOT inject a <break> between sentences — ElevenLabs already pauses
    // naturally at . ! ? and an extra break stacked on top made sentence-ends drag. Cap the beats
    // we DID add (ellipses/dashes/discourse) to avoid the documented prosody instability.
    const MAX = 6; let count = 0;
    s = s.replace(/<break[^>]*>/g, (t) => (++count > MAX ? '' : t));
  }
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

// Multi-provider TTS — kokoro (local neural, default), elevenlabs (cloud JARVIS), openai (onyx), piper (offline)
// Plain function so both the IPC handler (desktop HUD) and the express server (phone PWA) can call it.
async function synthesizeSpeech(text, opts = {}) {
  const c = loadConfig();
  const t = normalizeForSpeech((text || '').trim());   // humanize symbols/markdown for the spoken audio
  if (!t) return { error: 'empty text' };
  // Default to local Kokoro when installed (free, offline); honor explicit ttsProvider otherwise.
  const provider = c.ttsProvider || (kokoroAvailable() ? 'kokoro' : (c.elevenLabsKey ? 'elevenlabs' : (c.openaiKey ? 'openai' : (c.piperBin ? 'piper' : null))));
  const stitch = { previousText: opts.previousText, nextText: opts.nextText };
  try {
    if (provider === 'kokoro') {
      // kokoro can't parse SSML, but it does honor punctuation timing → punctuation-cadence.
      const r = await kokoroSynth(c.ttsCadence !== false ? humanizeCadence(t, { breaks: false }) : t, opts);
      if (r.success) return r;
      // worker died / not installed → fall back to cloud so voice never goes silent
      console.error('[tts] kokoro failed, falling back:', r.error);
      if (c.elevenLabsKey) { const e = await elevenLabsSynth(t, c, stitch); if (e.success) return e; }
      if (c.openaiKey) return await openaiSynth(t, c);
      return { error: 'kokoro failed and no cloud fallback: ' + r.error };
    }
    if (provider === 'elevenlabs') {
      const e = await elevenLabsSynth(t, c, stitch);
      if (e.success) return e;
      console.error('[tts] elevenlabs failed:', e.error);
      // STRICT (default): ElevenLabs-or-nothing — never substitute a different voice (user pays
      // for the EL subscription and wants exactly one voice). Set ttsStrict:false in config to
      // re-enable the Kokoro→OpenAI fallback if quota/network ever takes EL down.
      if (c.ttsStrict === false) {
        if (kokoroAvailable()) { const k = await kokoroSynth(t); if (k.success) return k; }
        if (c.openaiKey) return await openaiSynth(t, c);
      }
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
let ttsPlayProc = null, ttsPlaySeq = 0, ttsActive = false, ttsLastAudioSeq = 0;
// Tell the wake listener whether audio is playing, so its barge-in VAD only arms during
// playback (and uses the echo-rejection threshold then). Drives the `ttsActive` flag the
// barge-in handler checks.
function setTtsActive(on) {
  if (ttsActive === on) return;
  ttsActive = on;
  try { if (wakeProc && wakeProc.stdin && wakeProc.stdin.writable) wakeProc.stdin.write(on ? 'TTS 1\n' : 'TTS 0\n'); } catch {}
}
// Self-wake guard: when BhatBot's OWN speech contains a wake word ("Jarvis"/"BhatBot"),
// the mic hears it through the speakers and self-triggers. While such a clip plays we tell
// the listener to ignore wake hits (the listener also adds a short trailing grace for the
// echo tail). Energy-VAD barge-in is unaffected — Siddhant can still talk over it; only the
// wake WORD is suppressed, and only for clips that actually say the name.
const WAKE_WORD_RE = /\b(jarvis|bhat[\s-]?bot)\b/i;
function setWakeMute(on) {
  try { if (wakeProc && wakeProc.stdin && wakeProc.stdin.writable) wakeProc.stdin.write(on ? 'MUTE 1\n' : 'MUTE 0\n'); } catch {}
}
function stopDesktopTTS() {
  ttsPlaySeq++;
  if (ttsPlayProc) { try { ttsPlayProc.kill(); } catch {} ttsPlayProc = null; }
  setTtsActive(false);
  setWakeMute(false);   // clear any name-clip wake suppression on interrupt
}
// Barge-in (#19): true turn-taking — cancel in-flight speech AND abort the running agent turn so
// BhatBot actually STOPS and listens (not just goes quiet while it keeps working). The finished
// turn returns via finish('⏹ Stopped.') on the next loop check. Gated by config.bargeInAbortsTurn.
function bargeInInterrupt() {
  stopDesktopTTS();
  if (agentState === 'running' && loadConfig().bargeInAbortsTurn !== false) agentState = 'stopped';
}
// splitForSpeech moved to lib/pure.js (SPLIT_PLAN step 1).
function playFile(file, seq, text) {
  return new Promise((res) => {
    if (seq !== ttsPlaySeq) return res();
    ttsLastAudioSeq = seq;                               // ack watchdog: audio reached the speaker for this turn
    latMark('first-audio-playing');
    setTtsActive(true);                                  // arm barge-in for the duration of this clip
    const sayingName = WAKE_WORD_RE.test(String(text || ''));
    if (sayingName) setWakeMute(true);                   // don't let BhatBot's own "Jarvis" self-trigger the wake word
    ttsPlayProc = spawn('afplay', [file], { env: { ...process.env, PATH: EXEC_PATH } });
    const done = () => { fs.unlink(file, () => {}); if (seq === ttsPlaySeq) setTtsActive(false); if (sayingName) setWakeMute(false); res(); };
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
    await playFile(out, seq, chunks[i]);
    if (seq !== ttsPlaySeq) return { success: false, superseded: true };
  }
  return { success: true, via: 'tts' };
}
ipcMain.handle('play-tts', (_e, { text, full }) => speakDesktop(text, { full: !!full }));

// --- Streaming TTS: speak each sentence the moment it completes, while the model is still
// generating the next. First audio at ~sentence 1 (~2-3s) instead of after the whole reply
// + a summarize call. Shares ttsPlaySeq so a new turn cancels in-flight speech. ---
let ttsStreamSeq = 0, ttsStreamBuf = '', ttsStreamQ = [], ttsStreamDraining = false, ttsStreamProduced = false;
function ttsStreamStart() {
  stopDesktopTTS();
  ttsStreamSeq = ++ttsPlaySeq; ttsStreamBuf = ''; ttsStreamQ = []; ttsStreamDraining = false; ttsStreamProduced = false;
  return ttsStreamSeq;
}
// Tell the renderer speech has drained for this turn → conversation mode re-arms the mic. This
// MUST fire for every turn (even silent ones), or hands-free conversation wedges after one reply.
function emitTtsIdle(seq) {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tts-idle', { seq }); } catch {}
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
// Per-turn streaming parser. GUARANTEE: every reply is spoken as it streams.
//   • If the model uses <speak>…</speak> → speak ONLY that (brevity override: detail
//     stays on screen, a short line is read aloud).
//   • If the model omits <speak> → speak the ENTIRE visible reply, streamed sentence by
//     sentence (no more silent replies). Decision is made early so audio starts at ~the
//     first sentence; once committed to plain mode we never go silent.
// Handles tags split across deltas. ttsStreamFeed strips markdown/code before synth.
function makeSpeakStream(seq) {
  const OPEN = '<speak>', CLOSE = '</speak>';
  let pending = '', inside = false, sawTag = false, full = '', mode = 'undecided';
  const strip = (s) => s.replace(/<\/?speak>/g, '');
  function feed(delta) {
    full += delta;
    // Committed plain mode → fast path: everything visible is spoken.
    if (mode === 'plain') { const d = strip(pending + delta); pending = ''; if (d) { ttsStreamFeed(seq, d); recordSpoken(d); } return d; }
    pending += delta; let display = '';
    while (pending.length) {
      if (!inside) {
        const i = pending.indexOf(OPEN);
        if (i === -1) { const keep = partialTagTail(pending, OPEN); display += pending.slice(0, pending.length - keep); pending = pending.slice(pending.length - keep); break; }
        display += pending.slice(0, i); pending = pending.slice(i + OPEN.length); inside = true; sawTag = true; mode = 'tag';
      } else {
        const j = pending.indexOf(CLOSE);
        if (j === -1) { const keep = partialTagTail(pending, CLOSE); const emit = pending.slice(0, pending.length - keep); if (emit) { ttsStreamFeed(seq, emit); recordSpoken(emit); display += emit; } pending = pending.slice(pending.length - keep); break; }
        const segq = pending.slice(0, j); if (segq) { ttsStreamFeed(seq, segq); recordSpoken(segq); display += segq; } pending = pending.slice(j + CLOSE.length); inside = false;
      }
    }
    // No <speak> has appeared and we have enough signal (a sentence end or ~60 chars) →
    // commit to plain mode and speak everything streamed so far. Guarantees speech.
    if (mode === 'undecided') {
      const s = strip(full);
      if (s.length >= 60 || /[.!?\n]/.test(s)) { mode = 'plain'; if (s) { ttsStreamFeed(seq, s); recordSpoken(s); } pending = ''; }
    }
    return display;
  }
  function finish() {
    const display = strip(pending); pending = '';
    if ((inside || mode === 'plain') && display) { ttsStreamFeed(seq, display); recordSpoken(display); }
    // Reply too short to ever trip the threshold (e.g. "Done.") → speak it whole.
    else if (mode === 'undecided') { const f = strip(full).trim(); if (f) { ttsStreamFeed(seq, f); recordSpoken(f); } }
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
  latMark('ack-queued');
  ttsStreamFeed(seq, ACKS[Math.floor(Math.random() * ACKS.length)]);
}
// Watchdog behind maybeAck: guarantees SOME voice within ~5s of ANY message, not just
// action-shaped ones. If nothing has reached the speaker — and nothing is queued or mid-
// synthesis — by `ms`, speak a holding line. Audio lands at ms + one synth (~1s), well
// inside the 5s budget even on a cold router or slow first model token.
const HOLDING = ['One moment, sir.', 'Working on it, sir.', 'Just a moment, sir.'];
function armAckWatchdog(seq, ms = 2500) {
  return setTimeout(() => {
    if (seq !== ttsStreamSeq) return;                                            // a newer turn took over
    if (ttsLastAudioSeq === seq || ttsStreamQ.length || ttsStreamDraining) return; // audio flowing or imminent
    if (loadConfig().ttsEnabled === false || loadConfig().instantAck === false) return;
    latMark('ack-queued');
    ttsStreamEnqueue(seq, HOLDING[Math.floor(Math.random() * HOLDING.length)]);
  }, ms);
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
    markRouterCorrected();   // #13 — the prior turn's route led to a correction; feed the router data
    // last assistant text in history = what's being corrected
    let prior = priorText || '';
    if (!prior) { const a = [...(history || [])].reverse().find((m) => m.role === 'assistant'); if (a) prior = typeof a.content === 'string' ? a.content : (Array.isArray(a.content) ? a.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : ''); }
    // Self-heal corrections trigger: a BUG report (not a style nit) → queue a code fix. Style/tone
    // corrections ("be more concise") stay preference-only; functional breakage gets fixed.
    if (/\b(broke|broken|error|crash|crashed|doesn'?t work|didn'?t work|not working|failed|fails|bug|wrong (output|result|data|answer)|hallucinat|made up|fabricat|spoke|spoken|pronounc)\b/i.test(userText)) {
      try { selfheal.enqueue({ key: 'correction:' + userText.slice(0, 60), source: 'corrections', problem: `Siddhant reported a bug: "${userText.slice(0, 300)}". My prior reply/behavior: "${String(prior).slice(0, 300)}". Diagnose and fix the underlying code in the BhatBot repo.`, verify: 'node scripts/verify-syntax.js' }, loadConfig); } catch {}
    }
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
  const clean = stripReasoning(String(sentence)).replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '').trim();
  if (!clean) return;
  ttsStreamProduced = true;            // this turn put audio on the wire → drain will emit tts-idle
  ttsStreamQ.push(clean);
  if (!ttsStreamDraining) ttsStreamDrain(seq);
}
async function ttsStreamDrain(seq) {
  ttsStreamDraining = true;
  let prevSpoken = '';
  try {
    while (ttsStreamQ.length) {
      if (seq !== ttsStreamSeq) break;
      const s = ttsStreamQ.shift();
      latMark('tts-synth-start');
      // Request stitching: hand the synth the sentence just spoken + the one queued next so
      // prosody flows continuously across the stream instead of resetting each chunk.
      const r = await synthesizeSpeech(s, { previousText: prevSpoken, nextText: ttsStreamQ[0] || '' }).catch(() => null);
      prevSpoken = s;
      latMark('tts-synth-done');
      if (seq !== ttsStreamSeq) break;
      if (!r || !r.success) continue;
      const ext = (r.mimeType || '').includes('wav') ? 'wav' : 'mp3';
      const out = path.join(os.tmpdir(), `bb-stream-${seq}-${Math.random().toString(36).slice(2)}.${ext}`);
      try { fs.writeFileSync(out, Buffer.from(r.audio, 'base64')); } catch { continue; }
      await playFile(out, seq, s);
    }
  } finally {
    ttsStreamDraining = false;
    if (seq === ttsStreamSeq && !ttsStreamQ.length) emitTtsIdle(seq);
  }
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
  // 4) MID-history dangling tool_use (caused by concurrency/interruption — wake word firing a new
  //    turn between the assistant tool_use and its tool_results). The API rejects ANY tool_use that
  //    isn't immediately followed by matching tool_results, not just the trailing one. Repair by
  //    splicing in synthetic error results so the pairing is always intact. (#multi-step robustness)
  for (let i = 0; i < out.length; i++) {
    const ids = toolUseIds(out[i]);
    if (!ids.length) continue;
    const next = out[i + 1];
    const answered = (next && next.role === 'user' && Array.isArray(next.content))
      ? new Set(next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)) : new Set();
    const missing = ids.filter((id) => !answered.has(id));
    if (!missing.length) continue;
    const synth = missing.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '[interrupted — no result captured]', is_error: true }));
    if (next && next.role === 'user' && Array.isArray(next.content)) next.content.unshift(...synth);
    else out.splice(i + 1, 0, { role: 'user', content: synth });
    console.warn('[history] repaired', missing.length, 'dangling tool_use(s) at', i);
  }
  return out;
}
ipcMain.handle('stop-tts', () => { stopDesktopTTS(); return { success: true }; });

// Plain STT function (shared by desktop HUD + phone PWA). iOS MediaRecorder emits
// audio/mp4, not webm — derive the upload filename ext from mimeType so Whisper sniffs it.
// Bias STT toward the proper nouns + identifiers it would otherwise mishear ("Siddhant Pramod"
// → "Citadel Promote", saved login emails, brand words). Whisper/4o-transcribe accept a `prompt`
// of expected vocabulary. Seeded from config (ownerName/ownerEmail/sttVocab) + saved login usernames.
function sttVocabHint() {
  try {
    const c = loadConfig();
    const bits = ['BhatBot', 'Jarvis'];
    if (c.ownerName) bits.push(c.ownerName);
    if (c.ownerEmail) bits.push(c.ownerEmail);
    if (Array.isArray(c.sttVocab)) bits.push(...c.sttVocab);
    else if (typeof c.sttVocab === 'string' && c.sttVocab) bits.push(c.sttVocab);
    try { for (const p of (logins.list() || [])) if (p && p.username) bits.push(p.username); } catch {}
    const seen = new Set();
    const uniq = bits.filter((b) => b && !seen.has(String(b).toLowerCase()) && seen.add(String(b).toLowerCase()));
    return uniq.length ? ('Expected names/identifiers (spell exactly, keep emails lowercase): ' + uniq.join(', ') + '.') : '';
  } catch { return ''; }
}

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
  const hint = sttVocabHint();
  const attempt = async (model) => {
    const form = new FormData();
    form.append('model', model);
    form.append('file', new Blob([buf], { type: mt }), 'audio.' + ext);
    if (hint) form.append('prompt', hint);   // vocabulary biasing → fewer misheard names/emails
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

// Spoken output for direct callers (briefing, scheduled tasks, greeting, MCP/phone relays).
// ONE consistent voice: route through speakDesktop → the configured provider (ElevenLabs
// "Jarvis"). This also SERIALIZES with all other speech (speakDesktop cancels in-flight audio),
// so a briefing announce can't talk over the greeting. macOS `say` is a last resort only when
// no real TTS provider is configured or TTS is muted — it was the rogue second/third voice and
// ran as its own process that stopDesktopTTS couldn't cancel (→ overlapping voices).
function sayLocal(text) {
  const c = loadConfig();
  const t = String(text || '').slice(0, 600);
  if (!t.trim()) return { success: false };
  const hasProvider = c.ttsProvider || c.elevenLabsKey || c.openaiKey || c.piperBin || kokoroAvailable();
  if (c.ttsEnabled !== false && hasProvider) {
    speakDesktop(t, { full: true }).catch(() => {
      try { const p = spawn('say', ['-v', c.ttsLocalVoice || 'Daniel', t]); p.on('error', () => {}); } catch {}
    });
    return { success: true };
  }
  const v = c.ttsLocalVoice || 'Daniel';
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
  } catch {}
  const ct = costToday();                              // real token→USD spend, not a flat per-entry guess
  estimatedCost = ct.usd;
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
    costCalls: ct.calls, costByModel: ct.byModel, costByTool: ct.byTool || {},
    costToolUsd: ct.toolUsd || 0, dailyBudget: cfg.dailyBudgetUsd ?? null,
    router: routerStats().slice(0, 8),
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
  for (const p of r.filePaths) { blocks.push(...await mediaFileToBlocks(p)); names.push(path.basename(p)); rememberImagePath(p); }
  return { blocks, names };
});
ipcMain.handle('chat', async (event, { history }) => {
  const apiKey = getApiKey();
  if (!apiKey) return { error: 'No ANTHROPIC_API_KEY in env or ~/.bhatbot/config.json' };
  latStart();                                      // debugLatency checkpoint: message received
  noteActivity();                                  // user spoke/typed → keep the session alive
  // "wrap up" / "that's all" ends the session (note generated after the reply lands).
  const ut = lastUserText(history);
  const wrap = /\b(wrap up|wrap it up|that'?s all|we'?re done|end session|close out|debrief)\b/i.test(ut);
  // Pipeline toggle by voice/text — flips config.pipeline.enabled without the settings UI.
  const toggle = maybeTogglePipeline(ut);
  if (toggle) return { text: toggle, history: [...history, { role: 'assistant', content: toggle }] };
  // Voice-within-5s guarantee: own the TTS stream from the first millisecond. The ack
  // speaks immediately for action requests; the watchdog covers everything else if no
  // audio has reached the speaker by 2.5s (slow router / cold model / long trim).
  const ttsSeq = ttsStreamStart();
  maybeAck(ttsSeq, ut);
  const ackTimer = armAckWatchdog(ttsSeq);
  try {
    const ev = (event && event.sender ? event : { sender: { send() {} } });
    const res = await dispatchTurn(history, apiKey, ev, { stream: true, ttsSeq });
    if (wrap) setTimeout(() => endSession('wrap-up'), 1200);
    latMark('turn-complete');
    // Tell the renderer whether main actually spoke this turn (so a silent turn falls back to
    // renderer-side speech), and GUARANTEE the conversation re-arms: if nothing was queued the
    // drain never runs, so emit tts-idle here or hands-free mode wedges after one reply.
    if (res && typeof res === 'object') res._spoke = ttsStreamProduced;
    if (ttsSeq === ttsStreamSeq && !ttsStreamProduced && !ttsStreamQ.length && !ttsStreamDraining) emitTtsIdle(ttsSeq);
    return res;
  }
  catch (e) { clearTimeout(ackTimer); emitTtsIdle(ttsSeq); return { error: String(e && e.message ? e.message : e) }; }
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
  for (const p of (paths || [])) { try { blocks.push(...await mediaFileToBlocks(p)); names.push(path.basename(p)); rememberImagePath(p); } catch {} }
  return { blocks, names };
});
// Remember the most recently imported still image so make_printable can default to it
// ("drag a logo in, say 'make this a printable STL'").
let lastImagePath = null;
function rememberImagePath(p) { if (/\.(png|jpe?g|gif|webp|heic|heif)$/i.test(p || '')) lastImagePath = p; }
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
// In-chat holographic 3D viewer: feed model bytes to the renderer (no node access there).
ipcMain.handle('read-model', (_e, p) => {
  try {
    if (!p || !/\.(glb|gltf|stl|obj)$/i.test(p) || !fs.existsSync(p)) return null;
    if (fs.statSync(p).size > 80 * 1048576) return null;   // keep IPC payloads sane
    return { data: fs.readFileSync(p).toString('base64'), ext: path.extname(p).slice(1).toLowerCase(), name: path.basename(p) };
  } catch { return null; }
});
ipcMain.handle('open-3d-viewer', (_e, p) => { openInteractive3D(p); return true; });

// ---------------------------------------------------------------------------
// macOS privacy permissions (Screen Recording + Accessibility)
// ---------------------------------------------------------------------------
// Native control (vision_click / native login / AppleScript) needs Accessibility, and
// vision (screen_parse) needs Screen Recording. macOS only surfaces an app in System
// Settings → Privacy once the app actually *asks*. So we ask: Accessibility via the
// official prompt API, Screen Recording by attempting a 1px capture (which trips the
// TCC prompt the first time). If a permission is already denied (user said no earlier,
// so no prompt re-appears), we deep-link straight to the right Settings pane.
function permStatus() {
  if (process.platform !== 'darwin') return { ok: true, screen: 'granted', accessibility: true };
  let screenStat = 'unknown';
  try { screenStat = systemPreferences.getMediaAccessStatus('screen'); } catch {}
  let acc = false;
  try { acc = systemPreferences.isTrustedAccessibilityClient(false); } catch {}
  return { ok: screenStat === 'granted' && acc, screen: screenStat, accessibility: acc };
}
const SETTINGS_SCREEN = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const SETTINGS_ACCESS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
let permRequestedOnce = false;
async function ensurePermissions({ openSettings = false, force = false } = {}) {
  if (process.platform !== 'darwin') return { ok: true };
  const before = permStatus();
  if (before.ok && !force) return { ...before, alreadyGranted: true };
  // Accessibility: the `true` arg makes macOS pop the system prompt (and list the app).
  let accNow = before.accessibility;
  if (!accNow) { try { accNow = systemPreferences.isTrustedAccessibilityClient(true); } catch {} }
  // Screen Recording: a real capture attempt triggers the first-run TCC prompt.
  if (before.screen !== 'granted') {
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    } catch {}
  }
  const after = permStatus();
  // If still denied (prompt won't re-show after a prior "Don't Allow"), or caller asked,
  // jump the user to the exact Settings panes so the toggle is one click away.
  if (openSettings || (!after.accessibility && before.accessibility === after.accessibility && permRequestedOnce)) {
    try { if (after.screen !== 'granted') shell.openExternal(SETTINGS_SCREEN); } catch {}
    try { if (!after.accessibility) setTimeout(() => shell.openExternal(SETTINGS_ACCESS), 600); } catch {}
  }
  permRequestedOnce = true;
  return after;
}
ipcMain.handle('ensure-permissions', (_e, opts) => ensurePermissions(opts || { openSettings: true }));
ipcMain.handle('perm-status', () => permStatus());

// Automation (Apple events) permission for the apps BhatBot scripts. macOS only shows the
// "BhatBot wants to control Notes" prompt when the app actually sends an event — so we send a
// harmless one to each (with a short timeout so it can't hang) while the user is watching at
// launch. Granting these stops the AppleEvent timeouts that blocked Notes/Reminders in testing.
// Done once (config.automationPrimed) unless forced via the request_permissions tool.
// Surface the macOS Automation consent prompts for every app BhatBot drives via Apple events, so
// they appear under System Settings → Privacy & Security → Automation. Any Apple event triggers
// the prompt, so the exact command doesn't matter — we use a harmless per-app probe. Reminders,
// Mail (ambient awareness), Calendar, Notes, Music, Contacts, System Events (GUI scripting).
const AUTOMATION_APPS = [
  ['Reminders', 'count (every list)'],
  ['Calendar', 'count (every calendar)'],
  ['Mail', 'count (every account)'],
  ['Notes', 'count (every folder)'],
  ['Music', 'count (every playlist)'],
  ['Contacts', 'count (every person)'],
  ['System Events', 'count (every process)'],
];
const AUTOMATION_VERSION = 2;   // bump when AUTOMATION_APPS changes so installs re-prime the new apps
function primeAppAutomation(force = false) {
  if (process.platform !== 'darwin') return [];
  const c = loadConfig();
  if (!force && c.automationPrimed === AUTOMATION_VERSION) return [];
  const primed = [];
  for (const [app, probe] of AUTOMATION_APPS) {
    try {
      const p = spawn('osascript', ['-e', `with timeout of 6 seconds`, '-e', `tell application "${app}" to ${probe}`, '-e', `end timeout`], { env: { ...process.env, PATH: EXEC_PATH } });
      p.on('error', () => {});
      setTimeout(() => { try { p.kill(); } catch {} }, 8000);   // never leave a prompt-blocked osascript hanging
      primed.push(app);
    } catch {}
  }
  saveConfig({ automationPrimed: AUTOMATION_VERSION });
  return primed;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  try {
    migrateSecretsToVault();   // Phase 4 #1 — vault any plaintext secrets BEFORE anything (cloud bridge, MCP) reads them
    createWindow();
    mainWindow.show();
    if (!globalShortcut.register(HOTKEY, toggleWindow)) console.warn('Hotkey failed — may be claimed by another app.');
    startWakeHelper();
    // Ask for Screen Recording + Accessibility on launch so they appear in System Settings.
    // Deferred 1.5s so it doesn't fight the window-show animation. Opens the Settings pane
    // only if a permission is missing AND the silent prompt couldn't surface it.
    setTimeout(() => { ensurePermissions({ openSettings: false }).then((p) => { if (!p.ok) ensurePermissions({ openSettings: true }); }).catch(() => {}); }, 1500);
    // Surface the Notes/Reminders/Calendar Automation prompts once (so they appear in Settings).
    setTimeout(() => { try { primeAppAutomation(false); } catch {} }, 3500);
    initMcpServer();
    startCloudBridge();   // connect to the cloud backend as its Mac executor (if configured)
    offerBriefingOnOpen();   // Feat-1: no auto-briefing — OFFER one if idle after open (he picks the kind)
    setTimeout(() => { syncMemoryFromNotion(); }, 8000);   // write-through reconcile from the Notion SoT
    startTelegramBridge();
    // Feat-1: clock-scheduled auto morning briefing removed — briefings are on demand now. (scheduleBriefing()
    // remains available; re-enable by calling it if you ever want the timed brief back.)
    startScheduler();   // proactive recurring/one-off tasks
    startAmbient();     // #18 opt-in ambient awareness (no-op unless config.ambient.enabled)
    // Live state feed (state.json + events.jsonl) — bind main's live values, then persist on a loop.
    rstate.bind({
      agent: () => ({ state: agentState, lastUser: String(_lastUserText || '').slice(0, 200) }),
      health: () => ({
        cloud: !!(_cloudBridge && _cloudBridge.connected && _cloudBridge.connected()),
        elevenLabsCooldownMs: Math.max(0, _elDeadUntil - Date.now()),
        crashes: _crashCount,
        selfHeal: (() => { try { return selfheal.status(loadConfig); } catch { return {}; } })(),
      }),
      jobs: () => { try { return jobsBus.active(); } catch { return []; } },
    });
    rstate.startSnapshotLoop(5000);
    enableProactiveDefaults();   // Feat-2: turn on self-heal + ambient patrol by default (Siddhant asked for it)
    startSelfHeal();    // autonomous self-healing (verify-gated, auto-revert, never pushes)
    startPatrol();      // Feat-2: ambient health watch → relay via Telegram, call if urgent
    // Pre-warm local Kokoro TTS so the first spoken reply isn't cold (~0.8s load), then give a
    // short spoken "ready" confirmation once warm (ambient mode has no visual chat affordance,
    // so the greeting tells you BhatBot is live and listening). Fires once.
    let greeted = false;
    const greet = () => { if (greeted) return; greeted = true; try { speakDesktop('BhatBot online. Say Jarvis when you need me.', { full: true }); } catch {} };
    if (kokoroAvailable()) kokoroStart().then(() => { console.log('[tts] kokoro warm (local)'); greet(); }).catch((e) => { console.error('[tts] kokoro warmup failed:', e.message); greet(); });
    else setTimeout(greet, 900);   // cloud TTS (ElevenLabs/OpenAI): no local warmup needed
  } catch (e) { console.error('Startup error:', e); }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  try { await saveBrowserBounds(); } catch {}
  try { await saveBrowserState(); } catch {}
  try { if (browserContext) await browserContext.close(); else if (browser) await browser.close(); } catch {}
  try { if (wakeProc) wakeProc.kill(); } catch {}
  try { if (ptyProc) ptyProc.kill(); } catch {}
  try { if (kokoroProc) kokoroProc.kill(); } catch {}
  try { stopMcpServer(); } catch {}
  try { if (briefingTimer) clearTimeout(briefingTimer); } catch {}
  try { if (telegramBot) telegramBot.stopPolling(); } catch {}
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
