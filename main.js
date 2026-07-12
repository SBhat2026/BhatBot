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
const procedural = require('./lib/procedural');         // procedural memory — learned recurring step-series (faster over time)
const { createReadCache } = require('./lib/readcache'); // shared TTL read-cache: fleet dedup + speculative prefetch
const imagesearch = require('./lib/imagesearch');       // keyless real-photo search for the visual canvas + option cards
const studioscene = require('./lib/studioscene');       // deterministic Three.js scene skeleton + multi-part stitch
const risk = require('./lib/risk');                    // W3 tool tiers + Phase 6 desire classification + frozen-zone gate
const { riskOf } = risk;                               // per-tool key-risk classification (auto|confirm|stepup)
const graph = require('./lib/graph');                  // W4 — knowledge-graph memory (entities + typed edges, multi-hop)
const sandbox = require('./lib/sandbox');              // W6 — worker_threads isolation for community/dynamic plugin tools
const a2a = require('./lib/a2a');                       // W7 — agent-to-agent handoff envelope (future-proof subagent routing)
const subagents = require('./lib/subagents');          // #20 — persistent specialized sub-agents (research/coding/lifeadmin)
const agentTeam = require('./lib/orchestrator');        // C — parallel same-task ensemble + independent app-tester
const planner = require('./lib/planner');               // B1 — decompose a goal into a task DAG for the team
const ambient = require('./lib/ambient');              // #18 — opt-in proactive Calendar/Mail awareness (OFF by default)
const phonemirror = require('./lib/phonemirror');       // iPhone Mirroring glue — open/focus + gesture shortcuts + window geometry for the phone_mirror tool
const { textHintFromSelector, splitForSpeech, estimateToolCost, stripReasoning, classifySpeech, createSpeechNormalizer, isPromissory, shouldExtendBudget, toolSig, progressLine, classifyIntake, conversationContinuity } = require('./lib/pure');  // SPLIT_PLAN step 1
const WebSocket = require('ws');
const { createTtsWs } = require('./lib/ttsws');   // T1 — continuous ws streaming TTS transport (config.ttsTransport==='ws')
const speech = require('./lib/speech');                 // human-speech shaping: emoji→spoken-cue/drop + context-aware punctuation
const { validateHistory, sealDanglingToolUse, evictOldImages, isRetryableTool, TRANSIENT_RE } = require('./lib/history');  // SPLIT_PLAN step 9 (pure agent-loop helpers)
const projects = require('./lib/projects');            // #24 — project memory + living auto-summary
const visualInspect = require('./lib/inspect');
const security = require('./lib/security');          // P0.4 — injection sanitizer + daily audit
const notion = require('./lib/notion');               // P3  — Notion long-term memory (degrades gracefully)
const google = require('./lib/google');               // Gmail + Calendar + Drive (one OAuth2, degrades gracefully)
const routermodel = require('./lib/routermodel');     // learned text→tier router (shadow → active); degrades to regex
const bioart = require('./lib/bioart');               // NIH BioArt — public-domain scientific illustrations
const memmaint = require('./lib/memmaint');           // always-on memory maintenance (decay/dedup + log bounding)
const { createTurnState } = require('./lib/turnstate'); // T2 — single display-state reducer for a turn (never-quiet snapshot)
const brain = require('./lib/brain');                 // SYNAPSE — second-brain hybrid knowledge graph (nodes/edges + Connector)
const resolve = require('./lib/resolve');             // DaVinci Resolve native bridge (Python scripting API)
const mcphub = require('./lib/mcphub');               // MCP-client hub — consume external MCP servers as plugins
const figures = require('./lib/figures');             // data-accurate matplotlib/seaborn figures
const logins = require('./lib/logins');               // domain-keyed login profiles (CRED_REF handles)
const modePrompts = require('./lib/prompts');         // P4  — mode-switching system prompts
const jobsBus = require('./lib/jobs');                // P5  — background job bus (task cards + spoken relay + steering)
const scheduler = require('./lib/scheduler');         // proactive scheduler (recurring/one-off autonomous tasks)
const simulate = require('./lib/simulate');           // physics/chem/math simulation sandbox (scipy/sympy/rdkit/openmm/pyscf…)
const selfheal = require('./lib/selfheal');           // autonomous self-healing (DISABLED by default; verify-gated self_fix loop)
const selfdrive = require('./lib/selfdrive');         // Phase 6 — ON-DEMAND self-improvement governor (reflect→pipeline→implement→verify; never pushes)
const garmin = require('./lib/garmin');               // Health — native Garmin link (python venv worker; same lib the eddmann MCP wraps)
const health = require('./lib/health');               // Health — biometric trend/flag analysis + non-medical insights
const opsstatus = require('./lib/opsstatus');         // Manage — live "what is BhatBot managing" aggregator
const localstt = require('./lib/localstt');           // Voice — offline mlx-whisper STT fallback (no cloud key)
let _lastRetryAfterMs = 0;                            // last 429 Retry-After (ms) — self-drive budget governor reads it
let _pendingSelfDrive = null;                         // Phase 6: a reflection-sanctioned session to start once the turn goes idle
let _opusApproved = false;                            // session flag: user OK'd Opus for heavy tasks (asked once per session)
let _pendingOpusTask = null;                          // a heavy turn parked awaiting Opus approval ({history, at})
let _opusSuppressAsk = false;                         // one-shot: re-run the parked task WITHOUT re-asking (user declined Opus)
// T5/T6 — learned spoken-length loop. One "just-spoken" turn is held and its OUTCOME (interrupted@N /
// under / clean) is resolved on the NEXT user turn, then appended to spoken.jsonl (like depth's priorOut).
let _currentUserPrompt = '';
let _spk = { replyText: '', userPrompt: '', words: 0, bargedAt: null, at: 0 };
let _spkFinalizeCount = 0;
function countWords(s) { return (String(s || '').match(/[\w'-]+/g) || []).length; }
// Resolve the previous spoken turn against what the user just did, append a labeled row, retrain.
function finalizeSpokenRow(nextUserText) {
  try {
    if (!_spk.replyText) { _spk = { replyText: '', userPrompt: '', words: 0, bargedAt: null, at: 0 }; return; }
    const f = spokenmodel.extractFeatures(_spk.replyText, _spk.userPrompt);
    const { outcome, interrupt_at } = spokenmodel.labelOutcome({ bargedAt: _spk.bargedAt, nextUserText });
    const to_next_ms = outcome === 'clean' ? Date.now() - (_spk.at || Date.now()) : null;
    const row = { at: _spk.at, outcome, spoken_words: _spk.words, interrupt_at, to_next_ms, qtype: f.qtype, struct: f.struct_type, f };
    try { fs.mkdirSync(path.dirname(spokenmodel.DATASET), { recursive: true }); fs.appendFileSync(spokenmodel.DATASET, JSON.stringify(row) + '\n'); } catch {}
    try { spokenmodel.maybeRetrain(); } catch {}
    if (++_spkFinalizeCount % 10 === 0) { try { const L = spokenmodel.computeL(spokenmodel.readRows(), { lambda: loadConfig().spokenLambda || 1.0 }); if (L.L != null) console.log(`[spoken] L=${L.L} (interrupt ${L.interrupt_rate}, under ${L.underinform_rate}, n=${L.n})`); } catch {} }
  } catch {}
  _spk = { replyText: '', userPrompt: '', words: 0, bargedAt: null, at: 0 };
}
const vanguard = require('./lib/vanguard');           // Phase 1 — unified VANGUARD fleet codename roster (OVERMIND/FORGE/ORACLE/…)
const { createAdmission } = require('./lib/admission'); // Phase 1 — budget-aware fleet admission controller (convoy fix)
const blackboard = require('./lib/blackboard');        // FORGE — shared cross-agent state (T5)
const { runFleet } = require('./lib/fleet');           // FORGE — drone fleet supervisor (D1)
const scholar = require('./lib/integrations/scholar');  // FORGE — scholarly adapters (arXiv/Semantic Scholar)
const scicompute = require('./lib/scicompute');         // quant/numerics/stats/MPS-torch compute pack (sci_compute)
const dockerPack = require('./lib/integrations/docker'); // container isolation lane (container_run)
const { createEndpointer } = require('./lib/endpoint');  // adaptive, speaker-gated utterance endpointing
const voiceid = require('./lib/voiceid');                // T3 — speaker verification (cocktail-party post-filter)
const spokenmodel = require('./lib/spokenmodel');        // T5 — learned spoken-length model (density→compression)

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
const MODEL_HAIKU = 'claude-haiku-4-5';        // RETIRED from routing — kept only for legacy price/rate maps
const MODEL_OPUS = 'claude-opus-4-8';          // deepest reasoning — reserved for HEAVY tasks (sims, heavy coding+interpretation)
const MODEL_FABLE = 'claude-fable-5';          // native subagents + high autonomy — opt-in heavy/autonomous tier (config.useFable)
const MAX_AGENT_ITERATIONS = 20;   // step ceiling; complex tasks need headroom to retry/replan
// TIER-2 THROUGHPUT: tools that are READ-ONLY / side-effect-free / order-independent, so when the
// model fires several in one turn they can run CONCURRENTLY (the higher per-minute cap serves the
// burst — proven 4×+ in scripts/parallel-bench). Stateful/mutating tools (browser page, run_shell,
// write_file, vision_click, screen_parse's shared worker, save_memory, system/media_control) are
// deliberately EXCLUDED and always run sequentially in order.
// Tools with NO side effects and no shared-resource contention → safe to run CONCURRENTLY when the
// model fires a burst of them in one turn (main loop + every sub-agent/drone loop). Excludes anything
// that writes, mutates shared state, or contends a single resource (screen/browser/GPU/vision model).
const PARALLEL_SAFE = new Set([
  'read_file', 'list_directory', 'fetch_url', 'web_search', 'news', 'world_cup', 'notion_search',
  'ask_ai', 'keychain_lookup', 'onepassword_lookup', 'predict_function', 'maps', 'molecule', 'weather',
  'find_papers', 'math_reason', 'ops_status', 'generate_totp',
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
let _lastActivityTs = Date.now();   // Task 5 — last real turn, gates the opt-in cache keep-alive
function markActivity() { _lastActivityTs = Date.now(); }
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
const PROCEDURAL_PATH = path.join(os.homedir(), '.bhatbot', 'procedural.json');   // learned step-series
// Read tools whose results are content-stable enough to cache briefly (fleet dedup + prefetch).
// NEVER credential tools (keychain/1Password/TOTP), nothing that mutates, nothing time-critical.
const READ_CACHEABLE = new Set([
  'read_file', 'list_directory', 'fetch_url', 'web_search', 'find_papers',
  'predict_function', 'molecule', 'maps', 'math_reason',
]);
const _readCache = createReadCache();   // process-global → every agent/suit/drone shares it
const pendingConfirms = new Map();
let pendingGuidance = [];   // live feedback queued mid-task (steering)
const MAX_GUIDANCE_CHARS = 500;   // cap total queued steering text so a garbage burst can't balloon a turn
let terminalWindow = null;   // other secondary-window state (nexus/studio/chess/worldcup/viewer/mol/maps) lives in window-manager.js
let ptyProc = null, wakeProc = null;   // studioWatcher moved to window-manager.js

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

// Self-heal: if config.json lost a vaulted secret's CRED_REF pointer (config.json was rewritten/reset
// while the encrypted vault persisted — this silently broke the agent with "No ANTHROPIC_API_KEY"
// even though the key was safe in the vault), restore the newest ref per known secret field. Only
// fills fields that are MISSING (never clobbers a present value), so it's safe + idempotent.
const VAULT_FIELDS = ['apiKey', 'openaiKey', 'geminiKey', 'darkbloomKey', 'googleKey', 'elevenLabsKey', 'replicateKey', 'telegramToken', 'spotifyClientSecret', 'spotifyRefreshToken', 'gmailAppPassword', 'twilioToken', 'cloudToken'];
function reconcileVaultRefs() {
  try {
    const raw = loadConfigRaw();
    let entries; try { entries = credentials.list(); } catch { return; }
    const byLabel = {};
    for (const e of entries) { if (!e.label) continue; (byLabel[e.label] = byLabel[e.label] || []).push(e.ref); }
    const newest = (label) => {
      const refs = byLabel[label] || []; if (!refs.length) return null;
      const pre = 'CRED_REF_' + String(label).toUpperCase().replace(/\W+/g, '_') + '_';
      return refs.slice().sort((a, b) => (a.slice(pre.length) < b.slice(pre.length) ? -1 : 1)).pop();
    };
    const add = {};
    for (const f of VAULT_FIELDS) { if (!raw[f]) { const r = newest(f); if (r) add[f] = r; } }
    if (Object.keys(add).length) { saveConfigRaw({ ...raw, ...add }); console.log('[config] restored ' + Object.keys(add).length + ' vault ref(s) lost from config.json: ' + Object.keys(add).join(', ')); }
  } catch (e) { console.warn('[config] reconcileVaultRefs failed:', e.message); }
}

// Bridge resolved secrets into process.env so PURE libs that read config.json directly (and thus
// see the raw CRED_REF handle, not the resolved value) get the real key. semantic.js embeddings
// read process.env.OPENAI_API_KEY first — without this, a vaulted openaiKey shipped the handle to
// OpenAI → 401 → every embedding skipped → semantic recall returned nothing (BhatBot "forgot"
// everything / couldn't surface project context). Only sets keys not already present in env.
function syncResolvedSecretsToEnv() {
  try {
    const c = loadConfig();   // CRED_REF_* already resolved in-process (safeStorage)
    const map = { OPENAI_API_KEY: c.openaiKey, GEMINI_API_KEY: c.geminiKey };
    let n = 0;
    for (const [k, v] of Object.entries(map)) {
      if (v && !String(v).startsWith('CRED_REF') && !process.env[k]) { process.env[k] = v; n++; }
    }
    if (n) console.log('[config] bridged ' + n + ' secret(s) to env for pure libs (semantic recall)');
  } catch (e) { console.warn('[config] syncResolvedSecretsToEnv failed:', e.message); }
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

// Procedural recall (tier 7 — learned step-series). Cheap + synchronous (keyword match, no embeddings):
// look up routines that worked for tasks like THIS one, stash the hint block for buildMemoryBlock, and
// remember the top routine id so finish() can reinforce/decay it by outcome. If the top routine records
// a concrete read as its first step, SPECULATIVELY PREFETCH it now — warm before the model even asks.
let _proceduralRecall = { key: '', text: '', routineId: null };
function refreshProceduralRecall(query) {
  try {
    if (loadConfig().procedural === false) { _proceduralRecall = { key: '', text: '', routineId: null }; return; }
    const key = notionRecallKey(query);
    if (!key) { _proceduralRecall = { key: '', text: '', routineId: null }; return; }
    if (key === _proceduralRecall.key) return;                            // dedupe identical consecutive turns
    const c = loadConfig();
    const hints = procedural.recall(PROCEDURAL_PATH, query, { limit: c.proceduralRecallK || 3, minUses: c.proceduralMinUses, minScore: c.proceduralMinScore });
    _proceduralRecall = { key, text: hints.length ? procedural.format(hints) : '', routineId: hints[0] ? hints[0].id : null };
    if (hints.length) console.log(`[procedural] ↻ ${hints.length} learned routine(s) for this task (top ${Math.round(hints[0].confidence * 100)}% / ${hints[0].uses}×)`);
    // AUTO-RUN READ-ONLY PREFIX (Siddhant's choice): for a confident match, execute the top routine's
    // leading read-only steps NOW — into the shared cache, while the model call is still in flight — so
    // their results are ready the instant the model asks. Read-only + cacheable only; never mutations.
    const top = hints[0];
    if (top && loadConfig().proceduralPrefetch !== false && Array.isArray(top.readPrefix) && top.readPrefix.length) {
      const minConf = loadConfig().proceduralAutorunConfidence != null ? loadConfig().proceduralAutorunConfidence : 0.6;
      if (top.pinned || top.confidence >= minConf) {
        for (const st of top.readPrefix) {
          if (st && st.name && READ_CACHEABLE.has(st.name)) {
            try { _readCache.prefetch(st.name, st.input || {}, () => executeTool(st.name, st.input || {})); } catch {}
          }
        }
      }
    }
  } catch { _proceduralRecall = { key: query || '', text: '', routineId: null }; }
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
  const proc = (_proceduralRecall.text && _proceduralRecall.key === notionRecallKey(query)) ? _proceduralRecall.text : '';  // tier 7 (learned routines)
  if (proc) out += '\n\n' + proc;
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
  // HEAVY task → reinforce fleet decomposition for THIS turn (trailing/uncached so it never
  // invalidates the cached static prompt). Stateless: keyed off the actual user ask, so it persists
  // across the multi-step turn and stays off for everything else. Pairs with the Opus routing tier.
  if (query && looksHeavyTool(query)) blocks.push({ type: 'text', text: HEAVY_FLEET_DIRECTIVE });
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
  if (overBudget()) { model = MODEL_SONNET; task = 'budget'; }   // Haiku retired — cheap tier is local; Sonnet is the floor cloud model
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
    model = MODEL_SONNET; task = hit ? 'reasoning' : 'simple';   // Haiku retired — Sonnet is the floor cloud model (cheap 'simple' tier runs local)
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
// The wire cap = how much CONVERSATION (messages, excl. the cached static prompt + tools) may ride
// on a single API call. This is the real ceiling on complex-task working memory: on a 200K-window
// model, a small cap throws away most of the window and forces lossy mid-task summarization. Sized
// AGGRESSIVELY (~150K) so long autonomous fan-outs keep full-fidelity history; prompt caching on the
// static prefix + the per-turn rate preflight (which dynamically shrinks this under live pressure,
// see the budget.inSafe cap ~1576) keep cost/latency bounded. Config `wireCapTokens` / env BB_WIRE_CAP.
const WIRE_CAP_DEFAULT = Number(process.env.BB_WIRE_CAP) || 150000;
function wireCapTokens() {
  try { const v = Number(loadConfig().wireCapTokens); if (v > 0) return v; } catch {}
  return WIRE_CAP_DEFAULT;
}
// Trim oldest turns until the message payload fits a token budget. Pairing-safe: never start on an
// orphan tool_result. Default cap = wireCapTokens() (aggressive working memory); callers under rate
// pressure pass a smaller explicit maxTok.
function capTokens(messages, maxTok = wireCapTokens()) {
  if (!Array.isArray(messages)) return messages;
  let msgs = messages.slice();
  while (msgs.length > 2 && estimateTokens(msgs) > maxTok) {
    msgs.shift();
    while (msgs.length && leadsWithToolResult(msgs[0])) msgs.shift();
  }
  // FOLD the pairing repair into the SINGLE trim chokepoint: trimming can strand a tool_use whose
  // tool_result got shifted off the head (or leave a mid-history dangling tool_use from an interrupted
  // turn). validateHistory is idempotent, so wrapping it here makes EVERY wire path — the fast-reply
  // stream, the tool-less stream, the pipeline's anthropicTools escalation, pacing re-entry,
  // cloud-bridge — pairing-safe by construction. Root fix for the recurring "tool_use ids were found
  // without tool_result blocks" API 400, no matter which entry point built the messages.
  return validateHistory(msgs);
}

// Incremental prompt caching for the CONVERSATION. The static prompt+tools already carry a
// cache_control breakpoint; this adds a SECOND one at the very end of the message array, so the
// whole conversation prefix is cached and reused on the next call. Within a multi-tool turn (many
// calls seconds apart) and across turns inside the ~5-min TTL, this makes the now-large (~150K)
// working memory cheap on cache HITS and bills the reused prefix at the cache-read rate instead of
// full input — the cost mitigation that makes the aggressive wire cap affordable. Anthropic allows
// up to 4 breakpoints (we use 2); a prefix under the model's min cacheable size is ignored cleanly.
// PURE + clones only what it touches (callers' message objects are never mutated).
function tagLastBlockForCache(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const li = messages.length - 1;
  const last = messages[li];
  if (!last || typeof last !== 'object') return messages;
  let newContent;
  if (typeof last.content === 'string') {
    if (!last.content) return messages;
    newContent = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(last.content) && last.content.length) {
    const bi = last.content.length - 1;
    const blk = last.content[bi];
    if (!blk || typeof blk !== 'object' || blk.cache_control) return messages;   // untaggable / already tagged
    newContent = last.content.slice();
    newContent[bi] = { ...blk, cache_control: { type: 'ephemeral' } };
  } else {
    return messages;
  }
  const out = messages.slice();
  out[li] = { ...last, content: newContent };
  return out;
}

// Centralized Anthropic call with exponential backoff on 429 / 529 / 5xx, honoring the
// Retry-After header. Transient rate limits self-heal instead of erroring to the user.
// --- Rolling per-minute, PER-MODEL token tracker. Anthropic enforces BOTH input-tokens/min (ITPM)
// AND output-tokens/min (OTPM), and the caps differ per model (Sonnet's are far higher than
// Haiku's). A single global input bucket (the old design) ignored OTPM entirely — the likeliest
// throttle on long, generation-heavy turns — and wasted Sonnet's headroom. We now track in+out per
// model in separate rolling 60s windows. ---
const rateLib = require('./lib/rate');      // T1 — parse live anthropic-ratelimit headers + budget merge
const _liveRate = {};                       // per-model latest live reading from response headers (ground truth)
const _liveRateLogged = new Set();          // one-time "now pacing against live headers" log per model
// Called on EVERY Anthropic response (streaming + non): capture the real remaining budget so pacing
// stops guessing. Bind res.headers.get so lib/rate can read case-insensitively.
function noteRateHeaders(model, headers) {
  try {
    const parsed = rateLib.parseRateHeaders((n) => headers.get(n));
    if (!parsed) return;
    _liveRate[model] = parsed;
    if (!_liveRateLogged.has(model)) { _liveRateLogged.add(model); console.log(`[rate] now pacing against live headers for ${model}`); }
  } catch {}
}
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
  'claude-fable-5':    { itpm: 200000, otpm: 32000 },   // conservative until live headers (T1) correct it
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
  const frac = c.rateLimitSafetyFrac || 0.9;           // leave headroom on the ESTIMATE
  const { itpm, otpm } = rateLimitsFor(model);
  const inSafeEst = Math.floor(itpm * frac);
  const outSafeEst = otpm ? Math.floor(otpm * frac) : Infinity;
  const inUsed = _winSum(_win.in, model);
  const outUsed = _winSum(_win.out, model);
  const est = {
    inSafe: inSafeEst, outSafe: outSafeEst,
    inFree: Math.max(0, inSafeEst - inUsed),
    outFree: outSafeEst === Infinity ? Infinity : Math.max(0, outSafeEst - outUsed),
  };
  // T1: prefer the LIVE header reading (ground truth) when fresh; fall back to the windowed estimate.
  const eff = rateLib.effectiveBudget(est, _liveRate[model], { liveFrac: c.rateLimitLiveFrac || 0.95, otpmTracked: !!otpm });
  return {
    model, itpm, otpm, rateSource: eff.source,
    inSafe: eff.inSafe, inUsed, inFree: eff.inFree, outSafe: eff.outSafe, outUsed, outFree: eff.outFree,
    // back-compat aliases (callers that predate OTPM read .safe/.used/.free as the INPUT budget)
    limit: itpm, safe: eff.inSafe, used: inUsed, free: eff.inFree,
  };
}
// --- Real per-model cost ledger (token→USD), persisted per day in ~/.bhatbot/costs.json ---
// Unlike the old crude "audit lines × $0.004", this prices ACTUAL usage from each API
// response (incl. cache read/write tiers), so chooseModel + the cost system-block can make
// genuine budget-aware decisions ("calculate the cost, then chunk").
const MODEL_PRICES = {                              // USD / 1M tokens: [input, output, cacheWrite, cacheRead]
  'claude-opus-4-8':   [15, 75, 18.75, 1.50],
  'claude-fable-5':    [5, 25, 6.25, 0.50],         // estimate; refine when official pricing lands
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

// T2 — single display-state reducer. EVERY progress emit is folded into one coherent snapshot
// (feedTurnState below, called from the two send choke points), then a debounced `turn-state`
// snapshot is pushed to the renderer. Fixes "goes quiet": the strip always reflects the true
// authoritative state and can never be left stuck spinning (turn_done → done/idle).
const turnState = createTurnState();
let _tsTimer = null;
function pushTurnState(force) {
  const send = () => {
    _tsTimer = null;
    const snap = turnState.snapshot();
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('turn-state', snap); } catch {}
    try { if (activityWindow && !activityWindow.isDestroyed()) activityWindow.webContents.send('turn-state', snap); } catch {}
  };
  if (force) { if (_tsTimer) { clearTimeout(_tsTimer); _tsTimer = null; } return send(); }
  if (_tsTimer) return;                       // trailing debounce — coalesce token/thinking bursts
  _tsTimer = setTimeout(send, 60);
}
// Map a raw progress emit ({channel,data}) into a reducer event, then push (forced for the
// transitions that must be instant: tool boundaries + lifecycle; debounced for token/thinking).
function feedTurnState(channel, data) {
  try {
    if (!data || typeof data !== 'object') return;
    const ts = Date.now();
    let force = false;
    if (channel === 'plan' && Array.isArray(data.steps)) { turnState.reduce({ type: 'plan', steps: data.steps, ts }); force = true; }
    else if (channel === 'model' && data.model) { turnState.reduce({ type: 'model', model: data.model, ts }); }
    else if (channel === 'tool-update') {
      switch (data.type) {
        case 'plan': if (Array.isArray(data.steps)) { turnState.reduce({ type: 'plan', steps: data.steps, ts }); force = true; } break;
        case 'tool_start': turnState.reduce({ type: 'tool_start', name: data.name, narrate: data.narrate, ts }); force = true; break;
        case 'tool_done': turnState.reduce({ type: 'tool_done', name: data.name, ok: data.result ? data.result.success !== false : true, ts }); force = true; break;
        case 'thinking': turnState.reduce({ type: 'thinking', text: data.text, ts }); break;
        case 'token': turnState.reduce({ type: 'token', ts }); break;
        case 'provider_used': turnState.reduce({ type: 'model', model: data.model, provider: data.provider, ts }); break;
        default: return;   // guidance_applied / notify / etc. — no display-state change
      }
    } else return;
    pushTurnState(force);
  } catch { /* the reducer must never break a real emit */ }
}

let _lastModel = null, _lastRouterTask = null;
let _routerFeatures = null, _routerShadowTier = null;   // learned-router shadow: features + suggestion for this turn's training row
let _lastIntake = null;                                 // T1/T5 — last intake classification (chat|action|ambiguous)
// T1 — does the turn refer to work already running? "keep going / the sim / that build / the run" or
// the actual name of an active background job → treat as action (it wants execution/steering, not chat).
// Keep the ACTIVE project aligned with what Siddhant is actually talking about. When his message
// clearly names a known project, switch focus to it — so the injected "ACTIVE PROJECT" context (and
// the turn logging) follow the conversation instead of getting stuck on a stale project (the uricase-
// vs-Iron-Man drift). Conservative: switches ONLY on a distinctive name match, never on generic words.
const _PROJ_STOP = new Set(['the', 'a', 'an', 'and', 'project', 'challenge', 'suit', 'app', 'build', 'render', 'thing', 'stuff', 'work', 'task', 'design', 'my', 'this', 'that', 'for', 'with']);
function maybeSwitchProject(text) {
  try {
    const t = String(text || '').toLowerCase();
    if (!t || t.length < 3) return null;
    const list = projects.list(); if (!list.length) return null;
    const cur = projects.activeSlug();
    let best = null, bestScore = 0;
    for (const p of list) {
      const toks = (String(p.name).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !_PROJ_STOP.has(w));
      if (!toks.length) continue;
      let hit = 0; for (const tok of toks) if (t.includes(tok)) hit++;
      let score = hit;
      if (hit === toks.length) score += 2;                                  // matched ALL distinctive tokens
      if (t.includes(String(p.name).toLowerCase())) score += 3;             // full project name present verbatim
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (best && bestScore >= 2 && best.slug !== cur) {
      projects.setActive(best.slug);
      sendToActivity('tool-update', { type: 'thinking', text: `🎯 focus → ${best.name}` });
      return best.slug;
    }
    return null;
  } catch { return null; }
}
function referencesRunningJob(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(keep going|carry on|continue|go on|resume|the (sim|simulation|build|run|task|job|project|report|analysis|deploy|scan)|that (one|task|job|build|run))\b/.test(t)) return true;
  try { for (const j of (jobsBus.active ? jobsBus.active() : jobsBus.list()) || []) { const n = String(j.name || '').toLowerCase(); if (n && n.length > 4 && t.includes(n)) return true; } } catch {}
  return false;
}
// W1 — per-turn tool subset. agentLoop sets this once (relevant tools for the turn) and clears it in
// finish(); every Claude tool-loop call reads it via activeTools(). null ⇒ full catalog (default,
// and the graceful fallback when retrieval is off / unavailable / low-confidence).
let _activeTools = null;
// Base tool set (retrieval-filtered or full) PLUS any live external MCP-plugin tools, so the model
// can call `mcp__<plugin>__<tool>` the same as a native tool.
function activeTools() {
  const base = _activeTools || TOOLS;
  try { const hub = mcphub.toolSchemas(); if (hub.length) return base.concat(hub); } catch {}
  return base;
}
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
// Subtle rate cue for the main window (titlebar chip): headroom % + which model is being paced.
function ratePct(model) { try { const b = rateBudget(model); return Math.max(0, Math.min(100, Math.round((b.inFree / (b.inSafe || 1)) * 100))); } catch { return null; } }
function emitRateStatus(p) { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rate-status', p); } catch {} }
async function waitForBudget(model, needIn, needOut = 0, maxWaitMs = 75000) {
  const start = Date.now(); let announced = false;
  const clear = () => { if (announced) emitRateStatus({ state: 'clear' }); };
  while (Date.now() - start < maxWaitMs) {
    if (budgetOk(model, needIn, needOut)) { clear(); return true; }
    if (!announced) {
      const b = rateBudget(model);
      const which = b.inFree < needIn ? `${Math.round(needIn / 1000)}k in` : `${Math.round(needOut / 1000)}k out`;
      sendToActivity('tool-update', { type: 'thinking', text: `⏳ pacing for the ${model.replace(/^claude-/, '')} rate limit — continuing in a moment (${which} needed)` });
      emitRateStatus({ state: 'pacing', model, pct: ratePct(model) });   // subtle titlebar chip in the main window
      announced = true;
    }
    await sleep(3000);
  }
  clear();
  return budgetOk(model, needIn, needOut);
}
async function ollamaUp() {
  try { const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(700) }); return r.ok; } catch { return false; }
}
// Cached liveness so the CHEAP tier (below) doesn't pay a 700ms probe every turn.
let _ollamaUpCache = { up: false, at: 0 };
async function ollamaReady() {
  if (Date.now() - _ollamaUpCache.at < 20000) return _ollamaUpCache.up;
  const up = await ollamaUp(); _ollamaUpCache = { up, at: Date.now() };
  return up;
}
// The CHEAP tier — Haiku is retired; simple/utility work runs FREE on a local Ollama model
// (gemma/qwen), falling back to Sonnet (never Haiku) when Ollama is down or disabled.
// Default is gemma3:12b: ~1s warm, coherent, and NON-reasoning — qwen3 leaks <think> and runs
// ~16× slower (17s), which is unusable on the latency-critical voice/fast-reply paths. Override
// with config.cheapModel (e.g. 'qwen3:latest' if you want reasoning quality over latency).
function cheapLocalModel() { const c = loadConfig(); return c.cheapModel || c.localModel || 'gemma3:12b'; }
// SINGLE VOICE: Claude everywhere by default. The local gemma tier is now OPT-IN (useLocalCheap:true)
// — it produced a different, lower-quality "voice" (drift, leaked JSON, "feeling reports") that
// clashed with Claude's. One model = one consistent voice. Every caller already falls back to Claude.
function cheapEnabled() { return loadConfig().useLocalCheap === true; }
// One tool-less completion for internal utilities (summaries, session notes, reflection, briefs).
// Returns { text, via }. Local-first (free), Sonnet cloud fallback.
async function cheapText(system, userText, { maxTokens = 512 } = {}) {
  const t = String(userText || '');
  if (cheapEnabled() && await ollamaReady()) {
    try { const out = stripReasoning(await ollamaChat([{ role: 'user', content: t.slice(0, 8000) }], system, cheapLocalModel()) || '').trim();
      if (out) return { text: out, via: 'ollama:' + cheapLocalModel() }; } catch (e) { console.warn('[cheap] ollama failed → sonnet:', e.message); }
  }
  try {
    const r = await anthropicRequest({ model: MODEL_SONNET, max_tokens: maxTokens, system, messages: [{ role: 'user', content: t.slice(0, 8000) }] }, getApiKey(), { retries: 1 });
    return { text: (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim(), via: 'sonnet' };
  } catch (e) { return { text: '', via: 'none', error: e.message }; }
}
// SHAPE of a heavy task, for the "auto by shape" heavy-tier routing (Siddhant's choice):
//  • FAN-OUT  → a multi-lane build that the HEAVY_FLEET_DIRECTIVE decomposes into concurrent
//    research/design/code/test drones. Wants the roomy-OTPM model (Fable 5) so the fleet isn't
//    throttled to ~3 by Opus's 16K OTPM.
//  • SOLO DEEP → a single hard reasoning artifact (a proof, a derivation, one closed-form solve)
//    with no natural parallel decomposition. Wants Opus's depth on one linear call.
function looksFanOut(text) {
  const t = String(text || '').toLowerCase();
  const build = /\b(build|create|implement|develop|make|design|scaffold|deploy|engineer)\b/.test(t)
    && /\b(system|app|application|pipeline|framework|dashboard|engine|platform|website|web ?app|tool|simulation|game|model|service|api|bot)\b/.test(t);
  const researchPlusBuild = /\b(research|papers?|literature|survey|state.?of.?the.?art)\b/.test(t)
    && /\b(implement|code|build|write|design|test|visuali[sz]e|benchmark|prototype)\b/.test(t);
  const chained = (/\b(and then|then|after that|also|plus|as well as|followed by)\b/.test(t)
    || (t.match(/\band\b/g) || []).length >= 2)
    && /\b(build|create|implement|design|analy[sz]e|render|deploy|write)\b/.test(t);
  return build || researchPlusBuild || chained;
}
function looksSoloDeep(text) {
  const t = String(text || '').toLowerCase();
  return /\b(prove|proof|derive|derivation|solve\b|reason (?:through|about)|explain (?:why|the mechanism|rigorously)|analy[sz]e whether|theorem|lemma|closed.?form|analytic(?:al|ally)?|first principles?)\b/.test(t);
}
// Resolve the HEAVY/orchestrator tier. Order: explicit model override (heavyToolModel) → legacy
// useFable opt-in → config.heavyRouting ('auto'|'fable'|'opus', default 'auto'). AUTO routes by task
// shape: solo deep-reasoning → Opus; fan-out/fleet builds → Fable 5 (roomier OTPM for the drones).
function heavyModel(text = '') {
  const c = loadConfig();
  if (c.heavyToolModel) return c.heavyToolModel;         // explicit model override wins
  if (c.useFable) return MODEL_FABLE;                    // legacy hard opt-in
  const mode = c.heavyRouting || 'auto';
  if (mode === 'opus') return MODEL_OPUS;
  if (mode === 'fable') return MODEL_FABLE;
  return (looksSoloDeep(text) && !looksFanOut(text)) ? MODEL_OPUS : MODEL_FABLE;   // auto
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
const FLEET_CAP = 24;   // Phase 5: static upper bound (always-plugged desktop); admission paces against live OTPM below this
function fleetWidth(model = MODEL_SONNET, perAgentOut = 4096) {
  try { return admission.width(model, perAgentOut, { min: 3, max: FLEET_CAP }); } catch { return 3; }
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
  // Add the conversation cache breakpoint when the payload is big enough to be worth a cache write
  // (small one-off judge/plan calls skip it — the write premium would outweigh a prefix that never
  // repeats). Gated by config.convoCache (default on). Failure here must never block the call.
  try {
    if (loadConfig().convoCache !== false && Array.isArray(body && body.messages) && body.messages.length
        && estimateTokens(body.messages) >= 2000) {
      body = { ...body, messages: tagLastBlockForCache(body.messages) };
    }
  } catch {}
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
      noteRateHeaders(body.model, res.headers);       // T1 — capture live budget from the response
      const j = await res.json();
      try { const u = j.usage || {}; recordTokens(body.model, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), u.output_tokens || 0); recordCost(body.model, u); noteUsage(body.model, u); } catch {}
      return j;
    }
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt < retries) {
      const ra = parseFloat(res.headers.get('retry-after'));
      const waitMs = isFinite(ra) ? Math.min(ra * 1000, 30000) : Math.min(1000 * 2 ** attempt, 16000);
      if (res.status === 429 && isFinite(ra)) _lastRetryAfterMs = ra * 1000;   // self-drive budget governor reads this
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
    noteRateHeaders(body.model, res.headers);         // T1 — live budget from the streaming response
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

  // CHEAP TIER → local Ollama (Haiku retired). A non-tool, non-reasoning turn runs FREE on a local
  // model (qwen/gemma) instead of a paid cheap cloud model. Tool tasks + the 'sonnet' reasoning route
  // skip this — they need the cloud tool loop / real depth. Falls through to Sonnet when Ollama is down.
  if (!toolish && cheapEnabled() && route !== 'sonnet' && route !== 'db_directive' && await ollamaReady()) {
    try {
      const text = stripReasoning(await ollamaChat(messages, buildSystemPrompt(lastUserText(messages)), cheapLocalModel()) || '').trim();
      if (text) { if (onText) try { onText(text); } catch {} return { content: [{ type: 'text', text }], stop_reason: 'end_turn', _provider: 'ollama', _model: cheapLocalModel(), _cheapLocal: true }; }
    } catch (e) { console.warn('[cheap] local failed → cloud:', e.message); }
  }

  // Cloud Claude base tier is now SONNET (Haiku fully retired from routing). The complex/heavy
  // upgrades below can push it to Opus/Fable; the local branch above already took the free path.
  let claudeModel = MODEL_SONNET;

  // COMPLEX-TOOL ESCALATION: the regex classifier only routes obvious "reasoning" phrasings to Sonnet,
  // so a genuinely hard TOOL task worded plainly ("make a simulation of DNA replication", "build X",
  // "write a script that…") falls through to Haiku — which then fumbles the multi-step tool plan,
  // emits empty/partial tool calls (the `simulate {}` loop), and never actually does the work. When a
  // task both needs tools AND looks generative/multi-step, run it on Sonnet. Gated by the daily $
  // governor so cost stays bounded; trivial one-shot actions (open/play/screenshot/volume) stay Haiku.
  if (claudeModel === MODEL_SONNET && !overBudget() && toolish && looksComplexTool(lastUserText(messages))) {
    claudeModel = cfg.complexToolModel || MODEL_SONNET; _lastModel = claudeModel; _lastRouterTask = 'complex-tool-upgrade';
  }
  // HEAVY-TASK OPUS TIER: the hardest tasks — a scientific simulation, an engine/model needing deep
  // coding AND interpretation — get Opus as the orchestrating brain (the parallel drones it spawns
  // still run on Sonnet; Opus does the planning, synthesis, and interpretation). Overrides the Sonnet
  // upgrade above. Config: allowOpusHeavy (default true) to disable, heavyToolModel to override. The
  // $-governor still forces Haiku when over the daily budget.
  // Opus is gated by an explicit OK (cfg.opusRequiresApproval, default true): the dispatch layer asks
  // before switching and sets _opusApproved for the session. If we reach here un-approved (or the knob
  // is off), we simply stay on Sonnet — never silently spend Opus rates.
  if (!overBudget() && toolish && (cfg.allowOpusHeavy !== false) && (cfg.opusRequiresApproval === false || _opusApproved) && looksHeavyTool(lastUserText(messages))) {
    claudeModel = heavyModel(lastUserText(messages)); _lastModel = claudeModel;
    _lastRouterTask = 'heavy-' + (claudeModel === MODEL_FABLE ? 'fable' : claudeModel === MODEL_OPUS ? 'opus' : 'tier') + '-upgrade';
  }

  // LEARNED ROUTER (shadow → active). Predict the tier from the message features and stash it so the
  // turn's telemetry row carries a training label (see routermodel.js). SHADOW by default: the regex
  // above still decides; we only record what the learned model WOULD have said. When cfg.routerLearned
  // is on AND the model is confident, it may ESCALATE (never downgrade — safer): a plainly-worded hard
  // task the regex under-routed gets pulled up to the learned tier. Never spends Opus without approval.
  try {
    _routerFeatures = routermodel.extractFeatures(lastUserText(messages));
    const shadow = routermodel.predict(lastUserText(messages));
    _routerShadowTier = shadow ? shadow.tier : null;
    if (cfg.routerLearned && shadow && shadow.confidence >= (cfg.routerLearnedMinConf ?? 0.5) && !overBudget() && toolish) {
      const curTier = _lastRouterTask === 'simple' ? 'simple' : (_lastRouterTask || '').startsWith('heavy') ? 'heavy' : 'reasoning';
      const order = { simple: 0, reasoning: 1, heavy: 2 };
      if (order[shadow.tier] > order[curTier]) {                       // escalate only
        if (shadow.tier === 'heavy' && (cfg.opusRequiresApproval !== false && !_opusApproved)) {
          claudeModel = MODEL_SONNET;                                  // heavy needs approval → hold at Sonnet
        } else if (shadow.tier === 'heavy') {
          claudeModel = heavyModel(lastUserText(messages));
        } else {
          claudeModel = MODEL_SONNET;                                  // reasoning tier = Sonnet floor
        }
        _lastModel = claudeModel; _lastRouterTask = 'learned-' + shadow.tier;
      }
    }
  } catch {}

  // Preflight rate-limit check: if this request would blow the per-minute INPUT or OUTPUT budget,
  // either run it on a local Ollama model (free, no quota) or — if local is unavailable
  // / mode='notify' — abort with a clear message so the caller can reset for next task.
  // estOut = the learned/predicted output size for this turn (depth calibration), so OTPM-heavy
  // generation turns pace too, not just big-context ones.
  let est = requestTokenEstimate(messages);
  let estOut = predictedOutputTokens(lastUserText(messages));
  // (The old Haiku→Sonnet OTPM upgrade is gone — Haiku is retired; the cloud base is already Sonnet.)
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
// evictOldImages moved to lib/history.js (SPLIT_PLAN step 9).

// The effective wire cap is capTokens() (~150K messages by default). We summarize JUST UNDER that
// cap: past this budget capTokens would otherwise HARD-DROP the oldest turns (losing fidelity).
// Summarizing first means a dense summary survives capTokens instead of raw truncation. Keep the
// most recent CONTEXT_KEEP_TAIL tokens verbatim; both fit under the wire cap with headroom. Raised
// with the wire cap so a long autonomous fan-out keeps ~80K of verbatim recent context (was 16K)
// and only summarizes past ~120K (was 28K) — i.e. we now actually USE the 200K window. Env-overridable.
const CONTEXT_TRIM_BUDGET = Number(process.env.BB_CONTEXT_BUDGET) || 120000;
const CONTEXT_KEEP_TAIL = Number(process.env.BB_CONTEXT_TAIL) || 80000;
// Live threshold: config.midLoopTrimThreshold overrides the default at runtime (no restart).
// NOTE: the sensible ceiling is the capTokens wire cap (~150K), NOT the full 200K window — past the
// wire cap, capTokens hard-drops oldest turns on every call, so trimming later than that can't
// recover lost fidelity. Values above the wire cap are accepted but won't help.
function contextTrimBudget() {
  try { const v = Number(loadConfig().midLoopTrimThreshold); if (v > 0) return v; } catch {}
  return CONTEXT_TRIM_BUDGET;
}

// Token-budgeted (not message-count) summarizing trim. A single huge tool result now triggers
// it, and it's safe to call MID-LOOP (a long fan-out can blow the window before the next user
// turn — the one place the old count+turn-start trim never fired). Pairing is healed by the
// validateHistory that runs after every call site.
async function trimHistory(history, apiKey, budget = contextTrimBudget()) {
  if (!Array.isArray(history) || history.length <= 4) return history;
  if (estimateTokens(history) <= budget) return history;
  // Walk back from the newest message, keeping recent turns until the tail budget fills.
  let cut = history.length, tailTok = 0;
  while (cut > 1 && tailTok < CONTEXT_KEEP_TAIL) { cut--; tailTok += estimateTokens(history[cut]); }
  if (cut < 1) cut = 1;                     // always keep ≥1 recent message, summarize ≥1 old
  const toSummarize = history.slice(0, cut);
  const recent = history.slice(cut);
  if (!toSummarize.length) return history;
  let text = '';
  try {
    const summary = await callClaude([
      ...toSummarize,
      { role: 'user', content: 'Summarize this conversation so an in-progress task can continue without loss. Preserve concretely: decisions made, exact file paths + line numbers, code/diffs written, tool outputs still needed downstream, and unresolved TODOs. Be dense; skip pleasantries.' }
    ], apiKey, MODEL_SONNET);
    text = (summary.content.find((b) => b.type === 'text') || {}).text || '';
  } catch { return history; }               // summary failed → keep full history; capTokens still guards the wire
  if (!text) return history;
  return [
    { role: 'user', content: `[Earlier conversation summarized — ${toSummarize.length} messages condensed]: ${text}` },
    { role: 'assistant', content: 'Understood — continuing.' },
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
const { IMG_EXT, VID_EXT, TEXT_EXT, classifyExt } = require('./lib/attach');  // pure file-type routing (drag-drop / attach)

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
  const kind = classifyExt(ext);
  const blocks = [];
  if (kind === 'image') {
    const jpg = sipsToJpeg(p);
    if (jpg) { blocks.push(imgBlock(fs.readFileSync(jpg).toString('base64'), 'image/jpeg')); fs.unlink(jpg, () => {}); }
    else {
      const mt = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      blocks.push(imgBlock(fs.readFileSync(p).toString('base64'), mt));
    }
  } else if (kind === 'video') {
    const frames = videoFrames(p);
    if (frames.length) { blocks.push({ type: 'text', text: `[screen recording — ${frames.length} sampled frames follow]` }); frames.forEach(f => blocks.push(imgBlock(f, 'image/jpeg'))); }
    else blocks.push({ type: 'text', text: `[video at ${p}: frame extraction failed; inspect it with run_shell/ffmpeg]` });
  } else if (kind === 'pdf') {
    // Claude reads PDFs natively via a base64 document block (text + figures). Cap to keep the request
    // sane; oversized → a pointer so the model uses a tool (pdftotext / run_shell) instead.
    try {
      const sz = fs.statSync(p).size;
      if (sz <= 28 * 1024 * 1024) {
        blocks.push({ type: 'document', title: path.basename(p),
          source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(p).toString('base64') } });
      } else {
        blocks.push({ type: 'text', text: `[PDF ${path.basename(p)} is ${(sz / 1e6).toFixed(1)}MB — too large to inline; read it at ${p} with pdftotext / run_shell]` });
      }
    } catch (e) { blocks.push({ type: 'text', text: `[PDF at ${p}: ${e.message}]` }); }
  } else if (kind === 'text') {
    // Inline the actual content so BhatBot works on the data (CSV rows, code, config), not just a path.
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const CAP = 200 * 1024;
      const body = raw.length > CAP ? raw.slice(0, CAP) + `\n… [truncated — ${raw.length} chars total; full file at ${p}]` : raw;
      const lang = ext.slice(1);
      blocks.push({ type: 'text', text: `[attached file: ${path.basename(p)} — ${raw.length} chars]\n\`\`\`${lang}\n${body}\n\`\`\`` });
    } catch (e) { blocks.push({ type: 'text', text: `[file ${p}: ${e.message}; try opening it with a tool]` }); }
  } else {
    blocks.push({ type: 'text', text: `[attached file: ${p} — use your tools (read_file / run_shell / textutil) to inspect it]` });
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
    // skipPerms (self-drive, unattended) → --dangerously-skip-permissions so the headless coder can run
    // build/move/test commands without a prompt; else acceptEdits (auto-applies edits, still gated on bash).
    const ccFlag = input.skipPerms ? '--dangerously-skip-permissions' : '--permission-mode acceptEdits';
    const cc = await runShell('claude -p ' + JSON.stringify(prompt) + ' ' + ccFlag, proj, 300000);
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

// Interactive option picker (ask_options tool): show a checkbox card in the MAIN window and resolve
// with the labels Siddhant taps. Mirrors requestConfirm's promise-per-id pattern. A safety timeout
// resolves empty so the agent loop can never hang on an ignored card.
const pendingOptions = new Map();
// Resolves with { selected:[labels], text:'' } — text is the optional inline free-text box (allowText).
function requestOptions(question, options, multi, opts = {}) {
  return new Promise((resolve) => {
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    pendingOptions.set(id, resolve);
    try {
      if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.webContents.send('options-required', { id, question, options, multi: !!multi, allowText: !!opts.allowText, textPlaceholder: opts.textPlaceholder || '' }); }
      else { pendingOptions.delete(id); resolve({ selected: [], text: '' }); return; }
    } catch { pendingOptions.delete(id); resolve({ selected: [], text: '' }); return; }
    setTimeout(() => { if (pendingOptions.has(id)) { pendingOptions.delete(id); resolve({ selected: [], text: '' }); } }, 5 * 60 * 1000);
  });
}
ipcMain.on('options-answer', (_e, { id, selected, text } = {}) => {
  const r = pendingOptions.get(id);
  if (r) { pendingOptions.delete(id); r({ selected: Array.isArray(selected) ? selected.map(String) : [], text: String(text || '').trim() }); }
});

// Multi-field FORM (ask_form tool): show ONE card with several labelled inputs and resolve with
// { values: { key: value } } once Siddhant submits. Same promise-per-id + safety-timeout pattern as
// requestOptions so the agent loop can never hang on an ignored form.
const pendingForms = new Map();
function requestForm(title, fields, opts = {}) {
  return new Promise((resolve) => {
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    pendingForms.set(id, resolve);
    try {
      if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.webContents.send('form-required', { id, title: title || 'Fill in the details', fields, submitLabel: opts.submitLabel || 'Submit' }); }
      else { pendingForms.delete(id); resolve({ values: null, dismissed: true }); return; }
    } catch { pendingForms.delete(id); resolve({ values: null, dismissed: true }); return; }
    setTimeout(() => { if (pendingForms.has(id)) { pendingForms.delete(id); resolve({ values: null, dismissed: true }); } }, 5 * 60 * 1000);
  });
}
ipcMain.on('form-answer', (_e, { id, values, dismissed } = {}) => {
  const r = pendingForms.get(id);
  if (r) { pendingForms.delete(id); r({ values: (values && typeof values === 'object') ? values : null, dismissed: !!dismissed }); }
});

// Voice clarity gate (borderline path): a cheap local yes/no on whether an ambiguous utterance is a
// clear, actionable request. The instant heuristic (pure.looksActionable) runs in the renderer first;
// only 'borderline' utterances reach this. Fail-OPEN (treat as actionable) so it can never eat a real command.
ipcMain.handle('voice-intent', async (_e, { text } = {}) => {
  try {
    const t = String(text || '').trim();
    if (!t) return { ok: false };
    if (loadConfig().voiceClarityModel === false) return { ok: true };   // model check disabled → don't drop
    const r = await cheapText('You judge if a short transcribed utterance is a CLEAR, ACTIONABLE request/command to an assistant (answer strictly "yes"), or just rambling / thinking aloud / an incomplete fragment with no clear ask (answer strictly "no").', t, { maxTokens: 4 });
    const yes = /\byes\b/i.test(r.text || '');
    const no = /\bno\b/i.test(r.text || '');
    return { ok: yes || !no };   // fail-open: only drop on an explicit "no"
  } catch { return { ok: true }; }
});

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
// DevTools ring buffers — populated by page listeners so browser_devtools can report console
// output and network history retroactively (no pre-arming needed). Bounded to avoid unbounded growth.
const DEVTOOLS_CAP = 300;
let devtoolsConsole = [];   // { type, text, ts }
let devtoolsNetwork = [];   // { url, method, status, type, size, ts }
const pushCapped = (arr, item) => { arr.push(item); if (arr.length > DEVTOOLS_CAP) arr.splice(0, arr.length - DEVTOOLS_CAP); };

function attachPageHandlers(p) {
  try {
    p.on('dialog', async (dlg) => {
      try { sendToActivity('tool-update', { type: 'thinking', text: `🔔 page dialog (${dlg.type()}): "${(dlg.message() || '').slice(0, 60)}" — auto-accepted` }); } catch {}
      try { await dlg.accept(); } catch { try { await dlg.dismiss(); } catch {} }
    });
  } catch {}
  // Buffer console + page errors for browser_devtools (best-effort; never block the page).
  try {
    p.on('console', (msg) => { try { pushCapped(devtoolsConsole, { type: msg.type(), text: (msg.text() || '').slice(0, 500), ts: Date.now() }); } catch {} });
    p.on('pageerror', (err) => { try { pushCapped(devtoolsConsole, { type: 'error', text: ('[pageerror] ' + (err && err.message || err)).slice(0, 500), ts: Date.now() }); } catch {} });
    p.on('response', async (res) => {
      try {
        const req = res.request();
        let size = null; try { const h = await res.allHeaders(); size = Number(h['content-length']) || null; } catch {}
        pushCapped(devtoolsNetwork, { url: res.url().slice(0, 300), method: req.method(), status: res.status(), type: req.resourceType(), size, ts: Date.now() });
      } catch {}
    });
  } catch {}
}

// browser_devtools — inspect the live page: network history, console output, load metrics, or eval JS.
async function browserDevtools(input) {
  const a = input.action;
  if (a === 'network') {
    let rows = devtoolsNetwork.slice();
    if (input.filter) rows = rows.filter((r) => r.url.includes(input.filter));
    rows = rows.slice(-(input.limit || 30));
    return { success: true, count: rows.length, requests: rows };
  }
  if (a === 'console') {
    const rows = devtoolsConsole.slice(-(input.limit || 30));
    return { success: true, count: rows.length, messages: rows };
  }
  if (!page) return { success: false, error: 'No browser page open — call the `browser` tool first.' };
  if (a === 'metrics') {
    try {
      const m = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] || {};
        const paint = performance.getEntriesByType('paint') || [];
        const fcp = (paint.find((p) => p.name === 'first-contentful-paint') || {}).startTime || null;
        let lcp = null;
        try { const l = performance.getEntriesByType('largest-contentful-paint'); if (l && l.length) lcp = l[l.length - 1].startTime; } catch {}
        return {
          url: location.href,
          domContentLoaded: nav.domContentLoadedEventEnd ? Math.round(nav.domContentLoadedEventEnd) : null,
          load: nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
          responseTime: nav.responseEnd ? Math.round(nav.responseEnd - nav.requestStart) : null,
          transferBytes: nav.transferSize || null,
          fcp: fcp ? Math.round(fcp) : null, lcp: lcp ? Math.round(lcp) : null,
          resources: (performance.getEntriesByType('resource') || []).length,
        };
      });
      return { success: true, metrics: m };
    } catch (e) { return { success: false, error: e.message }; }
  }
  if (a === 'evaluate') {
    if (!input.expression) return { success: false, error: 'evaluate needs an `expression`.' };
    try {
      const v = await page.evaluate((expr) => {
        // eslint-disable-next-line no-eval
        const out = eval(expr);
        try { return JSON.parse(JSON.stringify(out)); } catch { return String(out); }
      }, input.expression);
      return { success: true, value: v };
    } catch (e) { return { success: false, error: e.message }; }
  }
  return { success: false, error: 'Unknown browser_devtools action: ' + a };
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
    const r = await anthropicRequest({ model: MODEL_SONNET, max_tokens: 500, system: sys, messages: [{ role: 'user', content: text.slice(0, 1000) }] }, getApiKey(), { retries: 1 });
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
// Secondary window openers live in window-manager.js (SPLIT_PLAN step 8). main keeps mainWindow +
// createWindow + the terminal/pty + fleet windows; everything else (Nexus/Studio/Chess/World Cup/
// Molecule/Maps/3D viewer) is created + state-owned there. Thin consts below keep all call sites
// (creation.js ctx, executeTool dispatch, IPC handlers, hotkey) unchanged. createWindow is a hoisted
// function decl so it resolves here even though it's defined further down.
const wm = require('./window-manager')({
  BrowserWindow, screen, webContents,
  getMainWindow: () => mainWindow, createWindow,
  paths: { STUDIO_DIR, STUDIO_INDEX, CHESS_HTML, NEXUS_URL },
});
const { toggleWindow, studioWebContents, openNexusWindow, ensureStudio, openStudioWindow,
  openChessWindow, openChessApplet, openWorldCupWindow, openInteractive3D,
  openMoleculeWindow, openMapsWindow, openMapsWindowSnapshot, openPresenceWindow } = wm;
ipcMain.on('viewer-ready', (e) => wm.sendPendingModel(e));
ipcMain.on('presence-ready', (e) => wm.sendPendingPresence(e));
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
ipcMain.on('molecule-ready', (e) => wm.sendPendingMol(e));

// --- FABLE / ProtFunc tie-in: predict protein FUNCTION → SEE it on the saliency-colored structure ---
const protfunc = require('./lib/protfunc')({ getUrl: () => { try { return (loadConfig().protfunc && loadConfig().protfunc.url) || ''; } catch { return ''; } } });

// --- Maps (Leaflet + OSM by default; Google geocoding when config.maps.googleKey present) ---
const maps = require('./lib/maps')({
  getKey: () => { try { return (loadConfig().maps && loadConfig().maps.googleKey) || ''; } catch { return ''; } },
  getMapId: () => { try { return (loadConfig().maps && loadConfig().maps.mapId) || ''; } catch { return ''; } },
});
ipcMain.on('map-ready', (e) => wm.sendPendingMap(e));
ipcMain.on('map-rendered', () => wm.fireMapRendered());
// In-window interactive route planner bridges (geocode + waypoint routing) — reuse the SAME
// backend as the maps tool (Google when keyed, OSM/OSRM free otherwise). No CORS/UA issues.
ipcMain.handle('maps-geocode', async (_e, q) => { try { return { ok: true, ...(await maps.geocode(q)) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('maps-route-path', async (_e, points, mode) => { try { return { ok: true, ...(await maps.routePath(points, mode)) }; } catch (e) { return { ok: false, error: e.message }; } });

// TRANSIENT_RE + isRetryableTool moved to lib/history.js (SPLIT_PLAN step 9).

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
  // Haiku RETIRED: there's no cheaper cloud tier to spill onto, so cross-model downgrade is disabled.
  // Sonnet is the floor; the free cheap tier is local (Ollama), which can't run the fleet tool-loop.
  return {
    anthropicRequest: pacedSubagentRequest, executeTool, toolDefs: TOOLS, apiKey: getApiKey(),
    models: { sonnet: MODEL_SONNET, haiku: MODEL_SONNET },   // Haiku retired → any 'haiku' role resolves to Sonnet (was undefined → broke lifeadmin/haiku roles)
    parallelSafe: (name) => PARALLEL_SAFE.has(name),   // lets each fleet/ensemble suit run a read-burst concurrently (same set the main loop uses)
    // Procedural learning from delegated agents too (Siddhant's choice: main + fleet/drones). Each suit
    // banks the step-series it ran for its sub-task, so the skill bank grows from parallel work as well.
    recordTrace: (trigger, steps, ok, ms) => {
      try {
        const c = loadConfig();
        if (c.procedural === false || c.proceduralLearnFleet === false) return;
        procedural.record(PROCEDURAL_PATH, { trigger, steps, ok, ms }, { clusterJaccard: c.proceduralClusterJaccard });
      } catch {}
    },
    fleetWidth, fleetFloor: 3,
    canDowngrade: () => false,   // no sub-Sonnet cloud tier anymore
    // T7 — a fresh SHARED blackboard per fan-out batch: ensemble/fleet pass it to every sibling so
    // they read each other's live status/findings mid-run instead of coordinating only at the end.
    makeBoard: () => { try { return blackboard.createBlackboard({ dir: path.join(os.tmpdir(), 'bb-fleet-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)) }); } catch { return null; } },
    onStep: (name, tool) => sendToActivity('tool-update', { type: 'thinking', text: `🤝 ${vanguard.codename(name)} → ${tool}` }),
  };
}

// ── DRONES (FORGE / D2) ────────────────────────────────────────────────────────────────────────
// Generic scoped one-shot agent loop for a single drone. Mirrors subagents.run's tool loop but takes
// its scope (tools/system/model/budget) from the drone ctx that lib/drone.js assembles. Charges spend
// + heartbeats via ctx.onStep each turn (drives the fleet's budget envelope + stall watchdog). The
// tool allow-list is enforced HERE too (belt): a tool_use outside the grant is refused, not run.
// T2: drones NEVER run on Opus. Opus OTPM (~16k/min) is far too tight for a fanned-out fleet — a batch
// of drone calls would drain it and stall waitForBudget (the stall that orphaned tool_use → API 400).
// A drone spec may only request the cheap tier (haiku); anything else — including 'opus'/heavyToolModel
// — resolves to Sonnet (90k OTPM). Opus is reserved for the single plan+interpret calls in the loop.
function resolveDroneModel(_specModel) { return MODEL_SONNET; }   // drones run tools → always Sonnet (Haiku retired; local can't tool-loop)

async function droneAgentRun(ctx, task) {
  const toolDefs = TOOLS.filter((t) => (ctx.tools || []).includes(t.name));
  const model = resolveDroneModel(ctx.model);
  const goal = (task && (task.goal || task)) || 'work the mission';
  let hist = [{ role: 'user', content: String(goal) }];
  const maxTurns = Math.max(1, Math.min((ctx.budget && ctx.budget.maxTurns) || 8, 12));
  let finalText = '';
  const _droneT0 = Date.now(); const _droneTrace = [];   // procedural learning from drones (main + fleet/drones)
  for (let i = 0; i < maxTurns; i++) {
    let resp;
    try { resp = await pacedSubagentRequest({ model, max_tokens: 3072, system: ctx.system, tools: toolDefs, messages: hist.slice(-24) }, getApiKey()); }
    catch (e) { return { status: finalText ? 'partial' : 'failed', summary: finalText || ('drone model error: ' + e.message) }; }
    const content = resp.content || [];
    hist.push({ role: 'assistant', content });
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) finalText = text;
    const u = resp.usage || {};
    const usd = ((u.input_tokens || 2000) / 1e6) * 3 + ((u.output_tokens || 400) / 1e6) * 15;   // Sonnet ~ $3 in / $15 out
    const step = ctx.onStep ? ctx.onStep({ usd, note: (text || 'tool step').slice(0, 60) }) : { budgetLeft: true };
    const tus = content.filter((b) => b.type === 'tool_use');
    if (!tus.length || resp.stop_reason === 'end_turn' || (step && step.budgetLeft === false) || (step && step.terminated)) break;
    for (const b of tus) if (_droneTrace.length < 40) _droneTrace.push(b.name);
    const runOne = async (tu) => {
      const r = (ctx.tools || []).includes(tu.name) ? await executeTool(tu.name, tu.input) : { success: false, error: `tool "${tu.name}" is not permitted for this drone` };
      return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(r).slice(0, 16 * 1024), is_error: r && r.success === false };
    };
    // Same read-burst throughput win as the main loop: independent read-only tools this turn run
    // concurrently (order preserved for pairing); anything stateful stays sequential.
    let results;
    if (tus.length > 1 && tus.every((b) => PARALLEL_SAFE.has(b.name))) results = await Promise.all(tus.map(runOne));
    else { results = []; for (const tu of tus) results.push(await runOne(tu)); }
    hist.push({ role: 'user', content: results });
  }
  // Bank this drone's step-series into the shared skill bank (gated by config; main + fleet/drones).
  try {
    const c = loadConfig();
    if (c.procedural !== false && c.proceduralLearnFleet !== false && _droneTrace.length >= procedural.MIN_STEPS) {
      procedural.record(PROCEDURAL_PATH, { trigger: String(goal), steps: _droneTrace, ok: true, ms: Date.now() - _droneT0 }, { clusterJaccard: c.proceduralClusterJaccard });
    }
  } catch {}
  return { status: 'ok', summary: finalText || '(completed, no text output)' };
}

// When the caller gives a mission but no explicit drones, an orchestrator call designs the fleet:
// N personas + roles from the mission. Bounded to `cap`; falls back to a sensible default trio.
async function designDroneFleet(mission, cap = 6) {
  const sys = `You design a small fleet of specialist agent "drones" for a mission. Output ONLY JSON: {"drones":[{"name":"UPPER_CASE","role":"research|coding|browser|creative|memory","brief":"one line","goal":"what THIS drone does"}]}. ${cap} max. Prefer distinct, complementary roles.`;
  try {
    const r = await anthropicRequest({ model: MODEL_SONNET, max_tokens: 900, system: sys, messages: [{ role: 'user', content: 'Mission: ' + String(mission).slice(0, 500) }] }, getApiKey());
    const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = txt.match(/\{[\s\S]*\}/);
    const arr = m ? (JSON.parse(m[0]).drones || []) : [];
    if (arr.length) return arr.slice(0, cap).map((d, i) => ({
      id: 'drone-' + (i + 1), role: d.role, persona: { name: d.name || ('DRONE-' + (i + 1)), brief: d.brief || d.goal || mission, style: 'concise' },
      _task: { goal: d.goal || mission },
    }));
  } catch {}
  return ['implementer', 'skeptic', 'reviewer'].map((role, i) => ({ id: 'drone-' + (i + 1), role: role === 'implementer' ? 'coding' : 'research', persona: { name: role.toUpperCase(), brief: role + ' on the mission', style: 'concise' }, _task: { goal: mission } }));
}

// Merge the drones' result envelopes into one recommendation (the synthesize:true step).
async function synthesizeDroneResults(mission, results) {
  const body = results.map((r) => `## ${r.persona} [${r.status}]\n${r.summary}`).join('\n\n').slice(0, 8000);
  try {
    const r = await anthropicRequest({ model: MODEL_SONNET, max_tokens: 1200, system: 'Synthesize these drone reports into one clear recommendation for Siddhant. Resolve disagreements explicitly. Be concise.', messages: [{ role: 'user', content: `Mission: ${mission}\n\n${body}` }] }, getApiKey());
    return (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (e) { return null; }
}

// Lean summary model call for project memory (#24) — minimal system so it's cheap.
const projectSummarize = async (prompt) => {
  const j = { content: [{ type: 'text', text: (await cheapText('You write tight, factual project summaries.', prompt, { maxTokens: 400 })).text }] };
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
};

// ── BUILD_PROJECT — the one-turn completion engine ───────────────────────────────────────────────
// Takes a gathered goal + specs and drives a heavy creative/engineering build ALL THE WAY to a finished,
// persisted deliverable in a single turn: decompose → PARALLEL fleet build (shared blackboard) →
// integrate → assemble the artifact(s) (a real physics pass via `simulate` + an interactive Three.js
// scene via `studio_write`) → completion-gate the render → save everything as a resumable Project.
// Completion is prioritised over breadth: unspecified specs get sensible defaults (noted), and the
// pipeline never ends without producing (or honestly reporting a failure to produce) the artifact.

// Fold the locked specs into a task so every lane builds to the SAME concrete brief.
function specBrief(spec, goal) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const keys = Object.keys(s);
  const lines = keys.length ? keys.map((k) => `- ${k}: ${String(s[k]).slice(0, 120)}`).join('\n') : '(no explicit specs — choose sensible defaults and NOTE each assumption)';
  return `\n\nOVERALL GOAL: ${goal}\n\nLOCKED SPECIFICATIONS:\n${lines}\n\nStay strictly within your lane; produce concrete, buildable output (numbers, materials, geometry, parameters) the integrator can drop straight into the final artifact.`;
}

// Decompose a build into 3–6 INDEPENDENT parallel lanes tailored to the goal + deliverable.
async function designWorkstreams(goal, spec, deliverable) {
  const want = deliverable === 'sim' ? 'a physics/quantitative simulation' : deliverable === 'studio' ? 'an interactive 3D visualization' : 'BOTH an interactive 3D visualization AND a physics simulation';
  const sys = `You decompose a design/build request into INDEPENDENT workstreams that specialists can build IN PARALLEL, then get integrated into ${want}. Output ONLY JSON: {"lanes":[{"role":"kebab-name","task":"one crisp sentence of what THIS lane produces"}]}. 3–6 lanes, distinct and complementary (e.g. for a wearable machine: exterior-geometry, materials-armor, power-systems, control-HUD, mobility-flight-physics). Each lane must yield concrete buildable output.`;
  try {
    const r = await anthropicRequest({ model: MODEL_SONNET, max_tokens: 700, system: sys, messages: [{ role: 'user', content: `Build: ${goal}\nDeliverable: ${want}\nSpecs: ${JSON.stringify(spec).slice(0, 600)}` }] }, getApiKey());
    const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = txt.match(/\{[\s\S]*\}/);
    const lanes = m ? (JSON.parse(m[0]).lanes || []) : [];
    const clean = lanes.filter((l) => l && l.task).slice(0, 6).map((l, i) => ({ role: l.role || ('lane-' + (i + 1)), task: String(l.task) }));
    if (clean.length >= 2) return clean;
  } catch {}
  // Fallback lanes so a build ALWAYS proceeds even if decomposition fails.
  return [
    { role: 'design-spec', task: 'Define the concrete design: form, dimensions, key components and how they fit together.' },
    { role: 'engineering', task: 'Work out the engineering: materials, power/energy, structure, and the governing numbers.' },
    { role: 'systems-features', task: 'Detail the functional systems / features and how each behaves and is controlled.' },
  ];
}

// Strip a fenced/backticked code wrapper → the raw payload (HTML or code). Pure + testable.
function extractCode(text, lang = '') {
  const s = String(text || '');
  const fence = new RegExp('```(?:' + (lang || '[a-z]*') + ')?\\s*\\n([\\s\\S]*?)```', 'i');
  const m = s.match(fence);
  let out = (m ? m[1] : s).trim();
  // If a full HTML doc is embedded in prose, slice from <!doctype/<html to </html>.
  const h = out.match(/<!doctype[\s\S]*<\/html>|<html[\s\S]*<\/html>/i);
  if (lang === 'html' && h) out = h[0];
  return out.trim();
}

// A real physics/quantitative pass: write Python from the integrated build, RUN it via `simulate`
// (numpy/scipy + a matplotlib plot), and return the computed numbers + figure.
async function runPhysicsPass(goal, spec, buildNotes, emit) {
  emit('🧮 physics pass — deriving the numbers');
  const sys = 'You write ONE self-contained Python script (numpy/scipy; matplotlib for ONE figure saved to the provided out path or shown) that computes the KEY quantitative characteristics of the described build (e.g. mass, power/energy, thrust-to-weight, thermal, structural, flight/dynamics as relevant) from first principles + the given specs. Print a concise labelled summary of the headline numbers. Output ONLY the Python code, no prose.';
  try {
    const r = await anthropicRequest({ model: MODEL_FABLE, max_tokens: 2200, system: sys, messages: [{ role: 'user', content: `Build: ${goal}\nSpecs: ${JSON.stringify(spec).slice(0, 800)}\n\nIntegrated design notes:\n${String(buildNotes).slice(0, 6000)}` }] }, getApiKey());
    const code = extractCode((r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), 'python');
    if (!code || code.length < 20) return { ok: false, summary: 'physics pass produced no code' };
    const out = await executeTool('simulate', { code });
    const summary = String(out && (out.stdout || out.output || out.result || '') || '').slice(0, 1400).trim();
    return { ok: !!(out && out.success !== false), summary: summary || 'simulation ran', image: out && out._image, error: out && out.error };
  } catch (e) { return { ok: false, summary: 'physics pass failed: ' + (e && e.message || e) }; }
}

// Assemble the final INTERACTIVE artifact: a complete self-contained Three.js document implementing
// the build, with orbit controls + an on-screen spec sheet (incl. any physics numbers). fixHint feeds
// a render error back for the single completion-gate retry.
async function generateStudioArtifact(goal, spec, buildNotes, physics, emit, fixHint) {
  emit(fixHint ? '🎨 re-rendering the 3D deliverable' : '🎨 assembling the interactive 3D deliverable');
  const physLine = physics && physics.summary ? `\n\nPHYSICS RESULTS to display on the spec sheet:\n${physics.summary}` : '';
  const sys = 'You output ONE COMPLETE, SELF-CONTAINED HTML document (starts <!doctype html>) that renders an INTERACTIVE 3D visualization of the described build with Three.js. Requirements: load Three.js + OrbitControls from a CDN (unpkg/jsdelivr, importmap ok); build the actual geometry from the design notes (not a placeholder cube); orbit/zoom controls; tasteful lighting + the specified colours; a fixed overlay "spec sheet" panel listing the key specs + any physics numbers; runs offline-capable in a normal browser. Output ONLY the HTML — no markdown, no prose, no explanation.';
  const usr = `Build: ${goal}\nSpecs: ${JSON.stringify(spec).slice(0, 900)}\n\nIntegrated design (use these concrete details for the geometry + spec sheet):\n${String(buildNotes).slice(0, 9000)}${physLine}${fixHint ? '\n\nThe previous attempt failed to render with: ' + String(fixHint).slice(0, 300) + ' — fix it and output a corrected, complete document.' : ''}`;
  try {
    // Fable 5 has the OUTPUT headroom (32k OTPM) for a large single-shot HTML; pace against the limit.
    try { await waitForBudget(MODEL_FABLE, estimateTokens([{ role: 'user', content: usr }]) + 1500, 8000); } catch {}
    const r = await anthropicRequest({ model: MODEL_FABLE, max_tokens: 8000, system: sys, messages: [{ role: 'user', content: usr }] }, getApiKey());
    const html = extractCode((r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), 'html');
    return /<html[\s\S]*<\/html>|<!doctype/i.test(html) ? html : null;
  } catch { return null; }
}

// ── MULTI-PART ARTIFACT ASSEMBLY ─────────────────────────────────────────────────────────────────
// A single 8k-token HTML can truncate on a big build. Instead: a DETERMINISTIC Three.js SKELETON
// (lib/studioscene — never model-generated, so it always renders) + one bounded geometry function
// PER subsystem, generated IN PARALLEL, then stitched in. Robust + parallel.
async function assembleStudioArtifact(goal, spec, buildNotes, physics, lanes, emit) {
  emit('🎨 assembling the 3D scene — subsystems in parallel');
  const list = (Array.isArray(lanes) && lanes.length ? lanes : [{ role: 'body', task: goal }]).slice(0, 6);
  const specStr = JSON.stringify(spec || {}).slice(0, 700);
  const genPart = async (lane, i) => {
    const sys = `You write ONE JavaScript function that adds a single subsystem's 3D geometry to a Three.js scene. Signature EXACTLY: function part_${i}(THREE, scene, group, specs){ ... }. Build real, recognizable geometry for the "${lane.role}" subsystem using THREE primitives (Box/Cylinder/Sphere/Cone/Torus/Lathe/Extrude), MeshStandardMaterial with the specified colours/metalness, and Groups for structure; position parts sensibly (up = +Y, human-ish scale ~1.8 units tall). Add everything to \`group\`. NO imports, NO HTML, NO OrbitControls, NO renderer/scene creation, NO markdown. Output ONLY the function.`;
    const usr = `Overall build: ${goal}\nThis subsystem — ${lane.role}: ${lane.task}\nSpecs: ${specStr}\nDesign notes:\n${studioscene.laneNotes(buildNotes, lane.role)}`;
    try {
      const r = await anthropicRequest({ model: MODEL_FABLE, max_tokens: 2400, system: sys, messages: [{ role: 'user', content: usr }] }, getApiKey());
      const code = extractCode((r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), 'javascript');
      const fn = code.match(new RegExp('function part_' + i + '\\s*\\([\\s\\S]*'));
      return (fn ? fn[0] : '') && /function part_/.test(fn ? fn[0] : '') ? (fn[0]) : `function part_${i}(THREE,scene,group,specs){}`;
    } catch { return `function part_${i}(THREE,scene,group,specs){}`; }
  };
  let parts;
  try { parts = await Promise.all(list.map(genPart)); } catch { parts = []; }   // PARALLEL geometry gen
  const good = (parts || []).filter((p) => p && /function part_\d+\s*\([\s\S]*\{[\s\S]*\}/.test(p));
  if (!good.length) { emit('↩︎ part assembly empty — single-shot fallback'); return generateStudioArtifact(goal, spec, buildNotes, physics, emit); }
  return studioscene.stitch(goal, spec, physics, parts);
}

// ONE build/refine pass: decompose → PARALLEL fleet → integrate → assemble (physics + multi-part 3D)
// → render (completion-gated) → persist artifacts. extraNotes carries refinement feedback so the same
// pass doubles as a refine step. Returns everything the caller needs to critique/iterate.
async function buildPass(goal, spec, deliverable, slug, emit, extraNotes = '') {
  const streams = await designWorkstreams(goal, spec, deliverable);
  emit(`🧩 ${streams.length} lanes in parallel: ${streams.map((s) => s.role).join(', ')}`);
  const fleetTasks = streams.map((s, i) => ({ id: 'lane-' + (i + 1), role: s.role, task: s.task + specBrief(spec, goal) + (extraNotes ? `\n\nINCORPORATE THIS FEEDBACK: ${extraNotes}` : '') }));
  let fleetOut;
  try { fleetOut = await agentTeam.fleet(fleetTasks, subagentDeps(), { maxParallel: fleetWidth(), integrate: true, onUpdate: (u) => fleetBroadcast(u) }); }
  catch (e) { fleetOut = { agents: [], result: 'lane build failed: ' + (e && e.message || e) }; }
  const agents = (fleetOut && fleetOut.agents) || [];
  const buildNotes = ((fleetOut && fleetOut.result) || agents.map((a) => `### ${a.role}\n${a.result}`).join('\n\n') || goal) + (extraNotes ? '\n\nREQUESTED CHANGES: ' + extraNotes : '');
  try { for (const a of agents) projects.note(slug, `[${a.role}] ${String(a.result).slice(0, 220)}`, 'lane'); } catch {}
  emit('🔗 lanes integrated — building the deliverable');

  let physics = null, firstImage = null; const made = [];
  if (deliverable === 'sim' || deliverable === 'both') {
    physics = await runPhysicsPass(goal, spec, buildNotes, emit);
    if (physics && physics.ok) { try { projects.recordArtifact(slug, { kind: 'sim', title: 'physics', meta: { summary: physics.summary.slice(0, 400) } }); } catch {} if (physics.image) firstImage = physics.image; made.push('physics'); }
  }
  let studioOk = false;
  if (deliverable === 'studio' || deliverable === 'both') {
    let html = await assembleStudioArtifact(goal, spec, buildNotes, physics, streams, emit);   // MULTI-PART assembly
    if (html) {
      let w = await executeTool('studio_write', { html });
      if (!w || w.success === false) {   // completion gate: one focused single-shot retry
        const html2 = await generateStudioArtifact(goal, spec, buildNotes, physics, emit, (w && w.error) || 'did not render');
        if (html2) w = await executeTool('studio_write', { html: html2 });
      }
      if (w && w.success !== false) { studioOk = true; made.push('3D viewer'); if (w._image && !firstImage) firstImage = w._image; try { projects.recordArtifact(slug, { kind: 'studio', title: goal.slice(0, 60), path: STUDIO_INDEX }); } catch {} }
    }
  }
  return { streams, buildNotes, physics, made, studioOk, firstImage };
}

// Critic pass for auto-run: score the current build + list the highest-value gaps to address next.
async function critiqueBuild(goal, spec, buildNotes, physics) {
  const sys = 'You are a demanding design/engineering critic. Given a build and its current state, output ONLY JSON: {"score":0-100,"done":bool,"gaps":["the 1-3 highest-value concrete improvements to make next"]}. done=true only if the build is genuinely complete and polished (score ≥ 88) or further work would be diminishing returns.';
  try {
    const r = await anthropicRequest({ model: MODEL_SONNET, max_tokens: 500, system: sys, messages: [{ role: 'user', content: `Goal: ${goal}\nSpecs: ${JSON.stringify(spec).slice(0, 500)}\nPhysics: ${physics && physics.summary ? physics.summary.slice(0, 500) : 'n/a'}\nCurrent build notes:\n${String(buildNotes).slice(0, 5000)}` }] }, getApiKey());
    const m = ((r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')).match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    return { score: Number(j.score) || 0, done: !!j.done, gaps: Array.isArray(j.gaps) ? j.gaps.slice(0, 3) : [] };
  } catch { return { score: 0, done: false, gaps: [] }; }
}

function autoBuildCaps(input) {
  const c = loadConfig().autoBuild || {};
  return { usd: Number(input.budgetUsd || c.budgetUsd || 10), hours: Number(input.hours || c.hours || 4), maxRounds: Number(input.maxRounds || c.maxRounds || 20) };
}

// AUTO-RUN — a DETACHED loop that keeps building/refining until it self-judges done, or hits the spend
// / time / round cap (Siddhant's pick: budget + time + done). Persists every round; notifies on finish.
async function runAutoBuild(jobId, goal, spec, deliverable, slug) {
  const caps = autoBuildCaps({}); const t0 = Date.now(); const usd0 = costToday().usd;
  const emit = (t) => { try { jobsBus.update(jobId, { note: t }); sendToActivity('tool-update', { type: 'thinking', text: '🤖 auto-build: ' + t }); } catch {} };
  let round = 0, best = null, notes = '';
  try {
    while (round < caps.maxRounds) {
      round++;
      emit(`round ${round} — building`);
      const pass = await buildPass(goal, spec, deliverable, slug, emit, notes);
      best = pass;
      const spent = +(costToday().usd - usd0).toFixed(2); const hrs = (Date.now() - t0) / 3.6e6;
      try { projects.note(slug, `auto round ${round}: ${pass.made.join(' + ') || 'notes'} (spent $${spent}, ${hrs.toFixed(1)}h)`, 'milestone'); } catch {}
      if (spent >= caps.usd) { emit(`stopped — hit $${caps.usd} budget`); break; }
      if (hrs >= caps.hours) { emit(`stopped — hit ${caps.hours}h`); break; }
      const crit = await critiqueBuild(goal, spec, pass.buildNotes, pass.physics);
      emit(`round ${round}: score ${crit.score}${crit.done ? ' — done' : ''}`);
      if (crit.done || !crit.gaps.length) { emit('stopped — build complete'); break; }
      notes = crit.gaps.join('; ');
    }
    const spent = +(costToday().usd - usd0).toFixed(2);
    try { projects.recordTurn(slug, 'Auto-build: ' + goal, `Auto-build finished after ${round} rounds ($${spent}). ${best ? best.made.join(' + ') : ''}`); await projects.updateSummary(slug, { summarize: projectSummarize }); } catch {}
    jobsBus.update(jobId, { status: 'done', note: `finished — ${round} rounds, $${spent}` });
    try { if (loadConfig().ttsEnabled !== false) speakDesktop(`<speak>Auto build finished, sir. ${round} rounds on ${goal.slice(0, 60)}.</speak>`); } catch {}
    try { telegramNotify(`🤖 Auto-build done: ${goal} — ${round} rounds, $${spent}. Project saved.`); } catch {}
  } catch (e) { jobsBus.update(jobId, { status: 'error', note: String(e && e.message || e) }); }
}

async function buildProject(input = {}, opts = {}) {
  const goal = String(input.goal || input.task || '').trim();
  if (!goal) return { success: false, error: 'build_project needs a `goal` (what to design/build). Gather the specs first (ask_options), then call build_project.' };
  const spec = (input.spec && typeof input.spec === 'object') ? input.spec : (input.spec ? { brief: String(input.spec) } : {});
  const deliverable = ['studio', 'sim', 'both'].includes(input.deliverable) ? input.deliverable : 'both';
  const mode = ['auto', 'collaborative'].includes(input.mode) ? input.mode : (loadConfig().buildMode === 'auto' ? 'auto' : 'collaborative');
  const emit = (t) => { try { (opts.onUpdate || ((x) => sendToActivity('tool-update', { type: 'thinking', text: x })))(t); } catch {} };

  // Durable project — everything persists here so Siddhant can resume the build later.
  const proj = projects.open(input.projectName || goal.slice(0, 60));
  const slug = proj.slug; try { projects.setActive(slug); projects.recordSpec(slug, spec); } catch {}
  projects.note(slug, 'Build started: ' + goal + ' (' + mode + ')', 'milestone');

  // AUTO-RUN — kick off the detached refine loop and return immediately (it runs for "hours").
  if (mode === 'auto') {
    const caps = autoBuildCaps(input);
    const job = jobsBus.create({ name: 'auto-build: ' + goal.slice(0, 80), kind: 'project' });
    runAutoBuild(job.id, goal, spec, deliverable, slug);   // NOT awaited — detached
    return {
      success: true, mode: 'auto', started: true, background: true, job_id: job.id, project: proj.name, projectSlug: slug,
      note: `Auto-build running in the background on "${proj.name}" — it will keep refining until done or it hits the cap ($${caps.usd} / ${caps.hours}h). Tell Siddhant it's underway in ONE short sentence and END your turn; do NOT wait. It saves each round and announces when finished; steer via manage_jobs.`,
    };
  }

  // COLLABORATIVE (default) — one pass, then check in and refine WITH Siddhant until he's happy.
  emit(`🗂 project "${proj.name}" — collaborative build`);
  let pass = await buildPass(goal, spec, deliverable, slug, emit);
  let rounds = 1; const interactive = !isRemote() && mainWindow && !mainWindow.isDestroyed() && input.checkpoint !== false;
  while (interactive && rounds < 6) {
    let ans = { selected: [], text: '' };
    try {
      ans = await requestOptions(
        `"${proj.name}" — ${pass.made.join(' + ') || 'draft'} ready. What next?`,
        [
          { label: 'Looks good — finish', description: 'Keep it as is and save the project.' },
          { label: 'Refine the design', description: 'Improve geometry / proportions / detail.' },
          { label: 'Adjust materials & colours', description: 'Change the look, finish, or palette.' },
          { label: 'Add / change a feature', description: 'Add, remove, or modify a subsystem.' },
        ], false, { allowText: true, textPlaceholder: 'or describe a specific change (e.g. "bulkier shoulders, matte finish")' });
    } catch { ans = { selected: [], text: '' }; }
    const pick = (ans.selected[0] || '').toLowerCase();
    if (!ans.text && (!pick || /looks good|finish/.test(pick))) break;
    // Prefer the free-text change he typed; else the picked category as a directive.
    const feedback = ans.text || pick;
    emit('🔧 refining: ' + feedback);
    pass = await buildPass(goal, spec, deliverable, slug, emit, feedback);
    rounds++;
  }

  const done = pass.made.length ? pass.made.join(' + ') : 'design notes only';
  const summary = `Built ${goal} → ${done} (${rounds} pass${rounds > 1 ? 'es' : ''}). Lanes: ${pass.streams.map((s) => s.role).join(', ')}.${pass.physics && pass.physics.ok ? ' Physics: ' + pass.physics.summary.split('\n')[0].slice(0, 120) : ''}`;
  try { projects.note(slug, 'Deliverable: ' + done, 'milestone'); projects.recordTurn(slug, 'Build: ' + goal, summary); await projects.updateSummary(slug, { summarize: projectSummarize }); } catch {}
  emit(`✅ ${proj.name}: ${done}`);

  return {
    success: true, mode: 'collaborative', project: proj.name, projectSlug: slug, deliverable, rounds,
    lanes: pass.streams.map((s) => s.role),
    physics: pass.physics ? pass.physics.summary : undefined,
    artifactRendered: pass.studioOk, produced: pass.made,
    summary, resume: `Saved as project "${proj.name}". Say "continue ${proj.name}" (or ask for a change) to keep working on it — the specs + artifacts are remembered. Set mode:"auto" to let it refine autonomously for hours.`,
    _image: pass.firstImage || undefined, _imageMime: 'image/jpeg',
  };
}

// ── VISUAL LAYER — canvas + option thumbnails ────────────────────────────────────────────────────
// Smart-mix image resolver (Siddhant's pick): a real photo for a real thing (Colosseum, a place, a
// product) via keyless search; an AI-generated image for a concept/abstract option. Returns a URL
// (https for search results, data: URI for generated) suitable for an <img src>.
async function resolveImage(query, { generate } = {}) {
  const q = String(query || '').trim(); if (!q) return null;
  if (generate) {
    try { const g = await generateImage({ prompt: q }); if (g && g.success && g._image) return `data:${g._imageMime || 'image/png'};base64,${g._image}`; } catch {}
    return null;
  }
  try { const r = await imagesearch.search(q, { limit: 1 }); if (r && r[0]) return r[0].thumb || r[0].url; } catch {}
  return null;
}

// show_visuals — open the in-app CANVAS and layer draggable/resizable image cards while BhatBot keeps
// talking. Sources images smart-mix (real search default; generate:true for concepts) or takes explicit urls.
async function showVisuals(input = {}) {
  const title = String(input.title || input.query || 'Visuals').slice(0, 90);
  let images = [];
  if (Array.isArray(input.urls) && input.urls.length) {
    images = input.urls.slice(0, 12).map((u, i) => ({ url: String(u), caption: (input.captions && input.captions[i]) || '' }));
  } else if (input.generate) {
    const n = Math.min(Number(input.count) || 1, 4);
    const gens = await Promise.all(Array.from({ length: n }, () => resolveImage(input.query || title, { generate: true })));
    images = gens.filter(Boolean).map((u) => ({ url: u, caption: input.query || title }));
  } else {
    try { const r = await imagesearch.search(input.query || title, { limit: Math.min(Number(input.count) || 6, 12) }); images = r.map((x) => ({ url: x.thumb || x.url, full: x.url, caption: x.title, by: x.by, source: x.source })); } catch {}
  }
  if (!images.length) return { success: false, error: 'no images found for "' + (input.query || title) + '" — describe it in words instead, or try generate:true.' };
  try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.webContents.send('canvas-add', { title, images }); mainWindow.webContents.send('show-panel', 'canvas'); } } catch {}
  return { success: true, shown: images.length, title, note: 'Images are ON the canvas now — keep talking about the subject; do NOT read image URLs aloud.' };
}

// Resolve any per-option imagery for an ask_options card (imageQuery → search, generate:true → AI),
// bounded so the card still pops promptly.
async function resolveOptionImages(opts) {
  await Promise.all(opts.map(async (o) => {
    if (o.image || (!o.imageQuery && !o.generate)) return;
    try {
      const u = await Promise.race([resolveImage(o.imageQuery || o.label, { generate: !!o.generate }), new Promise((r) => setTimeout(() => r(null), 6000))]);
      if (u) o.image = u;
    } catch {}
  }));
  return opts;
}

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
// Expand a leading ~ and $HOME/${HOME} in tool-supplied file paths. The model routinely
// passes "~/.bhatbot/config.json"; Node's fs takes it literally → ENOENT → the model falls
// back to run_shell (the read_file failure seen in the transcript). Normalizing here makes
// the file tools "just work" on home-relative paths.
function expandPath(p) {
  if (typeof p !== 'string' || !p) return p;
  let out = p.trim();
  if (out === '~' || out.startsWith('~/')) out = path.join(os.homedir(), out.slice(1));
  out = out.replace(/^\$\{?HOME\}?(?=\/|$)/, os.homedir());
  // Foreign-home remap. The model sometimes emits an absolute path under the WRONG
  // username (e.g. /Users/siddhant/bhatbot/package.json instead of the real
  // /Users/siddhantbhat/...), which ENOENTs and forced a run_shell fallback (the
  // read_file failures seen in the transcript). If a path sits directly under the
  // home root (/Users on macOS, /home on Linux) but names a different user than the
  // real home, and that path is missing while the same path under the real home
  // exists, rewrite the user segment so the file tools "just work". Guarded by the
  // existence check so legit siblings (e.g. /Users/Shared/...) are never touched.
  try {
    const home = os.homedir();
    const root = path.dirname(home);   // /Users
    const self = path.basename(home);  // siddhantbhat
    if (root && root !== '/' && out.startsWith(root + '/')) {
      const rest = out.slice(root.length + 1);
      const slash = rest.indexOf('/');
      const user = slash === -1 ? rest : rest.slice(0, slash);
      if (user && user !== self) {
        const remapped = slash === -1 ? home : path.join(home, rest.slice(slash + 1));
        if (!fs.existsSync(out) && fs.existsSync(remapped)) out = remapped;
      }
    }
  } catch {}
  return out;
}

// True for files that hold real secrets (the encrypted credential vault; the browser session
// profile with auth cookies/tokens). read_file returns a CLEAN structured refusal for these
// instead of a raw fs error, so the model explains why instead of improvising a run_shell find.
// NOTE: config.json is deliberately NOT guarded — it holds only CRED_REF_* handles (secrets were
// migrated to the vault), so it's safe + useful to read.
function isSecretPath(fp) {
  try {
    const p = path.resolve(fp);
    const bb = path.join(os.homedir(), '.bhatbot');
    if (p === path.join(bb, 'credentials.json')) return true;
    if (p === path.join(bb, 'browser-profile.json')) return true;
    if (p === path.join(bb, 'browser-profile-dir') || p.startsWith(path.join(bb, 'browser-profile-dir') + path.sep)) return true;
    return false;
  } catch { return false; }
}

function applyEdit(input) {
  const fp = expandPath(input && input.path);
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
  // Shared read-cache: for a side-effect-free read, serve a fresh cached result (or ride an in-flight
  // prefetch) instead of re-running it — this is the fleet-dedup + speculative-prefetch fast path.
  const __cacheable = READ_CACHEABLE.has(name) && loadConfig().readCache !== false;
  if (__cacheable) {
    try {
      const hit = await _readCache.getAsync(name, input);
      if (hit !== undefined) { auditLog(name, auditInput, hit, Date.now() - __auditT0, _lastUsage); return hit; }
    } catch {}
  }
  const maxAttempts = isRetryableTool(name, input) ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    switch (name) {
      case 'read_file': {
        const rp = expandPath(input.path);
        if (isSecretPath(rp)) { result = { success: false, guarded: true, error: 'refused: this path holds encrypted credentials/session secrets and cannot be read directly. The values are stored via the vault (CRED_REF handles); ask Siddhant if you need one.' }; break; }
        const stat = fs.statSync(rp);
        const raw = fs.readFileSync(rp, 'utf8');
        // Line paging so large files (e.g. BhatBot's own 400KB+ main.js — needed for self-inspection)
        // can be read in windows instead of hard-failing. offset = 1-based start line; limit = count.
        const hasWindow = input.offset != null || input.limit != null;
        const CHAR_CAP = 90 * 1024;   // keep any single result comfortably under the tool-result token cap
        if (hasWindow) {
          const lines = raw.split('\n');
          const start = Math.max(1, Number(input.offset) || 1);
          const count = Math.max(1, Number(input.limit) || 400);
          const slice = lines.slice(start - 1, start - 1 + count).join('\n').slice(0, CHAR_CAP);
          result = { success: true, content: slice, offset: start, lines_returned: Math.min(count, lines.length - start + 1), total_lines: lines.length, truncated: start - 1 + count < lines.length };
          break;
        }
        if (stat.size > CHAR_CAP) {
          const lines = raw.split('\n');
          const head = raw.slice(0, CHAR_CAP);
          const headLines = head.split('\n').length;
          result = { success: true, content: head, offset: 1, lines_returned: headLines, total_lines: lines.length, truncated: true,
            note: `File is ${Math.round(stat.size / 1024)}KB / ${lines.length} lines — returned the first ~${headLines}. Re-read with {"path":"…","offset":${headLines + 1},"limit":400} to page further.` };
          break;
        }
        result = { success: true, content: raw }; break;
      }
      case 'write_file': {
        const wp = expandPath(input.path);
        fs.mkdirSync(path.dirname(wp), { recursive: true });
        fs.writeFileSync(wp, input.content);
        result = { success: true, path: wp }; break;
      }
      case 'edit_file':
        result = applyEdit(input); break;
      case 'list_directory':
        result = { success: true, entries: fs.readdirSync(expandPath(input.path), { withFileTypes: true })
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
      case 'ask_options': {
        const opts = Array.isArray(input.options) ? input.options.filter((o) => o && (o.label || typeof o === 'string')).map((o) => (typeof o === 'string' ? { label: o } : { label: String(o.label), description: o.description ? String(o.description) : undefined, image: o.image ? String(o.image) : undefined, imageQuery: o.imageQuery ? String(o.imageQuery) : undefined, generate: !!o.generate })).slice(0, 12) : [];
        if (!input.question || opts.length < 2) { result = { success: false, error: 'ask_options needs a `question` and ≥2 `options` (each {label, description?, imageQuery?}).' }; break; }
        // Interactive picker is a desktop-window feature; on phone/headless/remote fall back to text.
        if (isRemote() || !mainWindow || mainWindow.isDestroyed()) { result = { success: false, error: 'No interactive UI on this surface — instead, list the options in your reply as a numbered list and ask Siddhant to reply with his pick(s).' }; break; }
        // autoVisual: give every un-imaged option a photo from its own label so the choice is visual.
        if (input.autoVisual) for (const o of opts) { if (!o.image && !o.imageQuery && !o.generate) o.imageQuery = o.label; }
        if (opts.some((o) => o.imageQuery || o.generate)) { try { sendToActivity('tool-update', { type: 'thinking', text: '🖼 fetching option visuals' }); await resolveOptionImages(opts); } catch {} }   // visual options
        const ans = await requestOptions(input.question, opts, !!input.multi, { allowText: input.allowText !== false, textPlaceholder: input.textPlaceholder || 'or type your own…' });
        result = { success: true, selected: ans.selected, text: ans.text || undefined, note: (ans.selected.length || ans.text) ? undefined : 'Siddhant made no selection (dismissed the card) — proceed with sensible defaults or ask again in text.' };
        break;
      }
      case 'ask_form': {
        const raw = Array.isArray(input.fields) ? input.fields : [];
        const fields = raw.filter((f) => f && f.key && f.label).map((f) => ({
          key: String(f.key), label: String(f.label),
          type: ['text', 'number', 'textarea', 'select', 'multiselect'].includes(f.type) ? f.type : 'text',
          placeholder: f.placeholder ? String(f.placeholder) : '',
          required: !!f.required,
          options: Array.isArray(f.options) ? f.options.map(String).slice(0, 20) : undefined,
          default: f.default
        })).slice(0, 10);
        if (!fields.length) { result = { success: false, error: 'ask_form needs a `fields` array (each {key, label, type?}).' }; break; }
        if (isRemote() || !mainWindow || mainWindow.isDestroyed()) { result = { success: false, error: 'No interactive UI on this surface — instead, ask for the fields in your reply and let Siddhant type them back.' }; break; }
        const ans = await requestForm(input.title, fields, { submitLabel: input.submitLabel });
        if (ans.dismissed || !ans.values) { result = { success: true, values: {}, note: 'Siddhant dismissed the form without submitting — proceed with sensible defaults or ask again in text.' }; break; }
        result = { success: true, values: ans.values };
        break;
      }
      case 'phone_mirror':
        result = await phoneMirror(input || {}); break;
      case 'show_visuals':
        result = await showVisuals(input || {}); break;
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
      case 'sci_compute': {
        // Quantitative/numerics/stats/MPS-torch compute pack (lib/scicompute.js, own venv).
        if ((input.action || 'run') === 'capabilities') result = scicompute.capabilities();
        else result = await scicompute.run({ code: input.code, timeoutMs: input.timeoutMs });
        break;
      }
      case 'container_run': {
        // Docker container lane — the STRONGER isolation floor over the untrusted-code wall. Never
        // inherits BhatBot's env/secrets; network defaults to 'none' for generated/cloned code.
        if ((input.action || 'run') === 'status') {
          const avail = await dockerPack.available();
          result = { success: true, available: avail, hint: avail ? undefined : dockerPack.INSTALL_HINT,
            note: avail ? 'Docker daemon reachable — container lane active.' : 'Docker absent — untrusted code falls back to the scrubbed-subprocess sandbox floor (lib/sandboxexec.js).' };
          break;
        }
        if (!(await dockerPack.available())) { result = { success: false, error: dockerPack.INSTALL_HINT }; break; }
        const image = input.image || dockerPack.baseImageFor(input.stack || 'debian');
        const net = input.network || (input.trusted ? 'bridge' : 'none'); // untrusted → no network by default
        const r = await dockerPack.run({ image, cmd: input.cmd, mount: input.mount, workdir: input.workdir,
          memory: input.memory, cpus: input.cpus, network: net, platform: input.platform,
          env: input.env && typeof input.env === 'object' ? input.env : undefined, timeoutMs: input.timeoutMs });
        result = { success: r.code === 0 && !r.timedOut, image: r.image, exitCode: r.code, timedOut: r.timedOut,
          network: net, stdout: (r.stdout || '').slice(-6000), stderr: (r.stderr || '').slice(-3000) };
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
      case 'gmail': {
        const a = input.action;
        if (a === 'search') result = await google.gmailSearch(input.query, { limit: input.limit });
        else if (a === 'read') result = await google.gmailRead(input.id);
        else if (a === 'draft') result = await google.gmailDraft(input);
        else if (a === 'label') result = await google.gmailLabel(input.id, { add: input.add || [], remove: input.remove || [] });
        else result = { success: false, error: 'Unknown gmail action: ' + a };
        break;
      }
      case 'calendar': {
        const a = input.action;
        if (a === 'list') result = await google.calendarList(input);
        else if (a === 'create') result = await google.calendarCreate(input);
        else if (a === 'update') result = await google.calendarUpdate(input.id, input);
        else if (a === 'delete') result = await google.calendarDelete(input.id, input);
        else result = { success: false, error: 'Unknown calendar action: ' + a };
        break;
      }
      case 'drive': {
        const a = input.action;
        if (a === 'search') result = await google.driveSearch(input.query, { limit: input.limit });
        else if (a === 'read') result = await google.driveRead(input.id);
        else if (a === 'create') result = await google.driveCreate(input);
        else result = { success: false, error: 'Unknown drive action: ' + a };
        break;
      }
      case 'davinci_resolve':
        result = await resolve.resolveTool(input); break;
      case 'browser_devtools':
        result = await browserDevtools(input); break;
      case 'bioart': {
        if (input.action === 'search') {
          const r = await bioart.search(input.query, { limit: input.limit });
          // Trim the token-heavy filesinfo out of the model-facing payload (kept server-side for `get`).
          if (r.success) result = { success: true, count: r.count, query: r.query,
            results: r.results.map((x) => ({ id: x.id, title: x.title, description: x.description, formats: x.formats, thumbnail: x.thumbnail, detail: x.detail })) };
          else result = r;
        } else if (input.action === 'get') {
          const r = await bioart.fetchAsset({ id: input.id, format: input.format || 'PNG', fileId: input.fileId });
          if (r.success) { try { showVisuals({ urls: ['file://' + r.path], title: 'BioArt ' + input.id }); } catch {} }
          result = r;
        } else result = { success: false, error: 'Unknown bioart action: ' + input.action };
        break;
      }
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
      case 'build_project': {
        // One-turn completion engine: parallel-fleet build → integrate → physics + 3D artifact →
        // persisted resumable project. Surface the Vanguard panel so the parallel lanes are visible.
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('show-panel', 'vanguard'); } catch {}
        result = await buildProject(input, { onUpdate: (t) => sendToActivity('tool-update', { type: 'thinking', text: t }) });
        break;
      }
      case 'deploy_drones': {
        // FORGE D2 — deploy N scoped BhatBot instances (drones) on a mission via the fleet supervisor
        // (lib/fleet.js): budget-derived width (admission), envelope wallet, stall reaping, blackboard
        // relay. Explicit `drones` or an orchestrator-designed fleet from `mission`.
        const mission = String(input.mission || (Array.isArray(input.drones) && input.drones.map((d) => d.goal).filter(Boolean).join('; ')) || '').trim();
        if (!mission && !(Array.isArray(input.drones) && input.drones.length)) { result = { success: false, error: 'mission or drones[] required' }; break; }
        const hardCap = Math.max(1, Math.min(input.hardCap || 6, FLEET_CAP));
        const wsDir = path.join(os.homedir(), '.bhatbot', 'drones', 'run-' + Date.now());
        try { fs.mkdirSync(wsDir, { recursive: true }); } catch {}
        const board = blackboard.createBlackboard({ dir: wsDir });
        let specs;
        if (Array.isArray(input.drones) && input.drones.length) {
          specs = input.drones.slice(0, hardCap).map((d, i) => ({
            id: 'drone-' + (i + 1), role: d.role, tools: Array.isArray(d.tools) ? d.tools : undefined,
            persona: d.persona || { name: (d.role || ('DRONE-' + (i + 1))).toUpperCase(), brief: d.brief || d.goal || mission, style: 'concise' },
            hermetic: !!d.hermetic, _task: { goal: d.goal || mission },
          }));
        } else {
          specs = await designDroneFleet(mission, hardCap);
        }
        const perDrone = (input.budgetUsd || 2) / Math.max(1, specs.length);
        specs.forEach((s, i) => { s.wsDir = path.join(wsDir, s.id || ('d' + i)); s.budget = { usd: perDrone, maxTurns: input.maxTurns || 8 }; });
        const taskMap = Object.fromEntries(specs.map((s) => [s.id, s._task || { goal: mission }]));
        // Live surfacing: Vanguard panel cards + Activity + spoken launch line.
        try { fleetSeed(specs.map((s) => ({ id: s.id, role: (s.persona && s.persona.name) || s.id, task: (taskMap[s.id] || {}).goal || mission }))); } catch {}
        sendToActivity('tool-update', { type: 'thinking', text: `🛩 deploying ${specs.length} drones: ${specs.map((s) => s.persona.name).join(', ')}` });
        try { speakDesktop(`<speak>Deploying ${specs.length} ${specs.length === 1 ? 'drone' : 'drones'} on it, sir.</speak>`); } catch {}
        const onEvent = (ev) => {
          if (ev.type === 'drone-done') { try { fleetBroadcast({ id: ev.drone, status: ev.status, step: 'done' }); } catch {} }
          if (ev.type === 'drone-reaped' || ev.type === 'drone-nudge') sendToActivity('tool-update', { type: 'thinking', text: `🛩 ${ev.type.replace('drone-', 'drone ')}: ${ev.drone}` });
        };
        let out;
        try {
          out = await runFleet(specs, { board, agentRun: droneAgentRun, admission, onEvent, log: (t) => sendToActivity('tool-update', { type: 'thinking', text: t }) },
            { wsDir, mission, hardCap, envelopeUsd: input.budgetUsd || 2, staleMs: input.staleMs || 90000, nudgeGraceMs: 15000, taskFor: (d) => taskMap[d.id] || { goal: mission } });
        } catch (e) { try { fleetDone(); } catch {}; result = { success: false, error: 'fleet error: ' + e.message }; break; }
        try { fleetDone(); } catch {}
        let synthesis = null;
        if (input.synthesize !== false && out.results.some((r) => r.status === 'ok' || r.status === 'partial')) {
          synthesis = await synthesizeDroneResults(mission, out.results);
        }
        sendToActivity('tool-update', { type: 'thinking', text: `🛩 fleet back: ${out.launched} launched, ${out.reaped} reaped, $${out.totalSpend.toFixed(3)}` });
        try { speakDesktop(`<speak>The fleet's back — summary on screen.</speak>`); } catch {}
        result = {
          success: true, mission, board_file: board.file,
          drones: out.results.map((r) => ({ persona: r.persona, status: r.status, summary: r.summary, spend: r.spend, reaped: !!r.reaped })),
          totalSpend: out.totalSpend, launched: out.launched, reaped: out.reaped, envelopeExceeded: out.envelopeExceeded,
          synthesis,
        };
        break;
      }
      case 'find_papers': {
        // FORGE Phase 6 — scholarly search across arXiv (keyless) + Semantic Scholar (key optional),
        // merged + deduped into normalized records. The research-depth pipeline builds on this.
        const q = String(input.query || '').trim();
        if (!q) { result = { success: false, error: 'query required' }; break; }
        const max = Math.max(1, Math.min(input.max || 8, 25));
        const c = loadConfig();
        const [ax, ss] = await Promise.all([
          scholar.arxiv(q, { max }),
          scholar.semanticScholar(q, { max, key: c.semanticScholarKey }).catch(() => ({ results: [] })),
        ]);
        const merged = scholar.mergeDedupe(ax.results, ss.results).slice(0, max);
        const notes = [ax.error && ('arxiv: ' + ax.error), ss.error && ('semanticscholar: ' + ss.error)].filter(Boolean);
        result = { success: merged.length > 0 || notes.length === 0, query: q, count: merged.length,
          papers: merged.map((p) => ({ title: p.title, authors: (p.authors || []).slice(0, 6), year: p.year, source: p.source, citations: p.citations, pdfUrl: p.pdfUrl, url: p.url, abstract: (p.abstract || '').slice(0, 400) })),
          notes: notes.length ? notes : undefined };
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
        // Guard the empty/no-arg call ({} or non-string html) that used to throw "data must be a
        // string" and leave the turn stalled — return a crisp corrective so the model retries with real HTML.
        if (typeof input.html !== 'string' || !input.html.trim()) {
          result = { success: false, error: 'studio_write was called with no `html`. Provide the COMPLETE HTML document as a string in `html` (a full <!doctype html>… page with inline CSS/JS — the simulation/render), then call studio_write again.' };
          break;
        }
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
          const sWin = wm.getStudioWindow();
          if (!shot && sWin && !sWin.isDestroyed()) {     // legacy fallback
            const img = await sWin.webContents.capturePage();
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
      case 'self_drive': {
        const a = (input && input.action) || 'status';
        if (a === 'status') { result = { success: true, running: selfdrive.isRunning(), ...selfdrive.status(loadConfig) }; break; }
        if (a === 'enable' || a === 'disable') {
          const cur = loadConfig().selfDrive || {};
          saveConfig({ selfDrive: { ...cur, enabled: a === 'enable' } });
          result = { success: true, result: `Self-drive ${a}d.`, ...selfdrive.status(loadConfig) };
          break;
        }
        if (a === 'stop') { result = { success: true, ...selfdrive.requestStop(input && input.now ? 'now' : 'graceful'), note: 'Self-drive will halt after the current cycle (or immediately if now=true).' }; break; }
        if (a === 'run' || a === 'start') {   // begin an on-demand session (runs in background; progress → panel)
          // The self_drive tool is a step-up tool: reaching this handler means the confirm card was
          // approved, so this manual path carries approval (approved:true). Run free from here.
          const r = startSelfDriveSession({ reason: input && input.reason ? String(input.reason).slice(0, 40) : 'manual', focus: (input && input.focus) || '', maxCycles: input && input.maxCycles, approved: true });
          result = { success: !r.skipped, ...r, note: r.skipped ? r.skipped : 'Self-drive session started — I\'ll run free through my actionable backlog on an isolated local branch (never pushed, verify-gated), refuse + report anything that would degrade me. Say "stop improving yourself" to halt.' };
          break;
        }
        result = { success: false, error: 'unknown self_drive action: ' + a };
        break;
      }
      case 'health': {
        const a = (input && input.action) || 'show';
        if (a === 'login') { result = { success: true, ...(await garmin.login(loadConfig, keychainRead, input && input.mfa)) }; break; }
        if (a === 'status') { result = { success: true, ...(await garmin.status(loadConfig, keychainRead)), monitoring: healthMonitoring() }; break; }
        if (a === 'monitor') { const on = input && input.enable !== false; const cur = loadConfig().health || {}; saveConfig({ health: { ...cur, enabled: on } }); if (on) startHealthMonitor(); else stopHealthMonitor(); result = { success: true, result: `Health monitor ${on ? 'on' : 'off'}.`, monitoring: healthMonitoring() }; break; }
        if (!garmin.available()) { result = { success: false, error: 'Garmin not connected yet. One-time setup: store your password in Keychain (security add-generic-password -s bhatbot-garmin -a <email> -w), set config.garmin.email, then run scripts/garmin-setup.sh (handles MFA).', needsSetup: true }; break; }
        if (a === 'sync') { const s = await healthSync(); pushBiometrics(); const p = biometricPortrait(); result = { success: !!(s && s.ok), result: health.brief(p), ...s, flags: p.flags }; break; }
        if (a === 'insights') {
          if (input && input.sync !== false) { await healthSync(); }
          const p = biometricPortrait(); pushBiometrics();
          const ins = await health.insights(p, { anthropicRequest, apiKey: getApiKey() });
          result = { success: true, result: ins.text, disclaimer: p.disclaimer, flags: p.flags, trends: p.trends };
          break;
        }
        // 'show' | 'today' | 'trends' → open the Health tab + return the portrait
        if (input && input.sync) { await healthSync(); }
        const p = biometricPortrait(); pushBiometrics();
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('show-panel', 'health'); } catch {}
        result = { success: true, result: health.brief(p), opened: 'health', portrait: { latest_date: p.latest_date, flags: p.flags, trends: p.trends, days_tracked: p.days_tracked, disclaimer: p.disclaimer } };
        break;
      }
      case 'ops_status': {
        const snap = opsSnapshot();
        if (input && input.show !== false) { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('show-panel', 'manage'); } catch {} }
        result = { success: true, result: snap.summary, ...snap };
        break;
      }
      case 'hud_control': {
        // Agent-driven HUD: surface a work panel, switch the command layout, or refocus a column.
        // Tool names are the user-facing tab names; the renderer keeps its historical panel ids.
        // 'presence' → the 3D fleet-presence lives IN the FLEET tab now (embedded iframe), so just
        // surface that tab and push the current snapshot into it.
        if (input && input.panel === 'presence') {
          try {
            if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.webContents.send('show-panel', 'vanguard'); mainWindow.webContents.send('presence-update', presenceSnapshot()); }
            result = { success: true, result: 'Opened the FLEET tab (3D agent presence).' };
          } catch (e) { result = { success: false, error: e.message }; }
          break;
        }
        const PANEL_ID = { command: 'chat', fleet: 'vanguard', management: 'manage' };
        const cmd = {};
        if (input && input.panel) cmd.panel = PANEL_ID[input.panel] || input.panel;
        if (input && input.layout) cmd.layout = Number(input.layout);
        if (input && input.focus) cmd.focus = input.focus;
        if (!Object.keys(cmd).length) { result = { success: false, error: 'Pass panel, layout, or focus.' }; break; }
        try {
          if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.webContents.send('hud-command', cmd); }
          result = { success: true, result: 'HUD updated: ' + JSON.stringify(cmd) };
        } catch (e) { result = { success: false, error: e.message }; }
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
        // Reflection → PROPOSAL (Siddhant's rule 2026-07-01): asking what I'd improve surfaces an offer,
        // but a session only STARTS with an explicit go-ahead (no more auto-start on reflection). If
        // there's ≥1 automatable, non-frozen LOCAL/STRUCTURAL desire, stage a pending proposal the user
        // approves by saying "go ahead"; once approved it runs FREE through the backlog.
        try {
          const sdCfg = selfdrive.cfgFrom(loadConfig);
          const forbid = /\b(do ?n'?t|do not|just tell|only tell|no change|hold off|not now|without (chang|edit|implement)|don'?t (implement|change|touch|act))\b/i.test(String(focus));
          const actionable = (rf.desires || []).some((d) => { const c = selfDriveClassify(d); return c.automatable && (c.level === 'LOCAL' || c.level === 'STRUCTURAL') && !c.frozen; });
          if (sdCfg.enabled && !forbid && actionable && !selfdrive.isRunning()) {
            _pendingSelfDrive = { reason: 'reflection', focus: String(focus || '').slice(0, 200), at: Date.now() };
            text += '\n\n— Want me to act on this? Say "go ahead" and I\'ll run a self-improvement session through these on an isolated local branch (verify-gated, auto-reverting anything that would degrade me, never pushed). I won\'t start without your go-ahead.';
          }
        } catch {}
        result = { success: true, result: text, desires: rf.desires, scope };
        break;
      }
      default:
        if (mcphub.isHubTool(name)) { result = await mcphub.callTool(name, input); break; }   // external MCP plugin tool
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
  // Populate the shared read-cache on a successful read; a write invalidates any stale cached read of
  // that path so a read-after-write in the same batch never sees old bytes.
  try {
    if (__cacheable && result && result.success !== false) _readCache.set(name, input, result);
    else if ((name === 'write_file' || name === 'edit_file') && result && result.success !== false && input && input.path) _readCache.invalidatePath(expandPath(input.path));
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
  feedTurnState(channel, data);   // T2 — fold this emit into the single display-state snapshot
}
function sendToActivity(channel, data) {
  // Direct callers (briefing, barge-in, studio/3D progress, MCP/Telegram tasks) — these are NOT
  // also routed via sendToAll, so a single send to the main renderer is correct (no double).
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data); } catch {}
  try { if (activityWindow && !activityWindow.isDestroyed()) activityWindow.webContents.send(channel, data); } catch {}
  pushActivity(channel, data);
  feedTurnState(channel, data);   // T2 — fold this emit into the single display-state snapshot
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

// ===========================================================================
// LIVE ACTION VIEW — a pop-up "watch me work" window that mirrors what the MAIN agent is doing in
// real time: the current action in plain English, a rolling log, and (for screen/browser/desktop
// work) periodic SCREENSHOTS of the actual screen. Reuses agentmon.html (id='live') so all the
// rendering already exists; we just feed it 'fleet-update' payloads tagged id:'live'.
// ===========================================================================
let actionViewWin = null;
let _avLastShot = 0;   // throttle live screenshots
function openActionView() {
  try {
    if (actionViewWin && !actionViewWin.isDestroyed()) { actionViewWin.show(); return { success: true }; }
    const asset = path.join(__dirname, 'assets', 'agentmon.html');
    if (!fs.existsSync(asset)) return { success: false, error: 'agentmon.html missing' };
    actionViewWin = new BrowserWindow({
      width: 620, height: 760, resizable: true, minWidth: 380, minHeight: 400,
      title: 'BhatBot — Live Action View', backgroundColor: '#0a0f17', alwaysOnTop: false,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload-agentmon.js') },
    });
    actionViewWin.loadFile(asset, { query: { id: 'live' } });
    actionViewWin.on('closed', () => { actionViewWin = null; });
    actionViewWin.webContents.once('did-finish-load', () => { try { actionViewWin.webContents.send('fleet-update', { id: 'live', role: 'BhatBot', status: 'working', note: 'Live action view attached.' }); } catch {} });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}
// Push one live-view update (no-op if the window isn't open). shot = base64 jpeg of the screen.
function actionView(payload) {
  try { if (actionViewWin && !actionViewWin.isDestroyed()) actionViewWin.webContents.send('fleet-update', { id: 'live', ...payload }); } catch {}
}
// Capture a throttled screenshot of the actual screen for the live view (so Siddhant SEES the agent
// acting on his machine). Best-effort; skips if we grabbed one very recently.
async function actionViewShot(caption) {
  if (!actionViewWin || actionViewWin.isDestroyed()) return;
  if (Date.now() - _avLastShot < 1800) return;   // ≥1.8s between captures
  _avLastShot = Date.now();
  // captureScreenJpeg returns { image, mime } (or { error } when Screen Recording is denied) —
  // pass ONLY the base64 string as shot, never the object (that rendered as a broken image).
  try { const r = await captureScreenJpeg(); if (r && r.image) actionView({ shot: r.image, shotMime: r.mime || 'image/jpeg', note: caption || 'live screen' }); } catch {}
}
ipcMain.handle('open-action-view', () => openActionView());
// Tools that ACTUATE the machine (browser/desktop/screen/shell) — these are what a "watch me work"
// view is for, so they auto-open the Action View and stream screenshots.
const ACTUATING_TOOLS = new Set([
  'browser', 'browser_workflow', 'browser_observe', 'open_in_browser', 'screen_parse', 'screen_observe',
  'vision_click', 'vision_local', 'ui_inspect', 'system_control', 'media_control', 'run_shell',
  'smart_login', 'manage_logins', 'phone_mirror',
]);
// Continuous plain-English narration of the current action (the "what am I doing right now" line).
function describeAction(name, input = {}) {
  const s = (v, n = 48) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  try {
    switch (name) {
      case 'web_search': return `Searching the web for “${s(input.query)}”`;
      case 'find_papers': return `Searching papers for “${s(input.query || input.q)}”`;
      case 'fetch_url': case 'open_in_browser': { let h = s(input.url, 60); try { h = new URL(input.url).host; } catch {} return `Opening ${h}`; }
      case 'browser': return input.action ? `Browser: ${s(input.action)}${input.url ? ' → ' + s(input.url, 40) : ''}` : 'Driving the browser';
      case 'browser_workflow': return `Running a browser workflow`;
      case 'run_shell': return `Running: ${s(input.command || input.cmd, 60)}`;
      case 'read_file': return `Reading ${s(input.path || input.file, 60)}`;
      case 'write_file': case 'edit_file': return `Writing ${s(input.path || input.file, 60)}`;
      case 'list_directory': return `Listing ${s(input.path || '.', 60)}`;
      case 'system_control': return `${s(input.action || 'controlling')} ${s(input.app || input.text || '', 40)}`.trim();
      case 'media_control': return `Media: ${s(input.action)}`;
      case 'screen_parse': case 'screen_observe': return 'Looking at the screen';
      case 'ui_inspect': return 'Inspecting the UI';
      case 'vision_click': return `Clicking ${s(input.expect || input.query || 'an element')}`;
      case 'phone_mirror': return `Phone: ${s(input.action)}`;
      case 'generate_image': return `Generating an image of “${s(input.prompt || input.query)}”`;
      case 'generate_3d': case 'make_printable': return 'Building a 3D model';
      case 'simulate': case 'sci_compute': return 'Running a computation';
      case 'studio_write': return 'Rendering the 3D scene';
      case 'make_figure': return 'Making a figure';
      case 'molecule': return `Rendering molecule ${s(input.query || input.name)}`;
      case 'maps': return `Mapping ${s(input.query || input.place)}`;
      case 'save_memory': return 'Saving to memory';
      case 'notion_search': return `Searching Notion for “${s(input.query)}”`;
      case 'gmail': return input.action === 'search' ? `Searching Gmail: ${s(input.query, 40)}` : input.action === 'draft' ? `Drafting an email${input.to ? ` to ${s(input.to, 30)}` : ''}` : input.action === 'read' ? 'Reading an email' : 'Updating an email';
      case 'calendar': return input.action === 'create' ? `Adding to calendar: ${s(input.summary, 40)}` : input.action === 'list' ? 'Checking the calendar' : input.action === 'delete' ? 'Removing a calendar event' : 'Updating a calendar event';
      case 'drive': return input.action === 'search' ? `Searching Drive: ${s(input.query, 40)}` : input.action === 'read' ? 'Reading a Drive file' : `Saving to Drive: ${s(input.name, 40)}`;
      case 'davinci_resolve': return input.action === 'render' ? 'Starting a Resolve render' : input.action === 'add_marker' ? 'Adding a timeline marker in Resolve' : input.action === 'open_project' ? `Opening Resolve project: ${s(input.name, 30)}` : input.action === 'switch_page' ? `Switching Resolve to the ${s(input.page, 20)} page` : 'Checking DaVinci Resolve';
      case 'browser_devtools': return input.action === 'network' ? 'Inspecting network traffic' : input.action === 'console' ? 'Reading the console' : input.action === 'metrics' ? 'Measuring page performance' : 'Running a page probe';
      case 'bioart': return input.action === 'search' ? `Searching NIH BioArt: ${s(input.query, 40)}` : `Fetching a BioArt illustration`;
      case 'ask_ai': return 'Consulting a second model';
      case 'notify_user': return 'Reaching you out-of-band';
      case 'build_project': return `Building: ${s(input.goal, 60)}`;
      default: return `Working on ${String(name || 'the task').replace(/_/g, ' ')}`;
    }
  } catch { return `Working on ${String(name || 'the task').replace(/_/g, ' ')}`; }
}
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
// parseJsonLoose lives once, near the pipeline stages (defined below); the earlier duplicate was removed.
async function quickPlan(taskText, apiKey) {
  const system = `You are BhatBot's fast planner. Draft a SHORT execution plan for Siddhant's request.
Return ONLY JSON: {"steps":["<imperative action>", ...3-6 items],"spoken":"<=2 sentences, plain spoken English summarizing your approach — no markdown, no numbered list>"}
Steps = concrete actions/tools BhatBot will take, each under 12 words. No preamble, JSON only.`;
  try {
    const r = await anthropicRequest({ model: MODEL_SONNET, max_tokens: 400,
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

// Post-turn ACTION VERIFICATION (Siddhant's choice). A cheap judge decides whether the assistant
// actually CARRIED OUT the requested action or merely promised/described it. Fail-open (acted:true)
// so a judge error never traps the loop. Uses the cheap tier (local-first, Sonnet fallback).
async function verifyActionDone(userText, replyText, toolNames) {
  try {
    const sys = 'You audit whether an assistant CARRIED OUT a requested action or merely talked about doing it. Be strict: a promise ("I\'ll open it", "let me run that") without a matching tool action = NOT done. Reply with STRICT JSON only, no prose.';
    const usr = `User request: "${String(userText).slice(0, 600)}"\nAssistant's final reply: "${String(replyText).slice(0, 800)}"\nTools the assistant ACTUALLY executed this turn: ${toolNames && toolNames.length ? toolNames.join(', ') : '(none)'}\n\nDid the assistant actually DO what was asked — or was it a pure question/info/conversational request that needs no action? Output JSON: {"acted": true|false, "missing": "<short phrase naming the action still not performed; empty if acted>"}`;
    const r = await cheapText(sys, usr, { maxTokens: 120 });
    const m = (r.text || '').match(/\{[\s\S]*\}/);
    if (!m) return { acted: true };
    const j = JSON.parse(m[0]);
    return { acted: j.acted !== false, missing: String(j.missing || '').slice(0, 200) };
  } catch { return { acted: true }; }
}

// SPEED gate for per-turn long-term recall (Notion/semantic/episodic). Returns false only for
// trivial turns that provably can't use recalled facts — greetings, one-word acks, yes/no/stop —
// so those skip the ~up-to-4s blocking recall and hit the model immediately. Fails toward TRUE
// (recall) for anything with real content, so no substantive turn ever loses its memory.
function turnNeedsRecall(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  // A short utterance that is ONLY a greeting/ack/control word → no recall.
  if (t.length <= 24 && /^(hi|hey|hello|yo|sup|thanks|thank you|ty|thx|ok|okay|k|cool|nice|great|got it|gotcha|yes|yep|yeah|no|nope|nah|stop|pause|resume|continue|go|go ahead|done|good|perfect|awesome|lol|haha|👍|🙏|❤️|sure)[.!?…]*$/i.test(t)) return false;
  return true;
}

async function agentLoop(history, apiKey, event, opts = {}) {
  agentState = 'running';
  _userSpokeSinceOpen = true;     // Feat-1: the user engaged → don't pop the idle briefing offer
  try { _lastUserText = lastUserText(history) || _lastUserText; } catch {}
  markActivity();   // Task 5 — mark the burst so the cache keep-alive stays warm between turns
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
  // SPEED: this blocks the FIRST token on every turn. Skip it for trivial turns (greetings, short
  // acks, "yes"/"stop"/"thanks") that can't benefit from long-term recall — those answer instantly.
  // The three recalls still run for anything substantive. Gate is config-tunable (recallGate:false
  // forces the old always-recall behaviour).
  if (loadConfig().recallGate === false || turnNeedsRecall(lastUserText(history))) {
    await Promise.all([refreshNotionRecall(lastUserText(history)), refreshSemanticRecall(lastUserText(history)), refreshEpisodicVec(lastUserText(history))]);
  }
  refreshProceduralRecall(lastUserText(history));   // learned step-series (sync) + speculative prefetch of the known first read

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
        actionView({ role: 'BhatBot', status: 'working', task: lastUserText(history).slice(0, 200), note: '📋 Plan: ' + plan.steps.map((s, i) => (i + 1) + ') ' + s).join('  ') });
        if (ttsSeq != null) ttsStreamFeed(ttsSeq, plan.spoken);   // read the plan aloud
        appendToLastUser(history, `[EXECUTION PLAN — you have ALREADY spoken this summary to Siddhant aloud; do NOT re-read or restate it. Execute these steps now, in order, and incorporate any "[Live guidance from Siddhant]" notes as they arrive. Keep spoken output to brief progress + the final result.]\n` + plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
      }
    } catch { /* planning is best-effort; never block execution */ }
  }

  // All exits go through here so live guidance can be offered for learning (2a).
  const finish = (text) => {
    agentState = 'idle';
    // T2 abort-guard: if this exit is an interruption mid-tool-call, seal the dangling tool_use with
    // synthetic '[interrupted]' results NOW, so the stored history is pairing-safe at the source.
    history = sealDanglingToolUse(history);
    // Phase 6: a reflection/capability-gap proposal is NOT auto-started (Siddhant's rule: approve at
    // start). _pendingSelfDrive stays parked until he says "go ahead" (handled in the chat entrypoint).
    _activeTools = null;   // W1 — drop the per-turn tool subset so out-of-loop calls see the full catalog
    if (speakParser) speakParser.finish(); else if (ttsSeq != null) ttsStreamFlush(ttsSeq);
    if (usedGuidance.length) sendToActivity('learn_prompt', { text: usedGuidance.join(' | ') });
    // Strip any <speak> tags from the returned text (renderer shows this as the final bubble).
    reflectOnCorrection(history, lastUserText(history), text);   // async, non-blocking
    try { logRouterDecision({ taskType: _lastRouterTask || currentMode, model: _lastModel, ms: Date.now() - _turnT0, usd: +(costToday().usd - _usd0).toFixed(5) }); } catch {}   // #13
    // T5 — post-turn intake audit: did the classified intake actually get EXECUTED? Ties T1's routing
    // decision to the observed outcome (tools run, action-verify redos) so "answered without doing the
    // work" regressions are measurable from router.jsonl, not just felt. Fire-and-forget.
    try {
      const wasAction = looksLikeToolTask(userText0);
      logRouterDecision({
        kind: 'intake-audit', intake: _lastIntake, executor: 'agent',
        toolsRan, verifyRedos: verifyCount,
        actedVerified: wasAction ? (toolsRan > 0 && verifyCount < 2) : true,
        stopped: agentState === 'stopped',
        ms: Date.now() - _turnT0, usd: +(costToday().usd - _usd0).toFixed(5),
      });
    } catch {}
    // LEARNED ROUTER training row: features of the ask + the tier that was actually used this turn
    // (the label) + what the shadow model predicted. Builds the dataset the learned router trains on,
    // then retrains in the background once enough rows exist. Never blocks the reply.
    try {
      if (_routerFeatures) {
        const usedTier = (_lastRouterTask || '').startsWith('heavy') || (_lastRouterTask || '').startsWith('learned-heavy') ? 'heavy'
          : (_lastRouterTask === 'simple' || _lastRouterTask === 'budget') ? 'simple' : 'reasoning';
        routermodel.logRow({ f: _routerFeatures, tier: usedTier, shadowTier: _routerShadowTier, model: (_lastModel || '').replace(/^claude-/, '') });
        setTimeout(() => { try { routermodel.maybeRetrain(); } catch {} }, 50);
      }
    } catch {}
    _routerFeatures = null; _routerShadowTier = null;
    const clean = stripReasoning(String(text || '')).replace(/<\/?speak>/g, '').trim();
    // #12 episodic memory is now recorded centrally in _dispatchTurnInner (covers fastReply +
    // pipeline-local too, which used to be dropped — starving the W5 fine-tune loop). Not here.
    // #24 project memory: if a project is open, record the turn + cheaply refresh its living summary.
    try { const slug = projects.activeSlug(); if (slug) { projects.recordTurn(slug, lastUserText(history), clean); projects.maybeAutoSummarize(slug, { summarize: projectSummarize }).catch(() => {}); } } catch {}
    // Procedural memory: bank THIS turn's step-series so look-alike tasks get faster next time. "ok" =
    // the turn finished on its own (not stopped/aborted) with a real series of ≥2 tools. record() finds
    // the matching routine by signature and reinforces it (wins++) or seeds a new one — so following a
    // recalled routine that still works strengthens it, and paths that changed simply age out. F&F.
    try {
      if (loadConfig().procedural !== false && toolTrace.length >= procedural.MIN_STEPS) {
        const ok = agentState !== 'stopped' && !/^⏹|interrupted/i.test(String(text || ''));
        procedural.record(PROCEDURAL_PATH, { trigger: userText0, steps: toolTrace, ok, ms: Date.now() - _turnT0, readPrefix: _readPrefix }, { clusterJaccard: loadConfig().proceduralClusterJaccard });
      }
    } catch {}
    if (stream) { const stopped = agentState === 'stopped' || /^⏹/.test(String(text || '')); actionView({ status: stopped ? 'stopped' : 'done', step: stopped ? 'Stopped.' : 'Finished.', text: clean.slice(0, 400) }); }
    return { text: clean, history, _streamed: stream };
  };

  // PERSISTENCE — how hard BhatBot pushes to FINISH a complex task before it reports back. Tunable via
  // config.persistence: 'normal' (default), 'high', or 'relentless'. Higher = more step headroom, a
  // higher hard ceiling, bigger auto-extend jumps, and a "second wind" replan when it gets stuck.
  const PERSIST = { normal: { base: 0, hard: 60, ext: 15, secondWind: false }, high: { base: 32, hard: 120, ext: 20, secondWind: true }, relentless: { base: 48, hard: 200, ext: 25, secondWind: true } };
  const pcfg = PERSIST[loadConfig().persistence] || PERSIST.normal;
  // Step budget: headroom for complex tasks that diagnose + retry across several approaches.
  // Configurable (agentMaxSteps); never below the default so a stale low value can't throttle.
  let maxIters = Math.max(Number(loadConfig().agentMaxSteps) || 0, MAX_AGENT_ITERATIONS, pcfg.base);
  // Auto-extend (Siddhant's choice): keep going past the budget while genuinely productive, up to a
  // HARD ceiling that bounds worst-case spend even if the agent loops. Unproductive = consecutive
  // iterations with no NOVEL tool signature (stuck/repeating) → stop extending.
  const HARD_CEILING = Math.max(maxIters, Number(loadConfig().agentMaxStepsHard) || 0, pcfg.hard);
  const EXTEND_STEP = pcfg.ext;
  const userText0 = lastUserText(history);            // the original request, for the action-verify judge
  let toolsRan = 0, unproductive = 0, verifyCount = 0; const toolNamesRan = []; const seenSigs = [];
  let consecFail = 0, failNudgedAt = -1, _secondWind = false, _lastNarrateTs = Date.now();   // persistence: failure-retry ladder + one-time stuck replan + text-heartbeat clock
  const toolTrace = []; const _readPrefix = []; let _prefixOpen = true;   // procedural memory: this turn's ordered step-series + its leading read-only run (auto-runnable ahead of the model next time)
  if (stream) ttsLastAudioTs = Date.now();            // measure the progress-heartbeat silence from turn start
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
      // POST-TURN ACTION VERIFICATION (Siddhant's choice): if this was an ACTION request and the reply
      // reads as a promise (or zero tools ran), have a cheap judge confirm the action was actually
      // performed. If it was only promised → inject a "do it now" directive and re-enter the loop
      // instead of accepting the promise. Bounded (≤2 redos), fail-open, action tasks only.
      if (loadConfig().actionVerify !== false && verifyCount < 2 && looksLikeToolTask(userText0)
          && (toolsRan === 0 || isPromissory(text))) {
        const v = await verifyActionDone(userText0, text, toolNamesRan);
        if (!v.acted) {
          verifyCount++;
          sendToActivity('tool-update', { type: 'thinking', text: '🔁 action check — you described it but did not do it; performing it now' });
          history = [...history, { role: 'user', content: `[ACTION CHECK — this is NOT done yet: ${v.missing || 'the requested action'}. Perform it NOW with the appropriate tools. Do not describe, promise, or ask — do it, then confirm with the actual result.]` }];
          if (maxIters - iterations < 5) maxIters = Math.min(HARD_CEILING, maxIters + 5);   // room for the redo
          iterations++;
          continue;
        }
      }
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
      // Continuous plain-English status of what's happening right now (chat + live view + heartbeat).
      const say = describeAction(block.name, block.input);
      sendToAll(event, 'tool-update', { type: 'tool_start', name: block.name, input: block.input, narrate: say });
      _lastNarrateTs = Date.now();
      if (stream) {
        // Auto-pop the "watch me work" window the first time this turn ACTUATES the machine (unless
        // disabled). Then mirror the current action + a live screenshot into it.
        if (ACTUATING_TOOLS.has(block.name) && loadConfig().actionView !== false && !isRemote()) openActionView();
        actionView({ role: 'BhatBot', status: 'working', step: say });
        if (ACTUATING_TOOLS.has(block.name)) actionViewShot(say);   // show the actual screen as it acts
      }
      // Guard empty code-tool calls (weak model or an interrupted stream that parsed tool input as {}):
      // short-circuit to a crisp corrective result — no wasted spawn, pairing intact, precise retry cue.
      if ((block.name === 'simulate' || block.name === 'sci_compute') && (block.input.action || 'run') === 'run' && !String(block.input.code || '').trim()) {
        const r = { success: false, error: `${block.name} was called with no \`code\`. Write the Python to run (call action:"capabilities" first if unsure what's installed), then call ${block.name} again with a non-empty \`code\`.` };
        sendToAll(event, 'tool-update', { type: 'tool_done', name: block.name, result: r });
        return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(r), is_error: true };
      }
      // Same guard for a required-string arg fired empty (the studio_write {} → "data must be a string"
      // stall). Return the retry cue instead of throwing, so the model re-issues it with real content.
      const _needArg = { studio_write: 'html', write_file: 'content' }[block.name];
      if (_needArg && (typeof block.input[_needArg] !== 'string' || !String(block.input[_needArg]).trim())) {
        const r = { success: false, error: `${block.name} was called with an empty/missing \`${_needArg}\`. Provide the full \`${_needArg}\` string, then call ${block.name} again.` };
        sendToAll(event, 'tool-update', { type: 'tool_done', name: block.name, result: r });
        return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(r), is_error: true };
      }
      let result;
      try { result = await executeTool(block.name, block.input); }
      catch (e) { result = { success: false, error: 'tool threw: ' + (e && e.message || String(e)) }; }
      // Jarvis HUD: surface visuals inline in chat — generated images / design renders /
      // explicit screenshots as holo-cards, and 3D outputs as an in-chat spinning model.
      const showImage = result._image && (['generate_image', 'make_figure', 'simulate', 'sci_compute', 'studio_write', 'ui_inspect', 'screen_parse', 'vision_click', 'molecule', 'maps', 'phone_mirror'].includes(block.name)
        || (block.name === 'browser' && block.input && block.input.action === 'screenshot'));
      const model3d = (block.name === 'generate_3d' || block.name === 'make_printable') && result.success && result.path ? result.path : undefined;
      sendToAll(event, 'tool-update', {
        type: 'tool_done', name: block.name,
        result: { ...result, _image: undefined, _imageMime: undefined },
        preview: showImage ? { image: result._image, mime: result._imageMime || 'image/jpeg' } : undefined,
        model3d
      });
      if (stream) {
        const okTool = result.success !== false;
        actionView({ note: String(block.name).replace(/_/g, ' ') + (okTool ? ' ✓' : ' ✗') });
        // Show what changed on screen: the tool's own capture if it has one, else a fresh screenshot
        // for actuating tools (so the live view reflects the machine's real state after the action).
        if (result._image) actionView({ shot: result._image, shotMime: result._imageMime || 'image/jpeg', note: describeAction(block.name, block.input) });
        else if (ACTUATING_TOOLS.has(block.name)) actionViewShot('after ' + String(block.name).replace(/_/g, ' '));
      }
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
      const gJoined = g.join(' | ').slice(0, MAX_GUIDANCE_CHARS);   // defensive cap: never balloon one turn
      toolResults.unshift({ type: 'text', text: '[Live guidance from Siddhant — adjust accordingly]: ' + gJoined });
      sendToAll(event, 'tool-update', { type: 'guidance_applied', text: gJoined });
    }

    // PERSISTENCE — failure-retry ladder. Track consecutive all-failing tool batches; after ≥2 in a
    // row, inject an escalating directive to STOP repeating the same call, diagnose the root cause from
    // the error text, and try a genuinely different approach/tool — and grant a little extra budget so
    // the recovery has room. Keeps BhatBot from either giving up or looping on the same broken call.
    const batchErr = toolResults.filter((r) => r && r.is_error).length;
    const batchTools = toolResults.filter((r) => r && r.type === 'tool_result').length;
    if (batchTools > 0 && batchErr === batchTools) consecFail++; else if (batchErr === 0) consecFail = 0;
    if (consecFail >= 2 && failNudgedAt !== iterations) {
      failNudgedAt = iterations;
      const rung = consecFail >= 4 ? 'You have failed the SAME way several times. Step back completely: question your assumptions, re-read the goal, and switch to a fundamentally different method (a different tool, a different path, or gather more information first).'
        : 'That approach keeps failing. Read the error carefully, diagnose the ROOT cause, and try a DIFFERENT approach or tool — do not simply repeat the same call.';
      toolResults.unshift({ type: 'text', text: `[PERSISTENCE — ${consecFail} consecutive failures. ${rung} Do NOT give up or hand this back to Siddhant unless you have genuinely exhausted the options.]` });
      if (maxIters - iterations < 4) maxIters = Math.min(HARD_CEILING, maxIters + EXTEND_STEP);   // room to recover
      sendToAll(event, 'tool-update', { type: 'thinking', text: `🧭 ${consecFail} failures — changing approach` });
      actionView({ note: `🧭 ${consecFail} failures — changing approach` });
    }

    history = [...history, { role: 'user', content: toolResults }];
    // Productivity tracking for auto-extend: a turn is "productive" if it ran ≥1 tool with a NOVEL
    // signature (not a repeat of a recent call). A stuck agent re-calling the same thing stops
    // extending; one exploring new actions keeps its budget.
    const sigs = toolUses.map((b) => toolSig(b.name, b.input));
    toolsRan += toolUses.length; for (const b of toolUses) toolNamesRan.push(b.name);
    // Procedural memory: capture the ordered step-series + the LEADING RUN of read-only steps (with
    // concrete inputs) so a future look-alike turn can auto-run that prefix ahead of the model. Bounded.
    for (const b of toolUses) {
      if (toolTrace.length < 40) toolTrace.push(b.name);
      if (_prefixOpen) {
        if (READ_CACHEABLE.has(b.name) && _readPrefix.length < 4) _readPrefix.push({ name: b.name, input: b.input });
        else _prefixOpen = false;   // the first non-read (or a full prefix) ends the leading read-only run
      }
    }
    const novel = sigs.some((s) => !seenSigs.includes(s));
    for (const s of sigs) seenSigs.push(s); while (seenSigs.length > 12) seenSigs.shift();
    unproductive = novel ? 0 : unproductive + 1;
    // Spoken progress heartbeat: a long turn with no audio for a while gets a brief tool-aware "still
    // working" line so tier-1-paced multi-tool turns never sit in dead air (Siddhant accepts the cost).
    if (stream && ttsSeq != null && loadConfig().spokenProgress !== false && loadConfig().ttsEnabled !== false) {
      const thresh = Number(loadConfig().spokenProgressMs) || 20000;
      if (Date.now() - (ttsLastAudioTs || 0) > thresh) {
        const lastTool = toolUses[toolUses.length - 1] && toolUses[toolUses.length - 1].name;
        ttsStreamFeed(ttsSeq, progressLine(lastTool) + ' ');
        ttsLastAudioTs = Date.now();   // reset so progress lines don't stack
      }
    }
    // TEXT progress heartbeat: independent of TTS, so even a muted long turn keeps showing a
    // "still working on X" line in chat + the live view rather than going silent for many steps.
    if (stream && loadConfig().textProgress !== false) {
      const tThresh = Number(loadConfig().textProgressMs) || 12000;
      if (Date.now() - _lastNarrateTs > tThresh) {
        const lastTool = toolUses[toolUses.length - 1] && toolUses[toolUses.length - 1].name;
        const line = `⏳ still working — ${describeAction(lastTool, (toolUses[toolUses.length - 1] || {}).input)} · step ${iterations + 1}`;
        sendToAll(event, 'tool-update', { type: 'thinking', text: line });
        actionView({ note: line });
        _lastNarrateTs = Date.now();
      }
    }
    // Mid-loop context guard: a single turn that fans out into dozens of tool calls can approach
    // the window before the next user message. Summarize the old head in place so long autonomous /
    // self-drive runs keep fidelity instead of getting hard-dropped by capTokens at the wire.
    if (estimateTokens(history) > contextTrimBudget()) {
      const before = history.length;
      history = await trimHistory(history, apiKey);
      if (history.length < before) sendToActivity('tool-update', { type: 'thinking', text: `🗜 context summarized mid-loop (${before}→${history.length} msgs) to stay within the window` });
    }
    iterations++;
    // AUTO-EXTEND (Siddhant's choice): about to hit the budget but still doing new work → raise it,
    // bounded by HARD_CEILING. Keeps genuine long tasks finishing instead of dead-ending at 20 steps.
    if (iterations >= maxIters && loadConfig().autoExtend !== false) {
      if (shouldExtendBudget({ maxIters, hardCeiling: HARD_CEILING, unproductive })) {
        const prev = maxIters; maxIters = Math.min(HARD_CEILING, maxIters + EXTEND_STEP);
        if (maxIters > prev) { sendToAll(event, 'tool-update', { type: 'thinking', text: `⏳ still making progress — extending step budget to ${maxIters}` }); actionView({ note: `⏳ extended budget to ${maxIters} steps` }); }
      } else if (pcfg.secondWind && !_secondWind && maxIters < HARD_CEILING) {
        // PERSISTENCE second wind (high/relentless only): about to give up because it's STUCK (repeating
        // itself), not because the task is done. Grant ONE more budget bump + force a fresh-approach
        // replan directive, then reset the stuck counter so it genuinely tries something different once
        // more before falling through to the progress report. Bounded to once per turn → no infinite loop.
        _secondWind = true; unproductive = 0;
        maxIters = Math.min(HARD_CEILING, maxIters + EXTEND_STEP);
        history = [...history, { role: 'user', content: '[SECOND WIND — you look stuck repeating the same actions, but this task is NOT finished. Do not stop. Step back, re-read the original goal, and attack it a completely different way (different tool, different decomposition, or gather missing information first). This is your one extra push before you must report progress.]' }];
        sendToAll(event, 'tool-update', { type: 'thinking', text: '🌬 second wind — stepping back to try a different approach' });
        actionView({ note: '🌬 second wind — trying a different approach' });
      }
    }
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

// Complexity gate for model routing: does this tool task need real authoring / multi-step reasoning
// (→ Sonnet) rather than a trivial one-shot action (open/play/screenshot → Haiku is fine)? Catches the
// generative + analytical + multi-step verbs Haiku reliably fumbles. Kept deliberately tight so
// everyday quick actions aren't needlessly upgraded.
function looksComplexTool(text) {
  const t = String(text || '').toLowerCase();
  return /\b(simulat|model\b|modeling|build|create|generate|design|render|3d|plot|graph|chart|figure|dashboard|write (?:code|a script|python|the|an?)|\bscript\b|refactor|debug|analy[sz]e|analysis|research|investigate|compare|optimi[sz]e|pipeline|automate|workflow|scaffold|deploy|backtest|derive|prove|forecast|predict|multi.?step|step.?by.?step|then .*then)\b/.test(t)
    // "make/compute a <thing>" where the thing is substantive (a sim/model/report/etc.), not "make a call".
    || /\b(make|compute|calculate|run)\b.*\b(simulation|model|analysis|report|forecast|prediction|backtest|figure|chart|graph|dataset|benchmark|proof|derivation)\b/.test(t);
}

// HEAVY-task gate: the hardest class — a scientific simulation, an engine/solver, a model that needs
// heavy coding AND interpretation (DNA replication, protein folding, fluid dynamics, N-body, MD…).
// These get the Opus tier as the orchestrating brain AND are decomposed across a parallel fleet.
// Deliberately stricter than looksComplexTool so everyday "complex" work (a dashboard, a refactor)
// stays on Sonnet and only genuinely deep scientific/engineering builds pull Opus + the fleet.
function looksHeavyTool(text) {
  const t = String(text || '').toLowerCase();
  const sim = /\b(simulat\w*|\bengine\b|\bsolver\b|from scratch|end.?to.?end|n-?body|monte.?carlo|\bode\b|\bpde\b|\bcfd\b|\bfem\b|finite element|molecular dynamics)\b/.test(t);
  const sciDomain = /\b(dna|rna|genom\w*|protein|molecul\w*|enzyme|cell(?:ular)?|biolog\w*|replication|transcription|translation|(?:protein )?folding|physics|quantum|orbital|fluid|aerodynam\w*|thermodynam\w*|climate|epidemi\w*|reaction.?diffusion|lattice|kinetics)\b/.test(t);
  const buildVerb = /\b(build|create|implement|develop|write|design|model|generate|make|simulate|prototype)\b/.test(t);
  const heavyBuild = buildVerb && /\b(simulat\w*|model|engine|system|pipeline|solver|framework|dashboard|app|analysis)\b/.test(t);
  // Physical / creative "build a whole THING" — a suit, device, machine, robot, vehicle, game, 3D
  // world, etc. This is the "design and simulate an Iron Man suit" class → route to the build engine.
  const thing = /\b(suit|device|machine|robot|drone|vehicle|car|plane|rocket|gadget|wearable|exoskeleton|weapon|gun|armou?r|game|3d|scene|world|environment|level|creature|character|product|contraption|apparatus|instrument)\b/.test(t);
  const physicalBuild = buildVerb && thing;
  const explicitHeavy = /\b(complex|detailed|rigorous|comprehensive|realistic|high.?fidelity|whole|entire|full|complete)\b/.test(t) && (heavyBuild || physicalBuild);
  return (sim && (sciDomain || heavyBuild || thing)) || (sciDomain && heavyBuild) || physicalBuild || explicitHeavy;
}

// Injected (uncached, trailing) into the system when a HEAVY task is detected — turns the single
// linear agent loop into a parallel fleet. This is the whole point of the subagent fleet: research,
// design, code, and testing proceed concurrently, then get synthesized with real interpretation.
const HEAVY_FLEET_DIRECTIVE = [
  'HEAVY TASK — multi-faceted build detected (e.g. "design and simulate an Iron Man suit", a device, a game, a simulation).',
  'FINISH IT THIS TURN — completion over breadth. The fastest reliable path:',
  '1) If Siddhant hasn\'t already given the key specs, gather them with ONE ask_options round (dimensions,',
  '   colours, features) — do NOT run a long multi-stage interview. For anything he leaves out, ASSUME a',
  '   sensible default and note it.',
  '2) Then call build_project{goal, spec, deliverable:"both"} — it decomposes the build into PARALLEL',
  '   lanes, runs them as a fleet, integrates, runs a real physics pass (simulate) AND renders an',
  '   interactive 3D scene (studio_write), and saves it as a RESUMABLE project. One call, whole thing.',
  'Only hand-roll plan_and_run / deploy_drones / a manual fleet+studio+sim sequence if build_project',
  'genuinely doesn\'t fit. Either way: end the turn with a PRODUCED, rendered artifact — never a promise to build.'
].join(' ');

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

// NOTE (Task 6): the local complex pipeline (planner → executor → critic) was intentionally
// retired — local models mangled tool-call JSON, so tool/complex work is scoped to Claude in
// runPipeline (the looksLikeToolTask + needsTools + complex→Claude escalations below). The old
// plannerPass/executorStep/criticValidate/compressStepOutput/checkRamPressure helpers were dead
// (only the unreachable branch called them) and have been removed. routerClassify + the local
// "simple" streaming path remain — that's the pipeline's real, working scope: fast local Q&A.

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

  // Complex / tool / code work always goes to Claude (full desktop tools + safety + cost-aware
  // chunking; see the COMPLEX-TASK BUDGETING note in the system prompt). The local pipeline is
  // deliberately scoped to the fast "simple" Q&A path handled above.
  return escalate('complex → Claude');
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
// A trivial acknowledgement/greeting the local model can't botch ("ok", "thanks", "hey", "yes").
// Everything with real content goes to Claude — the local gemma tier was emitting Python scripts,
// leaked JSON and invented personas for ordinary chat (Siddhant's call: quality over the free tier).
function isTinyAck(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 24) return false;
  return /^(hi|hey|hello|yo|sup|thanks|thank you|ty|thx|ok|okay|k|kk|cool|nice|great|got it|gotcha|yes|yep|yeah|yup|no|nope|nah|sure|good|perfect|awesome|nvm|never ?mind|right|indeed|word|lol|haha|hehe|👍|🙏)[.!?…]*$/i.test(t);
}
async function fastReply(history, apiKey, event, opts = {}) {
  const stream = !!opts.stream, ttsSeq = opts.ttsSeq;
  const parser = (stream && ttsSeq != null) ? makeSpeakStream(ttsSeq) : null;
  const onText = stream ? (delta) => {
    latMark('first-token');
    const disp = parser ? parser.feed(delta) : delta;
    if (disp) { try { event && event.sender && event.sender.send('tool-update', { type: 'token', text: disp }); } catch {} }
  } : null;
  const ut = lastUserText(history);
  // CHEAP TIER: the free local model is now reserved for TRIVIAL acks/greetings only (isTinyAck) —
  // it botched real chat (Python scripts, leaked JSON, invented personas). Anything with real
  // content falls straight through to Claude below for reliable, in-character replies.
  if (cheapEnabled() && isTinyAck(ut) && await ollamaReady()) {
    try {
      const text = stripReasoning(await ollamaChat(history, buildSystemPrompt(ut), cheapLocalModel()) || '').replace(/<\/?speak>/g, '').trim();
      if (text) {
        sendToAll(event, 'tool-update', { type: 'provider_used', provider: 'ollama', model: cheapLocalModel() });
        if (parser) { parser.feed(text); parser.finish(); } else if (stream && ttsSeq != null) { if (onText) onText(text); ttsStreamFlush(ttsSeq); } else if (onText) onText(text);
        return { text, history: [...history, { role: 'assistant', content: text }], _provider: 'ollama', _model: cheapLocalModel(), _streamed: !!(stream && ttsSeq != null) };
      }
    } catch (e) { console.warn('[fast] local failed → sonnet:', e.message); }
  }
  sendToAll(event, 'tool-update', { type: 'provider_used', provider: 'anthropic', model: MODEL_SONNET });
  // Cloud fallback: Sonnet (Haiku retired). Learned depth ceiling, capped at 2048 for quick replies.
  const d = sizeTurn(ut, history);           // Phase 3 — learned ceiling + position taper (fast no-tools path)
  const cont = conversationContinuity(history);   // resolve terse follow-ups against the prior subject
  const r = await anthropicStream({
    model: MODEL_SONNET, max_tokens: Math.min(d.maxTokens, 2048),
    system: [...systemBlocks(ut), { type: 'text', text: d.directive + (cont ? '\n\n' + cont : '') }],   // cache_control'd static block → cheap + low TTFT
    messages: capTokens(history)                    // NO tools → faster first token, no tool-decision detour
  }, apiKey, onText);
  logDepthOutcome({ depth: d.depth, maxTokens: Math.min(d.maxTokens, 2048), feats: d.feats, taperFactor: d.taperFactor, source: d.source }, r, 'fast');
  if (parser) parser.finish(); else if (stream && ttsSeq != null) ttsStreamFlush(ttsSeq);
  const text = stripReasoning(r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')).replace(/<\/?speak>/g, '').trim();
  return { text, history: [...history, { role: 'assistant', content: text }], _provider: 'anthropic', _model: MODEL_SONNET, _streamed: !!(stream && ttsSeq != null) };
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
  // T4 — announce the turn to the UI IMMEDIATELY, before recall / tool-selection / the first model
  // call (each of which can block for seconds). The status strip shows "working" within a frame
  // instead of going quiet. turn_done in the finally guarantees the strip never stays stuck.
  turnState.reduce({ type: 'turn_start', text: userText, ts: Date.now() });
  pushTurnState(true);
  maybeSwitchProject(userText);   // keep the injected "ACTIVE PROJECT" focus aligned with what he just named
  let res = null, _turnErr = null;
  try {
    // T1 — deterministic front-door router. Fail toward the instrumented agentLoop on ANY action signal;
    // reserve the tool-less fast path (and the local text-pipeline) strictly for clear 'chat'. This is the
    // fix for "answered without doing the work" / "didn't take my prompt": a tool-needing turn can no
    // longer be swallowed by fastReply or mangled by the pipeline.
    let inToolThread = false;
    try { inToolThread = /tool_result|tool_use/.test(JSON.stringify(history.slice(-2))); } catch {}
    const intake = classifyIntake(userText, { looksLikeToolTask, referencesJob: referencesRunningJob, inToolThread });
    _lastIntake = intake;   // T5 audit
    if (intake === 'action' || intake === 'ambiguous') {
      res = await agentLoop(history, apiKey, event, opts);        // tools available + full progress instrumentation
    } else {                                                       // 'chat' — tool-free small talk / short question
      if (loadConfig().fastChat !== false) {
        try { res = await fastReply(history, apiKey, event, opts); }
        catch (e) { console.warn('[fast] reply failed → agent:', e.message); }
      }
      // Pipeline can ONLY ever see 'chat' now (never action/ambiguous → never mangles tool work).
      if (!res) res = pipelineCfg().enabled ? await runPipeline(history, apiKey, event, opts) : await agentLoop(history, apiKey, event, opts);
    }
    if (res && res.text) recordEpisode(userText, res.text, surface);
    return res;
  } catch (e) { _turnErr = e; throw e; }
  finally {
    turnState.reduce({ type: 'turn_done', stopped: agentState === 'stopped', error: _turnErr ? (_turnErr.message || String(_turnErr)) : '', ts: Date.now() });
    pushTurnState(true);
  }
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
    if (c.briefingOfferOnOpen !== true) return;             // OPT-IN only — the auto-offer was hijacking real commands (it injects "which briefing?" into the convo and the model answered it instead of the task). Off unless explicitly enabled.
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
      biometrics: () => { try { return biometricPortrait(); } catch { return { error: 'unavailable' }; } },   // Health screen on the phone
      opsStatus: () => { try { return opsSnapshot(); } catch { return { error: 'unavailable' }; } },           // Manage view on the phone
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
  const q = lastUserText(history);
  const sysStr = buildSystemPrompt(q) + '\n\n[PHONE CALL: answer in ONE or two short spoken sentences, plain text, no lists.]';
  // Cheap tier: local-first (free), Sonnet fallback (Haiku retired).
  if (cheapEnabled() && await ollamaReady()) {
    try { const t = stripReasoning(await ollamaChat(history, sysStr, cheapLocalModel()) || '').trim(); if (t) return clampSpoken(t); } catch {}
  }
  const r = await anthropicStream({ model: MODEL_SONNET, max_tokens: 320, system: [{ type: 'text', text: sysStr }], messages: capTokens(history) }, getApiKey(), null);
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

// phone_mirror tool backend — operate Siddhant's iPhone via macOS iPhone Mirroring. The actual
// TAPPING reuses the existing vision loop (screen_parse → vision_click on the mirrored window); this
// handles the lifecycle around it: launch/focus, connection status, gesture shortcuts, a phone
// screenshot the model can see, and the "call me to open my phone" flow. Attaches _image (the phone
// screen) so the model gets a closed loop on open/status/home/screenshot.
async function phoneMirror(input) {
  const action = String(input.action || 'status');
  const withShot = async (base) => {
    try {
      const r = await captureScreenJpeg();
      if (r && r.image) { base._image = r.image; base._imageMime = r.mime || 'image/jpeg'; }
    } catch {}
    return base;
  };
  try {
    if (action === 'call_to_start') {
      const msg = String(input.message || 'This is BhatBot. I need to do something on your iPhone. Please unlock your Mac and phone and open iPhone Mirroring, then tell me to go ahead.').slice(0, 600);
      const r = await twilioCall(msg);
      return r.sent
        ? { success: true, via: r.via, sid: r.sid, note: 'Called Siddhant to bring the phone online. He can speak instructions on the call (they route back to you). Once he confirms, call phone_mirror action:"open" then screen_parse/vision_click to operate the phone.' }
        : { success: false, error: r.error || 'call failed', note: 'Twilio call could not be placed. Fall back to notify_user or ask him in chat to open iPhone Mirroring.' };
    }
    if (action === 'open') {
      const o = await phonemirror.open();
      if (!o.ok) return { success: false, error: o.note || 'could not open iPhone Mirroring', note: 'iPhone Mirroring may not be set up (needs macOS 15+ and a one-time pairing). Ask Siddhant, or use call_to_start.' };
      const conn = await phonemirror.connected();
      return await withShot({ success: true, launched: o.launched, connected: conn.connected, bounds: conn.bounds,
        note: conn.connected
          ? 'iPhone Mirroring is live. Now screen_parse(target:"screen") the phone window and vision_click an element to tap it.'
          : (conn.reason || 'Mirroring window not connected — the phone/Mac may be locked. Use call_to_start to ask Siddhant to unlock it.') });
    }
    if (action === 'home') {
      const g = await phonemirror.gesture('home');
      if (!g.ok) return { success: false, error: g.error };
      await new Promise((res) => setTimeout(res, 400));
      return await withShot({ success: true, note: 'Sent Home. Re-parse the screen before tapping.' });
    }
    if (action === 'screenshot') {
      const running = await phonemirror.isRunning();
      if (!running) return { success: false, error: 'iPhone Mirroring is not open. Call phone_mirror action:"open" (or call_to_start if the phone is locked).' };
      await phonemirror.open();   // ensure frontmost so the screenshot shows the phone
      return await withShot({ success: true, note: 'Phone screen captured. Use screen_parse for click coordinates.' });
    }
    // status (default)
    const running = await phonemirror.isRunning();
    if (!running) return { success: true, running: false, connected: false, note: 'iPhone Mirroring is not open. Call phone_mirror action:"open" to launch it, or call_to_start if you need Siddhant to unlock the phone first.' };
    const conn = await phonemirror.connected();
    return await withShot({ success: true, running: true, connected: conn.connected, bounds: conn.bounds, note: conn.reason || 'iPhone Mirroring is live — screen_parse + vision_click to operate the phone.' });
  } catch (e) { return { success: false, error: 'phone_mirror failed: ' + (e && e.message || String(e)) }; }
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

// ── SELF-DRIVE (Phase 6) — ON-DEMAND autonomous self-improvement ────────────────────────────────
// NOT a perpetual loop (Siddhant: don't constantly self-update). A finite session runs only when he
// asks, when he asks what BhatBot would improve (reflection sanctions it), or on a capability gap.
// Per cycle: reflect → pick top automatable LOCAL/STRUCTURAL desire → SCOUT research → ORACLE+ECHO
// plan → risk.checkFrozen preflight → FORGE (claude_code) → ATLAS verify → MEDIC resolve. Verify-or-
// revert; never pushes; commits to a local per-session branch. See lib/selfdrive.js + lib/risk.js.

// reflect(focus) — build the self-portrait and run the bounded Opus desire engine.
// Relay a self-drive progress line to every surface (Activity/Vanguard panel, chat, Telegram) so
// the run is visible in real time instead of a black box between "started" and "done".
function sdRelay(text) {
  try { sendToActivity('tool-update', { type: 'thinking', text }); } catch {}
  try { fleetBroadcast({ id: 'self-drive', role: 'OVERMIND', status: 'working', note: text, panel: 'selfdrive' }); } catch {}
}
async function selfDriveReflect(focus) {
  const toolNames = TOOLS.map((t) => t.name);
  let roleNames = []; try { roleNames = Object.keys(require('./lib/agents/roles').ROLES); } catch {}
  const portrait = introspect.buildSelfPortrait({ toolNames, roleNames, repoDir: SELF_HEAL_PROJ });
  try { if (portrait.code_scan && portrait.code_scan.summary) sdRelay('🔍 Scanned my source — ' + portrait.code_scan.summary); } catch {}
  const r = await reflect.reflect(portrait, { anthropicRequest, apiKey: getApiKey(), focus: focus || '' });
  try {
    const ds = (r.desires || []).slice(0, 3).map((d, i) => `${i + 1}. ${d.aspiration}`).join('  ·  ');
    if (ds) sdRelay('🧠 Improvement ideas — ' + ds);
    else if (r.error) sdRelay('⚠ Reflection produced no actionable ideas (' + r.error + ')');
  } catch {}
  return r;
}
function selfDriveSnapshot() {
  const toolNames = TOOLS.map((t) => t.name);
  let roleNames = []; try { roleNames = Object.keys(require('./lib/agents/roles').ROLES); } catch {}
  return introspect.buildSelfPortrait({ toolNames, roleNames, repoDir: SELF_HEAL_PROJ });
}
// classify(desire) — bundle reflect.classifyActionability + risk.classifyDesire (+ frozen flag) so the
// governor can pick only safe, automatable desires.
function selfDriveClassify(desire) {
  const act = reflect.classifyActionability(desire);
  const rc = risk.classifyDesire(desire);
  const frozen = risk.checkFrozen(rc.files).blocked;
  return { automatable: act.automatable && rc.decision !== 'block', level: rc.level, files: rc.files, frozen, reason: act.automatable ? rc.reason : act.reason };
}
// SCOUT — read-only research (one fleet suit). Returns a findings report.
async function selfDriveResearch(desire, files) {
  const aspiration = String(desire.aspiration || desire.id);
  try {
    const sc = await agentTeam.fleet([{ id: 'SCOUT', role: 'research',
      tools: ['read_file', 'list_directory', 'run_shell', 'web_search', 'fetch_url'],
      persona: 'You are SCOUT, the RESEARCHER (read-only). Investigate the BhatBot repo to ground a planned change. Report: current state / root cause, the exact files+functions involved, 2-3 implementation options with tradeoffs, a recommended option, and the precise list of files that must change. Do NOT edit anything.',
      task: `Research this planned self-improvement:\n\nDesire: ${aspiration}\nIntended approach: ${(desire.implementation && desire.implementation.summary) || ''}\nImplicated files: ${(files || []).join(', ')}\n\nRead the relevant source and report findings + the precise change surface.` }],
      subagentDeps(), { maxParallel: 1, maxSteps: 10, onUpdate: (u) => fleetBroadcast(u) });
    const result = ((sc.agents || [])[0] || {}).result || '';
    try { if (result) sdRelay('🔬 SCOUT findings — ' + String(result).replace(/\s+/g, ' ').slice(0, 240)); } catch {}
    return result;
  } catch { return ''; }
}
// ORACLE + ECHO — plan + adversarial review (ensemble). Parse the synthesized plan for a VERIFY
// command, the file list, and ECHO's SEVERITY (so the governor can halt a too-risky desire).
async function selfDrivePlan(desire, report) {
  const aspiration = String(desire.aspiration || desire.id);
  const planTask = `Produce a precise, MINIMAL implementation plan for this BhatBot self-improvement, then stress-test it.\n\nDesire: ${aspiration}\nIntended approach: ${(desire.implementation && desire.implementation.summary) || ''}\n\nSCOUT's research:\n${String(report).slice(0, 5000)}\n\nThe synthesized output MUST end with exactly these three lines:\nFILES: <space-separated files that will change>\nVERIFY: <one shell command that exits 0 only when the change is correct; prefer "npm run verify">\nSEVERITY: <low|medium|high|severe>  (ECHO's worst-case risk if this is implemented)`;
  let text = '';
  try {
    const ens = await agentTeam.ensemble(planTask, subagentDeps(), {
      roles: [
        { name: 'planner', codename: 'ORACLE', persona: 'You are ORACLE, the PLANNER. Turn the goal + research into the smallest correct, concrete step-by-step plan. Name exact files/functions.' },
        { name: 'skeptic', codename: 'ECHO', persona: 'You are ECHO, the ADVERSARIAL REVIEWER. Stress-test the plan: what could go wrong, what edge cases are missed, what is the rollback if verify fails, what guardrail might it trip. Assign a worst-case SEVERITY.' },
      ], maxSteps: 6, onUpdate: (u) => fleetBroadcast(u) });
    text = (ens && ens.result) || '';
  } catch {}
  try { if (text) sdRelay('📋 Plan — ' + String(text).replace(/\s+/g, ' ').slice(0, 240)); } catch {}
  const grab = (re) => { const m = String(text).match(re); return m ? m[1].trim() : ''; };
  return { brief: text, files: grab(/FILES:\s*(.+)/) ? grab(/FILES:\s*(.+)/).split(/\s+/) : [], verify: grab(/VERIFY:\s*(.+)/) || null, severity: grab(/SEVERITY:\s*(\w+)/).toLowerCase() || 'medium', concern: text.slice(-400) };
}
// FORGE — the only writer. Drives claude_code with --dangerously-skip-permissions on the session
// branch (acceptEdits is subsumed by skip-permissions, which also lets the unattended coder run
// build/move/test commands). risk.js has ALREADY blocked any frozen-file plan before we reach here.
async function selfDriveForge({ desire, report, plan, verify, proj }) {
  const prompt = [
    `Implement this BhatBot self-improvement. Make the MINIMAL necessary edits to the source files.`,
    `Desire: ${desire.aspiration || desire.id}`,
    plan && plan.brief ? `\nApproved plan (follow it):\n${String(plan.brief).slice(0, 6000)}` : (report ? `\nResearch:\n${String(report).slice(0, 4000)}` : ''),
    plan && plan.reviewerNotes ? `\nA reviewer flagged the previous attempt — ADDRESS these before anything else:\n${String(plan.reviewerNotes).slice(0, 2000)}` : '',
    `\nThe change is correct when this exits 0:\n  ${verify}`,
    `Do NOT run the verify command yourself. Do NOT edit any of: lib/selfdrive.js, lib/risk.js, lib/selfheal.js, lib/security.js, lib/credentials.js, lib/admission.js, scripts/verify-syntax.js, scripts/test-upgrade.js, config files, or secrets.`,
  ].filter(Boolean).join('\n');
  try {
    sdRelay('🔧 FORGE: editing files via Claude Code (full write access on the isolated branch)…');
    const r = await runShell('claude -p ' + JSON.stringify(prompt) + ' --dangerously-skip-permissions', proj, 300000);
    try { sdRelay('🔧 Claude Code done — ' + String((r && (r.stdout || r.error)) || '').replace(/\s+/g, ' ').slice(-240)); } catch {}
    return { success: r && r.success !== false, out: (r && (r.stdout || r.error) || '').slice(-400) };
  }
  catch (e) { return { success: false, error: e.message }; }
}
// REVIEWER (demo 7 / C2) — a skeptic pass over the FORGE diff against docs/CODE_STYLE.md + the hard
// frozen-zone rules, BEFORE the verify judge. severe → the governor runs a bounded revise loop, then
// blocks. Reviewer unavailable / parse-fail → 'none' (never block on the reviewer's own failure; verify
// is still the gate). Cached style doc keeps it cheap.
let _codeStyleDoc = null;
function codeStyleDoc() {
  if (_codeStyleDoc != null) return _codeStyleDoc;
  try { _codeStyleDoc = fs.readFileSync(path.join(SELF_HEAL_PROJ, 'docs', 'CODE_STYLE.md'), 'utf8').slice(0, 6000); } catch { _codeStyleDoc = ''; }
  return _codeStyleDoc;
}
async function selfDriveReview({ diff, desire } = {}) {
  if (!diff || !String(diff).trim()) return { severity: 'none', notes: '' };
  const frozen = risk.FROZEN_ZONE.join(', ');
  const sys = `You are the REVIEWER: a skeptic reviewing a code diff produced by a SELF-MODIFYING agent, BEFORE it is verified. Output ONLY JSON: {"severity":"none|minor|severe","notes":"specific, actionable findings"}.
severe = a HARD-RULE violation (touches or weakens a frozen rail [${frozen}]; weakens a guardrail/gate/limit or the verify suite; ships a secret; swallows a load-bearing error) OR a real correctness/quality defect.
minor = style nits only. none = clean.
STYLE GUIDE:\n${codeStyleDoc()}`;
  try {
    const r = await anthropicRequest({ model: MODEL_SONNET, max_tokens: 700, system: sys, messages: [{ role: 'user', content: `Desire: ${desire && (desire.aspiration || desire.id)}\n\nDIFF:\n${String(diff).slice(0, 16000)}` }] }, getApiKey());
    const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) { const j = JSON.parse(m[0]); const sev = String(j.severity || 'none').toLowerCase(); try { sdRelay(`🔎 REVIEWER — ${sev}${j.notes ? ': ' + String(j.notes).replace(/\s+/g, ' ').slice(0, 180) : ''}`); } catch {} return { severity: sev, notes: j.notes || '' }; }
  } catch {}
  return { severity: 'none', notes: '' };
}
function selfDriveDeps() {
  return {
    reflect: selfDriveReflect,
    // REVIEWER stage — on by default; disable with config.codeReview.enabled=false.
    review: (loadConfig().codeReview && loadConfig().codeReview.enabled === false) ? undefined : selfDriveReview,
    listResolvedIds: () => { try { const rows = reflect.listDesires(); return new Set(rows.filter((r) => r.type === 'resolution').map((r) => r.id)); } catch { return new Set(); } },
    resolveDesire: (id, outcome, opts) => { try { return reflect.resolveDesire(id, outcome, opts); } catch {} },
    classify: selfDriveClassify,
    research: selfDriveResearch,
    plan: selfDrivePlan,
    forge: selfDriveForge,
    verify: (cmd, proj) => runShell(cmd, proj, 300000),
    snapshot: selfDriveSnapshot,
    telemetryDelta: (a, b) => introspect.telemetryDelta(a, b),
    runShell,
    notify: (t) => { try { telegramNotify(t); } catch {} try { sendToActivity('tool-update', { type: 'thinking', text: t }); } catch {} },
    broadcast: (u) => { try { fleetBroadcast({ id: 'self-drive', role: u.role || 'OVERMIND', status: u.done ? 'done' : 'working', note: u.note, panel: 'selfdrive', ...u }); } catch {} },
    proj: SELF_HEAL_PROJ,
    probe: async () => { let treeClean = false; try { const r = await runShell('git status --porcelain', SELF_HEAL_PROJ, 15000); treeClean = !((r.stdout || '').trim()); } catch {} return { idle: agentState === 'idle', treeClean }; },
    budget: () => { try { return rateBudget(MODEL_SONNET); } catch { return { outFree: Infinity }; } },
    retryAfterMs: () => _lastRetryAfterMs || 0,
    selfhealDayCount: () => { try { return selfheal.dayCount(); } catch { return 0; } },
  };
}
// Kick off a session in the background (a session can run minutes with budget sleeps); progress streams
// to the VANGUARD panel + Telegram. reason: 'manual' | 'reflection' | 'capability_gap' | 'schedule'.
function startSelfDriveSession(opts = {}) {
  if (!selfdrive.enabled(loadConfig)) return { skipped: 'disabled' };
  if (selfdrive.isRunning()) return { skipped: 'already running' };
  // APPROVAL GATE (Siddhant's rule 2026-07-01): every session — manual, reflection, capability-gap —
  // needs an explicit go-ahead. A manual invocation already carries approval (self_drive is a step-up
  // tool: the confirm card WAS the approval, so its handler passes approved:true). Auto-triggers pass
  // no approval → we stash a pending proposal and ask; the user says "go ahead" to launch.
  const sdCfg = selfdrive.cfgFrom(loadConfig);
  if (sdCfg.requireStartApproval && !opts.approved) {
    _pendingSelfDrive = { reason: opts.reason || 'manual', focus: opts.focus || '', maxCycles: opts.maxCycles, at: Date.now() };
    const proposal = `Approve a self-improvement session${opts.focus ? ` focused on: ${String(opts.focus).slice(0, 120)}` : ''}? Once approved I run free through my actionable backlog on an isolated local branch, verify-gate every change, auto-revert anything that would degrade me, never touch my own safety rails, and never push. Say "go ahead" to begin.`;
    try { sendToActivity('tool-update', { type: 'thinking', text: '🕹 awaiting your approval to start a self-improvement session' }); } catch {}
    try { if (opts.reason && opts.reason !== 'manual') telegramNotify('🕹 ' + proposal); } catch {}
    return { needsApproval: true, proposal };
  }
  // Capture the branch we start from so we can return to it afterward. selfdrive checks out its own
  // self-drive-* branch and never switches back — which left the repo (and any later commits, mine or
  // the user's) stranded on the session branch. Restore the original branch when the session ends.
  let origBranch = 'main';
  try { origBranch = require('child_process').execSync('git rev-parse --abbrev-ref HEAD', { cwd: SELF_HEAL_PROJ }).toString().trim() || 'main'; } catch {}
  if (/^self-drive-/.test(origBranch)) origBranch = 'main';   // never return onto a prior session branch
  selfdrive.startSession(loadConfig, selfDriveDeps(), { ...opts, approved: true })
    .then((r) => { if (r && r.skipped) console.log('[self-drive] not started:', r.skipped); })
    .catch((e) => console.error('[self-drive] session error:', e.message))
    .finally(() => { runShell('git checkout ' + JSON.stringify(origBranch), SELF_HEAL_PROJ).then((r) => { if (r && r.success !== false) console.log('[self-drive] returned to branch ' + origBranch); }).catch(() => {}); });
  return { started: true, reason: opts.reason || 'manual' };
}
// Capability-gap trigger: BhatBot decided it can't do something with its current tools. Enqueue a
// focused improvement and (if allowed + idle) start a session targeting it. Conservative — no-op while
// busy or already running, so it never thrashes mid-task.
function noteCapabilityGap(description, files) {
  try {
    const cfg = selfdrive.cfgFrom(loadConfig);
    if (!cfg.enabled || !cfg.capabilityGapTrigger) return { skipped: 'trigger off' };
    if (selfdrive.isRunning() || agentState !== 'idle') return { skipped: 'busy' };
    return startSelfDriveSession({ reason: 'capability_gap', focus: String(description || '').slice(0, 300) });
  } catch (e) { return { error: e.message }; }
}

// ── HEALTH — Garmin biometrics + PROACTIVE monitor ──────────────────────────────────────────────
// Pulls biometrics on a timer (default on), caches them, and PROACTIVELY surfaces notable trends
// (resting-HR creep, low HRV/sleep/body-battery, etc.) via Telegram + the Health panel — no prompting.
// Not a clinician; framed as decision-support over the user's own wearable data.
let _healthTimer = null;
let _healthNotified = {};       // metric → last-notified day, so a standing flag isn't re-pinged daily
function healthCfg() { const c = loadConfig().health || {}; return { enabled: c.enabled !== false, syncEveryMin: c.syncEveryMin || 90, proactive: c.proactive !== false, quietHours: c.quietHours !== false, ...c }; }
function biometricPortrait() {
  try { const off = loadConfig().health || {}; health.setSleepOffset(off.sleepOffsetHours != null ? off.sleepOffsetHours : 1); } catch {}
  try { return health.portrait(garmin.readHistory(180)); } catch { return health.portrait([]); }
}
async function healthSync() {
  if (!garmin.available()) return { ok: false, needsSetup: true, reason: 'run scripts/garmin-setup.sh (one-time)' };
  return garmin.sync(loadConfig, keychainRead, { activities: 3 });
}
function pushBiometrics() { try { const p = biometricPortrait(); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('biometrics-update', p); return p; } catch { return null; } }
async function healthTick() {
  const cfg = healthCfg();
  if (!cfg.enabled || !garmin.available()) return;
  // KILL INTERRUPTIONS: never surface an ambient health ping WHILE a turn is running — it muddies the
  // active task. Skip this tick; the next one (or idle) catches it. (Siddhant: proactive pokes queue for idle.)
  if (agentState === 'running' || agentState === 'paused') return;
  if (cfg.quietHours) { const h = new Date().getHours(); if (h < 7 || h >= 23) return; }   // no biometric pings overnight
  try {
    await healthSync();
    const p = pushBiometrics();
    if (!cfg.proactive || !p) return;
    // Proactively relay any NEW concern/watch flag (deduped per metric per day).
    const day = new Date().toISOString().slice(0, 10);
    const notable = (p.flags || []).filter((f) => (f.level === 'concern' || f.level === 'watch') && _healthNotified[f.metric] !== day);
    if (notable.length) {
      for (const f of notable) _healthNotified[f.metric] = day;
      const lead = notable.find((f) => f.level === 'concern') || notable[0];
      const msg = `❤️ Health: ${lead.message}` + (notable.length > 1 ? ` (+${notable.length - 1} more on the Health tab)` : '');
      try { telegramNotify(msg); } catch {}
      try { sendToActivity('tool-update', { type: 'thinking', text: msg }); } catch {}
    }
  } catch (e) { console.warn('[health] tick failed:', e.message); }
}
function startHealthMonitor() {
  const cfg = healthCfg();
  if (!cfg.enabled) { console.log('[health] monitor disabled (config.health.enabled=false)'); return; }
  if (!garmin.available()) { console.log('[health] Garmin not set up — run scripts/garmin-setup.sh to enable the biometrics monitor'); return; }
  if (_healthTimer) return;
  _healthTimer = setInterval(healthTick, Math.max(15, cfg.syncEveryMin) * 60 * 1000);
  console.log(`[health] proactive monitor on — syncing every ${cfg.syncEveryMin}m, alerting on notable trends`);
  setTimeout(healthTick, 60 * 1000);
}
function stopHealthMonitor() { if (_healthTimer) { clearInterval(_healthTimer); _healthTimer = null; } }
function healthMonitoring() { return !!_healthTimer; }

// ── MANAGE — live snapshot of everything BhatBot is running ──────────────────────────────────────
function opsSnapshot() {
  return opsstatus.gather({
    selfheal: () => selfheal.status(loadConfig),
    selfdrive: () => ({ ...selfdrive.status(loadConfig), running: selfdrive.isRunning() }),
    patrolOn: () => !!(loadConfig().patrol && loadConfig().patrol.enabled !== false),
    ambient: () => { try { return ambient.status ? ambient.status(loadConfig) : { enabled: false }; } catch { return { enabled: false }; } },
    schedules: () => scheduler.list().map((s) => ({ id: s.id, title: s.title, kind: s.kind, nextRun: s.nextRun ? new Date(s.nextRun).toISOString() : null, enabled: s.enabled })),
    health: () => { const st = (garmin.latest() || {}); return { configured: garmin.available(), monitoring: healthMonitoring(), last_sync: st.synced_at || null }; },
    cloudConnected: () => !!(_cloudBridge && _cloudBridge.connected && _cloudBridge.connected()),
    fleet: () => { try { const a = jobsBus.active() || []; return { active: a.length, agents: a.map((j) => ({ id: j.id, role: j.agent || j.kind, task: j.name })),
      // Live OTPM-derived width so the panel shows what's ACTUALLY available now vs the static cap.
      width: fleetWidth(MODEL_SONNET), cap: FLEET_CAP,
      widthByModel: { sonnet: fleetWidth(MODEL_SONNET), fable: fleetWidth(MODEL_FABLE), opus: fleetWidth('claude-opus-4-8') } }; }
      catch { return { active: 0, agents: [], width: 0, cap: FLEET_CAP }; } },
    budgets: () => [MODEL_SONNET, MODEL_FABLE, 'claude-opus-4-8'].map((m) => { try { const b = rateBudget(m); return { model: m.replace(/^claude-/, ''), outFree: b.outFree, outSafe: b.outSafe }; } catch { return { model: m, outFree: null }; } }),
    costToday: () => { try { return costToday(); } catch { return null; } },
    recentEvents: () => { try { return rstate.recentEvents(20); } catch { return []; } },
  });
}
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

// Always-on memory maintenance: periodic decay/dedup of the semantic store + per-workspace compaction
// + bounding of runaway OPERATIONAL logs (never the training datasets). Runs on a timer in the main
// process, so it keeps memory healthy whether or not the window is open — and 24/7 under the daemon.
// ── SYNAPSE — the second brain ────────────────────────────────────────────────────────────────────
// Hybrid knowledge graph over BhatBot's memory (lib/brain.js). hydrate = import nodes from projects +
// semantic memories + the user's repos (summaries + key files) + Notion. connect = embed the nodes and
// let the Connector propose cross-project links, each with an LLM "why related" rationale. The SYNAPSE
// tab renders + prunes it; a light background worker keeps it fresh (the 24/7 job is the cloud brain).
let _brain = null;
function synapse() { if (!_brain) { _brain = brain.createBrain({}); } return _brain; }
function pushSynapse() { try { const g = synapse().graphView(); g.budget = { limit: synapseBudget(), spent: synapseSpent(), left: synapseBudgetLeft() }; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('synapse-update', g); } catch {} }

// ── SYNAPSE cost governor ─────────────────────────────────────────────────────────────────────────
// A HARD dollar cap (default $1, config.synapseBudgetUsd) on the paid parts of the brain (embeddings +
// rationale + suggestions). Spend is a persistent cumulative ledger; once it hits the cap, paid calls
// are skipped so a POC / always-on worker can never run away. Prices are the 2026 list rates.
const SY_PRICE = { embed: 0.02 / 1e6, sonnetIn: 3 / 1e6, sonnetOut: 15 / 1e6 };   // USD per token
const _syTok = (s) => Math.ceil(String(s || '').length / 4);                        // ~4 chars/token estimate
function synapseBudget() { const v = Number(loadConfig().synapseBudgetUsd); return Number.isFinite(v) && v > 0 ? v : 1; }
function synapseSpent() { try { return Number(synapse().getMeta('spendUsd')) || 0; } catch { return 0; } }
function synapseBudgetLeft() { return Math.max(0, synapseBudget() - synapseSpent()); }
function synapseSpend(usd) { try { const b = synapse(); b.setMeta('spendUsd', (Number(b.getMeta('spendUsd')) || 0) + (Number(usd) || 0)); } catch {} }

// Pull the raw semantic store (records carry their embedding vecs) — so memory nodes reuse embeddings.
function _semanticRecords() {
  try { const s = JSON.parse(fs.readFileSync(semantic.STORE_PATH, 'utf8')); return (s.records || []).filter((r) => r && r.text); } catch { return []; }
}
// Discover the user's git repos directly under $HOME (top-level project dirs) at the chosen depth.
function _scanRepos({ max = 40, keyFileCap = 12 } = {}) {
  const home = os.homedir(); const out = [];
  let dirs = []; try { dirs = fs.readdirSync(home, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return out; }
  for (const name of dirs) {
    if (out.length >= max) break;
    const root = path.join(home, name);
    try { if (!fs.existsSync(path.join(root, '.git'))) continue; } catch { continue; }   // git repos only
    // README (the summary) + the key files (READMEs/docs/entrypoints only — not every file).
    let readme = '';
    for (const rn of ['README.md', 'readme.md', 'Readme.md']) { try { readme = fs.readFileSync(path.join(root, rn), 'utf8').slice(0, 6000); break; } catch {} }
    let all = []; try { all = fs.readdirSync(root).filter((f) => { try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; } }); } catch {}
    try { const s = fs.readdirSync(path.join(root, 'src')).map((f) => 'src/' + f); all = all.concat(s); } catch {}
    const key = brain.keyFilesFor(all, keyFileCap);
    const files = [];
    for (const rel of key) { try { files.push({ path: rel, text: fs.readFileSync(path.join(root, rel), 'utf8').slice(0, 4000) }); } catch {} }
    out.push({ name, path: root, readme, files });
  }
  return out;
}
async function synapseHydrate({ repos = true, memories = true, notionPages = true } = {}) {
  const b = synapse(); const ts = Date.now(); let added = 0;
  const push = (n) => { if (n) { b.upsertNode(n, ts); added++; } };
  const pushBundle = (bundle) => { for (const n of (bundle.nodes || [])) push(n); for (const e of (bundle.edges || [])) b.upsertEdge(e, ts); };
  try { for (const p of projects.list()) push(brain.projectNode(projects.get(p.slug))); } catch {}                    // BhatBot projects
  if (memories) { const recs = _semanticRecords(); recs.slice(0, 600).forEach((m, i) => push(brain.memoryNode(m, i))); } // semantic memories (+ vecs)
  if (repos) { for (const r of _scanRepos()) pushBundle(brain.repoNodes(r)); }                                        // ~/repos (summary + key files)
  if (notionPages) { try { const pages = notion.listPages ? await notion.listPages({ limit: 60 }) : []; for (const pg of (pages || [])) pushBundle(brain.notionNodes(pg)); } catch {} }
  b.save(); pushSynapse();
  return b.stats();
}
// Embed any nodes missing a vector (batched), then run the Connector and add a short LLM rationale
// to each proposed link before committing it. Cross-project only; pruned pairs are never re-proposed.
async function synapseConnect({ threshold = 0.8, maxRationale = 8 } = {}) {
  const b = synapse();
  const all = b.nodes().filter((n) => n.status !== 'pruned');
  const need = all.filter((n) => !Array.isArray(n.embedding) || !n.embedding.length);
  for (let i = 0; i < need.length; i += 64) {
    if (synapseBudgetLeft() <= 0) break;                                            // budget exhausted → stop embedding
    const batch = need.slice(i, i + 64);
    const texts = batch.map((n) => (n.label + '. ' + (n.text || '')).slice(0, 2000));
    try { const { vecs } = await semantic.embedBatch(texts); synapseSpend(texts.reduce((s, t) => s + _syTok(t), 0) * SY_PRICE.embed); batch.forEach((n, k) => { if (vecs[k]) b.upsertNode({ id: n.id, type: n.type, ref: n.ref, embedding: vecs[k] }, Date.now()); }); }
    catch { break; }   // no embed key / offline → stop; existing links stay
  }
  const existingPairs = new Set(b.edges().map((e) => [e.from, e.to].sort().join('|')));   // includes pruned → never re-propose
  const cands = brain.proposeConnections(b.nodes(), { threshold, maxPerNode: 3, existingPairs });
  // Rationale for the strongest few (cheap; the rest commit without prose and get one lazily on view).
  cands.sort((a, c) => c.confidence - a.confidence);
  for (let i = 0; i < cands.length; i++) {
    const e = cands[i];
    if (i < maxRationale && synapseBudgetLeft() > 0) {
      try {
        const A = b.getNode(e.from), C = b.getNode(e.to);
        const content = `A (${A.type}): ${A.label} — ${(A.text || '').slice(0, 400)}\n\nB (${C.type}): ${C.label} — ${(C.text || '').slice(0, 400)}`;
        const r = await anthropicRequest({ model: MODEL_SONNET, max_tokens: 90, system: 'In ONE sentence, say specifically how these two items from DIFFERENT projects are related or could inform each other. If not genuinely related, reply exactly "NONE".', messages: [{ role: 'user', content }] }, getApiKey());
        const txt = (r.content.filter((x) => x.type === 'text').map((x) => x.text).join(' ') || '').trim();
        synapseSpend(_syTok(content) * SY_PRICE.sonnetIn + _syTok(txt) * SY_PRICE.sonnetOut);
        if (/^none/i.test(txt)) continue;   // the model rejects it → don't add
        e.rationale = txt.slice(0, 300);
      } catch {}
    }
    b.upsertEdge(e, Date.now());
  }
  b.save(); pushSynapse();
  return { proposed: cands.length, ...b.stats() };
}

// From the connected graph, synthesize a few "projects to move ahead on" — grounded in the strongest
// cross-project links + project recency. ONE budget-gated Claude call; result rides in graph meta.
async function synapseSuggest() {
  const b = synapse();
  if (synapseBudgetLeft() <= 0) return { suggestions: b.getMeta('suggestions') || [], budgetExhausted: true };
  let projs = [];
  try { projs = projects.list().map((p) => ({ name: p.name, status: p.status, slug: p.slug })); } catch {}
  const links = b.edges().filter((e) => e.status !== 'pruned' && e.rationale)
    .sort((a, c) => (c.confidence || 0) - (a.confidence || 0)).slice(0, 14)
    .map((e) => { const A = b.getNode(e.from), C = b.getNode(e.to); return A && C ? `• ${A.label} ↔ ${C.label}: ${e.rationale}` : null; }).filter(Boolean);
  const ctx = `MY PROJECTS:\n${projs.map((p) => '- ' + p.name + (p.status ? ` (${p.status})` : '')).join('\n') || '(none)'}\n\nCROSS-PROJECT CONNECTIONS THE SECOND BRAIN FOUND:\n${links.join('\n') || '(none yet)'}`;
  const sys = 'You are the second brain surfacing what Siddhant should work on next. From his projects and the connections found, pick 3-5 concrete moves. Reply ONLY a JSON array: [{"project":"<name>","why":"<one grounded sentence, cite a connection if relevant>","next":"<one concrete next step>"}]. No prose outside the JSON.';
  let suggestions = [];
  try {
    const r = await anthropicRequest({ model: MODEL_SONNET, max_tokens: 700, system: sys, messages: [{ role: 'user', content: ctx }] }, getApiKey());
    const txt = (r.content.filter((x) => x.type === 'text').map((x) => x.text).join(' ') || '').trim();
    synapseSpend(_syTok(ctx) * SY_PRICE.sonnetIn + _syTok(txt) * SY_PRICE.sonnetOut);
    const m = txt.match(/\[[\s\S]*\]/); if (m) suggestions = JSON.parse(m[0]);
  } catch {}
  if (Array.isArray(suggestions) && suggestions.length) { b.setMeta('suggestions', suggestions.slice(0, 5)); b.setMeta('suggestedAt', Date.now()); b.save(); pushSynapse(); }
  return { suggestions: b.getMeta('suggestions') || [] };
}

// config.memoryMaintenance: { enabled(default true), intervalMinutes(default 30), maxEpisodicAgeDays(45) }.
function startMemoryMaintenance() {
  const c = (loadConfig().memoryMaintenance) || {};
  if (c.enabled === false) { console.log('[memmaint] disabled by config'); return; }
  const intervalMs = Math.max(5, c.intervalMinutes || 30) * 60 * 1000;
  memmaint.start({
    intervalMs,
    deps: {
      maxLogLines: c.maxLogLines || 20000,
      // OPERATIONAL logs only — training datasets (router-train/spoken/depth .jsonl) are excluded on purpose.
      trimLogs: [ROUTER_LOG, LOG_PATH],
      semanticMaintain: () => { try { return semantic.maintain({ maxEpisodicAgeDays: c.maxEpisodicAgeDays || 45 }); } catch (e) { return { error: e.message }; } },
      onReport: (r) => {
        try {
          const s = r.semantic || {};
          if (s.decayed || s.merged) console.log(`[memmaint] semantic ${s.before}→${s.after} (decayed ${s.decayed}, merged ${s.merged})`);
          const trimmed = (r.logs || []).reduce((n, l) => n + (l.trimmed || 0), 0);
          if (trimmed) console.log(`[memmaint] trimmed ${trimmed} old log lines`);
        } catch {}
      },
    },
  });
  console.log(`[memmaint] started (every ${intervalMs / 60000}min): semantic decay/dedup + log bounding`);
}

// ── SYNAPSE always-on worker ────────────────────────────────────────────────────────────────────
// Keeps the second brain fresh without any input. FREE re-import (nodes) on a short cycle so new
// projects/memories/files always show up; the PAID pass (embeddings + rationale + suggestions) runs
// on a slow cycle, ONLY when the agent is idle and the $1 budget has room. config.synapse:
//   { worker(default true), hydrateMin(30), connectHours(6), paid(true) }.
let _synapseTimer = null, _synapseLastConnect = 0;
function synapseWorkerConfig() {
  const c = (loadConfig().synapse) || {};
  return { worker: c.worker !== false, hydrateMin: Math.max(5, c.hydrateMin || 30), connectHours: Math.max(1, c.connectHours || 6), paid: c.paid !== false };
}
async function synapseWorkerTick() {
  const c = synapseWorkerConfig();
  if (!c.worker) return;
  try {
    await synapseHydrate();   // free — no LLM / no embeddings
    const idle = agentState !== 'running' && agentState !== 'paused';
    const due = Date.now() - _synapseLastConnect >= c.connectHours * 3600 * 1000;
    if (c.paid && idle && due && synapseBudgetLeft() > 0.02) {
      _synapseLastConnect = Date.now();
      const before = synapseSpent();
      await synapseConnect();
      await synapseSuggest();
      console.log(`[synapse] background pass: +$${(synapseSpent() - before).toFixed(4)} (spent $${synapseSpent().toFixed(3)}/$${synapseBudget().toFixed(2)})`);
    }
  } catch (e) { console.warn('[synapse] worker tick failed:', e.message); }
}
function startSynapseWorker() {
  const c = synapseWorkerConfig();
  if (!c.worker) { console.log('[synapse] worker disabled by config'); return; }
  if (_synapseTimer) clearInterval(_synapseTimer);
  _synapseTimer = setInterval(() => { synapseWorkerTick(); }, c.hydrateMin * 60 * 1000);
  setTimeout(() => { synapseWorkerTick(); }, 20000);   // first pass shortly after boot
  console.log(`[synapse] worker started (re-import every ${c.hydrateMin}min; paid pass every ${c.connectHours}h when idle, under $${synapseBudget().toFixed(2)})`);
}

// ── MCP-client hub ──────────────────────────────────────────────────────────────────────────────
// Spawn every enabled external MCP server from config.mcpPlugins and surface its tools to the agent
// loop (namespaced mcp__<plugin>__<tool>). Best-effort + async so a slow/broken plugin never blocks boot.
async function startMcpHub() {
  const specs = loadConfig().mcpPlugins || [];
  const enabled = specs.filter((s) => s && s.enabled !== false);
  if (!enabled.length) { console.log('[mcphub] no external MCP plugins configured'); return; }
  if (!mcphub.available()) { console.warn('[mcphub] MCP SDK unavailable — plugins skipped'); return; }
  try { const st = await mcphub.connectAll(enabled, { log: (m) => console.log(m) }); console.log(`[mcphub] ready — ${st.total} tool(s) across ${st.plugins.length} plugin(s)`); }
  catch (e) { console.warn('[mcphub] connectAll failed:', e.message); }
}

// Map live background jobs → agent-presence avatars for the 3D presence window.
const JOB_STATE = { running: 'working', active: 'working', queued: 'thinking', blocked: 'thinking', done: 'done', completed: 'done', failed: 'error', error: 'error', cancelled: 'idle' };
function presenceSnapshot() {
  let jobs = [];
  try { jobs = (jobsBus.active ? jobsBus.active() : jobsBus.list()) || []; } catch {}
  const agents = jobs.slice(0, 12).map((j) => ({ role: j.name || j.kind || 'agent', state: JOB_STATE[j.status] || 'idle', label: (j.note || '').slice(0, 40) }));
  return { agents };
}
// Push live fleet state to the presence window a few times a second while it's open (updatePresence
// no-ops when the window is closed, so this is cheap). Empty snapshots are skipped so the window's
// built-in demo animation keeps it alive when nothing is running.
function startPresenceFeed() {
  const t = setInterval(() => {
    try {
      const snap = presenceSnapshot();
      if (!snap.agents.length) return;                 // no active agents → let the office idle (demo loop)
      wm.updatePresence(snap);                          // popup presence window (if open)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('presence-update', snap);   // FLEET-tab iframe
    } catch {}
  }, 1200);
  t.unref?.();
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

// Nexus/Studio/Chess/ChessApplet/WorldCup/toggle window openers + studioWebContents moved to
// window-manager.js (SPLIT_PLAN step 8). createWindow + openTerminalWindow + the fleet windows
// stay in main (mainWindow/pty coupling). Thin consts at the top of the file keep call sites intact.

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
  const hasCloudStt = !!(c.openaiKey || (c.sttProvider === 'groq' && c.groqKey));
  let hasLocalStt = false; try { hasLocalStt = localstt.available(); } catch {}
  return {
    hasOpenAI: hasCloudStt,
    hasLocalStt,
    hasSTT: hasCloudStt || hasLocalStt,   // renderer arms MediaRecorder→Whisper whenever ANY STT exists
    picovoiceKey: c.picovoiceKey || null, wakeWord: c.wakeWord || 'jarvis', silenceMs: c.silenceMs || 2000,
    vadFloorMargin: (c.vad && c.vad.floorMargin) || 1.8, verifyUser: !!(c.voice && c.voice.verifyUser),
    ttsEnabled: c.ttsEnabled !== false, ttsProvider, hasTTS,
    ttsSpeed: c.ttsSpeed != null ? c.ttsSpeed : 1.05,
    ttsTransport: ttsWsActive() ? 'ws' : 'rest',   // T1 transport, RESOLVED (auto→ws when usable) — surfaced for the ops panel
    uiTheme: c.uiTheme === 'hud' ? 'hud' : 'zen',            // T10 default: minimalist zen (config can force 'hud')
    hasReplicateKey: !!c.replicateKey, hasImageGen: !!c.openaiKey
  };
});
// ── Adaptive utterance endpointing (lib/endpoint.js) ──────────────────────────────────────────────
// One learned model of the user's speech-pause habits, persisted so it improves across sessions. The
// renderer asks for the current silence threshold when it opens the mic, and reports each mid-utterance
// pause it observes so the model learns when THIS user actually stops talking (vs a thinking-pause).
const ENDPOINT_FILE = path.join(os.homedir(), '.bhatbot', 'endpoint.json');
let _endpointer = null, _endpointSaveTimer = null;
function endpointer() {
  if (_endpointer) return _endpointer;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8')); } catch {}
  const c = loadConfig();
  _endpointer = createEndpointer({ pauses: saved.pauses,
    floorMs: c.endpointFloorMs, ceilMs: c.endpointCeilMs, defaultMs: c.silenceMs || c.endpointDefaultMs });
  return _endpointer;
}
function saveEndpointSoon() {
  clearTimeout(_endpointSaveTimer);
  _endpointSaveTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(ENDPOINT_FILE), { recursive: true }); fs.writeFileSync(ENDPOINT_FILE, JSON.stringify(endpointer().toJSON())); } catch {}
  }, 1500);
}
// Renderer opens the mic → asks how long to wait for silence (learned, per-user). Returns { thresholdMs, stats }.
ipcMain.handle('endpoint-threshold', () => { try { const e = endpointer(); return { thresholdMs: e.threshold(), stats: e.stats() }; } catch { return { thresholdMs: 1800 }; } });
// Renderer saw the user pause mid-utterance and resume (resumed:true) or end (resumed:false) → learn it.
ipcMain.handle('endpoint-observe', (_e, { ms, resumed } = {}) => {
  try { const e = endpointer(); e.observePause(ms, resumed); saveEndpointSoon(); return { thresholdMs: e.threshold() }; }
  catch { return { thresholdMs: 1800 }; }
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
// List the ElevenLabs voices on the account (for the Voice panel picker). Younger British male
// voices give JARVIS a younger timbre with the same delivery (v2 models have no pitch control —
// age = voice choice). Returns a slim list; degrades gracefully without a key.
ipcMain.handle('list-voices', async () => {
  const c = loadConfig();
  if (!c.elevenLabsKey) return { error: 'no elevenLabsKey', voices: [] };
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': c.elevenLabsKey } });
    if (!r.ok) return { error: `elevenlabs ${r.status}`, voices: [] };
    const j = await r.json();
    const voices = (j.voices || []).map((v) => ({
      voice_id: v.voice_id, name: v.name, category: v.category,
      labels: v.labels || {}, preview: v.preview_url || null,
    }));
    return { voices, active: c.ttsVoice || c.elevenLabsVoiceId || 'pNInz6obpgDQGcFmaJgB', model: c.ttsModel || 'eleven_flash_v2_5' };
  } catch (e) { return { error: e.message, voices: [] }; }
});
ipcMain.handle('set-voice', (_e, { voiceId }) => {
  if (!voiceId || typeof voiceId !== 'string') return { error: 'no voiceId' };
  saveConfig({ ttsProvider: 'elevenlabs', ttsVoice: voiceId, elevenLabsVoiceId: voiceId });
  return { ok: true, voiceId };
});
ipcMain.handle('set-voice-model', (_e, { model }) => {
  const ok = ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2', 'eleven_v3'].includes(model);
  if (!ok) return { error: 'unknown model' };
  saveConfig({ ttsModel: model });
  return { ok: true, model };
});
// JARVIS character presets — researched from Paul Bettany's delivery (clipped British RP, calm/measured/
// unflappable, dry wit in DEADPAN). High stability (even, never theatrical), strong similarity (hold the
// timbre), LOW style (deadpan — theatrics kill the wit), unhurried butler pace. "younger" only nudges
// pace/brightness slightly; true age is the chosen voice.
const VOICE_PRESETS = {
  jarvis:        { ttsStability: 0.55, ttsSimilarity: 0.90, ttsStyle: 0.18, ttsSpeed: 0.97, ttsSpeakerBoost: true },
  jarvis_younger:{ ttsStability: 0.48, ttsSimilarity: 0.88, ttsStyle: 0.22, ttsSpeed: 1.02, ttsSpeakerBoost: true },
  natural:       { ttsStability: 0.40, ttsSimilarity: 0.85, ttsStyle: 0.30, ttsSpeed: 1.0,  ttsSpeakerBoost: true },
};
ipcMain.handle('apply-voice-preset', (_e, { preset }) => {
  const p = VOICE_PRESETS[preset];
  if (!p) return { error: 'unknown preset' };
  saveConfig(p);
  return { ok: true, preset, settings: p };
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

// ONE source of truth for the voice character (used by both the MP3 desktop path and the μ-law phone
// path). Tuned for a JARVIS × ALFRED blend: JARVIS's composed, unflappable dryness + Alfred's warmer,
// measured, paternal delivery. So: steadier stability (even + warm, not erratic), strong similarity
// (hold the British clone timbre), a touch MORE style (warmth/humanity over pure deadpan), and a
// slightly slower, unhurried pace (gravitas). Every field is config-overridable live.
function jarvisVoiceSettings(c) {
  return {
    stability: c.ttsStability != null ? c.ttsStability : 0.44,   // steady + warm (Alfred), not monotone
    similarity_boost: c.ttsSimilarity != null ? c.ttsSimilarity : 0.88,   // hold the British timbre
    style: c.ttsStyle != null ? c.ttsStyle : 0.28,        // a little more warmth/character than pure deadpan
    use_speaker_boost: c.ttsSpeakerBoost != null ? c.ttsSpeakerBoost : true,
    speed: Math.max(0.7, Math.min(1.2, Number(c.ttsSpeed) || 0.98)),  // unhurried, paternal gravitas
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
  // HARD GUARD: normalize AT the synth call — the lowest choke point every ElevenLabs byte passes
  // through — so filenames/symbols are spoken correctly no matter which caller reached here (the
  // streaming path could split "top_10.csv" across tokens and slip a raw dot past upstream passes).
  // normalizeForSpeech is idempotent, so re-running it on already-normalized text is harmless.
  const text = humanizeCadence(normalizeForSpeech(t), { breaks: supportsBreaks });
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
  s = speech.forSpeech(s);                                     // emoji → spoken cue / clean drop; calm shouty punctuation (lib/speech)
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
  // 5b–7. EXHAUSTIVE symbol / number / punctuation → spoken words. One tested, comprehensive pass
  //        (lib/speech.speakSymbolsForSpeech): ranges, decimals, comparisons (< > ≤ ≥), math (× ÷ √ ^),
  //        arrows, minus, scientific units + Greek (Å, Δ, μ, °C…), currencies, unit ratios (kcal/mol),
  //        underscores, filename/domain dots, slashes, and every leftover markup symbol. Guaranteed by
  //        scripts/test-speech-punct.js so no symbol is ever voiced ambiguously again.
  s = speech.speakSymbolsForSpeech(s);
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
// Openers that earn a natural breath-beat. Includes Alfred-register leads ("Now then", "I'm afraid",
// "If I may", "Very good") so the paternal, measured rhythm lands. "now then" precedes "now" so the
// longer phrase matches first.
const DISCOURSE_LEAD = /^(right|so|well|now then|now|look|listen|honestly|actually|alright|okay|ok|hmm|ah|oh|sure|of course|indeed|very well|very good|certainly|quite|i'm afraid|if i may|forgive me|my word)\b[,]?\s+/i;
function humanizeCadence(input, { breaks = false } = {}) {
  let s = String(input || '');
  if (!s) return s;
  const SHORT = breaks ? '<break time="0.2s"/>' : ',';
  // Opening discourse marker → a plain comma beat. (T3: dropped the extra <break> on the ws/flash
  // path — it double-paused with the comma and read as a stammer.)
  s = s.replace(DISCOURSE_LEAD, (m) => m.replace(/[,\s]+$/, '') + ', ');
  // T3: ellipses used to render as a LONG trailing pause (…/<break 0.3s>) that stacked with the
  // sentence pause and dragged noticeably. A plain comma is the right micro-beat on every engine.
  s = s.replace(/\s*\.\.\.+\s*/g, ', ');
  // Em/en dashes and " - " = a brief mid-thought beat.
  s = s.replace(/\s*[—–]\s*/g, breaks ? ' ' + SHORT + ' ' : ', ');
  s = s.replace(/\s+-\s+/g, breaks ? ' ' + SHORT + ' ' : ', ');
  if (breaks) {
    // We deliberately do NOT inject a <break> between sentences — ElevenLabs already pauses at
    // . ! ? and an extra break made sentence-ends drag. Cap the beats we DID add (dashes) hard,
    // to avoid the documented prosody instability. T3 lowered the cap 6 → 3.
    const MAX = 3; let count = 0;
    s = s.replace(/<break[^>]*>/g, (t) => (++count > MAX ? '' : t));
  }
  return s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
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
let ttsPlayProc = null, ttsPlaySeq = 0, ttsActive = false, ttsLastAudioSeq = 0, ttsLastAudioTs = 0;
// Pre-rendered ack library (latency pass): the ack is the FIRST thing heard every turn, so make it
// FREE latency-wise — play a cached mp3 (rendered once in the configured voice) instead of a live
// synth round-trip. Rendered lazily at boot; falls back to live synth if a clip is missing.
const ACKS_DIR = path.join(os.homedir(), '.bhatbot', 'voice', 'acks');
let _ackRendering = false;
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
  ttsWsClose();         // T1 — tear down any in-flight ws stream + player instantly (barge-in)
  setTtsActive(false);
  setWakeMute(false);   // clear any name-clip wake suppression on interrupt
}
// Barge-in (#19): true turn-taking — cancel in-flight speech AND abort the running agent turn so
// BhatBot actually STOPS and listens (not just goes quiet while it keeps working). The finished
// turn returns via finish('⏹ Stopped.') on the next loop check. Gated by config.bargeInAbortsTurn.
function bargeInInterrupt() {
  stopDesktopTTS();
  if (_spk.words && _spk.bargedAt == null) _spk.bargedAt = _spk.words;   // T6 — spoken-word position at barge-in (right-censoring signal)
  if (agentState === 'running' && loadConfig().bargeInAbortsTurn !== false) agentState = 'stopped';
}
// splitForSpeech moved to lib/pure.js (SPLIT_PLAN step 1).
function playFile(file, seq, text) {
  return new Promise((res) => {
    if (seq !== ttsPlaySeq) return res();
    ttsLastAudioSeq = seq; ttsLastAudioTs = Date.now();  // ack watchdog + progress heartbeat: audio reached the speaker
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
function ackSlug(line) { return slugify(line); }
function ackFilePath(line) { return path.join(ACKS_DIR, ackSlug(line) + '.mp3'); }
// Play a PRE-RENDERED ack clip directly (single afplay, zero synth latency). Mirrors playFile's
// barge-in/wake-mute bookkeeping and counts as this turn's first audio for the watchdog. Tracked in
// ttsPlayProc so stopDesktopTTS()/barge-in kills it. Returns true if it started.
function playAckFile(seq, file, text) {
  if (seq !== ttsStreamSeq) return false;
  try {
    ttsLastAudioSeq = seq; ttsLastAudioTs = Date.now(); latMark('ack-audio'); setTtsActive(true);
    const sayingName = WAKE_WORD_RE.test(String(text || ''));
    if (sayingName) setWakeMute(true);
    const p = spawn('afplay', [file], { env: { ...process.env, PATH: EXEC_PATH } });
    ttsPlayProc = p;
    const done = () => {
      if (ttsPlayProc === p) ttsPlayProc = null;
      // Only disarm if no reply audio has taken over (rest drain / ws stream still owns it otherwise).
      if (seq === ttsStreamSeq && !ttsStreamDraining && !ttsStreamQ.length && !_ttsWsSess) setTtsActive(false);
      if (sayingName) setWakeMute(false);
    };
    p.on('close', done); p.on('error', done);
    return true;
  } catch { return false; }
}
// Lazily render the ack + holding lines in the CONFIGURED voice so ack and reply sound identical.
// Runs once in the background at boot; skips clips already on disk. Uses the existing ElevenLabs
// synth path (resolves the vaulted key + honors the cooldown). No-op without an EL key.
async function maybeRenderAcks() {
  const c = loadConfig();
  if (c.prerenderAcks === false || !c.elevenLabsKey || _ackRendering) return;
  _ackRendering = true;
  try {
    fs.mkdirSync(ACKS_DIR, { recursive: true });
    const lines = [...new Set([...ACKS, ...HOLDING])];
    let rendered = 0;
    for (const line of lines) {
      const f = ackFilePath(line);
      if (fs.existsSync(f)) continue;
      const r = await elevenLabsSynth(normalizeForSpeech(line), c, {});
      if (r && r.success && r.audio) { try { fs.writeFileSync(f, Buffer.from(r.audio, 'base64')); rendered++; } catch {} }
      else if (r && r.cooldown) break;   // EL cooling down (quota/auth) → try again next boot
      await sleep(300);
    }
    try { fs.writeFileSync(path.join(ACKS_DIR, 'index.json'), JSON.stringify(lines.map((l) => ({ slug: ackSlug(l), text: l })), null, 2)); } catch {}
    if (rendered) console.log(`[acks] pre-rendered ${rendered} ack clip(s) → ${ACKS_DIR}`);
  } catch (e) { console.warn('[acks] render failed:', e.message); }
  finally { _ackRendering = false; }
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
// --- T1: continuous ws streaming TTS transport --------------------------------------------
// Probe (cached) for the raw-PCM player + a singleton transport. `available()` gates the whole
// path so a missing ffplay/sox or key silently keeps us on the legacy REST stream.
const _binCache = {};
function _binExists(bin) {
  if (bin in _binCache) return _binCache[bin];
  let ok = false;
  try { ok = spawnSync('/usr/bin/which', [bin], { env: { ...process.env, PATH: EXEC_PATH }, timeout: 3000 }).status === 0; } catch {}
  return (_binCache[bin] = ok);
}
const _ttsWs = createTtsWs({
  WebSocket, spawn, which: _binExists,
  getConfig: () => { const c = loadConfig(); return { ...c, jarvisVoiceSettings: jarvisVoiceSettings(c) }; },
  log: (m) => console.warn(m),
  latMark: (m) => { try { latMark(m); } catch {} },
  onWakeMute: (on) => setWakeMute(on),
});
let _ttsWsSess = null, _ttsWsSeq = -1, _ttsWsNorm = null;
// TTS transport. Default 'auto' = use the low-latency continuous ws stream (one ElevenLabs
// stream-input ws → one persistent ffplay/sox PCM player, no per-sentence REST POST + afplay
// respawn) WHENEVER it's usable, else fall back to the REST per-sentence path. 'ws' forces it
// (still guarded by available()); 'rest' pins the old path. Flipped from 'rest' default now that
// ffplay is present here — kills the inter-sentence latency on every spoken turn.
function ttsTransportMode() {
  const t = loadConfig().ttsTransport;
  return t === 'rest' ? 'rest' : t === 'ws' ? 'ws' : 'auto';
}
// The one resolved TTS voice for THIS config (same precedence synthesizeSpeech uses). Default is
// local Kokoro when installed; explicit ttsProvider overrides.
function resolvedTtsProvider() {
  const c = loadConfig();
  return c.ttsProvider || (kokoroAvailable() ? 'kokoro' : (c.elevenLabsKey ? 'elevenlabs' : (c.openaiKey ? 'openai' : (c.piperBin ? 'piper' : null))));
}
// ONE VOICE: the ws stream IS an ElevenLabs transport, so only use it when EL is the chosen voice.
// Otherwise streamed replies would speak in EL while side-channel speech (acks, plan read-out,
// "Noted", drone notices) goes through synthesizeSpeech in the configured voice (e.g. Kokoro) → two
// voices in one session. Gating on the provider makes every utterance the SAME voice: Kokoro-default
// → ws off, everything streams through Kokoro; provider 'elevenlabs' → ws on, everything is EL.
function ttsWsActive() { return ttsTransportMode() !== 'rest' && resolvedTtsProvider() === 'elevenlabs' && _ttsWs.available(); }
function ttsWsEnsure(seq) {
  if (_ttsWsSess && _ttsWsSeq === seq) return _ttsWsSess;
  if (_ttsWsSess) { try { _ttsWsSess.close(); } catch {} }
  _ttsWsSeq = seq;
  _ttsWsNorm = createSpeechNormalizer(normalizeForSpeech);   // stream-safe: never splits a URL/decimal token
  const sess = _ttsWs.create(seq);
  sess.onFirstAudio(() => { ttsLastAudioSeq = seq; ttsLastAudioTs = Date.now(); setTtsActive(true); try { latMark('first-audio-playing'); } catch {} });
  sess.onDrained(() => { if (seq === ttsStreamSeq) { setTtsActive(false); emitTtsIdle(seq); } });
  _ttsWsSess = sess;
  ttsStreamProduced = true;   // ws will put audio on the wire → reserve the drain→tts-idle contract
  return sess;
}
function ttsWsClose() { if (_ttsWsSess) { try { _ttsWsSess.close(); } catch {} _ttsWsSess = null; _ttsWsSeq = -1; _ttsWsNorm = null; } }
function ttsStreamFeed(seq, delta) {
  if (seq !== ttsStreamSeq) return;
  if (loadConfig().ttsEnabled === false) return;
  if (ttsWsActive()) {                                        // ws path: normalize to token boundaries, stream raw
    const sess = ttsWsEnsure(seq);
    const out = _ttsWsNorm.push(delta);
    if (out) sess.feed(out);
    return;
  }
  ttsStreamBuf += delta;
  const re = /[^.!?\n]*[.!?\n]+/g; let m, consumed = 0;
  while ((m = re.exec(ttsStreamBuf))) { const s = m[0].trim(); consumed = re.lastIndex; if (s.length > 2) ttsStreamEnqueue(seq, s); }
  if (consumed) ttsStreamBuf = ttsStreamBuf.slice(consumed);
}
function ttsStreamFlush(seq) {
  if (seq !== ttsStreamSeq) return;
  if (_ttsWsSess && _ttsWsSeq === seq && ttsWsActive()) {     // ws path: flush the token-boundary tail + EOS
    const tail = _ttsWsNorm ? _ttsWsNorm.flush() : '';
    if (tail) _ttsWsSess.feed(tail);
    _ttsWsSess.flush();
    return;
  }
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
// Build + push a concise on-screen SUMMARY card to accompany a spoken digest: a headline (the
// spoken one-liner) plus scannable key points scanned from the full reply's own structure (bullets,
// numbered items, headers). Pure/local — no extra model call. Renderer shows it pinned above the
// full reply so the quick verbal version has a matching quick VISUAL version.
function extractKeyPoints(full) {
  const clean = (s) => String(s || '')
    .replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*#{1,6}\s*/, '').replace(/^\s*([-*]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ').trim();
  const pts = [];
  for (const line of String(full || '').split('\n')) {
    if (/^\s*([-*]\s|\d+[.)]\s)/.test(line) || /^\s*#{1,6}\s+\S/.test(line)) {
      const t = clean(line);
      if (t && t.length >= 3 && !pts.includes(t)) pts.push(t.slice(0, 110));
    }
    if (pts.length >= 6) break;
  }
  return pts;
}
function emitSpeechSummary(spoken, full) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (loadConfig().speechSummaryCard === false) return;
    const headline = String(spoken || '').trim();
    if (!headline) return;
    let points = extractKeyPoints(full);
    // No inherent structure → fall back to the summary's own sentences as points (still concise/visual).
    if (!points.length) {
      points = headline.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 2).slice(0, 4);
      if (points.length < 2) points = [];   // a single-sentence summary needs no bullet list
    }
    mainWindow.webContents.send('speech-summary', { headline, points });
  } catch {}
}
function makeSpeakStream(seq) {
  const OPEN = '<speak>', CLOSE = '</speak>';
  let pending = '', inside = false, sawTag = false, full = '', mode = 'undecided';
  const strip = (s) => s.replace(/<\/?speak>/g, '');
  function feed(delta) {
    full += delta;
    // Committed short-plain → fast path: everything visible is read verbatim as it streams.
    if (mode === 'short-plain') { const d = strip(pending + delta); pending = ''; if (d) { ttsStreamFeed(seq, d); recordSpoken(d); } return d; }
    // Committed digest → speak NOTHING more from the stream (finish() summarizes); still flow
    // the visible text to the screen so the full structured reply is shown.
    if (mode === 'digest') { const d = strip(pending + delta); pending = ''; return d; }
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
    // No <speak> tag yet — let the speech PLANNER decide once there's signal (T2). It reads the
    // visible text so far and commits to reading verbatim (short prose) or summarizing (long /
    // structured). Until it commits, keep buffering; a truly short reply is spoken whole by finish().
    if (mode === 'undecided') {
      const decision = classifySpeech(strip(full));
      if (decision === 'short-plain') { mode = 'short-plain'; const s = strip(full); if (s) { ttsStreamFeed(seq, s); recordSpoken(s); } pending = ''; }
      else if (decision === 'digest') { mode = 'digest'; }   // speak nothing now; finish() feeds the digest
    }
    return display;
  }
  function finish() {
    const display = strip(pending); pending = '';
    if (mode === 'digest') {
      // Reserve the drain→tts-idle contract SYNCHRONOUSLY so the post-turn idle guard doesn't fire
      // early (the digest is async). The drain that runs when the digest enqueues will emit tts-idle;
      // if the digest is empty we release the mic explicitly. Never silent, never wedges hands-free.
      ttsStreamProduced = true;
      (async () => {
        let spoken = '';
        try { const r = await summarizeForSpeech(strip(full)); if (r && r.success && r.text) spoken = r.text.trim(); } catch {}
        if (seq !== ttsStreamSeq) return;                      // a newer turn now owns tts-idle
        if (!spoken) { const m = strip(full).trim().match(/[^.!?\n]*[.!?]/); spoken = (m ? m[0] : strip(full).trim().slice(0, 200)).trim(); }  // floor: first sentence
        // Pair the concise SPOKEN summary with a concise ON-SCREEN summary card (headline + key
        // points scanned from the full reply), so the quick verbal version is backed visually while
        // the full detail stays below. Zero extra model cost — reuses the summary text + reply structure.
        emitSpeechSummary(spoken, strip(full));
        if (spoken) { ttsStreamEnqueue(seq, spoken); recordSpoken(spoken); }
        else emitTtsIdle(seq);
      })();
      return { sawTag, display, digest: true };
    }
    if ((inside || mode === 'short-plain') && display) { ttsStreamFeed(seq, display); recordSpoken(display); }
    // Reply too short to ever commit a mode (e.g. "Done.") → speak it whole.
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
  const line = ACKS[Math.floor(Math.random() * ACKS.length)];
  // Instant path: play the pre-rendered clip directly (zero synth latency). Fall back to live synth.
  if (c.prerenderAcks !== false) { const f = ackFilePath(line); if (fs.existsSync(f) && playAckFile(seq, f, line)) return; }
  ttsStreamFeed(seq, line + ' ');   // trailing space = clean token boundary for the ws normalizer
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
    const line = HOLDING[Math.floor(Math.random() * HOLDING.length)];
    // Instant path: pre-rendered holding clip. Else ws-stream it, else the REST enqueue.
    if (loadConfig().prerenderAcks !== false) { const f = ackFilePath(line); if (fs.existsSync(f) && playAckFile(seq, f, line)) return; }
    if (ttsWsActive()) ttsStreamFeed(seq, line + ' ');   // ws path: stream it, don't spawn a competing REST clip
    else ttsStreamEnqueue(seq, line);
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
  if (t && t.length > 1) { sessionSpoken.push(t); _spk.words += countWords(t); noteActivity(); }
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
    const r = await cheapText(sys, 'Spoken transcript of this session:\n\n' + transcript.slice(0, 6000) + '\n\nWrite the session note.', { maxTokens: 700 });
    let md = (r.text || '').trim();
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
        const r = await cheapText('You extract one durable working-preference from a user correction, or output NONE.', `User correction: "${userText.slice(0, 500)}"\nMy prior reply: "${String(prior).slice(0, 800)}"\n\nExtract ONE durable working-preference to remember for next time, as a single imperative line (e.g. "Keep spoken replies under two sentences"). If there is nothing durable/actionable, output exactly: NONE`, { maxTokens: 120 });
        const pref = (r.text || '').trim();
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

// validateHistory moved to lib/history.js (SPLIT_PLAN step 9).
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

// STT hallucination guard. Whisper-family models emit repeated-token / low-entropy bursts on
// near-silent or non-speech audio (the "Talaser Talaser…" loop). Reject those before they enter
// the chat or get injected as live steering. Returns a trimmed string, or null to drop it.
function sanitizeSteering(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const capped = text.length > 2000 ? text.slice(0, 2000) : text;   // cap runaway transcripts
  const words = capped.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  if (!words.length) return null;
  const distinct = new Set(words);
  if (distinct.size === 1 && words.length >= 2) return null;                          // one token repeated
  if (words.length >= 6 && distinct.size / words.length < 0.34) return null;          // low lexical diversity
  let run = 1;                                                                        // 4+ consecutive repeats
  for (let i = 1; i < words.length; i++) { run = words[i] === words[i - 1] ? run + 1 : 1; if (run >= 4) return null; }
  return capped;
}

async function transcribeAudio(audioBuffer, mimeType) {
  const c = loadConfig();
  const useGroq = c.sttProvider === 'groq' && c.groqKey;             // fastest path (opt-in)
  const endpoint = useGroq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
  const key = useGroq ? c.groqKey : c.openaiKey;
  const primary = c.sttModel || (useGroq ? 'whisper-large-v3-turbo' : 'gpt-4o-mini-transcribe');
  const mt = (mimeType || 'audio/webm').split(';')[0].trim();
  const ext = mt === 'audio/mp4' || mt === 'audio/m4a' || mt === 'audio/aac' ? 'm4a'
    : mt === 'audio/mpeg' ? 'mp3' : mt === 'audio/wav' || mt === 'audio/x-wav' ? 'wav'
    : mt === 'audio/ogg' ? 'ogg' : 'webm';
  const buf = Buffer.from(audioBuffer);
  const hint = sttVocabHint();
  // Offline fallback (mlx-whisper): used when there's no cloud key, or when the cloud call fails.
  // Keeps voice working with zero cloud dependency once scripts/whisper-setup.sh has run.
  const tryLocal = async (tag) => {
    if (!localstt.available()) return null;
    const r = await localstt.transcribe(buf, ext, { model: c.localSttModel, prompt: hint, execPath: EXEC_PATH });
    if (r && typeof r.text === 'string') {
      if (r.dropped === 'low_confidence') console.warn(`[stt-guard] worker dropped low-confidence audio (no_speech=${r.no_speech_prob}, avg_logprob=${r.avg_logprob})`);
      const clean = sanitizeSteering(r.text);
      return { success: true, text: clean || '', model: 'local-whisper' + (tag ? '(' + tag + ')' : ''), ...(clean ? {} : { _dropped: r.dropped || 'hallucination' }) };
    }
    return { error: 'local STT: ' + ((r && r.error) || 'failed') };
  };
  if (!key) {
    const local = await tryLocal('');
    if (local) return local;
    return { error: 'No STT key (set openaiKey, or groqKey + sttProvider="groq"), and offline Whisper is not set up — run scripts/whisper-setup.sh.' };
  }
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
    if (!res.ok) {
      const local = await tryLocal('fallback');     // cloud errored → try offline before giving up
      if (local && local.success) return local;
      return { error: res.err || `STT ${res.status}` };
    }
    if (res.text && !sanitizeSteering(res.text)) return { success: true, text: '', model: primary, _dropped: 'hallucination' };
    return { success: true, text: res.text, model: primary };
  } catch (e) {
    const local = await tryLocal('fallback');        // network down → offline
    if (local && local.success) return local;
    return { error: e.message };
  }
}
// COCKTAIL-PARTY post-filter (T3, config.voice.verifyUser): after transcribing, verify the clip is the
// ENROLLED user's voice; if it clearly isn't (someone else in the room talking), discard so BhatBot
// never acts on a background speaker. Off by default (voiceid is a slow venv); fail-OPEN on any error
// or missing enrollment so it can never wedge the mic.
async function verifyEnrolledSpeaker(buf, ext) {
  try {
    if (!voiceid.ready() || !voiceid.isEnrolled()) return { ok: true, skipped: 'not-enrolled' };
    const tmp = path.join(os.tmpdir(), `bb-spk-${Date.now()}.${ext}`);
    try { fs.writeFileSync(tmp, buf); } catch { return { ok: true, skipped: 'tmp-write' }; }
    const r = await voiceid.verify(tmp).catch(() => null);
    fs.unlink(tmp, () => {});
    if (!r || r.ok === false || typeof r.match !== 'boolean') return { ok: true, skipped: 'verify-error' };  // fail-open
    return { ok: r.match, score: r.score, threshold: r.threshold };
  } catch { return { ok: true, skipped: 'exception' }; }
}
// PASSIVE SPEAKER LEARNING (Siddhant's pick): with no enrollment session, quietly bank the first N
// clear utterances as the owner's voiceprint, auto-enroll, then start gating others (soft — the
// verify step fails open). Assumes the first several interactions are the owner (personal device).
const SPK_SAMPLES_DIR = path.join(os.homedir(), '.bhatbot', 'voiceid-samples');
let _spkLearnBusy = false;
async function passiveSpeakerLearn(buf, ext, text) {
  try {
    const c = loadConfig();
    if ((c.voice && c.voice.speakerLearn === false) || _spkLearnBusy) return;
    if (!voiceid.ready() || voiceid.isEnrolled()) return;                        // done once enrolled
    if (!text || String(text).trim().split(/\s+/).length < 4) return;            // learn only from real, clear speech
    fs.mkdirSync(SPK_SAMPLES_DIR, { recursive: true });
    const clips = () => fs.readdirSync(SPK_SAMPLES_DIR).filter((f) => /\.(webm|wav|m4a|ogg)$/.test(f));
    const need = Number(c.voice && c.voice.learnSamples) || 8;
    if (clips().length < need) { fs.writeFileSync(path.join(SPK_SAMPLES_DIR, `s${Date.now()}.${ext}`), buf); return; }
    _spkLearnBusy = true;
    const samples = clips().map((f) => path.join(SPK_SAMPLES_DIR, f));
    console.log(`[voiceid] passive-learn: enrolling your voiceprint from ${samples.length} samples…`);
    await voiceid.enroll(samples).catch((e) => console.warn('[voiceid] enroll error:', e && e.message));
    if (voiceid.isEnrolled()) {
      const v = { ...(loadConfig().voice || {}), verifyUser: true }; saveConfig({ voice: v });
      console.log('[voiceid] passive-learn complete — now focusing on your voice (soft gating).');
      try { if (loadConfig().ttsEnabled !== false) speakDesktop('<speak>I have learned your voice, sir. I will focus on you now.</speak>'); } catch {}
    }
    _spkLearnBusy = false;
  } catch { _spkLearnBusy = false; }
}
ipcMain.handle('transcribe-audio', async (_e, { audioBuffer, mimeType }) => {
  const res = await transcribeAudio(audioBuffer, mimeType);
  const c = loadConfig();
  const mt = (mimeType || 'audio/webm').split(';')[0].trim();
  const ext = mt === 'audio/mp4' || mt === 'audio/m4a' ? 'm4a' : mt === 'audio/wav' ? 'wav' : mt === 'audio/ogg' ? 'ogg' : 'webm';
  if (res && res.success && res.text && c.voice && c.voice.verifyUser) {
    const v = await verifyEnrolledSpeaker(Buffer.from(audioBuffer), ext);
    if (!v.ok) { console.log(`[voiceid] discarded non-enrolled speaker (score ${v.score}, thr ${v.threshold})`); return { success: true, text: '', _dropped: 'not_enrolled_speaker', score: v.score }; }
  } else if (res && res.success && res.text) {
    passiveSpeakerLearn(Buffer.from(audioBuffer), ext, res.text);   // fire-and-forget: build the voiceprint
  }
  return res;
});

// Spoken-summary: long replies get condensed for voice (the full text still shows on
// screen / can be read in full on demand). Haiku first (tiny + fast + negligible quota);
// if Haiku is rate-limited/unavailable, fall back to the local model so voice never dies.
const SPEECH_SYS = "You are J.A.R.V.I.S., a refined British butler, distilling a written reply into SPOKEN form for Siddhant — the full text is already on his screen, so you are giving the quick verbal version, not reading the document. HEADLINE FIRST: open with the single most important thing (the direct answer, the key number/name, the verdict, or what you did). Then add only what genuinely earns a breath. If the reply is a LIST, say how many and name just the top one or two — never enumerate all of them aloud. Cut every hedge, preamble, and piece of list/heading scaffolding. Stay faithful; never invent or add. 1–3 short, natural spoken sentences. No markdown, lists, code, or URLs — just the spoken line.";
// Trim a possibly-truncated tail back to the last complete sentence so a spoken summary that hit
// the token cap never ends on a half-sentence (a direct cause of "the voice gets cut off").
function trimToSentence(s) {
  const str = String(s || '').trim();
  const m = str.match(/^[\s\S]*[.!?]["')\]]?(?=\s|$)/);
  return (m && m[0].trim()) || str;
}
async function summarizeForSpeech(text) {
  const t = (text || '').trim();
  if (!t) return { error: 'empty text' };
  const cfg = loadConfig();
  const apiKey = getApiKey();
  // T5 — the LEARNED spoken-length target. The prompt stays qualitative; the NUMBER is learned from
  // this user's barge-in / ask-for-more feedback (density-conditioned). Below MIN_ROWS predict()
  // returns null and we keep the 1–3 sentence heuristic.
  let sys = SPEECH_SYS;
  try {
    const pred = spokenmodel.predict(spokenmodel.extractFeatures(t, _currentUserPrompt));
    if (pred && pred.words) sys += ` Aim for roughly ${pred.words} spoken words — lead with the headline (the key number, name, or verdict), then only what earns its place.`;
  } catch {}
  // 1) Local model FIRST (free, no quota) — a 1-3 sentence summary is well within a local model's reach.
  //    Haiku retired: the cheap tier is now local-first, Sonnet cloud fallback.
  if (cheapEnabled() && await ollamaReady()) {
    try {
      // stripReasoning: local models (qwen3 etc.) leak <think>…</think> — those tags must never be spoken.
      const out = stripReasoning((await ollamaChat([{ role: 'user', content: t.slice(0, 8000) }], sys, cheapLocalModel()) || '')).trim();
      if (out) return { success: true, text: out, via: 'ollama' };
    } catch (e) { console.warn('[summary] ollama failed → sonnet:', e.message); }
  }
  // 2) Sonnet cloud fallback — only if there's budget this minute (a summary is small, ~few hundred tok).
  if (apiKey && requestTokenEstimate([{ role: 'user', content: t.slice(0, 8000) }]) < rateBudget(MODEL_SONNET).free) {
    try {
      const j = await anthropicRequest({
        model: MODEL_SONNET, max_tokens: 512, system: sys,   // 512: a 1-3 sentence summary must never be hard-truncated mid-word
        messages: [{ role: 'user', content: t.slice(0, 8000) }]
      }, apiKey, { retries: 1 });
      let out = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      if (j && j.stop_reason === 'max_tokens') out = trimToSentence(out);   // belt-and-suspenders: never speak a truncated tail
      if (out) return { success: true, text: out, via: 'sonnet' };
    } catch (e) { console.warn('[summary] sonnet failed:', e.message); }
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
// Biometrics (Garmin) + ops snapshot for the Health / Manage panels (distinct from get-health = system metrics).
ipcMain.handle('get-biometrics', async (_e, opts) => { try { if (opts && opts.sync) await healthSync(); return biometricPortrait(); } catch (e) { return { error: e.message }; } });
ipcMain.handle('get-ops-status', async () => { try { return opsSnapshot(); } catch (e) { return { error: e.message }; } });
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
// Live system vitals for the HUD gauges + status-bar telemetry (cheap: os module + cached
// net-bytes delta; no extra deps). NET is machine-wide throughput sampled between calls.
let _netPrev = null;
function netBytesNow() {
  try {
    const out = require('child_process').execSync('netstat -ib', { timeout: 900 }).toString();
    let rx = 0, tx = 0;
    for (const l of out.split('\n').slice(1)) {
      const c = l.trim().split(/\s+/);
      if (c.length >= 10 && /^en\d/.test(c[0])) { rx += Number(c[6]) || 0; tx += Number(c[9]) || 0; }
    }
    return { rx, tx, t: Date.now() };
  } catch { return null; }
}
// SYNAPSE second-brain IPC — the SYNAPSE tab views/builds/prunes the knowledge graph.
ipcMain.handle('synapse-graph', () => { try { const g = synapse().graphView(); g.budget = { limit: synapseBudget(), spent: synapseSpent(), left: synapseBudgetLeft() }; return g; } catch (e) { return { error: e.message }; } });
// FREE first-open population: import nodes (projects + memories + repos + Notion) if the graph is empty.
// No embeddings / no LLM → no cost. The paid connect + suggestions happen on explicit Build.
ipcMain.handle('synapse-ensure', async () => {
  try { if (synapse().stats().nodes === 0) await synapseHydrate(); const g = synapse().graphView(); g.budget = { limit: synapseBudget(), spent: synapseSpent(), left: synapseBudgetLeft() }; return g; }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('synapse-build', async () => {
  try {
    sendToActivity('tool-update', { type: 'thinking', text: '🧠 building the second brain…' });
    await synapseHydrate();
    const r = await synapseConnect();
    const s = await synapseSuggest();
    return { ok: true, ...r, suggestions: s.suggestions, budget: { limit: synapseBudget(), spent: synapseSpent(), left: synapseBudgetLeft() } };
  }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('synapse-prune', (_e, { kind, id } = {}) => { try { const ok = synapse().prune(kind, id); synapse().save(); pushSynapse(); return { ok }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('synapse-confirm', (_e, { kind, id } = {}) => { try { const ok = synapse().confirm(kind, id); synapse().save(); pushSynapse(); return { ok }; } catch (e) { return { error: e.message }; } });

ipcMain.handle('get-vitals', () => {
  const cores = os.cpus().length || 1;
  const cpu = Math.max(0, Math.min(100, Math.round((os.loadavg()[0] / cores) * 100)));
  const mem = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  let pwr = null, charging = null;
  try {
    const b = require('child_process').execSync('pmset -g batt', { timeout: 900 }).toString();
    const m = b.match(/(\d+)%/); if (m) pwr = Number(m[1]);
    charging = /AC Power/.test(b);
  } catch {}
  let netMbs = null;
  const now = netBytesNow();
  if (now && _netPrev && now.t > _netPrev.t) {
    const dt = (now.t - _netPrev.t) / 1000;
    netMbs = Math.max(0, Math.round(((now.rx + now.tx) - (_netPrev.rx + _netPrev.tx)) / dt / 1024 / 1024 * 10) / 10);
  }
  if (now) _netPrev = now;
  return { cpu, mem, net: netMbs, pwr, charging, cores, uptime: os.uptime() };
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
  finalizeSpokenRow(ut);            // T5/T6 — resolve the PREVIOUS spoken turn's outcome now that the user acted
  _currentUserPrompt = ut;
  const wrap = /\b(wrap up|wrap it up|that'?s all|we'?re done|end session|close out|debrief)\b/i.test(ut);
  // Pipeline toggle by voice/text — flips config.pipeline.enabled without the settings UI.
  const toggle = maybeTogglePipeline(ut);
  if (toggle) return { text: toggle, history: [...history, { role: 'assistant', content: toggle }] };
  // Approve a PARKED self-improvement proposal (from reflection or a capability gap). This is the
  // "approve at start" half of Siddhant's rule — a plain "go ahead" launches the staged session with
  // approval, and from there it runs free. Guarded to only fire when a proposal is actually pending.
  if (_pendingSelfDrive && !/\?/.test(ut) && /^\s*(go ahead|go for it|approved?|permission granted|you have my (approval|permission)|yes,?\s*(do it|go|please|start)?|do it|proceed|start( it)?|make it so)\b/i.test(ut)) {
    const p = _pendingSelfDrive; _pendingSelfDrive = null;
    let msg;
    try {
      const r = startSelfDriveSession({ ...p, approved: true });
      msg = (r && (r.started || r.ran)) && !r.skipped
        ? `🚀 Approved — running a self-improvement session${p.focus ? ` (focus: ${p.focus})` : ''} on an isolated local branch. I'll work through what's actionable, verify-gate each change, and report anything I refuse as self-degrading. Say "stop improving yourself" to halt.`
        : ('Couldn\'t start: ' + ((r && (r.skipped || r.error)) || 'unknown') + '.');
    } catch (e) { msg = 'Self-drive start failed: ' + (e && e.message || e); }
    return { text: msg, history: [...history, { role: 'assistant', content: msg }] };
  }
  // Deterministic self-improvement trigger — "begin/start/run self-improvement" (or "improve
  // yourself") reliably invokes the self_drive tool instead of depending on the model to decide.
  // Routes THROUGH executeTool's step-up gate (the confirm card), so the human approval is still
  // required — this never bypasses the guardrail. Short + non-question guard avoids false hits on
  // conversation *about* self-improvement.
  // Anchored to the start of the message so mid-sentence mentions don't fire. Captures an optional
  // focus after "on"/"about"/"focused on"/":" — a focus is what makes reflection productive (with
  // none, the desire engine often finds nothing concrete on a freshly-booted, telemetry-thin app,
  // and the session halts with "no_actionable_desires").
  const sdMatch = !/\?/.test(ut) && (
    ut.match(/^\s*(?:begin|start|run|kick ?off)\b.*?\bself[\s-]?(?:improve(?:ment)?|driv\w*)\b\s*(?:(?:focus(?:ed)?\s+on|focusing on|on|about|:)\s+(.{3,200}))?$/i)
    || ut.match(/^\s*improve yourself\b\s*(?:(?:focus(?:ed)?\s+on|focusing on|on|about|:)\s+(.{3,200}))?$/i));
  if (sdMatch) {
    const focus = (sdMatch[1] || '').trim();
    try {
      const r = await executeTool('self_drive', { action: 'start', reason: 'manual', focus });
      const msg = (r && r.success)
        ? `🚀 Starting a self-improvement session${focus ? ` focused on: ${focus}` : ''} on an isolated local branch (never pushed, verify-gated). Approve the card to proceed — say "stop improving yourself" to halt.${focus ? '' : ' (Tip: add a focus — "begin self-improvement on <area>" — so it has something concrete to work on.)'}`
        : ('Could not start self-drive: ' + ((r && (r.error || r.note)) || 'unknown') + (isRemote() ? ' (self-drive must be started from the desktop app — it requires an in-person approval).' : ''));
      return { text: msg, history: [...history, { role: 'assistant', content: msg }] };
    } catch (e) { const m = 'Self-drive start failed: ' + (e && e.message || e); return { text: m, history: [...history, { role: 'assistant', content: m }] }; }
  }
  // OPUS PERMISSION GATE: heavy tasks (scientific sims / deep builds) can run on Opus, but per
  // Siddhant's rule BhatBot ASKS before switching. Flow: detect heavy → park the turn + ask → on "use
  // opus"/"yes" run it on Opus (and remember the OK for the session); on "stay on sonnet"/"no" run it
  // on Sonnet. Opus stays ENABLED — this only governs the switch. (He'll refine the UX later.)
  {
    const cfgOpus = loadConfig();
    if (_pendingOpusTask) {
      const yes = /^\s*(use (opus|fable)|opus\b|fable\b|heavy tier|yes|yeah|yep|sure|ok(ay)?|go ahead|go for it|do it|proceed|approved?|permission granted)\b/i.test(ut) && !/\?/.test(ut);
      const no = /^\s*(no|nope|stay on sonnet|sonnet|keep sonnet|don'?t|cheaper|not now)\b/i.test(ut);
      if (yes) { const p = _pendingOpusTask; _pendingOpusTask = null; _opusApproved = true; history = p.history; }        // re-run on Opus
      else if (no) { const p = _pendingOpusTask; _pendingOpusTask = null; _opusSuppressAsk = true; history = p.history; } // re-run on Sonnet
      else { _pendingOpusTask = null; }   // unrelated message → drop the ask, handle it normally
    }
    if (!_opusApproved && !_opusSuppressAsk && cfgOpus.opusRequiresApproval !== false && cfgOpus.allowOpusHeavy !== false
        && !overBudget() && looksLikeToolTask(ut) && looksHeavyTool(ut)) {
      _pendingOpusTask = { history, at: Date.now() };
      const hm = heavyModel(ut);
      const hmName = hm === MODEL_FABLE ? 'Fable 5' : hm === MODEL_OPUS ? 'Opus' : 'the heavy tier';
      const why = hm === MODEL_FABLE
        ? 'my most capable tier, with the output headroom to fan this out across a research → design → code → test fleet in parallel'
        : 'my deepest reasoning model, best for a single hard derivation/solve';
      const q = `This one's heavy — a scientific simulation / deep build. I can run it on **${hmName}** (${why}), which is more capable but costs more, or keep it on Sonnet. Want me on ${hmName}? Say "use ${hm === MODEL_FABLE ? 'fable' : 'opus'}" (or just "yes") or "stay on sonnet".`;
      return { text: q, history: [...history, { role: 'assistant', content: q }] };
    }
    _opusSuppressAsk = false;   // one-shot: only suppresses the immediate re-run
  }
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
    // T5/T6 — capture this turn's reply for the spoken-length row; word count keeps accruing via
    // recordSpoken as the (possibly streamed) audio plays, and is finalized on the NEXT user turn.
    if (res && res.text) { _spk.replyText = res.text; _spk.userPrompt = _currentUserPrompt; _spk.at = Date.now(); }
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
// Routines panel (procedural memory inspection/curation): list the learned skill bank; pin/unpin so a
// skill never fades, or prune one that's wrong. Read/curate only — never runs a routine.
ipcMain.handle('list-routines', () => { try { return procedural.list(PROCEDURAL_PATH, { limit: 200 }); } catch { return []; } });
ipcMain.handle('routine-action', (_e, { id, action, value } = {}) => {
  try {
    if (action === 'delete') return { ok: procedural.remove(PROCEDURAL_PATH, id) };
    if (action === 'pin') return { ok: procedural.setPinned(PROCEDURAL_PATH, id, value !== false) };
    if (action === 'rename') return { ok: procedural.rename(PROCEDURAL_PATH, id, value) };
    return { ok: false, error: 'unknown action' };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
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
ipcMain.on('agent-guidance', (_e, { text }) => {
  const clean = sanitizeSteering(text);
  if (!clean) { if (text && text.trim()) sendToActivity('tool-update', { type: 'thinking', text: '🚫 ignored a low-confidence voice fragment' }); return; }
  if (pendingGuidance[pendingGuidance.length - 1] === clean) return;   // dedup consecutive repeats
  pendingGuidance.push(clean);
  // Total-queue cap: a burst of steering can't balloon a single tool-result turn — drop oldest
  // until the queued text fits MAX_GUIDANCE_CHARS.
  while (pendingGuidance.length > 1 && pendingGuidance.join(' | ').length > MAX_GUIDANCE_CHARS) pendingGuidance.shift();
});
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
// Task 5 — cache keep-alive (config.cacheKeepAlive, default ON as of the latency pass). The ephemeral prompt
// cache TTL is ~5min; for a bursty ambient assistant an idle gap >5min re-bills the full static
// prompt + tool schemas on the next turn. When on, refresh the Sonnet cache with a 1-token no-op
// every ~4min — but ONLY within KEEPALIVE_ACTIVE_MS of a real turn, so a genuinely idle machine is
// never billed for keep-alives it won't benefit from. The system block matches real turns' cached
// prefix (static block + breakpoint; the mode block rides after it and doesn't affect the prefix).
// Best-effort: any error is swallowed. Refreshes the FULL-catalog prefix (helps no-embedding-key /
// out-of-loop turns most; toolselect-subset turns vary their own prefix and benefit less).
const KEEPALIVE_ACTIVE_MS = 30 * 60 * 1000;
function startCacheKeepAlive() {
  const t = setInterval(async () => {
    try {
      if (loadConfig().cacheKeepAlive === false) return;   // default ON — keep the static prefix hot for fast first token
      if (Date.now() - _lastActivityTs > KEEPALIVE_ACTIVE_MS) return;   // idle → let the cache lapse
      const key = getApiKey(); if (!key) return;
      await anthropicRequest({ model: MODEL_SONNET, max_tokens: 1,
        system: [{ type: 'text', text: buildStaticPrompt(), cache_control: { type: 'ephemeral' } }],
        tools: TOOLS, messages: [{ role: 'user', content: 'ping' }] }, key, { retries: 0 });
    } catch { /* keep-alive is best-effort */ }
  }, 4 * 60 * 1000);
  if (t.unref) t.unref();
}

app.whenReady().then(() => {
  try {
    migrateSecretsToVault();   // Phase 4 #1 — vault any plaintext secrets BEFORE anything (cloud bridge, MCP) reads them
    reconcileVaultRefs();      // self-heal: re-point config.json at vaulted secrets if it lost them
    syncResolvedSecretsToEnv();// bridge vaulted secrets → process.env so pure libs (semantic embeddings) get the REAL key, not the CRED_REF handle (a vaulted openaiKey had silently 401'd all recall)
    createWindow();
    mainWindow.show();
    if (!globalShortcut.register(HOTKEY, toggleWindow)) console.warn('Hotkey failed — may be claimed by another app.');
    // ⌘⇧L — toggle VOICE LOCK (continuous listening, no wake word) from anywhere. Global so it works
    // while another app is focused; it only drives the local mic loop, never blocks Telegram/phone/MCP.
    try { globalShortcut.register('CommandOrControl+Shift+L', () => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-voice-lock'); } catch {} }); } catch {}
    // ⌘⇧V — pop the LIVE ACTION VIEW ("watch me work": current action + rolling log + live screenshots).
    try { globalShortcut.register('CommandOrControl+Shift+V', () => { try { openActionView(); } catch {} }); } catch {}
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
    startMemoryMaintenance();   // always-on memory upkeep (runs on a timer, independent of the window)
    startSynapseWorker();       // SYNAPSE second brain — free re-import loop + slow budget-capped paid pass
    startMcpHub();              // connect external MCP-server plugins (config.mcpPlugins) → tools for the agent
    startPresenceFeed();        // stream live fleet state to the 3D presence window while it's open
    startCacheKeepAlive();   // Task 5 — prompt-cache warm-keeper (default on; keeps first token fast after idle gaps)
    setTimeout(() => { maybeRenderAcks().catch(() => {}); }, 6000);   // pre-render ack clips in the background (instant first audio)
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
    // Phase 6 self-drive is ON-DEMAND — intentionally NOT auto-started here. It runs only when Siddhant
    // asks, when he asks what BhatBot would improve, or on a capability gap. (config.selfDrive.autostart
    // is honored if he ever flips it, but defaults false — BhatBot does not constantly self-update.)
    if (selfdrive.cfgFrom(loadConfig).autostart === true) { setTimeout(() => startSelfDriveSession({ reason: 'autostart' }), 120 * 1000); console.log('[self-drive] autostart enabled — one session 2m after boot'); }
    else console.log('[self-drive] ready (on-demand: "improve yourself" / reflection / capability-gap)');
    startPatrol();      // Feat-2: ambient health watch → relay via Telegram, call if urgent
    startHealthMonitor(); // Health: proactive Garmin biometrics monitor (default on; no-op until garmin-setup.sh is run)
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
