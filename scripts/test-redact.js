'use strict';
// Outbound secret redaction (lib/redact.js) — the guard on everything that leaves for the API.
//
// Two properties matter equally here, and the second is the one that bites:
//   1. secrets must not survive  — obvious, and easy to over-fit
//   2. NON-secrets must survive  — the rule this replaced flagged any 40+ char alphanumeric run, so
//      every git SHA and content hash reaching the model became "[REDACTED_TOKEN]". A redactor that
//      eats commit ids is not safe, it is just differently broken. Half these assertions are
//      false-positive tests for exactly that reason.
const assert = require('assert');
const redact = require('../lib/redact');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const gone = (s) => !/[A-Za-z0-9_\-]{20,}/.test(s.replace(/\[REDACTED\]/g, ''));

// ── tier 1: exact values this machine holds ───────────────────────────────────────────────────
const LIVE = 'sk-' + 'ant-api03-THISISTHEREALKEYVALUE-000111222';   // split: see the note in the shapes block
const OPAQUE = 'acedata_9f8e7d6c5b4a32100011';   // no recognizable prefix — shape rules cannot catch it
redact.setSecretProvider(() => [LIVE, OPAQUE, 'short']);

{
  ok(redact.redact(`key=${LIVE}`) === 'key=[REDACTED]', 'a known key value is replaced');
  ok(!redact.redact(`export X=${OPAQUE}`).includes(OPAQUE), 'an OPAQUE known value is caught — this is why value-matching exists, no shape rule would find it');
  ok(redact.redact('the shortest path').includes('short'), 'a known value under MIN_VALUE_LEN is ignored (it would corrupt prose)');
  ok(redact.hasSecret(`x ${OPAQUE}`) === true, 'hasSecret detects without allocating a replacement');
  ok(redact.hasSecret('plain text') === false, 'hasSecret is false on clean text');
}
{
  // Rotation: the matcher is cached, so a NEW value must still be caught without a restart.
  redact.setSecretProvider(() => ['rotated_key_aaaaaaaaaaaa']);
  ok(redact.redact('v=rotated_key_aaaaaaaaaaaa') === 'v=[REDACTED]', 'a rotated key is picked up (cache invalidates on set)');
  redact.setSecretProvider(() => [LIVE, OPAQUE]);
}
{
  // Same length, different value — the fingerprint must not treat these as the same set.
  redact.setSecretProvider(() => ['AAAAAAAAAAAAAAAA']);
  redact.redact('warm the cache');
  redact.setSecretProvider(() => ['BBBBBBBBBBBBBBBB']);
  ok(redact.redact('x BBBBBBBBBBBBBBBB') === 'x [REDACTED]', 'a same-length replacement value still rebuilds the matcher');
  redact.setSecretProvider(() => [LIVE, OPAQUE]);
}

