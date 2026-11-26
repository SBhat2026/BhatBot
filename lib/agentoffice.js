'use strict';
// ── THE AGENT OFFICE, DRIVEN FROM BHATBOT ─────────────────────────────────────────────────────────
//
// 2026-11-26: "integrate this office style for the agents … still have the functionality of the
// current agents … tailored to Claude instead of ChatGPT … the full 3D experience is maintained and
// BhatBot can fully access it."
//
// Agent Office (MIT, AgentSystemLabs) runs isolated under ~/bhatbot-office (its own data, its own
// floors folder, port 4600), with the research desks of the ResearchOffice bundle on port 4612. Its
// workers are Claude Code (default, Sonnet) or OpenCode on the Mac's own Ollama models. This module is
// how BhatBot reaches it: the same login + WebSocket the office's own browser client uses, so anything
// a person can do at a desk — hire, prompt, read the terminal, send home, queue — BhatBot can do.
//
// Pure-ish: Node + fetch + ws. No Electron. Every call fails soft with a reason.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULTS = {
  dir: path.join(os.homedir(), 'bhatbot-office'),
  url: 'http://127.0.0.1:4600',
  research: 'http://127.0.0.1:4612',
  floor: 'research',
};
// Desks 1–5 carry the research roles' live logs; BhatBot hires from desk 6 up.
const RESERVED = new Set(['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5']);
const HIRE_DESKS = Array.from({ length: 11 }, (_, i) => `desk-${i + 6}`);

function cfgOf(config = {}) { return { ...DEFAULTS, ...(config.agentOffice || {}) }; }
function floorDir(c) { return path.join(c.dir, 'outputs', 'research'); }
function readPassword(c) {
  try { return JSON.parse(fs.readFileSync(path.join(floorDir(c), '.agent-office', 'config.json'), 'utf8')).password || ''; } catch { return ''; }
}
async function up(url, ms = 1500) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.status < 500; } catch { return false; }
}

/** Start the office + research server if they are not running (start.sh is idempotent). */
async function ensureRunning(config) {
  const c = cfgOf(config);
  if (await up(c.url + '/api/login') && await up(c.research + '/state')) return { ok: true, started: false };
  const script = path.join(c.dir, 'start.sh');
  if (!fs.existsSync(script)) return { ok: false, error: `Agent Office is not installed (${script} missing)` };
  await new Promise((resolve) => {
    const p = spawn('/bin/zsh', [script], { cwd: c.dir, stdio: 'ignore', detached: true });
    p.on('exit', resolve); p.on('error', resolve); p.unref();
    setTimeout(resolve, 45000);
  });
  return { ok: await up(c.url + '/api/login'), started: true };
}

/** A session cookie for the office (the same one its browser client gets). */
async function login(config) {
  const c = cfgOf(config);
  const password = readPassword(c);
  if (!password) return { ok: false, error: 'no office password (has the office run once?)' };
  const r = await fetch(c.url + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: c.url },
    body: JSON.stringify({ password }), signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) return { ok: false, error: 'office login ' + r.status };
  const cookie = String(r.headers.get('set-cookie') || '').split(';')[0];
  return cookie ? { ok: true, cookie } : { ok: false, error: 'office gave no session cookie' };
}

/**
 * One short WebSocket session: connect, receive the floor's workers, optionally send messages, wait
 * for what the caller is after, close. Short-lived on purpose — nothing stays connected in the
 * background, so the office never shows a phantom visitor.
 */
