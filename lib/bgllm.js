'use strict';
// ── BACKGROUND LLM ROUTER — unattended work rides the Claude subscription, not API billing ────────
// Background jobs (SYNAPSE paid pass, backlog worker, memory maintenance, scheduled mini-agent runs…)
// used to POST to api.anthropic.com with a metered key. The Claude Code CLI, signed in through
// claude.ai, bills the subscription instead. This module runs a tool-less, text-only request through
// `claude -p --model <m>` with ANTHROPIC_API_KEY REMOVED from the child's env (if it were present the
// CLI would silently prefer it and bill the API again), and falls back to the metered API only when
// the CLI is missing, logged out, or rate-limited.
//
// NOT for interactive chat — main.js's chat path calls anthropicRequest/anthropicStream directly and
// never goes through here. Tool-using requests also bypass the CLI (the CLI runs its own agent loop,
// which cannot honour a caller-supplied tool schema), as do requests carrying images.
//
// Pure + dependency-injected (spawn, clock, ledger path, config) so the routing/fallback policy is
// testable with no CLI, no network and no spend. See docs/BILLING_AUDIT.md.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const COSTS_PATH = path.join(os.homedir(), '.bhatbot', 'costs.json');

// Cooldowns after a CLI failure: stop hammering a limit/login that will not clear in seconds.
const COOLDOWN_MS = { rate_limited: 15 * 60000, auth: 30 * 60000, unavailable: 10 * 60000 };
const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'BHATBOT_ANTHROPIC_KEY'];

// Marks an async call chain as UNATTENDED. main.js's bgTick wraps every background timer tick in
// runBackground(), and anthropicRequest consults backgroundLabel() — so any tool-less LLM call made
// from inside a tick routes subscription-first, while an interactive turn (which is never inside the
// store) is untouched. AsyncLocalStorage is per async chain, so a tick and a chat turn running at the
// same moment cannot leak into each other.
const _als = new AsyncLocalStorage();
const runBackground = (label, fn) => _als.run({ label: String(label || 'background') }, fn);
const backgroundLabel = () => { const s = _als.getStore(); return s ? s.label : null; };

let _cool = { until: 0, reason: '' };
const resetCooldown = () => { _cool = { until: 0, reason: '' }; };

function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }

/** billing.backgroundViaSubscription — default TRUE; only an explicit `false` opts out. */
function enabled(cfg) {
  const b = (cfg || {}).billing;
  return !(b && b.backgroundViaSubscription === false);
}

/** Child env: the parent's env minus every metered-key var, so the CLI uses the claude.ai login. */
function childEnv(base = process.env) {
  const env = { ...base };
  for (const k of KEY_VARS) delete env[k];
  // Electron / LaunchAgent PATHs are minimal; the CLI usually lives in one of these.
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local')];
  env.PATH = [...extra, env.PATH || ''].filter(Boolean).join(path.delimiter);
  return env;
}

/** 'rate_limited' | 'auth' | 'unavailable' | 'error' from CLI output/exit state. */
function classifyFailure({ text = '', code = null, enoent = false, timedOut = false } = {}) {
  if (enoent) return 'unavailable';
  const t = String(text);
  if (/usage limit|rate.?limit|limit reached|too many requests|\b429\b|overloaded|\b529\b|resets? (at|in)/i.test(t)) return 'rate_limited';
  if (/not logged in|please run \/?login|invalid (api key|credentials)|authentication|\b401\b|oauth|unauthorized/i.test(t)) return 'auth';
  if (timedOut) return 'error';
  return 'error';
}

const blockText = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';

/** True iff the body is a plain text exchange the CLI can serve (no tools, no images/tool blocks). */
function cliEligible(body) {
  if (!body || body.tools && body.tools.length) return false;
  if (!Array.isArray(body.messages) || !body.messages.length) return false;
  return body.messages.every((m) => typeof m.content === 'string'
    || (Array.isArray(m.content) && m.content.every((b) => b && b.type === 'text')));
}

function modelAlias(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus')) return 'opus';
  return 'sonnet';
}

