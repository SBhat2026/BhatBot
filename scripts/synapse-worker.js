#!/usr/bin/env node
'use strict';
// ── THE HEADLESS SECOND BRAIN ─────────────────────────────────────────────────────────────────────
// A plain node process that keeps SYNAPSE (and memory upkeep, and schedules) alive whether or not the
// Electron window is open.
//
// WHY THIS EXISTS. BhatBot's "always-on" subsystems were all running inside the Electron main
// process, so "always-on" actually meant "on while a window happens to be open". The proof was
// unambiguous: `~/.bhatbot/brain/` did not exist at all. The SYNAPSE worker shipped weeks earlier had
// never produced a single node, because the app had not been launched in over two weeks — and
// `scripts/install-daemon.js` "daemon" is itself just the GUI app, so it could not have helped.
//
// THE HARD RULE: no `electron` anywhere in this file's require graph. Everything it touches
// (lib/synapse, lib/brain, lib/semantic, lib/projects, lib/notion, lib/memmaint, lib/scheduler,
// lib/llm, lib/runtime-state, lib/pidlock) is already Electron-free, and test-synapse-worker.js
// asserts it stays that way. The moment electron creeps in, this stops booting under launchd and the
// second brain silently dies again.
//
// CREDENTIALS. config.json holds CRED_REF_* vault handles that only Electron's safeStorage can
// decrypt, so this process usually cannot get an API key. That is FINE and deliberate: the free
// hydrate pass — projects, memories, repos, Notion — needs no key and is the bulk of the value. The
// paid pass (embeddings + rationales) degrades gracefully and says so. See lib/llm.js resolveKey for
// the env → Keychain → plain-config ladder.
//
//   node scripts/synapse-worker.js            # run forever (what the LaunchAgent does)
//   node scripts/synapse-worker.js --once     # a single cycle, then exit (CI + manual checks)
//   node scripts/synapse-worker.js --once --force   # ignore idle/due gating, force the paid pass
//   node scripts/synapse-worker.js --status   # what the last cycle did, without running one

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const semantic = require(path.join(ROOT, 'lib', 'semantic'));
const projects = require(path.join(ROOT, 'lib', 'projects'));
const memmaint = require(path.join(ROOT, 'lib', 'memmaint'));
const scheduler = require(path.join(ROOT, 'lib', 'scheduler'));
const rstate = require(path.join(ROOT, 'lib', 'runtime-state'));
const pidlock = require(path.join(ROOT, 'lib', 'pidlock'));
const llm = require(path.join(ROOT, 'lib', 'llm'));
const miniagent = require(path.join(ROOT, 'lib', 'miniagent'));
const { createSynapse } = require(path.join(ROOT, 'lib', 'synapse'));

const LOCK = 'synapse-worker';
const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const ARGV = process.argv.slice(2);
const ONCE = ARGV.includes('--once');
const FORCE = ARGV.includes('--force');
const STATUS = ARGV.includes('--status');

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`${ts()} ${m}`);

function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }

// Notion is optional and its module may not be loadable/configured — never let it stop the worker.
function notionPagesFn() {
  try {
    const notion = require(path.join(ROOT, 'lib', 'notion'));
    if (typeof notion.listPages !== 'function') return null;
    return (o) => notion.listPages(o);
  } catch { return null; }
}

// The paid pass needs a key this process can actually reach. Resolve ONCE at construction and report
// clearly, because "the brain is quietly not doing the expensive half" is exactly the kind of silent
// degradation that let the original worker go unnoticed for weeks.
function buildLlm() {
  const key = llm.resolveKey('anthropic');
  if (!key) return null;
  return async ({ system, content, maxTokens }) => llm.ask(content, { system, maxTokens, apiKey: key, log });
}

