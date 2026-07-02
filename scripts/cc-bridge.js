#!/usr/bin/env node
'use strict';
// CLAUDE CODE ↔ BHATBOT bridge. A read-only pipeline so an external agent (Claude Code) can pull
// BhatBot's live error surface and work from real messages instead of guessing. Aggregates the
// three ledgers BhatBot already writes:
//   ~/.bhatbot/audit.log        — JSONL, one line per tool call ({ts,tool,ok,result,usd,ms,...})
//   ~/.bhatbot/logs/app.log     — "<ISO> [level] [tag] message" console tee
//   ~/.bhatbot/logs/events.jsonl— {ts,kind,text} activity stream (thinking/error/…)
//
// Usage:
//   node scripts/cc-bridge.js errors [--since 60m] [--json]   # clustered tool failures + error lines
//   node scripts/cc-bridge.js status [--json]                 # one-glance health for triage
//   node scripts/cc-bridge.js tail [N]                        # last N app.log lines (default 40)
//   npm run cc:errors        # == errors
//   npm run cc:status        # == status
const fs = require('fs'), os = require('os'), path = require('path');

const HOME = os.homedir();
const AUDIT = path.join(HOME, '.bhatbot', 'audit.log');
const APPLOG = path.join(HOME, '.bhatbot', 'logs', 'app.log');
const EVENTS = path.join(HOME, '.bhatbot', 'logs', 'events.jsonl');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'errors';
const JSON_OUT = argv.includes('--json');

function parseSince(args) {
  const i = args.indexOf('--since');
  const raw = i >= 0 ? args[i + 1] : '120m';
  const m = /^(\d+)\s*(m|h|d)?$/.exec(String(raw || '120m').trim());
  if (!m) return 120 * 60 * 1000;
  const n = Number(m[1]); const unit = m[2] || 'm';
  return n * (unit === 'h' ? 3600e3 : unit === 'd' ? 86400e3 : 60e3);
}
function readLines(file, max = 5000) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-max); } catch { return []; }
}
function readJsonl(file, max = 5000) {
  return readLines(file, max).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function tsOf(x) { return new Date((x && (x.ts || x.time)) || 0).getTime() || 0; }

// --- tool-failure clustering: mirrors lib/selfheal.clusterAudit so the bridge shows exactly what
//     the self-heal loop would act on (same signal, external view). ---
function clusterFailures(sinceMs) {
  const cutoff = Date.now() - sinceMs;
  const byTool = {};
  for (const e of readJsonl(AUDIT)) {
    if (!e || e.ok !== false) continue;
    if (tsOf(e) && tsOf(e) < cutoff) continue;
    const tool = e.tool || 'unknown';
    (byTool[tool] = byTool[tool] || []).push({ err: String(e.result || e.error || '').slice(0, 200), ts: e.ts, args: e.args });
  }
  return Object.entries(byTool)
    .map(([tool, list]) => ({ tool, count: list.length, sample: (list.find((x) => x.err) || {}).err || '(no error text)', last: list[list.length - 1].ts }))
    .sort((a, b) => b.count - a.count);
}
function appLogErrors(sinceMs, limit = 40) {
  const cutoff = Date.now() - sinceMs;
  const out = [];
  for (const line of readLines(APPLOG)) {
    if (!/\[(error|warn)\]|✗|⚠|Error:|EADDR|ENOENT|ECONN|undefined is not|TypeError|ReferenceError|429|5\d\d /i.test(line)) continue;
    const t = Date.parse((line.match(/^\S+/) || [])[0] || '');
    if (t && t < cutoff) continue;
    out.push(line);
  }
  return out.slice(-limit);
}
function eventErrors(sinceMs, limit = 30) {
  const cutoff = Date.now() - sinceMs;
  return readJsonl(EVENTS)
    .filter((e) => tsOf(e) >= cutoff && (e.kind === 'error' || /error|fail|✗|⚠|crash/i.test(e.text || '')))
    .slice(-limit)
    .map((e) => ({ ts: e.ts, kind: e.kind, text: (e.text || '').slice(0, 200) }));
}
function appRunning() {
  try { const { execSync } = require('child_process'); return !!execSync('pgrep -f "electron ." || pgrep -f Bhatbot || true', { encoding: 'utf8' }).trim(); }
  catch { return false; }
}
function freshness(file) {
  try { const age = Date.now() - fs.statSync(file).mtimeMs; return age < 6e4 ? 'just now' : age < 36e5 ? Math.round(age / 6e4) + 'm ago' : Math.round(age / 36e5) + 'h ago'; }
  catch { return 'missing'; }
}

function cmdErrors() {
  const sinceMs = parseSince(argv);
  const report = {
    since: argv[argv.indexOf('--since') + 1] || '120m',
    tool_failures: clusterFailures(sinceMs),
    app_log_errors: appLogErrors(sinceMs),
    event_errors: eventErrors(sinceMs),
  };
  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }
  const { tool_failures: tf, app_log_errors: ae, event_errors: ee } = report;
  console.log(`# BhatBot error surface (last ${report.since})\n`);
  console.log(`## Tool failures (${tf.length} clustered)`);
  if (!tf.length) console.log('  (none)');
  for (const f of tf) console.log(`  ✗ ${f.tool} ×${f.count} — ${f.sample}  [last ${f.last}]`);
  console.log(`\n## app.log errors/warns (${ae.length})`);
  if (!ae.length) console.log('  (none)');
  for (const l of ae) console.log('  ' + l);
  console.log(`\n## activity error events (${ee.length})`);
  if (!ee.length) console.log('  (none)');
  for (const e of ee) console.log(`  ${e.ts} [${e.kind}] ${e.text}`);
  const total = tf.reduce((a, b) => a + b.count, 0) + ae.length + ee.length;
  console.log(`\n→ ${total ? total + ' signals — start with the top tool cluster.' : 'clean — nothing to act on.'}`);
}

function cmdStatus() {
  let cost = null; try { cost = JSON.parse(fs.readFileSync(path.join(HOME, '.bhatbot', 'costs.json'), 'utf8')); } catch {}
  const tf = clusterFailures(parseSince(['--since', '120m']));
  const status = {
    app_running: appRunning(),
    app_log: freshness(APPLOG),
    events: freshness(EVENTS),
    audit: freshness(AUDIT),
    top_tool_failures: tf.slice(0, 5),
    cost_today: cost && (cost.day === new Date().toISOString().slice(0, 10)) ? cost : null,
  };
  if (JSON_OUT) { console.log(JSON.stringify(status, null, 2)); return; }
  console.log(`BhatBot: ${status.app_running ? '🟢 running' : '⚪ not running'}`);
  console.log(`logs — app.log ${status.app_log}, events ${status.events}, audit ${status.audit}`);
  console.log(`tool failures (2h): ${tf.length ? tf.slice(0, 5).map((f) => `${f.tool}×${f.count}`).join(', ') : 'none'}`);
  if (status.cost_today) console.log(`cost today: ${JSON.stringify(status.cost_today).slice(0, 200)}`);
}

function cmdTail() {
  const n = Number(argv[1]) || 40;
  for (const l of readLines(APPLOG, n)) console.log(l);
}

if (cmd === 'errors') cmdErrors();
else if (cmd === 'status') cmdStatus();
else if (cmd === 'tail') cmdTail();
else { console.error(`unknown command "${cmd}". Use: errors | status | tail`); process.exit(2); }
