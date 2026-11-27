#!/usr/bin/env node
'use strict';
// Tests for lib/bgllm.js — background LLM routing: subscription (`claude -p`) first, metered API as
// fallback. Fake spawn + fake apiRequest + temp ledger → no CLI, no network, no spend.
//   node scripts/test-bgllm.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const bg = require('../lib/bgllm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-bgllm-'));
const ledgerPath = path.join(TMP, 'costs.json');
const day = new Date().toISOString().slice(0, 10);
const led = () => { try { return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))[day] || {}; } catch { return {}; } };

// fake `claude` child: scripted stdout/stderr/exit, records args + env + stdin
function fakeSpawn(script, seen = {}) {
  return (bin, args, o) => {
    seen.bin = bin; seen.args = args; seen.env = o.env; seen.cwd = o.cwd; seen.calls = (seen.calls || 0) + 1;
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdin = { end: (d) => { seen.stdin = d; } };
    c.kill = () => {};
    setImmediate(() => {
      if (script.enoent) { const e = new Error('spawn claude ENOENT'); e.code = 'ENOENT'; return c.emit('error', e); }
      if (script.out) c.stdout.emit('data', script.out);
      if (script.err) c.stderr.emit('data', script.err);
      c.emit('close', script.code == null ? 0 : script.code);
    });
    return c;
  };
}
const good = (text = 'hello') => ({ out: JSON.stringify({ type: 'result', is_error: false, result: text, total_cost_usd: 0.012, usage: { input_tokens: 10, output_tokens: 5 } }) });
const body = { model: 'claude-sonnet-5', max_tokens: 100, system: 'be brief', messages: [{ role: 'user', content: 'hi' }] };

