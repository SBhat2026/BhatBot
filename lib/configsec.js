'use strict';
// Config credential security (Phase 4, Deliverable #1). Three jobs:
//   1. migrate(): move plaintext secrets in config.json → the safeStorage vault, leaving CRED_REF_*
//      handles behind. Runs once at app startup (vault encryption needs the running Electron app).
//   2. assertWritable(): a WRITE-TIME schema validator — config saves carrying a plaintext credential
//      are rejected (or auto-vaulted), so self_fix/self_heal code-edit paths can never persist a new
//      plaintext key. Enforces "no plaintext credentials on disk" going forward.
//   3. isSecretKey()/looksLikeRef(): shared predicates.
//
// A credential KEY is matched by name (the directive's regex: *_key/*_token/*_secret/*_password) plus
// a few explicit names that don't fit the suffix pattern (apiKey, mcpToken, rateLimitTokens, …).
// A secret VALUE is "plaintext" when it's a non-empty string that is NOT already a CRED_REF handle.

// snake_case / whole-word (case-insensitive) — but NOT "monkey"/"turkey" (suffix must be a word edge)
const SECRET_KEY_SNAKE = /(^|_)(key|token|secret|password|passwd)s?$/i;
// camelCase — a lowercase letter immediately followed by a capitalized secret suffix (openaiKey, gmailAppPassword)
const SECRET_KEY_CAMEL = /[a-z](Key|Token|Secret|Password|Passwd)s?$/;
const SECRET_KEY_RE = SECRET_KEY_SNAKE;   // kept exported for back-compat
const EXPLICIT_SECRET_KEYS = new Set([
  'apiKey', 'mcpToken', 'rateLimitTokens', 'cloudToken', 'spotifyRefreshToken',
  'spotifyClientSecret', 'gmailAppPassword', 'twilioToken', 'darkbloomKey',
]);
// Keys that LOOK like secrets by name but are NOT (ids/voice handles/booleans) — never vault these.
const NOT_SECRET_KEYS = new Set(['elevenLabsVoiceId', 'spotifyClientId', 'twilioSid', 'twilioAccountSid', 'voiceId']);

function isSecretKey(k) {
  if (NOT_SECRET_KEYS.has(k)) return false;
  return EXPLICIT_SECRET_KEYS.has(k) || SECRET_KEY_SNAKE.test(k) || SECRET_KEY_CAMEL.test(k);
}
function looksLikeRef(v) { return typeof v === 'string' && /^CRED_REF_[A-Z0-9_]+$/.test(v); }
function isPlaintextSecret(k, v) {
  return isSecretKey(k) && typeof v === 'string' && v.length > 0 && !looksLikeRef(v);
}

// Find every plaintext secret in an object, recursing through nested objects (e.g.
// gmailAccounts["a@x.com"].appPassword). `parentObj` lets the caller rewrite the value in place.
function findPlaintext(obj, prefix = '', depth = 0, parentObj = null) {
  const hits = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 5) return hits;
  for (const [k, v] of Object.entries(obj)) {
    if (isPlaintextSecret(k, v)) hits.push({ path: prefix + k, key: k, value: v, container: obj });
    else if (v && typeof v === 'object' && !Array.isArray(v)) hits.push(...findPlaintext(v, prefix + k + '.', depth + 1, obj));
  }
  return hits;
}

// WRITE-TIME validator. `patch` is what a caller is trying to merge into config.
//   • auto-vault available → returns a sanitized patch with secrets replaced by refs (no plaintext lands)
//   • no vault (e.g. outside the app) → throws, so the plaintext write is REJECTED, not silently kept
// `store(label, value)` should mint+persist a CRED_REF and return the handle.
function sanitizeWrite(patch, { store } = {}) {
  if (!findPlaintext(patch).length) return patch;
  if (!store) {
    const e = new Error(`config write rejected: plaintext credential(s) [${findPlaintext(patch).map((h) => h.path).join(', ')}] — must be vaulted, not written as plaintext`);
    e.code = 'PLAINTEXT_CRED_BLOCKED';
    throw e;
  }
  const next = JSON.parse(JSON.stringify(patch));
  for (const h of findPlaintext(next)) h.container[h.key] = store(h.key, h.value);   // container points into the clone
  return next;
}

// One-shot migration of an existing config object. Returns { next, migrated:[paths] }.
// `store` is required (must be in-app). Idempotent: already-ref values are skipped.
function migrate(cfg, { store }) {
  const next = JSON.parse(JSON.stringify(cfg || {}));
  const migrated = [];
  for (const h of findPlaintext(next)) {
    try { h.container[h.key] = store(h.key, h.value); migrated.push(h.path); }
    catch { /* leave this one; surfaced by caller via the leftover check */ }
  }
  return { next, migrated };
}

module.exports = { isSecretKey, looksLikeRef, isPlaintextSecret, findPlaintext, sanitizeWrite, migrate, SECRET_KEY_RE };
