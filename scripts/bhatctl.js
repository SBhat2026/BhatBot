#!/usr/bin/env node
'use strict';
// bhatctl — terminal interface to the RUNNING BhatBot desktop app.
// Sends a real user prompt through the same agent loop the phone/desktop use, streams the
// live tool/thinking/error trace, and prints the final reply. Lets tests be realistic
// (end-to-end through the actual agent) and lets us watch logs/errors from the terminal
// instead of hitting them blind in the UI.
//
//   node scripts/bhatctl.js "who's winning the world cup?"     # send a prompt (default cmd)
//   node scripts/bhatctl.js -r "new convo, reset history"      # --reset / -r: fresh conversation
//   node scripts/bhatctl.js -q "..."                           # --quiet: reply only, no trace
//   node scripts/bhatctl.js logs [-f]                          # show / follow ~/.bhatbot/logs/app.log
//   node scripts/bhatctl.js health                             # ping the app's HTTP server
//   node scripts/bhatctl.js wc [report|odds|live|...]          # quick World Cup probe (via the agent)
//
// npm: `npm run ctl -- "<prompt>"`. Reads mcpPort/mcpToken from ~/.bhatbot/config.json.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const LOG_PATH = path.join(os.homedir(), '.bhatbot', 'logs', 'app.log');

function cfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}
// Phase 4 vaulted mcpToken → config.json now holds a CRED_REF_* handle, not the literal token,
// and safeStorage only decrypts INSIDE the running Electron app (not this plain-node CLI). So if
// the configured token is a handle, fall back to the BHATBOT_MCP_TOKEN env var (the real token is
// printed in the app's startup log: `[mcp] listening on …/mcp/<token>`). No new plaintext on disk.
function resolveToken(c) {
  const env = (process.env.BHATBOT_MCP_TOKEN || '').trim();
  if (env) return env;
  const t = c.mcpToken;
  if (t && !/^CRED_REF/i.test(String(t))) return t;
  if (t && /^CRED_REF/i.test(String(t))) {
    console.error('✗ mcpToken is vaulted (CRED_REF handle) — this CLI can\'t decrypt it (safeStorage is Electron-only).');
    console.error('  Fix: copy the token from the app log line `[mcp] listening on …/mcp/<TOKEN>` and run:');
    console.error('       export BHATBOT_MCP_TOKEN=<TOKEN>    (or: npm run logs | grep "mcp] listening")');
    process.exit(2);
  }
  console.error('✗ no mcpToken in ~/.bhatbot/config.json — is the app set up?');
  process.exit(2);
}
function base() {
  const c = cfg();
  const port = c.mcpPort || 8788;
  const token = resolveToken(c);
  return { url: `http://127.0.0.1:${port}`, token };
}
const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