function build() {
  const anthropicKey = llm.resolveKey('anthropic');
  const openaiKey = llm.resolveKey('openai');
  // semantic.js reads OPENAI_API_KEY from env (it cannot read the vault either) — bridge it in.
  if (openaiKey && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = openaiKey;

  const synapse = createSynapse({
    deps: {
      embedBatch: openaiKey ? ((texts) => semantic.embedBatch(texts)) : null,
      llm: buildLlm(),
      listProjects: () => projects.list(),
      getProject: (slug) => projects.get(slug),
      notionPages: notionPagesFn(),
      semanticStorePath: semantic.STORE_PATH,
      loadConfig,
      log,
      isIdle: () => true,          // a headless worker has no foreground turn to yield to
    },
  });
  return { synapse, anthropicKey: !!anthropicKey, openaiKey: !!openaiKey };
}

async function runCycle(synapse, { force = false } = {}) {
  const t0 = Date.now();
  try {
    const out = await synapse.tick({ force });
    const st = synapse.stats();
    const b = synapse.budget();
    await pushCloudReplica(synapse);
    log(`cycle done in ${Math.round((Date.now() - t0) / 1000)}s — ${st.nodes} nodes / ${st.edges} edges · $${b.spent.toFixed(3)} of $${b.limit.toFixed(2)}${out.paidSkipped ? ` · paid pass skipped (${out.paidSkipped})` : ''}`);
    rstate.event('synapse-tick', { nodes: st.nodes, edges: st.edges, spendUsd: +b.spent.toFixed(4), ms: Date.now() - t0, paidSkipped: out.paidSkipped || null });
    return out;
  } catch (e) {
    log('✗ cycle failed: ' + e.message);
    rstate.event('error', { kind: 'synapse-worker', message: String(e.message).slice(0, 300) });
    return { error: e.message };
  }
}

// Schedules were in the same boat as SYNAPSE: persisted to disk, but only ever fired by a timer
// inside the GUI, so a daily job simply did not happen on a day nobody opened the window. Now the
// worker RUNS them, through lib/miniagent.js — a read-only tool-loop (search / fetch / read).
//
// A task that needs something this process cannot do (Mail.app, sending anything, the shell, the
// vault) calls defer_to_app, and we deliberately do NOT markRan — the schedule stays due so the full
// agent runs it properly on next launch. Producing a half-answer that quietly omits the part it
// couldn't reach would be worse than waiting, so deferral is a first-class outcome, not a failure.
const RESULTS_DIR = path.join(os.homedir(), '.bhatbot', 'schedule-results');

function writeResult(s, payload) {
  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const f = path.join(RESULTS_DIR, `${s.id}-${Date.now()}.json`);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ id: s.id, title: s.title, at: new Date().toISOString(), unread: true, ...payload }, null, 2));
    fs.renameSync(tmp, f);
    return f;
  } catch (e) { log('could not write schedule result: ' + e.message); return null; }
}

// Telegram is how an unattended result actually reaches him. The bot token is vaulted like everything
// else, so this only works if a copy is in the login Keychain — optional, and silent when absent.
async function telegramPush(text) {
  const token = llm.keychainRead('bhatbot-telegram');
  const chat = llm.keychainRead('bhatbot-telegram-chat');
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 3500) }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch { return false; }
}


