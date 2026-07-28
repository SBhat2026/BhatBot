#!/usr/bin/env node
'use strict';
// Tests for lib/llm.js — the Electron-free Anthropic client background workers use.
// The two things that must hold, because a worker's failures are INVISIBLE:
//   1. key resolution never returns a CRED_REF_* vault handle. Sending a handle as a bearer token
//      401s, which historically presented as "embeddings silently stopped working" rather than as an
//      auth error. A headless process cannot decrypt the vault (safeStorage is Electron-only), so it
//      must fall through env → Keychain → non-vaulted config and otherwise report nothing.
//   2. transient failures degrade inertly — honour retry-after, back off on 5xx, and turn a malformed
//      body into an empty response instead of throwing. A worker must never crash or hang the process.
// Injected fetch + injected keychain → no network, no real Keychain. Wired into `npm run verify`.
//   node scripts/test-llm.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-llm-'));
const llm = require('../lib/llm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// Keep the ambient environment out of the assertions.
const SAVED = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, b: process.env.BHATBOT_ANTHROPIC_KEY };
delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.BHATBOT_ANTHROPIC_KEY;
const noKeychain = () => '';

// ---- key resolution ----
{
  const cfg = { apiKey: 'CRED_REF_APIKEY_ABC123', openaiKey: 'CRED_REF_OPENAIKEY_XYZ' };
  ok(llm.resolveKey('anthropic', { config: cfg, keychain: noKeychain }) === '',
    'resolveKey: a CRED_REF handle in config is NOT returned (it would 401 as a bearer token)');
  ok(llm.resolveKey('openai', { config: cfg, keychain: noKeychain }) === '', 'resolveKey: same for the openai handle');
  ok(llm.hasKey('anthropic', { config: cfg, keychain: noKeychain }) === false, 'hasKey: false when only a handle exists');

  // Precedence: env beats Keychain beats config.
  process.env.ANTHROPIC_API_KEY = 'sk-from-env';
  ok(llm.resolveKey('anthropic', { config: cfg, keychain: () => 'sk-from-keychain' }) === 'sk-from-env', 'resolveKey: env wins');
  delete process.env.ANTHROPIC_API_KEY;
  ok(llm.resolveKey('anthropic', { config: cfg, keychain: () => 'sk-from-keychain' }) === 'sk-from-keychain',
    'resolveKey: falls back to the macOS Keychain (the vault is Electron-only)');
  ok(llm.resolveKey('anthropic', { config: { apiKey: 'sk-plain-legacy' }, keychain: noKeychain }) === 'sk-plain-legacy',
    'resolveKey: a NON-vaulted config value still works (older installs)');
  ok(llm.resolveKey('anthropic', { config: {}, keychain: () => 'CRED_REF_LEAKED' }) === '',
    'resolveKey: a handle coming back from the Keychain is rejected too');

  process.env.BHATBOT_ANTHROPIC_KEY = 'sk-alt-env';
  ok(llm.resolveKey('anthropic', { config: {}, keychain: noKeychain }) === 'sk-alt-env', 'resolveKey: honours the BHATBOT_ANTHROPIC_KEY alias');
  delete process.env.BHATBOT_ANTHROPIC_KEY;

  ok(llm.resolveKey('openai', { config: { openaiKey: 'sk-oai' }, keychain: noKeychain }) === 'sk-oai', 'resolveKey: openai reads its own config key');
  ok(llm.resolveKey('anthropic', { config: { openaiKey: 'sk-oai' }, keychain: noKeychain }) === '', 'resolveKey: providers do not cross-contaminate');
  ok(llm.keychainRead('definitely-no-such-service-xyz') === '', 'keychainRead: a missing item returns "" (never throws)');
}

// ---- request behaviour ----
const okRes = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });
const errRes = (status, retryAfter) => ({
  ok: false, status,
  headers: { get: (h) => (h.toLowerCase() === 'retry-after' && retryAfter != null ? String(retryAfter) : null) },
  text: async () => 'server said no',
  json: async () => ({}),
});

