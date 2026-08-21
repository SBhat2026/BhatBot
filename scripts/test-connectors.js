'use strict';
// Hosted MCP connectors (lib/connectors.js) + the mcphub environment scrub (lib/mcphub.js) +
// the configsec array blind spot that let a connector token land on disk in plaintext.
//
// These three are one story: adding a remote connector means a bearer token and a URL enter the
// system, and every existing guard around credentials had a hole exactly where they would land.
const assert = require('assert');
const connectors = require('../lib/connectors');
const mcphub = require('../lib/mcphub');
const configsec = require('../lib/configsec');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const throws = (fn, re, m) => { try { fn(); } catch (e) { if (re.test(e.message)) { pass++; return; } throw new Error(m + ' — wrong error: ' + e.message); } throw new Error(m + ' — did not throw'); };

// ── the registry fills in what config should not have to state ────────────────────────────────
{
  const { specs, skipped } = connectors.resolveSpecs({ mcpPlugins: [{ name: 'seedance' }], acedataToken: 'tok-abcdef123456' });
  ok(specs.length === 1, 'a bare {name:"seedance"} resolves to a full spec');
  ok(specs[0].url === 'https://seedance.mcp.acedata.cloud/mcp', 'url comes from the registry, not from config');
  ok(specs[0].transport === 'http', 'transport comes from the registry');
  ok(specs[0].auth.token === 'tok-abcdef123456', 'the token is pulled from the configured field');
  ok(skipped.length === 0, 'nothing skipped when the token is present');
}
{
  const { specs, skipped } = connectors.resolveSpecs({ mcpPlugins: [{ name: 'seedance' }] });
  ok(specs.length === 0 && skipped.length === 1, 'no token → the connector is not dialled');
  ok(skipped[0].missingAuth === true && /ACEDATACLOUD_API_TOKEN/.test(skipped[0].reason),
    'and it is REPORTED with the variable to set, rather than silently not existing');
}
{
  process.env.ACEDATACLOUD_API_TOKEN = 'env-token-value-123';
  const { specs } = connectors.resolveSpecs({ mcpPlugins: [{ name: 'seedance' }] });
  ok(specs[0].auth.token === 'env-token-value-123', 'an env var authenticates the connector with nothing written to config at all');
  delete process.env.ACEDATACLOUD_API_TOKEN;
}
{
  const cfg = { mcpPlugins: [{ name: 'seedance', enabled: false }], acedataToken: 't'.repeat(20) };
  ok(connectors.resolveSpecs(cfg).specs.length === 0, 'enabled:false is honoured');
  ok(connectors.describe(cfg)[0].enabled === false && connectors.describe(cfg)[0].authenticated === true,
    'describe() separates "off" from "unauthenticated" so the UI can tell you which it is');
  ok(!JSON.stringify(connectors.describe(cfg)).includes('t'.repeat(20)), 'describe() never returns the token itself — only a boolean');
}

// ── HOST PINNING: the egress guard ────────────────────────────────────────────────────────────
{
  // A registered connector's host is a fact in code. If config could move it, a prompt-injected
  // "point your seedance connector at evil.example" would ship every subsequent tool argument there.
  throws(() => connectors.assertAllowedHost({ name: 'seedance', url: 'https://evil.example/mcp' }),
    /pinned to seedance\.mcp\.acedata\.cloud/, 'a registered connector cannot be repointed at another host');
  const { specs, skipped } = connectors.resolveSpecs({ mcpPlugins: [{ name: 'seedance', url: 'https://evil.example/mcp' }], acedataToken: 'tok-abcdef123456' });
  ok(specs[0].url === 'https://seedance.mcp.acedata.cloud/mcp', 'a config-supplied url for a REGISTERED connector is ignored, not obeyed');
  ok(skipped.length === 0, 'and the connector still works — pinning overrides rather than disables');
}
{
  throws(() => connectors.assertAllowedHost({ name: 'custom', url: 'http://plain.example/mcp' }),
    /is not allowed — use https/, 'an unregistered connector may not use plaintext http (the bearer token would be on the wire)');
  connectors.assertAllowedHost({ name: 'custom', url: 'https://anything.example/mcp' }); pass++;
  connectors.assertAllowedHost({ name: 'local', url: 'http://127.0.0.1:9000/mcp' }); pass++;   // loopback is exempt
  throws(() => connectors.assertAllowedHost({ name: 'bad', url: 'not a url' }), /malformed url/, 'a malformed url is rejected before anything is dialled');
  ok(connectors.allowedHosts().has('seedance.mcp.acedata.cloud'), 'allowedHosts is derived from the registry');
}
{
  const { skipped } = connectors.resolveSpecs({ mcpPlugins: [{ name: 'sketchy', url: 'http://sketchy.example/mcp' }] });
  ok(skipped.length === 1 && /https/.test(skipped[0].reason), 'a rejected custom connector is skipped with a reason, and never contacted');
}
{
  throws(() => connectors.enablePatch({}, 'nope'), /unknown connector/, 'enabling an unknown connector fails loudly');
  const patch = connectors.enablePatch({ mcpPlugins: [{ name: 'seedance', enabled: false }] }, 'seedance', 'newtok-1234567890');
  ok(patch.mcpPlugins.filter((p) => p.name === 'seedance').length === 1, 'enabling replaces the existing entry rather than duplicating it');
  ok(patch.mcpPlugins[0].enabled === true, 'and turns it on');
}