async function ping(url, token) {
  try {
    const r = await fetch(`${url}/health`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

async function activitySince(url, token, since) {
  try {
    const r = await fetch(`${url}/api/${token}/activity?since=${since}`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function printEvent(e) {
  const ts = C.dim(new Date(e.t).toLocaleTimeString());
  const kind = e.kind || 'event';
  const isErr = /error|fail|✗|⚠/i.test(e.text) || kind === 'error';
  const color = isErr ? C.red : (kind === 'tool_start' || kind === 'tool_done' ? C.cyan : C.dim);
  const tag = kind === 'tool_start' ? '→' : kind === 'tool_done' ? '✓' : kind === 'thinking' ? '·' : '•';
  console.log(`  ${ts} ${color(tag)} ${color(e.text)}`);
}

async function send(args) {
  const reset = args.includes('-r') || args.includes('--reset');
  const quiet = args.includes('-q') || args.includes('--quiet');
  const prompt = args.filter((a) => !a.startsWith('-')).join(' ').trim();
  if (!prompt) { console.error('✗ usage: bhatctl "your prompt"'); process.exit(2); }
  const { url, token } = base();
  if (!(await ping(url, token))) { console.error(C.red('✗ app not reachable at ' + url + ' — start BhatBot (npm start) first.')); process.exit(1); }

  console.log(C.bold('› ') + prompt + (reset ? C.dim('  [reset]') : ''));
  // Seed the activity cursor at the current tail so we only print THIS turn's events.
  let cursor = 0;
  const seed = await activitySince(url, token, 0);
  if (seed && typeof seed.seq === 'number') cursor = seed.seq;

  let done = false;
  let poll = null;
  if (!quiet) {
    poll = (async () => {
      while (!done) {
        const a = await activitySince(url, token, cursor);
        if (a && a.events && a.events.length) {
          for (const e of a.events) { printEvent(e); cursor = Math.max(cursor, e.id); }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
  }

  const t0 = Date.now();
  let res;
  try {
    const r = await fetch(`${url}/api/${token}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ text: prompt, new_conversation: reset }),
      signal: AbortSignal.timeout(600000),
    });
    res = await r.json().catch(() => ({ error: 'non-JSON response ' + r.status }));
  } catch (e) {
    done = true; if (poll) await poll;
    console.error(C.red('✗ request failed: ' + (e.message || e)));
    process.exit(1);
  }
  done = true; if (poll) await poll;

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  if (res.error) console.log(C.red('✗ ' + res.error));
  else console.log(C.green('BHATBOT ') + (res.text || res.reply || '(no text)'));
  console.log(C.dim(`  (${dt}s)`));
}

async function health() {
  const { url, token } = base();
  const ok = await ping(url, token);
  console.log(ok ? C.green('✓ app up at ' + url) : C.red('✗ app not reachable at ' + url));
  if (!ok) process.exit(1);
  const a = await activitySince(url, token, 0);
  if (a) console.log(C.dim(`  activity buffer: ${a.events ? a.events.length : 0} events (seq ${a.seq})`));
}

function logs(args) {
  const follow = args.includes('-f') || args.includes('--follow');
  if (!fs.existsSync(LOG_PATH)) { console.error(C.red('✗ no log yet at ' + LOG_PATH + ' — start the app (it tees console there).')); process.exit(1); }
  const tailBytes = 16 * 1024;
  let size = fs.statSync(LOG_PATH).size;
  const start = Math.max(0, size - tailBytes);
  process.stdout.write(fs.readFileSync(LOG_PATH, 'utf8').slice(start));
  if (!follow) return;
  let pos = size;
  fs.watchFile(LOG_PATH, { interval: 300 }, (cur) => {
    if (cur.size < pos) pos = 0;                 // truncated/rotated
    if (cur.size > pos) {
      const fd = fs.openSync(LOG_PATH, 'r');
      const buf = Buffer.alloc(cur.size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      process.stdout.write(buf.toString('utf8'));
      pos = cur.size;
    }
  });
}

// ── missions ─────────────────────────────────────────────────────────────────────────────────────
// Reads ~/.bhatbot/missions straight off disk — no IPC, so it works with the app CLOSED. That matters:
// the times you most want to know what's parked are exactly the times nothing is running.
function missionStore() { return require('../lib/mission').createMissions({}); }
const AGE = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
};
const STATUS_COLOR = { running: C.cyan, parked: C.yellow, done: C.green, failed: C.red, abandoned: C.dim };

function missions(args) {
  const M = missionStore();
  const sub = args[0] || 'list';

  if (sub === 'list') {
    const all = M.list();
    if (!all.length) return console.log(C.dim('(no missions — ~/.bhatbot/missions is empty)'));
    for (const m of all) {
      const col = STATUS_COLOR[m.status] || C.dim;
      const bits = [`${m.stepsUsed || 0} steps`, `$${(m.spendUsd || 0).toFixed(2)}`];
      if (m.resumeCount) bits.push(`${m.resumeCount} resume${m.resumeCount > 1 ? 's' : ''}`);
      console.log(`${col(m.status.padEnd(9))} ${C.bold(m.id)} ${C.dim(AGE(Date.now() - (m.updatedAt || 0)) + ' ago')}  ${C.dim(bits.join(' · '))}`);
      console.log(`  ${String(m.goal || '').replace(/\s+/g, ' ').slice(0, 150)}`);
      if (m.status === 'parked' && m.lastError) console.log(`  ${C.yellow('parked:')} ${C.dim(m.lastError.slice(0, 140))}`);
    }
    const parked = all.filter((m) => m.status === 'parked').length;
    if (parked) console.log(C.dim(`\n${parked} parked — the app resumes these automatically on its 30s tick (needs BhatBot running).`));
    return;
  }

  const id = args[1];
  if (!id) { console.error('✗ usage: bhatctl missions <show|resume|abandon> <id>'); process.exit(2); }
  const m = M.attach(id);
  if (!m) { console.error(C.red('✗ no mission ' + id)); process.exit(1); }

  if (sub === 'show') {
    const meta = m.meta;
    console.log(C.bold('GOAL  ') + meta.goal);
    console.log(C.bold('STATE ') + (STATUS_COLOR[meta.status] || C.dim)(meta.status)
      + C.dim(`  ${meta.stepsUsed || 0} steps · $${(meta.spendUsd || 0).toFixed(2)} of $${meta.budgetUsd ?? '—'} · ${meta.resumeCount || 0} resumes · ${AGE(Date.now() - meta.createdAt)} old`));
    if (meta.lastError) console.log(C.bold('WHY   ') + C.yellow(meta.lastError));
    if (meta.traceId) console.log(C.bold('TRACE ') + C.dim(meta.traceId));
    const plan = m.plan.read();
    if (plan.length) {
      console.log(C.bold('\nPLAN'));
      for (const p of plan) console.log(`  [${{ todo: ' ', doing: '~', done: 'x', blocked: '!' }[p.status]}] ${p.status === 'done' ? C.dim(p.text) : p.text}${p.note ? C.dim('  — ' + p.note) : ''}`);
    }
    const j = m.journal();
    if (j.length) {
      console.log(C.bold(`\nJOURNAL (last 15 of ${j.length})`));
      for (const r of j.slice(-15)) {
        console.log(`  ${C.dim(String(r.seq).padStart(3))} ${(r.status === 'error' ? C.red : C.cyan)(r.name.padEnd(16))} ${C.dim((r.ms || 0) + 'ms')}  ${String(r.head || '').replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    console.log(C.dim('\ndir: ' + m.dir));
    return;
  }

  if (sub === 'resume') {
    // Flip it to parked + clear the backoff so the running app's next tick adopts it. We deliberately
    // don't run the agent here — this CLI has no Electron, no vault, and no tools.
    m.park('manual resume requested via bhatctl');
    console.log(`✓ ${id} queued — the running app will pick it up on its next tick (within ~30s).`);
    console.log(C.dim('  (If BhatBot is not running, start it — missions only resume inside the app.)'));
    return;
  }
  if (sub === 'abandon') { m.abandon('abandoned via bhatctl'); return console.log(`✓ ${id} abandoned.`); }
  console.error('✗ unknown: bhatctl missions ' + sub);
  process.exit(2);
}

// ── doctor ───────────────────────────────────────────────────────────────────────────────────────
// One command that answers "is any of this actually running?" — the question that went unasked while
// two LaunchAgents sat dead for weeks and the second brain never wrote a single node.
async function doctor() {
  const { execSync } = require('child_process');
  const HOME = os.homedir();
  const line = (label, good, detail) => console.log(`${good === null ? C.yellow('⚠') : good ? C.green('✅') : C.red('❌')} ${label.padEnd(22)} ${C.dim(detail)}`);

  console.log(C.bold('\nLAUNCH AGENTS'));
  let agents = '';
  try { agents = execSync('launchctl list', { encoding: 'utf8' }); } catch {}
  const rows = agents.split('\n').filter((l) => /bhatbot|siddhant\.bhat/i.test(l));
  if (!rows.length) line('bhatbot agents', null, 'none loaded — nothing runs unless the app is open');
  for (const r of rows) {
    const [pid, status, label] = r.trim().split(/\s+/);
    line(label, status === '0', `pid=${pid} last-exit=${status}${status !== '0' ? '  ← FAILING' : ''}`);
  }

  console.log(C.bold('\nSTATE'));
  // Both the GUI and the headless worker write state.json, so a stale file means BOTH are down —
  // which is the thing actually worth flagging, not "the window is closed".
  const statePath = path.join(HOME, '.bhatbot', 'state.json');
  const workerUp = (() => { try { return require('../lib/pidlock').alive('synapse-worker'); } catch { return false; } })();
  try {
    const st = fs.statSync(statePath);
    const age = Date.now() - st.mtimeMs;
    const fresh = age < 60 * 60 * 1000;
    line('state.json', fresh || workerUp, `updated ${AGE(age)} ago` + (!fresh && !workerUp ? '  ← nothing has run in a while' : ''));
  } catch { line('state.json', false, 'missing — nothing has ever run far enough to write it'); }
  line('synapse worker', workerUp, workerUp ? 'headless worker holds the lock (survives the window closing)' : 'not running — `npm run worker:install` to make the brain always-on');

  console.log(C.bold('\nSECOND BRAIN'));
  const graphPath = path.join(HOME, '.bhatbot', 'brain', 'graph.json');
  try {
    const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    const age = Date.now() - fs.statSync(graphPath).mtimeMs;
    const n = Object.keys(g.nodes || {}).length, e = Object.keys(g.edges || {}).length;
    line('brain/graph.json', age < 2 * 3600 * 1000, `${n} nodes · ${e} edges · updated ${AGE(age)} ago`);
    line('synapse spend', true, `$${Number((g.meta || {}).spendUsd || 0).toFixed(3)} of the daily cap`);
  } catch { line('brain/graph.json', false, 'MISSING — the SYNAPSE worker has never produced a graph'); }

  console.log(C.bold('\nMISSIONS'));
  try {
    const all = missionStore().list();
    const by = (s) => all.filter((m) => m.status === s).length;
    line('missions', true, all.length ? `${all.length} total · ${by('running')} running · ${by('parked')} parked · ${by('abandoned')} abandoned` : 'none yet');
    for (const m of all.filter((x) => x.status === 'parked')) console.log(C.dim(`     ${m.id} — ${String(m.goal).slice(0, 80)}`));
  } catch (e) { line('missions', false, e.message); }

  console.log(C.bold('\nCLOUD'));
  const c = cfg();
  if (!c.cloudUrl) line('cloud', null, 'no cloudUrl configured');
  else {
    try {
      const r = await fetch(c.cloudUrl.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(6000) });
      line('cloud', r.status === 401 || r.ok, `${c.cloudUrl} → HTTP ${r.status}${r.status === 401 ? ' (up, auth-gated)' : ''}`);
    } catch (e) { line('cloud', false, `${c.cloudUrl} unreachable — ${e.message}`); }
  }

  console.log(C.bold('\nRECENT ERRORS'));
  try {
    const evs = fs.readFileSync(path.join(HOME, '.bhatbot', 'logs', 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .filter((e) => e.kind === 'error' || e.status === 'error').slice(-5);
    if (!evs.length) console.log(C.dim('  (none in the recent event log)'));
    for (const e of evs) console.log(`  ${C.dim(e.ts)} ${C.red(e.kind)} ${String(e.error || e.msg || e.name || '').slice(0, 100)}`);
  } catch { console.log(C.dim('  (no events.jsonl yet)')); }
  console.log('');
}

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'logs') return logs(argv.slice(1));
  if (cmd === 'health') return health();
  if (cmd === 'doctor') return doctor();
  if (cmd === 'missions' || cmd === 'mission') return missions(argv.slice(1));
  if (cmd === 'wc') return send(['world cup', (argv[1] || 'report')]);
  // default: treat all args as a prompt to send
  return send(argv);
})();