async function session(config, { send = [], until = null, timeoutMs = 8000 } = {}) {
  const WebSocket = require('ws');
  const c = cfgOf(config);
  const auth = await login(config);
  if (!auth.ok) return { ok: false, error: auth.error };
  const wsUrl = c.url.replace(/^http/, 'ws') + `/ws?floor=${encodeURIComponent(c.floor)}&name=BhatBot&lite=1`;
  return new Promise((resolve) => {
    const workers = new Map(); const screens = new Map(); const errors = []; let queue = null; let done = false;
    const sock = new WebSocket(wsUrl, { origin: c.url, headers: { Cookie: auth.cookie } });
    const finish = (extra = {}) => {
      if (done) return; done = true;
      try { sock.close(); } catch {}
      resolve({ ok: !errors.length || !!extra.ok, workers: [...workers.values()], screens, queue, errors, ...extra });
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    sock.on('error', (e) => { errors.push(e.message); clearTimeout(timer); finish({ ok: false }); });
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === 'welcome') {
        for (const w of m.workers || []) workers.set(w.id, w);
        if (m.queue) queue = m.queue;
        for (const msg of (typeof send === 'function' ? send([...workers.values()]) : send) || []) sock.send(JSON.stringify(msg));
      }
      if (m.t === 'worker.update' && m.worker) workers.set(m.worker.id, m.worker);
      if (m.t === 'worker.remove') workers.delete(m.workerId);
      if (m.t === 'queue' && m.state) queue = m.state;
      if (m.t === 'term.snapshot') screens.set(m.workerId, String(m.data || ''));
      if (m.t === 'error') errors.push(m.message || 'office error');
      if (until && until(m, workers, screens)) { clearTimeout(timer); finish({ ok: true }); }
    });
  });
}

const brief = (w) => ({
  id: w.id, name: w.name, desk: w.deskId, kind: w.kind, provider: w.provider || (w.kind === 'shell' ? 'shell' : 'claude'),
  model: w.model || (w.usage && w.usage.model) || null, status: w.status,
  task: w.task ? `${w.task.name}${w.task.summary ? ' — ' + w.task.summary : ''}` : (w.prompt ? String(w.prompt).slice(0, 140) : ''),
  branch: w.worktree && w.worktree.branch || null, pr: w.pr && (w.pr.url || w.pr.number) || null,
  waiting: w.status === 'needs_input' || w.status === 'done',
});

/** Strip terminal escape codes so a screen reads as text. */
function plain(s) { return String(s || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, ''); }

async function list(config) {
  await ensureRunning(config);
  const s = await session(config, { until: (m) => m.t === 'welcome', timeoutMs: 6000 });
  if (!s.ok && !s.workers.length) return { success: false, error: s.errors.join('; ') || 'office unreachable' };
  return { success: true, workers: s.workers.map(brief), queue: s.queue && (s.queue.tasks || []).length || 0 };
}

/**
 * Hire a worker. provider 'claude' (default, Sonnet unless model says otherwise — Opus needs his OK,
 * enforced by the caller) or 'opencode' with a local model id like 'ollama/qwen3:14b'.
 */
async function hire(config, { prompt, provider = 'claude', model, desk, worktree = false } = {}) {
  if (!String(prompt || '').trim()) return { success: false, error: 'a task (prompt) is required' };
  await ensureRunning(config);
  let chosen = desk;
  const s = await session(config, {
    send: (ws) => {
      const taken = new Set(ws.map((w) => w.deskId));
      chosen = chosen || HIRE_DESKS.find((d) => !taken.has(d) && !RESERVED.has(d));
      if (!chosen) return [];
      const msg = { t: 'worker.spawn', deskId: chosen, kind: 'agent', provider, prompt: String(prompt), worktree: !!worktree };
      if (model) msg.model = String(model);
      return [msg];
    },
    until: (m) => m.t === 'worker.update' && m.worker && m.worker.deskId === chosen,
    timeoutMs: 15000,
  });
  if (!chosen) return { success: false, error: 'every desk is taken — send someone home first' };
  const w = s.workers.find((x) => x.deskId === chosen);
  return w ? { success: true, hired: brief(w) } : { success: false, error: s.errors.join('; ') || 'the office did not seat a worker in time' };
}

function find(workers, who) {
  const q = String(who || '').toLowerCase();
  return workers.find((w) => w.id === who || String(w.name).toLowerCase() === q || w.deskId === q)
    || workers.find((w) => String(w.name).toLowerCase().includes(q));
}