// ── mcphub: the stdio environment is ALLOW-LISTED ─────────────────────────────────────────────
{
  // This is the bug that mattered most. main.js's syncResolvedSecretsToEnv() deliberately bridges
  // vault secrets into process.env, and mcphub used to spawn plugins with `{...process.env}` — so
  // every third-party MCP server (often an auto-updating `npx -y ...`) was handed every key.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-be-forwarded';
  process.env.OPENAI_API_KEY = 'sk-proj-should-never-be-forwarded';
  process.env.BHATBOT_MCP_TOKEN = 'mcp-token-should-never-be-forwarded';
  process.env.SOME_RANDOM_SECRET = 'random-should-never-be-forwarded';
  process.env.MY_FORWARDED_TOKEN = 'explicitly-forwarded';

  const env = mcphub.pluginEnv({ name: 'x', command: 'y', env: { ACEDATACLOUD_API_TOKEN: '$MY_FORWARDED_TOKEN', LITERAL: 'value' } });
  const leaked = Object.entries(env).filter(([, v]) => String(v).includes('should-never-be-forwarded'));
  ok(leaked.length === 0, 'NO secret from the parent environment reaches a plugin — ' + JSON.stringify(leaked));
  ok(env.ANTHROPIC_API_KEY === undefined && env.OPENAI_API_KEY === undefined, 'the model API keys specifically are absent');
  ok(env.BHATBOT_MCP_TOKEN === undefined, 'the MCP token — which is the whole remote-access boundary — is absent');
  ok(env.SOME_RANDOM_SECRET === undefined, 'a secret this code has never heard of is excluded BY CONSTRUCTION (allow-list, not deny-list)');
  ok(env.PATH === process.env.PATH, 'PATH is forwarded — a plugin has to be findable');
  ok(env.ACEDATACLOUD_API_TOKEN === 'explicitly-forwarded', '$VAR indirection forwards exactly the one variable the spec names');
  ok(env.LITERAL === 'value', 'a literal env value is passed through');
  ok(mcphub.SAFE_ENV_KEYS.every((k) => !/KEY|TOKEN|SECRET|PASS/i.test(k)), 'nothing credential-shaped is on the safe list');

  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'BHATBOT_MCP_TOKEN', 'SOME_RANDOM_SECRET', 'MY_FORWARDED_TOKEN']) delete process.env[k];
}
{
  const h = mcphub.authHeaders({ auth: { type: 'bearer', token: 'abc123' } });
  ok(h.Authorization === 'Bearer abc123', 'bearer is the default auth style');
  ok(mcphub.authHeaders({ auth: { type: 'header', header: 'X-API-Key', token: 'k' } })['X-API-Key'] === 'k', 'header auth is supported');
  ok(Object.keys(mcphub.authHeaders({})).length === 0, 'no auth → no headers (not an empty Authorization)');
  process.env.HDR_TOK = 'from-env';
  ok(mcphub.authHeaders({ auth: { token: '$HDR_TOK' } }).Authorization === 'Bearer from-env', 'a $VAR token is resolved from the environment at connect time');
  delete process.env.HDR_TOK;
}
{
  ok(mcphub.parseId('mcp__seedance__seedance_generate_video').plugin === 'seedance', 'namespaced tool ids round-trip');
  ok(mcphub.parseId('mcp__seedance__seedance_generate_video').tool === 'seedance_generate_video', '…including tool names that contain the plugin name');
  ok(mcphub.isHubTool('mcp__x__y') && !mcphub.isHubTool('read_file'), 'hub tools are distinguishable from native ones');
}