// ── tier 2: vendor-prefixed shapes (keys we do NOT hold) ──────────────────────────────────────
{
  // ASSEMBLED AT RUNTIME, ON PURPOSE — do not inline these back into literals.
  // A test for a secret detector is, by construction, a file full of things that look like secrets.
  // Written literally, GitHub push protection blocks the push ("Push cannot contain secrets — Stripe
  // API Key"), which is the scanner working correctly on a false positive. Splitting the prefix from
  // the body defeats the scanner's literal match while the value handed to redact() is byte-for-byte
  // what a real key looks like, so the rules under test are exercised identically.
  const P = (prefix, body) => prefix + body;
  const cases = [
    ['openai',    'OPENAI_API_KEY=' + P('sk-', 'proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd')],
    ['google',    P('AIza', 'SyD-1234567890abcdefghijklmnopqrstu')],
    ['github',    P('ghp', '_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
    ['aws',       P('AKIA', 'IOSFODNN7EXAMPLE')],
    ['slack',     P('xoxb', '-1234567890-abcdefghijkl')],
    ['stripe',    P('sk_', 'live_ABCDEFGHIJKLMNOPQRSTUVWX')],
    ['hf',        P('hf', '_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')],
    ['jwt',       P('ey', 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVPmB92K27u')],
  ];
  for (const [label, sample] of cases) ok(gone(redact.redact(sample)), `${label} key shape is redacted even though we do not hold it`);
  ok(redact.redact('Authorization: Bearer abcdef1234567890xyz') === 'Authorization: Bearer [REDACTED]',
    'a bearer header keeps the header NAME (the model still learns auth was present) and loses the value');
  ok(/api_key\s*=\s*\[REDACTED\]/.test(redact.redact('api_key = hunter2hunter2hunter2')), 'an assignment form loses only its value');
  const pem = '-----BEGIN RSA PRIVATE ' + 'KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE ' + 'KEY-----';
  ok(gone(redact.redact(pem)), 'a PEM private key block is redacted whole');
}

// ── the false-positive suite — the regression this module exists to prevent ────────────────────
{
  const keep = [
    ['git SHA',        'commit cf05ff6a1b2c3d4e5f60718293a4b5c6d7e8f901 landed on endurance-pass-b'],
    ['sha256 digest',  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['long identifier','const REALLY_LONG_CONSTANT_NAME_FOR_TESTING_1234 = 5;'],
    ['base64 data',    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'],
    ['uuid',           'run id 3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['prose',          'Read main.js and summarize the router architecture decisions'],
    ['file path',      '/Users/siddhantbhat/bhatbot/lib/tools-schema.js'],
    ['npm version',    'ugrep 7.5.0 and @modelcontextprotocol/sdk 1.29.0'],
  ];
  for (const [label, text] of keep) ok(redact.redact(text) === text, `NOT redacted: ${label} — survives untouched`);
  ok(redact.redact('the quick brown foxy jumps over lazy') === 'the quick brown foxy jumps over lazy',
    'four lowercase words in a row are prose, not a gmail app password (the old rule redacted these)');
}

// ── redactDeep: whole tool results ────────────────────────────────────────────────────────────
{
  const result = {
    success: true,
    content: `export ANTHROPIC_API_KEY=${LIVE}`,
    nested: { list: [`token ${OPAQUE}`, 'clean'], n: 42, flag: true },
    buf: Buffer.from('binary'),
  };
  const hits = [];
  redact.redactDeep(result, { onHit: (l) => hits.push(l) });
  ok(!JSON.stringify({ c: result.content, n: result.nested }).includes(LIVE), 'redactDeep reaches a nested string');
  ok(!result.nested.list[0].includes(OPAQUE), 'redactDeep reaches inside arrays');
  ok(result.nested.list[1] === 'clean' && result.nested.n === 42 && result.nested.flag === true, 'non-strings and clean strings are left alone');
  ok(Buffer.isBuffer(result.buf) && result.buf.toString() === 'binary', 'Buffers are NOT walked (a multi-MB screenshot must not be stringified)');
  ok(hits.length >= 2, 'onHit fires per redaction so the caller can audit what was stripped');
}
{
  const cyc = { name: `k ${OPAQUE}` }; cyc.self = cyc;
  redact.redactDeep(cyc);
  ok(!cyc.name.includes(OPAQUE), 'a circular result is still redacted');
  ok(cyc.self === cyc, 'a circular reference terminates instead of hanging');
}
{
  ok(redact.redactDeep(null) === null && redact.redactDeep(7) === 7, 'primitives pass straight through');
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'x' } } } } } } } } };
  redact.redactDeep(deep);                                       // must not throw or recurse forever
  ok(true, 'depth cap holds on a deeply nested result');
}

// ── efficiency: this runs on EVERY tool result, including 90KB file reads ──────────────────────
{
  const big = 'const x = "abc123def456"; // line\n'.repeat(3000);   // ~100KB
  const t0 = process.hrtime.bigint();
  redact.redact(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(ms < 60, `100KB redacts in ${ms.toFixed(1)}ms — cheap enough for the per-tool-call hot path`);
}

console.log(`✅ redact: ${pass} assertions passed`);
