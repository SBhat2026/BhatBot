'use strict';
// The safeStorage READY GATE (lib/credentials.js).
//
// On macOS, safeStorage derives its Keychain key on FIRST USE and caches the result for the life of
// the process. main.js calls loadConfig() from module scope, before app.ready — so the first
// decryptString() happened while the Keychain was inaccessible, that failure was cached, and every
// later call failed too. Symptom: 13/13 vaulted secrets unreadable at runtime, with the app name,
// the vault file and the Keychain item all perfectly correct. The bug was purely call ORDER.
//
// Electron is not available in a plain node test, so these pin the two behaviours that make the gate
// safe: it must degrade cleanly with no Electron, and resolveRefs must FAIL SOFT (return the handle)
// rather than throw or return undefined — main.js's loadConfig relies on that to decline caching.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cred = require('../lib/credentials');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// The gate itself, read from source: the require must be guarded by an isReady() check.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'credentials.js'), 'utf8');
  const fn = src.slice(src.indexOf('function safe()'), src.indexOf('function canStore()'));
  ok(/isReady\s*\(\s*\)/.test(fn), 'safe() consults app.isReady() before handing out safeStorage');
  ok(/return null/.test(fn), 'and returns null (not the module) when the app is not ready yet');
  ok(/catch\s*\{\s*return null/.test(fn), 'and still degrades to null outside Electron entirely');
}

// Outside Electron (this process) safeStorage is unavailable — the whole module must stay usable.
{
  ok(cred.canStore() === false, 'canStore() is false with no Electron — callers gate vault writes on this');
  let threw = null;
  try { cred.resolve('CRED_REF_NOPE_1'); } catch (e) { threw = e.message; }
  ok(/Unknown credential ref|safeStorage/.test(threw || ''), 'resolve() throws a named error rather than returning garbage');
}

// FAIL SOFT is the contract loadConfig depends on: an unresolvable handle comes back AS the handle,
// so `hasRef()` can spot it and main.js can refuse to cache a half-resolved config.
{
  const cfg = { apiKey: 'CRED_REF_APIKEY_ABC', port: 8788, nested: { tok: 'CRED_REF_TOK_1' }, arr: ['CRED_REF_A_1'] };
  const out = cred.resolveRefs(cfg);
  ok(out.apiKey === 'CRED_REF_APIKEY_ABC', 'an unresolvable ref is returned unchanged, not dropped or nulled');
  ok(out.port === 8788, 'non-secret values pass through');
  ok(out.nested.tok === 'CRED_REF_TOK_1' && out.arr[0] === 'CRED_REF_A_1', 'nested objects and arrays are walked');
  ok(cred.hasRef(out) === true, 'hasRef() detects the surviving handle — this is what stops the poisoned cache');
  ok(cred.hasRef(cred.resolveRefs({ a: 'plain' })) === false, 'hasRef() is false once nothing is left to resolve');
}

// With a working resolver injected, everything resolves and hasRef goes quiet.
{
  const out = cred.resolveRefs({ apiKey: 'CRED_REF_APIKEY_ABC', u: 'https://x/mac/CRED_REF_TOK_1' }, (r) => 'real-' + r.slice(9, 15));
  ok(out.apiKey === 'real-APIKEY', 'an injected resolver is used');
  ok(out.u === 'https://x/mac/real-TOK_1', 'a ref EMBEDDED in a larger string is substituted in place — this is the cloud-bridge url case');
  ok(cred.hasRef(out) === false, 'a fully resolved config reports no refs, so main.js may cache it');
}

console.log(`✅ credentials ready-gate: ${pass} assertions passed`);