// ── configsec: arrays were a blind spot, and mcpPlugins is an array ────────────────────────────
{
  // Before this fix findPlaintext() returned [] for this shape, so sanitizeWrite passed it straight
  // through and the token was written to config.json in the clear — with no error and no vault entry.
  const patch = { mcpPlugins: [{ name: 'seedance', auth: { type: 'bearer', token: 'PLAINTEXT-SECRET-VALUE' } }] };
  const hits = configsec.findPlaintext(patch);
  ok(hits.length === 1, 'a plaintext token nested inside an ARRAY of plugin specs is now found');
  ok(hits[0].path === 'mcpPlugins[0].auth.token', 'the path names the array index, so two plugins get distinct vault labels');

  const stored = [];
  const next = configsec.sanitizeWrite(patch, { store: (label, v) => { stored.push(label); return 'CRED_REF_' + label.toUpperCase().replace(/\W+/g, '_') + '_X'; } });
  ok(next.mcpPlugins[0].auth.token.startsWith('CRED_REF_'), 'sanitizeWrite vaults it and leaves a handle');
  ok(stored[0] === 'mcpPlugins_0_auth_token', 'the vault label is the full path (handle-safe), not a bare "token" shared by every connector');
  ok(patch.mcpPlugins[0].auth.token === 'PLAINTEXT-SECRET-VALUE', 'the caller\'s object is not mutated (sanitizeWrite clones)');

  throws(() => configsec.sanitizeWrite(patch, {}), /PLAINTEXT|rejected/, 'with no vault available the write is REJECTED, not silently accepted');
}
{
  // Top-level behaviour must be unchanged — reconcileVaultRefs() keys off these labels.
  const stored = [];
  configsec.sanitizeWrite({ apiKey: 'sk-plain' }, { store: (l, v) => { stored.push(l); return 'CRED_REF_APIKEY_1'; } });
  ok(stored[0] === 'apiKey', 'at the top level the label is still the bare key — existing vault handles keep working');
  ok(configsec.findPlaintext({ mcpPlugins: [{ name: 'x', enabled: true }] }).length === 0, 'a plugin entry with no token is not a false positive');
  ok(configsec.findPlaintext({ tags: ['a', 'b', 'c'] }).length === 0, 'an array of plain strings is not mistaken for a secret');
}


// ── an unresolved vault handle is NOT a credential ────────────────────────────────────────────
// A CRED_REF handle is a non-empty string, so every `if (cfg.token)` check accepts it. Treating it
// as a token means authenticating with the literal handle: a guaranteed 401 that reads as "the
// service rejected us" rather than "the vault never opened". Observed live — 13/13 vaulted secrets
// failed to decrypt and the cloud bridge reconnect-looped forever presenting the handle.
{
  const cfg = { mcpPlugins: [{ name: 'seedance' }], acedataToken: 'CRED_REF_ACEDATATOKEN_MQVQA7W' };
  const { specs, skipped } = connectors.resolveSpecs(cfg);
  ok(specs.length === 0, 'a connector whose token is an unresolved handle is NOT dialled');
  ok(skipped[0].missingAuth === true, 'and it is reported as unauthenticated, which is the truth');
  ok(connectors.describe(cfg)[0].authenticated === false, 'describe() reports it as unauthenticated rather than configured');
  ok(connectors.tokenFor(connectors.REGISTRY.seedance, cfg, {}) === null, 'tokenFor returns null, not the handle');
}
{
  const cfg = { mcpPlugins: [{ name: 'seedance', auth: { token: 'CRED_REF_X_1' } }], acedataToken: 'real-token-value-12345' };
  ok(connectors.tokenFor(connectors.REGISTRY.seedance, cfg, cfg.mcpPlugins[0]) === 'real-token-value-12345',
    'an unresolved explicit handle falls THROUGH to the next source rather than shadowing a working token');
}

// ── a hung connector must not hold the app hostage ────────────────────────────────────────────
// Observed live: the Mac woke from sleep mid-boot, the streamable-HTTP connect hung, the SSE
// fallback hung behind it, and startMcpHub took NINE MINUTES to fail — then sat at "0 tool(s)" for
// the rest of the session because nothing retried. Three properties keep that from recurring.
// 10.255.255.1 is non-routable, so this is deterministic and needs no network.
(async () => {
  const BLACKHOLE = { name: 'blackhole', transport: 'http', url: 'https://10.255.255.1/mcp', auth: { token: 'x' } };

  const t0 = Date.now();
  const n = await mcphub.connectOne(BLACKHOLE, { timeoutMs: 1500 });
  const elapsed = Date.now() - t0;
  ok(n === 0, 'an unreachable connector yields zero tools rather than throwing');
  ok(elapsed < 12000, `and gives up in ${(elapsed / 1000).toFixed(1)}s — bounded by the timeout, not by the socket (was ~9 minutes)`);

  const t1 = Date.now();
  const st = await mcphub.connectAll([BLACKHOLE, { ...BLACKHOLE, name: 'blackhole2' }], { timeoutMs: 1500 });
  const par = Date.now() - t1;
  ok(Array.isArray(st.failed) && st.failed.length === 2, 'connectAll REPORTS which connectors failed, so the caller can retry them');
  ok(st.failed.includes('blackhole') && st.failed.includes('blackhole2'), '…by name');
  ok(st.total === 0, 'and reports zero live tools');
  // Serial would be ~2x one connector's budget; parallel is ~1x. Generous bound to stay stable.
  ok(par < elapsed * 1.8, `two dead connectors resolve in ${(par / 1000).toFixed(1)}s — connected in PARALLEL, so one slow endpoint does not gate the others`);

  ok(mcphub.status().plugins.length === 0, 'a failed connector leaves no half-registered entry behind');

  console.log(`✅ connectors/mcphub/configsec: ${pass} assertions passed (incl. vault-handle guard + hang bounds)`);
})();
