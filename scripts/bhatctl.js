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

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'logs') return logs(argv.slice(1));
  if (cmd === 'health') return health();
  if (cmd === 'wc') return send(['world cup', (argv[1] || 'report')]);
  // default: treat all args as a prompt to send
  return send(argv);
})();