(async () => {
  // ── toggle ──
  ok(bg.enabled({}) === true, 'toggle: default ON when billing missing');
  ok(bg.enabled({ billing: {} }) === true, 'toggle: default ON when key missing');
  ok(bg.enabled({ billing: { backgroundViaSubscription: false } }) === false, 'toggle: explicit false turns it OFF');

  // ── child env strips every metered key ──
  const env = bg.childEnv({ ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_AUTH_TOKEN: 't', BHATBOT_ANTHROPIC_KEY: 'k', HOME: '/h', PATH: '/bin' });
  ok(env.ANTHROPIC_API_KEY === undefined && env.ANTHROPIC_AUTH_TOKEN === undefined && env.BHATBOT_ANTHROPIC_KEY === undefined, 'childEnv: API key vars removed');
  ok(env.HOME === '/h', 'childEnv: other vars kept');

  // ── eligibility / mapping ──
  ok(bg.cliEligible(body), 'eligible: plain text exchange');
  ok(!bg.cliEligible({ ...body, tools: [{ name: 't' }] }), 'ineligible: tools');
  ok(!bg.cliEligible({ ...body, messages: [{ role: 'user', content: [{ type: 'image' }] }] }), 'ineligible: image block');
  ok(bg.modelAlias('claude-haiku-5') === 'haiku' && bg.modelAlias('claude-opus-5') === 'opus' && bg.modelAlias('claude-sonnet-5') === 'sonnet', 'model alias mapping');
  ok(/JSON schema/.test(bg.toPrompt({ ...body, _reason: { schema: { type: 'object' } } }).system), 'schema → JSON instruction in system prompt');

  // ── happy path: subscription, no API call, ledger tagged ──
  bg.resetCooldown();
  let apiCalls = 0; const api = async () => { apiCalls++; return { content: [{ type: 'text', text: 'FROM API' }], usage: { input_tokens: 1, output_tokens: 1 } }; };
  let seen = {};
  let r = await bg.backgroundRequest(body, { apiRequest: api, config: {}, spawnImpl: fakeSpawn(good('sub text'), seen), ledgerPath, label: 'synapse' });
  ok(r._billing === 'subscription' && bg.textOf(r) === 'sub text', 'subscription: CLI result returned, tagged');
  ok(apiCalls === 0, 'subscription: API NOT called');
  ok(seen.args.includes('-p') && seen.args[seen.args.indexOf('--model') + 1] === 'sonnet', 'CLI invoked as `claude -p --model sonnet`');
  ok(seen.env.ANTHROPIC_API_KEY === undefined, 'CLI child env has no ANTHROPIC_API_KEY');
  ok(seen.stdin === 'hi', 'prompt delivered on stdin (not argv)');
  ok(led().byBilling && led().byBilling.subscription.calls === 1 && led().byBilling.subscription.equivUsd > 0, 'ledger: subscription call tagged with equivalent $');
  ok(!led().usd, 'ledger: metered usd untouched by a subscription call');
  ok(led().bySource['synapse:subscription'] === 1, 'ledger: per-caller source tag');

  // ── toggle off → API only ──
  apiCalls = 0; seen = {};
  r = await bg.backgroundRequest(body, { apiRequest: api, config: { billing: { backgroundViaSubscription: false } }, spawnImpl: fakeSpawn(good(), seen), ledgerPath });
  ok(r._billing === 'api' && apiCalls === 1 && !seen.calls, 'toggle off: API used, CLI never spawned');

  // ── tools → API without touching the CLI ──
  apiCalls = 0; seen = {};
  r = await bg.backgroundRequest({ ...body, tools: [{ name: 'x' }] }, { apiRequest: api, config: {}, spawnImpl: fakeSpawn(good(), seen), ledgerPath });
  ok(r._billing === 'api' && apiCalls === 1 && !seen.calls, 'tool request: API, CLI untouched');

  // ── fallbacks ──
  bg.resetCooldown(); apiCalls = 0;
  r = await bg.backgroundRequest(body, { apiRequest: api, config: {}, spawnImpl: fakeSpawn({ enoent: true }), ledgerPath });
  ok(r._billing === 'api' && apiCalls === 1, 'CLI missing (ENOENT) → API fallback');

  bg.resetCooldown(); apiCalls = 0;
  r = await bg.backgroundRequest(body, { apiRequest: api, config: {}, spawnImpl: fakeSpawn({ out: JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached|1700000000' }), code: 1 }), ledgerPath });
  ok(r._billing === 'api' && apiCalls === 1, 'CLI rate-limited → API fallback');

  // cooldown: the next call must not even spawn the CLI
  seen = {}; apiCalls = 0;
  r = await bg.backgroundRequest(body, { apiRequest: api, config: {}, spawnImpl: fakeSpawn(good(), seen), ledgerPath });
  ok(r._billing === 'api' && !seen.calls, 'cooldown after rate limit: CLI skipped');
  // …and expires
  seen = {};
  r = await bg.backgroundRequest(body, { apiRequest: api, config: {}, spawnImpl: fakeSpawn(good('back'), seen), ledgerPath, now: () => Date.now() + bg.COOLDOWN_MS.rate_limited + 1000 });
  ok(r._billing === 'subscription' && bg.textOf(r) === 'back', 'cooldown expires → subscription resumes');

  bg.resetCooldown(); apiCalls = 0;
  r = await bg.backgroundRequest(body, { apiRequest: api, config: {}, spawnImpl: fakeSpawn({ err: 'Not logged in · Please run /login', code: 1 }), ledgerPath });
  ok(r._billing === 'api' && apiCalls === 1, 'CLI logged out → API fallback');

  bg.resetCooldown(); apiCalls = 0;
  r = await bg.backgroundRequest(body, { apiRequest: api, config: {}, spawnImpl: fakeSpawn({ out: 'garbage', code: 2 }), ledgerPath });
  ok(r._billing === 'api' && apiCalls === 1, 'CLI generic failure → API fallback');
  ok(led().byBilling.api.calls >= 4, 'ledger: API fallbacks tagged api');

  // API fallback failing propagates (caller already handles API errors)
  bg.resetCooldown();
  let threw = false;
  try { await bg.backgroundRequest(body, { apiRequest: async () => { throw new Error('no key'); }, config: {}, spawnImpl: fakeSpawn({ enoent: true }), ledgerPath }); } catch (e) { threw = /no key/.test(e.message); }
  ok(threw, 'both paths fail → API error surfaces');

  // ── agentRequest (backlog): read-only built-in tools, fallback to metered loop ──
  bg.resetCooldown(); seen = {};
  let ar = await bg.agentRequest('plan x', { config: {}, spawnImpl: fakeSpawn(good('plan!'), seen), ledgerPath, label: 'backlog', cwd: TMP, system: 'persona' });
  ok(ar.billing === 'subscription' && ar.text === 'plan!' && ar.usd === 0, 'agentRequest: subscription, $0');
  ok(seen.args[seen.args.indexOf('--tools') + 1] === 'Read,Grep,Glob,WebSearch,WebFetch' && seen.cwd === TMP, 'agentRequest: read-only tool set, cwd honoured');
  ok(!seen.args.join(' ').match(/Write|Edit|Bash/), 'agentRequest: no write/shell tools granted');
  bg.resetCooldown();
  ar = await bg.agentRequest('plan x', { config: {}, spawnImpl: fakeSpawn({ enoent: true }), ledgerPath, label: 'backlog', apiFallback: async () => ({ ok: true, text: 'api plan', usd: 0.3 }) });
  ok(ar.billing === 'api' && ar.text === 'api plan' && ar.usd === 0.3, 'agentRequest: CLI down → metered fallback with its $');

  // ── background context: only chains inside runBackground are marked ──
  ok(bg.backgroundLabel() === null, 'context: outside a tick → interactive (null)');
  let inside = null, siblingOutside = 'unset';
  await Promise.all([
    bg.runBackground('weaver', async () => { await new Promise((r) => setTimeout(r, 5)); inside = bg.backgroundLabel(); }),
    (async () => { await new Promise((r) => setTimeout(r, 2)); siblingOutside = bg.backgroundLabel(); })(),
  ]);
  ok(inside === 'weaver', 'context: inside runBackground → label visible across awaits');
  ok(siblingOutside === null, 'context: concurrent interactive chain is NOT marked');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