// ── CLOUD READ REPLICA (opt-in) ───────────────────────────────────────────────────────────────────
// The workers stay local — hydrating needs the repos, the semantic store and ~/.bhatbot/projects, and
// shipping those to a hosted box would be a real exfiltration surface for a $1/month graph. What CAN
// travel is a pruned VIEW: labels, edges and rationales, with embeddings and file bodies stripped, so
// the phone can read the brain when the Mac is off.
//
// OFF unless config.synapseCloudReplica === true AND a token is reachable. The cloud token is vaulted
// like everything else, so it needs a Keychain copy under `bhatbot-cloud`.
async function pushCloudReplica(synapse) {
  const cfg = loadConfig();
  if (cfg.synapseCloudReplica !== true) return;
  const url = String(cfg.cloudUrl || '').replace(/\/+$/, '');
  const token = llm.keychainRead('bhatbot-cloud');
  if (!url || !token) { log('[replica] enabled but no cloudUrl / no `bhatbot-cloud` Keychain token — skipping'); return; }
  try {
    const g = synapse.graphView();
    const body = JSON.stringify({
      nodes: (g.nodes || []).map(({ embedding, ...n }) => n),   // strip vectors before they ever leave
      edges: g.edges || [], stats: g.stats || null, meta: { suggestions: (g.meta || {}).suggestions || [] },
    });
    const r = await fetch(`${url}/api/${token}/brain`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body, signal: AbortSignal.timeout(30000),
    });
    if (r.ok) { const j = await r.json().catch(() => ({})); log(`[replica] pushed ${j.nodes || '?'} nodes / ${j.edges || '?'} edges to the cloud`); }
    else log(`[replica] push failed: HTTP ${r.status}`);
  } catch (e) { log('[replica] push failed: ' + e.message); }
}

let _schedulesRunning = false;
async function runDueSchedules() {
  if (_schedulesRunning) return;
  let due = [];
  try { due = scheduler.due(Date.now()); } catch { return; }
  if (!due.length) return;

  if (!llm.hasKey('anthropic')) {
    log(`⏰ ${due.length} schedule(s) due but no Anthropic key is reachable — leaving them for the app: ` + due.map((s) => s.title).join(', '));
    return;
  }

  _schedulesRunning = true;
  try {
    for (const s of due) {
      log(`⏰ running "${s.title}"`);
      const t0 = Date.now();
      const prompt = `[Scheduled task "${s.title}"] ${s.prompt}\n\nThis is an unattended background run — nobody is watching. Do the task, then reply with a short, concrete summary.`;
      let r;
      try { r = await miniagent.run(prompt, { config: loadConfig(), log }); }
      catch (e) { r = { error: String(e.message) }; }

      if (r.deferred) {
        // Leave it DUE on purpose. markRan here would silently swallow the occurrence.
        log(`⏰ "${s.title}" deferred — needs ${r.needs}; leaving it due for the desktop app`);
        writeResult(s, { status: 'deferred', needs: r.needs, partial: r.partial || null });
        continue;
      }
      if (r.error || !r.text) {
        log(`⏰ "${s.title}" failed: ${r.error || 'no output'} — leaving it due to retry`);
        writeResult(s, { status: 'failed', error: r.error || 'no output' });
        continue;
      }

      const file = writeResult(s, { status: 'ok', text: r.text, steps: r.steps, toolsUsed: r.toolsUsed, ms: Date.now() - t0, truncated: !!r.truncated });
      scheduler.markRan(s.id, Date.now());   // only on genuine success
      rstate.event('schedule-run', { id: s.id, title: s.title, ms: Date.now() - t0, steps: r.steps, host: 'worker' });
      log(`⏰ "${s.title}" done in ${Math.round((Date.now() - t0) / 1000)}s (${r.steps} steps)`);
      if (s.notify !== false) { if (await telegramPush(`⏰ ${s.title}\n\n${r.text}`)) log('   → pushed to Telegram'); }
      if (file) log('   → ' + file);
    }
  } finally { _schedulesRunning = false; }
}

function printStatus() {
  const holder = pidlock.read(LOCK);
  console.log('worker:      ' + (pidlock.alive(LOCK) ? `running (pid ${holder.pid}, up ${Math.round((Date.now() - holder.startedAt) / 60000)}m)` : 'not running'));
  const graph = path.join(os.homedir(), '.bhatbot', 'brain', 'graph.json');
  try {
    const g = JSON.parse(fs.readFileSync(graph, 'utf8'));
    const age = Math.round((Date.now() - fs.statSync(graph).mtimeMs) / 60000);
    console.log(`graph:       ${Object.keys(g.nodes || {}).length} nodes, ${Object.keys(g.edges || {}).length} edges, updated ${age}m ago`);
    console.log(`spend:       $${Number((g.meta || {}).spendUsd || 0).toFixed(4)}`);
  } catch { console.log('graph:       MISSING — the worker has never completed a cycle'); }
  console.log('anthropic:   ' + (llm.hasKey('anthropic') ? 'resolvable' : 'NOT resolvable (paid pass will be skipped)'));
  console.log('openai:      ' + (llm.hasKey('openai') ? 'resolvable' : 'NOT resolvable (embeddings will be skipped)'));
}

