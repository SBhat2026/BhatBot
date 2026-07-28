'use strict';
// ── HEADLESS ANTHROPIC CALLER ─────────────────────────────────────────────────────────────────────
// A deliberately small, Electron-free Claude client for BACKGROUND WORKERS (scripts/synapse-worker.js
// and anything else that must run outside the GUI process).
//
// WHY THIS DUPLICATES ~40 LINES OF main.js ON PURPOSE:
// main.js's anthropicRequest is entangled with the live rate ledger, the learned router, cost
// telemetry, tool schemas, streaming, and the Electron app object. None of that can be required from
// a plain node process, and untangling it is a large, risky refactor with no payoff for a worker that
// makes a handful of cheap calls an hour. So: a separate, boring implementation with an explicit
// contract. If the two ever need to converge, converge them deliberately — this is not an accident.
//
// KEY RESOLUTION IS THE INTERESTING PART. config.json holds CRED_REF_* vault handles, and the vault
// (lib/credentials.js) can only be decrypted by Electron's safeStorage — a plain node process gets
// nothing. So a headless worker resolves keys in this order:
//   1. process.env                      — what a LaunchAgent or a shell would set
//   2. the macOS login Keychain         — via the `security` CLI, OS-protected, no plaintext on disk
//   3. a NON-vaulted value in config.json (older installs that were never migrated)
// A CRED_REF handle is never returned: sending one as a bearer token 401s, which historically looked
// like "embeddings mysteriously stopped working" rather than an auth failure.
//
// Note that the SYNAPSE free pass (hydrate) needs no key at all — the worker's core job still runs
// when every one of these misses. Only the paid pass degrades. See scripts/synapse-worker.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const isRef = (v) => typeof v === 'string' && /^CRED_REF/i.test(v);

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// macOS login Keychain via the `security` CLI — the same mechanism main.js's keychain_lookup uses.
// No npm dep, no plaintext on disk, and the OS gates access. Returns '' on any platform but darwin.
function keychainRead(service, account) {
  if (process.platform !== 'darwin') return '';
  try {
    const args = ['find-generic-password', '-s', service, '-w'];
    if (account) args.push('-a', account);
    const r = spawnSync('security', args, { encoding: 'utf8', timeout: 8000 });
    return (r.status === 0 && r.stdout != null) ? r.stdout.replace(/\n+$/, '') : '';
  } catch { return ''; }
}

/**
 * resolveKey('anthropic'|'openai', { config?, keychain? }) → string ('' if unresolvable)
 * Both lookups are injectable so this is testable without a real Keychain.
 */
function resolveKey(which = 'anthropic', { config, keychain = keychainRead } = {}) {
  const spec = which === 'openai'
    ? { env: ['OPENAI_API_KEY'], cfg: ['openaiKey'], service: 'bhatbot-openai' }
    : { env: ['ANTHROPIC_API_KEY', 'BHATBOT_ANTHROPIC_KEY'], cfg: ['apiKey', 'anthropicKey'], service: 'bhatbot-anthropic' };

  for (const e of spec.env) {
    const v = (process.env[e] || '').trim();
    if (v && !isRef(v)) return v;
  }
  const k = (keychain(spec.service) || '').trim();
  if (k && !isRef(k)) return k;

  const cfg = config || readConfig();
  for (const c of spec.cfg) {
    const v = cfg[c];
    if (v && !isRef(v)) return String(v);      // a CRED_REF handle is USELESS here — skip, don't send it
  }
  return '';
}

/** True iff a headless process can actually reach the given provider right now. */
function hasKey(which = 'anthropic', opts) { return !!resolveKey(which, opts); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * anthropicRequest(body, { apiKey?, retries?, fetchImpl?, log? }) → the parsed API response.
 *
 * Contract, chosen for a BACKGROUND caller — a worker must never crash the process or hang forever
 * over a transient API hiccup, and its failures are invisible, so they have to be inert:
 *   • honours `retry-after` on 429/529 and backs off exponentially on 5xx
 *   • a malformed/empty body degrades to { content: [] } instead of throwing
 *   • only genuinely unrecoverable failures (no key, 4xx that isn't 429) throw
 */
// `keychain`/`config` are injectable purely so this is hermetically testable — otherwise a test for
// the no-key path passes or fails depending on whether the developer's login Keychain happens to
// hold a key, which is exactly the kind of environment coupling that makes a suite untrustworthy.
async function anthropicRequest(body = {}, { apiKey, retries = 3, fetchImpl, log = () => {}, timeoutMs = 120000, keychain, config } = {}) {
  const key = apiKey || resolveKey('anthropic', { keychain, config });
  if (!key) throw new Error('no Anthropic key available (env / Keychain / config all missed — config.json holds a vault handle a headless process cannot decrypt)');
  const doFetch = fetchImpl || globalThis.fetch;

  const payload = { model: DEFAULT_MODEL, max_tokens: 1024, ...body };
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await doFetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
      continue;
    }

    if (res.ok) {
      try {
        const json = await res.json();
        return (json && Array.isArray(json.content)) ? json : { content: [], _malformed: true };
      } catch { return { content: [], _malformed: true }; }
    }

    // 429 (rate) and 529 (overloaded) are worth waiting out; the server tells us how long.
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt);
      lastErr = new Error(`HTTP ${res.status}`);
      if (attempt === retries) break;
      log(`[llm] ${res.status} — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${retries})`);
      await sleep(waitMs);
      continue;
    }

    // Anything else (400/401/403) is a real problem the caller must see; retrying would just repeat it.
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new Error(`Anthropic ${res.status}: ${detail}`);
  }
  throw new Error('Anthropic request failed after ' + retries + ' retries: ' + (lastErr && lastErr.message || 'unknown'));
}

/** Convenience: one prompt in, plain text out. Returns '' rather than throwing on an empty reply. */
async function ask(prompt, { system, model, maxTokens = 512, ...opts } = {}) {
  const r = await anthropicRequest({
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: String(prompt) }],
  }, opts);
  return (r.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
}

module.exports = { anthropicRequest, ask, resolveKey, hasKey, keychainRead, DEFAULT_MODEL, API_URL, CONFIG_PATH };