/** Anthropic request body → { system, prompt } for `claude -p`. */
function toPrompt(body) {
  let system = blockText(body.system);
  const schema = body._reason && body._reason.schema;
  if (schema) system += (system ? '\n\n' : '') + 'Respond with ONLY a JSON value (no prose, no code fence) matching this JSON schema:\n' + JSON.stringify(schema);
  const msgs = body.messages;
  const prompt = msgs.length === 1 && msgs[0].role === 'user'
    ? blockText(msgs[0].content)
    : msgs.map((m) => (m.role === 'assistant' ? 'Assistant: ' : 'User: ') + blockText(m.content)).join('\n\n') + '\n\nAssistant:';
  return { system, prompt };
}

/**
 * runCli(prompt, { system, model, timeoutMs, spawnImpl, bin, env, tools, cwd, maxTurns })   (tools: '' = none, or e.g. 'Read,Grep,WebSearch') → { ok, text, usage, costUsd, reason, detail }
 * Never throws. `reason` is set when !ok (see classifyFailure).
 */
function runCli(prompt, { system, model = 'sonnet', timeoutMs = 180000, spawnImpl = spawn, bin = 'claude', env, tools = '', cwd, maxTurns } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', model, '--output-format', 'json', '--tools', tools, '--no-session-persistence'];
    if (maxTurns) args.push('--max-turns', String(maxTurns));
    if (system) args.push('--system-prompt', system);
    let child, out = '', err = '', done = false, timedOut = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { timedOut = true; try { child && child.kill('SIGKILL'); } catch {} }, timeoutMs);
    try {
      child = spawnImpl(bin, args, { env: env || childEnv(), cwd: cwd || os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return finish({ ok: false, reason: classifyFailure({ enoent: e && e.code === 'ENOENT', text: e && e.message }), detail: String(e && e.message || e).slice(0, 200) }); }
    child.on('error', (e) => finish({ ok: false, reason: classifyFailure({ enoent: e && e.code === 'ENOENT', text: e && e.message }), detail: String(e && e.message || e).slice(0, 200) }));
    child.stdout && child.stdout.on('data', (d) => { out += d; });
    child.stderr && child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      let j = null; try { j = JSON.parse(out); } catch {}
      const text = j && typeof j.result === 'string' ? j.result : (j ? '' : out.trim());
      if (code === 0 && !(j && j.is_error) && text) {
        const u = (j && j.usage) || {};
        return finish({ ok: true, text, usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 }, costUsd: Number(j && j.total_cost_usd) || 0 });
      }
      const blob = [text, err, out].join('\n');
      finish({ ok: false, reason: classifyFailure({ text: blob, code, timedOut }), detail: blob.trim().slice(0, 200) || ('exit ' + code) });
    });
    try { child.stdin && child.stdin.end(prompt); } catch {}
  });
}

// ── ledger tag ── costs.json[day].byBilling = { subscription: {calls, equivUsd, tokensIn, tokensOut}, api: {calls, usd} }
// `usd` (the metered total) is NOT touched by subscription calls — that is the point — but their
// would-have-been API cost is kept as `equivUsd` so the saving is visible. bySource splits by caller.
function tagLedger({ billing, label = 'background', usd = 0, usage = {}, ledgerPath = COSTS_PATH, day }) {
  try {
    let led = {}; try { led = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch {}
    const d = day || new Date().toISOString().slice(0, 10);
    const e = (led[d] = led[d] || { usd: 0, calls: 0, byModel: {} });
    const bb = (e.byBilling = e.byBilling || {});
    const slot = (bb[billing] = bb[billing] || { calls: 0 });
    slot.calls += 1;
    if (billing === 'subscription') {
      slot.equivUsd = (slot.equivUsd || 0) + usd;
      slot.tokensIn = (slot.tokensIn || 0) + (usage.input_tokens || 0);
      slot.tokensOut = (slot.tokensOut || 0) + (usage.output_tokens || 0);
    } else slot.usd = (slot.usd || 0) + usd;
    const bs = (e.bySource = e.bySource || {});
    const key = label + ':' + billing;
    bs[key] = (bs[key] || 0) + 1;
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(led));
  } catch {}
}

const asResponse = (text, usage, billing, model) => ({
  content: [{ type: 'text', text }], model, stop_reason: 'end_turn', usage: usage || {}, _billing: billing,
});