(async () => {
  if (STATUS) return printStatus();

  const lock = pidlock.acquire(LOCK);
  if (!lock.ok) {
    log(`another worker already holds the lock (pid ${lock.heldBy && lock.heldBy.pid}) — exiting`);
    process.exit(0);
  }

  const { synapse, anthropicKey, openaiKey } = build();
  const c = synapse.workerConfig();
  log(`synapse worker up (pid ${process.pid}) — hydrate every ${c.hydrateMin}min, paid pass every ${c.connectHours}h, cap $${synapse.budget().limit.toFixed(2)}`);
  if (!anthropicKey || !openaiKey) {
    log(`⚠ paid pass degraded — ${!anthropicKey ? 'no Anthropic key' : ''}${!anthropicKey && !openaiKey ? ' and ' : ''}${!openaiKey ? 'no OpenAI key' : ''} reachable from a headless process.`);
    log('  The FREE pass (projects + memories + repos + Notion) still runs and is most of the value.');
    log('  To enable the paid pass, put the keys in the login Keychain:');
    log('    security add-generic-password -s bhatbot-anthropic -a bhatbot -w "sk-ant-…"');
    log('    security add-generic-password -s bhatbot-openai    -a bhatbot -w "sk-…"');
  }

  if (ONCE) {
    await runCycle(synapse, { force: FORCE });
    await runDueSchedules();
    pidlock.release(LOCK);
    return;
  }

  // Memory upkeep was GUI-bound too — decay/dedup of the semantic store + bounding runaway logs.
  try {
    const mc = loadConfig().memoryMaintenance || {};
    if (mc.enabled !== false) {
      memmaint.start({
        intervalMs: Math.max(5, mc.intervalMinutes || 30) * 60 * 1000,
        deps: {
          maxLogLines: mc.maxLogLines || 20000,
          trimLogs: [path.join(os.homedir(), '.bhatbot', 'router.jsonl'), path.join(os.homedir(), '.bhatbot', 'logs', 'app.log')],
          semanticMaintain: () => { try { return semantic.maintain({ maxEpisodicAgeDays: mc.maxEpisodicAgeDays || 45 }); } catch (e) { return { error: e.message }; } },
          // Every deploy_drones call mints a run dir and nothing ever removed them.
          pruneDirs: [{ dir: path.join(os.homedir(), '.bhatbot', 'drones'), prefix: 'run-', maxAgeDays: mc.maxRunDirAgeDays || 14 }],
          onReport: (r) => {
            const s = r.semantic || {};
            if (s.decayed || s.merged) log(`memmaint: semantic ${s.before}→${s.after} (decayed ${s.decayed}, merged ${s.merged})`);
            const dropped = (r.dirs || []).reduce((n, d) => n + ((d.removed || []).length), 0);
            if (dropped) log(`memmaint: removed ${dropped} aged-out run director${dropped === 1 ? 'y' : 'ies'}`);
          },
        },
      });
      log(`memmaint started (every ${Math.max(5, mc.intervalMinutes || 30)}min)`);
    }
  } catch (e) { log('memmaint failed to start: ' + e.message); }

  await runCycle(synapse);
  await runDueSchedules();
  setInterval(() => { runCycle(synapse).then(runDueSchedules); }, c.hydrateMin * 60 * 1000);

  // Nothing else holds the loop open — the interval does. Keep the process from exiting silently.
  process.stdin.resume();
})().catch((e) => {
  log('✗ fatal: ' + (e && e.stack || e));
  try { pidlock.release(LOCK); } catch {}
  process.exit(1);
});