(async () => {
  // No key at all → a clear, actionable error rather than a doomed request.
  // Inject an empty keychain + config: whether THIS machine's login Keychain holds a real key must
  // not decide whether the test passes.
  try {
    await llm.anthropicRequest({ messages: [] }, { apiKey: '', keychain: noKeychain, config: {}, fetchImpl: async () => okRes({ content: [] }) });
    ok(false, 'anthropicRequest: missing key should throw');
  } catch (e) {
    ok(/no Anthropic key/.test(e.message), 'anthropicRequest: no key → a clear error naming the cause');
    ok(/vault handle/.test(e.message), 'anthropicRequest: the error explains WHY a headless process has no key');
  }

  // Happy path + headers.
  {
    let seen = null;
    const r = await llm.anthropicRequest({ messages: [{ role: 'user', content: 'hi' }] }, {
      apiKey: 'sk-test',
      fetchImpl: async (url, init) => { seen = { url, init }; return okRes({ content: [{ type: 'text', text: 'hello' }] }); },
    });
    ok(r.content[0].text === 'hello', 'anthropicRequest: returns the parsed response');
    ok(seen.url === llm.API_URL, 'anthropicRequest: posts to the messages endpoint');
    ok(seen.init.headers['x-api-key'] === 'sk-test', 'anthropicRequest: sends x-api-key');
    ok(seen.init.headers['anthropic-version'], 'anthropicRequest: sends anthropic-version');
    ok(JSON.parse(seen.init.body).model === llm.DEFAULT_MODEL, 'anthropicRequest: defaults the model');
    ok(JSON.parse(seen.init.body).max_tokens > 0, 'anthropicRequest: always sets max_tokens');
  }

  // Malformed/empty body must be INERT, not fatal — a worker cannot crash on a bad response.
  {
    const r = await llm.anthropicRequest({ messages: [] }, { apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); }, headers: { get: () => null } }) });
    ok(r.content.length === 0 && r._malformed, 'anthropicRequest: unparseable body → { content: [] }, not a throw');
    const r2 = await llm.anthropicRequest({ messages: [] }, { apiKey: 'k', fetchImpl: async () => okRes({ nope: true }) });
    ok(r2._malformed === true, 'anthropicRequest: a response with no content array → flagged malformed');
  }

  // 429 honours retry-after, then succeeds.
  {
    let calls = 0; const waits = [];
    const t0 = Date.now();
    const r = await llm.anthropicRequest({ messages: [] }, {
      apiKey: 'k', retries: 2,
      log: (m) => waits.push(m),
      fetchImpl: async () => (++calls === 1 ? errRes(429, 0.05) : okRes({ content: [{ type: 'text', text: 'ok' }] })),
    });
    ok(calls === 2 && r.content[0].text === 'ok', 'anthropicRequest: retries after a 429 and succeeds');
    ok(waits.some((w) => /429/.test(w)), 'anthropicRequest: logs the backoff so a silent worker is debuggable');
    ok(Date.now() - t0 >= 45, 'anthropicRequest: actually waited the retry-after interval');
  }

  // 5xx retries then gives up with a real error.
  {
    let calls = 0;
    try {
      await llm.anthropicRequest({ messages: [] }, { apiKey: 'k', retries: 1, fetchImpl: async () => { calls++; return errRes(503); } });
      ok(false, 'anthropicRequest: exhausted 5xx retries should throw');
    } catch (e) { ok(calls === 2 && /failed after/.test(e.message), 'anthropicRequest: retries a 5xx, then reports failure'); }
  }

  // A 4xx that is not 429 must NOT be retried — repeating a bad request just wastes quota.
  {
    let calls = 0;
    try {
      await llm.anthropicRequest({ messages: [] }, { apiKey: 'k', retries: 3, fetchImpl: async () => { calls++; return errRes(400); } });
      ok(false, 'anthropicRequest: a 400 should throw');
    } catch (e) { ok(calls === 1 && /400/.test(e.message), 'anthropicRequest: a 400 fails fast (no pointless retries)'); }
  }

  // Network errors retry too.
  {
    let calls = 0;
    const r = await llm.anthropicRequest({ messages: [] }, {
      apiKey: 'k', retries: 2,
      fetchImpl: async () => { if (++calls === 1) throw new Error('ECONNRESET'); return okRes({ content: [{ type: 'text', text: 'recovered' }] }); },
    });
    ok(r.content[0].text === 'recovered', 'anthropicRequest: recovers from a transient network error');
  }

  // ask() convenience.
  {
    let body = null;
    const text = await llm.ask('what is 2+2', {
      system: 'be terse', maxTokens: 32, apiKey: 'k',
      fetchImpl: async (u, i) => { body = JSON.parse(i.body); return okRes({ content: [{ type: 'text', text: ' four ' }] }); },
    });
    ok(text === 'four', 'ask: returns trimmed text');
    ok(body.system === 'be terse' && body.max_tokens === 32, 'ask: passes system + maxTokens through');
    const empty = await llm.ask('x', { apiKey: 'k', fetchImpl: async () => okRes({ content: [] }) });
    ok(empty === '', 'ask: an empty reply → "" rather than a throw');
  }

  // ---- no electron anywhere in the require graph (the entire point of this module) ----
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'llm.js'), 'utf8');
  ok(!/require\(['"]electron['"]\)/.test(src), 'lib/llm.js: never requires electron');
  ok(!Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/]electron[\\/]/.test(k)), 'lib/llm.js: pulls in no electron transitively');

  Object.entries({ ANTHROPIC_API_KEY: SAVED.a, OPENAI_API_KEY: SAVED.o, BHATBOT_ANTHROPIC_KEY: SAVED.b })
    .forEach(([k, v]) => { if (v != null) process.env[k] = v; });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
