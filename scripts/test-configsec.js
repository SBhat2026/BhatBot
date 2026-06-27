#!/usr/bin/env node
'use strict';
// Unit tests for the Phase-4 credential-security core: lib/configsec.js (the "no plaintext creds on
// disk" write-time guard + migration) and lib/credentials.resolveRefs (CRED_REF resolution). Pure
// functions — run in plain node, no Electron/keychain. Guards the security invariants the rest of the
// app trusts. Wired into `npm run verify`.
//   node scripts/test-configsec.js
const cs = require('../lib/configsec');
const cred = require('../lib/credentials');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };
const throws = (fn, code, m) => { try { fn(); ok(false, m + ' (did not throw)'); } catch (e) { ok(e.code === code, m + (e.code === code ? '' : ` (got code=${e.code})`)); } };

// ---- isSecretKey ----
for (const k of ['apiKey', 'mcpToken', 'openaiKey', 'gmail_app_password', 'twilioToken', 'anthropic_key',
                 'foo_secret', 'barPassword', 'cloudToken', 'spotifyRefreshToken', 'spotifyClientSecret',
                 'DARKBLOOM_KEY', 'some_passwd'])
  ok(cs.isSecretKey(k), `isSecretKey("${k}") → true`);
for (const k of ['elevenLabsVoiceId', 'spotifyClientId', 'twilioSid', 'twilioAccountSid', 'voiceId',
                 'monkey', 'turkey', 'username', 'cloudUrl', 'mcpPort', 'keyboard', 'tokenizer'])
  ok(!cs.isSecretKey(k), `isSecretKey("${k}") → false`);

// ---- looksLikeRef ----
ok(cs.looksLikeRef('CRED_REF_MCPTOKEN_ABC123'), 'looksLikeRef(uppercase ref) → true');
ok(!cs.looksLikeRef('cred_ref_lower'), 'looksLikeRef(lowercase) → false');
ok(!cs.looksLikeRef('sk-realsecret'), 'looksLikeRef(plaintext) → false');
ok(!cs.looksLikeRef(''), 'looksLikeRef("") → false');

// ---- isPlaintextSecret ----
ok(cs.isPlaintextSecret('apiKey', 'sk-abc'), 'plaintext apiKey → true');
ok(!cs.isPlaintextSecret('apiKey', 'CRED_REF_APIKEY_X1'), 'already-vaulted apiKey → false');
ok(!cs.isPlaintextSecret('apiKey', ''), 'empty apiKey → false');
ok(!cs.isPlaintextSecret('apiKey', 12345), 'numeric "secret" key → false (type guard)');
ok(!cs.isPlaintextSecret('username', 'siddhant'), 'non-secret key → false');

// ---- findPlaintext (nesting, refs, arrays, depth) ----
const cfg = {
  apiKey: 'sk-top',
  username: 'sid',
  mcpToken: 'CRED_REF_MCPTOKEN_AA11',                 // already vaulted — skip
  gmailAccounts: { 'a@x.com': { appPassword: 'hunter2', label: 'main' } },  // nested plaintext
  logins: { 'github.com': { credRef: 'CRED_REF_GITHUB_BB22', username: 'sid' } }, // ref nested — skip
  tags: ['key', 'token'],                              // array of secret-looking strings — must be ignored
};
const hits = cs.findPlaintext(cfg);
const paths = hits.map((h) => h.path).sort();
ok(paths.includes('apiKey'), 'findPlaintext → top-level apiKey');
ok(paths.includes('gmailAccounts.a@x.com.appPassword'), 'findPlaintext → nested appPassword');
ok(!paths.includes('mcpToken'), 'findPlaintext → skips already-vaulted ref');
ok(!paths.some((p) => p.startsWith('logins')), 'findPlaintext → skips nested ref + non-secret');
ok(!paths.some((p) => p.startsWith('tags')), 'findPlaintext → ignores arrays');
ok(hits.length === 2, `findPlaintext → exactly 2 plaintext hits (got ${hits.length})`);

// ---- sanitizeWrite: no store → REJECT ----
throws(() => cs.sanitizeWrite({ apiKey: 'sk-leak' }), 'PLAINTEXT_CRED_BLOCKED', 'sanitizeWrite w/o store → throws PLAINTEXT_CRED_BLOCKED');
ok(cs.sanitizeWrite({ port: 8788, name: 'x' }) && true, 'sanitizeWrite of non-secret patch → passes through');

// ---- sanitizeWrite: with store → vaults, clones, leaves non-secrets ----
{
  const minted = [];
  const store = (label, value) => { const ref = `CRED_REF_${label.toUpperCase()}_T${minted.length}`; minted.push({ label, value, ref }); return ref; };
  const patch = { apiKey: 'sk-secret', mcpPort: 8788, nested: { twilioToken: 'tw-xyz' } };
  const out = cs.sanitizeWrite(patch, { store });
  ok(cs.looksLikeRef(out.apiKey), 'sanitizeWrite → apiKey replaced with ref');
  ok(cs.looksLikeRef(out.nested.twilioToken), 'sanitizeWrite → nested twilioToken replaced with ref');
  ok(out.mcpPort === 8788, 'sanitizeWrite → non-secret preserved');
  ok(patch.apiKey === 'sk-secret', 'sanitizeWrite → original patch NOT mutated (clone)');
  ok(minted.length === 2, 'sanitizeWrite → store called once per secret');
  ok(cs.findPlaintext(out).length === 0, 'sanitizeWrite → output has zero plaintext secrets');
}

// ---- migrate: vaults + idempotent ----
{
  const store = (label, value) => `CRED_REF_${label.toUpperCase()}_M`;
  const r1 = cs.migrate({ apiKey: 'sk-1', port: 80 }, { store });
  ok(r1.migrated.includes('apiKey') && cs.looksLikeRef(r1.next.apiKey), 'migrate → vaults plaintext');
  const r2 = cs.migrate(r1.next, { store });
  ok(r2.migrated.length === 0, 'migrate → idempotent (already-ref values skipped)');
}

// ---- credentials.resolveRefs (injected resolver) ----
{
  const R = (ref) => ({ 'CRED_REF_A_1': 'secretA', 'CRED_REF_B_2': 'secretB' })[ref] || (() => { throw new Error('unknown'); })();
  ok(cred.resolveRefs('CRED_REF_A_1', R) === 'secretA', 'resolveRefs → bare ref string');
  ok(cred.resolveRefs('Bearer CRED_REF_A_1 end', R) === 'Bearer secretA end', 'resolveRefs → embedded ref in string');
  const o = cred.resolveRefs({ a: 'CRED_REF_A_1', b: ['CRED_REF_B_2', 5], c: true }, R);
  ok(o.a === 'secretA' && o.b[0] === 'secretB' && o.b[1] === 5 && o.c === true, 'resolveRefs → nested obj/array/passthrough');
  ok(cred.resolveRefs('CRED_REF_MISSING_9', R) === 'CRED_REF_MISSING_9', 'resolveRefs → unknown ref left intact (graceful)');
  ok(cred.hasRef({ x: { y: 'CRED_REF_A_1' } }), 'hasRef → detects nested ref');
  ok(!cred.hasRef({ x: 'plain' }), 'hasRef → false when no ref');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