/**
 * backgroundRequest(body, { apiRequest, label, config, now, spawnImpl, ledgerPath, log, apiUsd }) → Anthropic-shaped response
 * with `_billing: 'subscription' | 'api'`.
 *   apiRequest(body) — the metered fallback (required; the caller owns key resolution + retries).
 * Policy: toggle on + eligible body + CLI not cooling down → CLI. CLI failure → remember why, fall
 * back to apiRequest. If the API fallback also fails, its error propagates (callers already handle it).
 */
async function backgroundRequest(body, opts = {}) {
  const { apiRequest, label = 'background', config, now = Date.now, spawnImpl, bin, ledgerPath, log = () => {} } = opts;
  if (typeof apiRequest !== 'function') throw new Error('backgroundRequest: apiRequest fallback required');
  const cfg = config || readConfig();
  const viaApi = async (why) => {
    const r = await apiRequest(body);
    const u = (r && r.usage) || {};
    try { tagLedger({ billing: 'api', label, usd: opts.apiUsd ? opts.apiUsd(body.model, u) : 0, usage: u, ledgerPath }); } catch {}
    if (r && typeof r === 'object') r._billing = 'api';
    if (why) log(`[bgllm] ${label}: API (${why})`);
    return r;
  };

  if (!enabled(cfg)) return viaApi('subscription routing disabled');
  if (!cliEligible(body)) return viaApi('request needs tools/images');
  if (now() < _cool.until) return viaApi('CLI cooling down: ' + _cool.reason);

  const { system, prompt } = toPrompt(body);
  const r = await runCli(prompt, { system, model: modelAlias(body.model), spawnImpl, bin, timeoutMs: opts.timeoutMs });
  if (r.ok) {
    tagLedger({ billing: 'subscription', label, usd: r.costUsd, usage: r.usage, ledgerPath });
    return asResponse(r.text, r.usage, 'subscription', body.model);
  }
  const ms = COOLDOWN_MS[r.reason];
  if (ms) _cool = { until: now() + ms, reason: r.reason };
  return viaApi(`CLI ${r.reason}: ${r.detail}`);
}

/**
 * agentRequest(prompt, { system, tools, cwd, apiFallback, ... }) → { ok, text, billing, usd, error }
 * For BACKGROUND tool-loop jobs (backlog worker): the CLI runs its own read-only agent loop
 * (`tools` = CLI built-ins, e.g. 'Read,Grep,Glob,WebSearch,WebFetch'). On CLI failure,
 * `apiFallback()` (the metered tool loop) runs instead. Both paths tag the ledger.
 */
async function agentRequest(prompt, opts = {}) {
  const { system, tools = 'Read,Grep,Glob,WebSearch,WebFetch', cwd, model = 'sonnet', maxTurns = 12, apiFallback, label = 'agent',
    config, now = Date.now, spawnImpl, bin, ledgerPath, log = () => {}, timeoutMs } = opts;
  const viaApi = async (why) => {
    if (typeof apiFallback !== 'function') return { ok: false, text: '', billing: 'none', error: why };
    const r = await apiFallback();
    tagLedger({ billing: 'api', label, usd: (r && r.usd) || 0, ledgerPath });
    log(`[bgllm] ${label}: API (${why})`);
    return { ...r, billing: 'api' };
  };
  if (!enabled(config || readConfig())) return viaApi('subscription routing disabled');
  if (now() < _cool.until) return viaApi('CLI cooling down: ' + _cool.reason);
  const r = await runCli(prompt, { system, model, tools, cwd, maxTurns, spawnImpl, bin, timeoutMs });
  if (r.ok) {
    tagLedger({ billing: 'subscription', label, usd: r.costUsd, usage: r.usage, ledgerPath });
    return { ok: true, text: r.text, billing: 'subscription', usd: 0 };
  }
  const ms = COOLDOWN_MS[r.reason];
  if (ms) _cool = { until: now() + ms, reason: r.reason };
  return viaApi(`CLI ${r.reason}: ${r.detail}`);
}

/** The text of a response (shared by callers that only want a string). */
const textOf = (r) => ((r && r.content) || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();

module.exports = {
  backgroundRequest, agentRequest, runCli, enabled, childEnv, classifyFailure, cliEligible, modelAlias, toPrompt, tagLedger, textOf,
  runBackground, backgroundLabel, resetCooldown, COOLDOWN_MS, KEY_VARS, COSTS_PATH, CONFIG_PATH,
};