async function tell(config, { who, prompt }) {
  const pre = await session(config, { until: (m) => m.t === 'welcome' });
  const w = find(pre.workers, who);
  if (!w) return { success: false, error: `no worker "${who}" on the floor` };
  await session(config, { send: [{ t: 'worker.prompt', workerId: w.id, prompt: String(prompt) }], timeoutMs: 1500 });
  return { success: true, told: w.name };
}

async function read(config, { who, lines = 40 }) {
  const pre = await session(config, { until: (m) => m.t === 'welcome' });
  const w = find(pre.workers, who);
  if (!w) return { success: false, error: `no worker "${who}" on the floor` };
  const s = await session(config, {
    send: [{ t: 'worker.attach', workerId: w.id }],
    until: (m) => m.t === 'term.snapshot' && m.workerId === w.id, timeoutMs: 6000,
  });
  const text = plain(s.screens.get(w.id) || '').split('\n').filter((l) => l.trim()).slice(-Math.max(5, Math.min(200, lines))).join('\n');
  return { success: true, worker: brief(w), screen: text || '(nothing on screen yet)' };
}

async function sendHome(config, { who, cleanup = 'auto' }) {
  const pre = await session(config, { until: (m) => m.t === 'welcome' });
  const w = find(pre.workers, who);
  if (!w) return { success: false, error: `no worker "${who}" on the floor` };
  if (RESERVED.has(w.deskId)) return { success: false, error: `${w.name} is a research desk — leave it seated` };
  await session(config, { send: [{ t: 'worker.kill', workerId: w.id, cleanup }], until: (m) => m.t === 'worker.remove' && m.workerId === w.id, timeoutMs: 8000 });
  return { success: true, sentHome: w.name };
}

// ── research desks (port 4612) ─────────────────────────────────────────────────────────────────────
async function researchSubmit(config, { question, route = 'hybrid' }) {
  await ensureRunning(config);
  const c = cfgOf(config);
  const r = await fetch(c.research + '/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: String(question), route: route === 'local' ? 'local' : 'hybrid' }), signal: AbortSignal.timeout(5000) });
  if (!r.ok) return { success: false, error: 'research server ' + r.status };
  return { success: true, job: await r.json(), route: route === 'local' ? 'local only' : 'Claude plans + reviews, local model researches' };
}
async function researchStatus(config, { job } = {}) {
  const c = cfgOf(config);
  const s = await (await fetch(c.research + '/state', { signal: AbortSignal.timeout(5000) })).json();
  if (!job) return { success: true, jobs: (s.jobs || []).slice(0, 10).map((j) => ({ id: j.id, status: j.status, stage: j.stage, question: String(j.question).slice(0, 120) })), feeds: s.feeds };
  const j = (s.jobs || []).find((x) => x.id === job);
  if (!j) return { success: false, error: 'unknown job ' + job };
  const out = { success: true, job: j, events: (s.events || []).filter((e) => e.job === job).slice(0, 8) };
  if (j.status === 'complete') { try { out.report = await (await fetch(`${c.research}/runs/${job}/report.md`)).text(); } catch {} }
  return out;
}
async function journalScan(config) {
  const c = cfgOf(config);
  const py = path.join(c.dir, 'work', 'venv', 'bin', 'python');
  return new Promise((resolve) => {
    const p = spawn(py, ['scan.py', '--now'], { cwd: floorDir(c) });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve(code === 0 ? { success: true, result: 'journal watch ran — new papers are queued as briefings' } : { success: false, error: err.slice(-300) || 'scan failed' }));
    p.on('error', (e) => resolve({ success: false, error: e.message }));
  });
}

module.exports = { ensureRunning, login, list, hire, tell, read, sendHome, researchSubmit, researchStatus, journalScan, cfgOf, plain, RESERVED, HIRE_DESKS };
