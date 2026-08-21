'use strict';
// ── OUTBOUND SECRET REDACTION ────────────────────────────────────────────────────────────────────
// The inbound direction was already defended (lib/security.js sanitizes web/shell text before it
// enters model context). The OUTBOUND direction was not: every tool result — read_file contents,
// run_shell stdout, MCP plugin output — went to api.anthropic.com verbatim. `run_shell("printenv")`,
// `read_file(".env")` or a stack trace carrying an Authorization header was a straight exfil path,
// and the only redaction that existed (main.js redactSecrets) was applied to the system prompt and
// memory blocks, never to tool results.
//
// DESIGN — value-first, not shape-first. Two tiers, in this order:
//
//   1. EXACT VALUES. BhatBot knows its own secrets: loadConfig() resolves the vault's CRED_REF
//      handles in-process, and syncResolvedSecretsToEnv() bridges more into process.env. Matching
//      those literal strings has ZERO false positives and catches secrets no shape rule could know
//      (the AceData token, the MCP token, a Twilio SID) — including ones minted after this file was
//      written. This is the tier that actually does the work.
//
//   2. SHAPES, but only vendor-prefixed, unambiguous ones (sk-ant-…, AIza…, ghp_…, AKIA…). These
//      exist to catch a key we do NOT hold — one sitting in some other repo's .env that a shell
//      command happened to print.
//
// What is deliberately ABSENT is a generic "long alphanumeric string" rule. main.js's redactSecrets
// had one, and it is why `commit cf05ff6a1b2c3d4e5f60718293a4b5c6d7e8f901` reached the model as
// `commit [REDACTED_TOKEN]`: a 40-char git SHA has letters and digits, so it matched. Content
// hashes, base64 blobs and minified JS all matched too. Applying that rule to tool results — where
// SHAs and hashes are the whole point of the output — would have made the agent unable to read its
// own git log. Precision is a correctness requirement here, not a nicety.
//
// Pure + dependency-free so it is unit-testable headless and usable from the cloud brain.

const MARK = '[REDACTED]';

// Vendor-prefixed shapes only. Every one of these is anchored on a prefix that has no meaning
// outside "this is a credential", so a match is never a false positive on ordinary text.
const SHAPES = [
  { label: 'anthropic',  re: /\bsk-ant-(?:api|admin)[A-Za-z0-9_\-]{16,}/g },
  { label: 'openai',     re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{32,}/g },
  { label: 'google',     re: /\bAIza[0-9A-Za-z_\-]{30,}/g },
  { label: 'groq',       re: /\bgsk_[A-Za-z0-9]{20,}/g },
  { label: 'replicate',  re: /\br8_[A-Za-z0-9]{30,}/g },
  { label: 'slack',      re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'github',     re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { label: 'aws',        re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'stripe',     re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { label: 'hf',         re: /\bhf_[A-Za-z0-9]{30,}/g },
  { label: 'elevenlabs', re: /\bsk_[a-f0-9]{40,}/g },
  { label: 'jwt',        re: /\bey[A-Za-z0-9_\-]{10,}\.ey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g },
  { label: 'pem',        re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // Header/assignment forms: `Authorization: Bearer xyz`, `API_KEY=xyz`, `"token": "xyz"`. The VALUE
  // is replaced, the key name is kept, so the model still learns that an auth header was present.
  { label: 'bearer',     re: /\b(Authorization\s*:\s*(?:Bearer|Basic|token)\s+)([A-Za-z0-9._\-+/=]{12,})/gi, keep: 1 },
  { label: 'assignment', re: /\b((?:api[_-]?key|apikey|secret|passwd|password|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;}]{8,})/gi, keep: 1 },
];

// Values shorter than this are not redacted as exact matches: a 6-character "secret" is likelier to
// be a substring of ordinary prose than a credential, and blanking it would corrupt real output.
const MIN_VALUE_LEN = 12;

let _provider = null;          // () => string[] — the live secret values this machine holds
let _valueRe = null;           // compiled alternation over those values
let _valueKey = '';            // cheap fingerprint so we only recompile when the set actually changes

/**
 * Register the source of truth for tier-1 exact-value redaction.
 * @param {() => string[]} fn returns the CURRENT resolved secret values (config + env)
 */
function setSecretProvider(fn) { _provider = typeof fn === 'function' ? fn : null; _valueRe = null; _valueKey = ''; }

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compile (and cache) the exact-value matcher. Rebuilt only when the provider's output changes. */
function valueMatcher() {
  if (!_provider) return null;
  let vals;
  try { vals = _provider() || []; } catch { return null; }
  const clean = [...new Set(vals.filter((v) => typeof v === 'string' && v.length >= MIN_VALUE_LEN && !v.startsWith('CRED_REF')))];
  // Fingerprint on length+head so a rotated key of the same length still triggers a rebuild.
  const key = clean.map((v) => v.length + ':' + v.slice(0, 4)).sort().join('|');
  if (key === _valueKey) return _valueRe;
  _valueKey = key;
  if (!clean.length) { _valueRe = null; return null; }
  // Longest first: if one secret is a prefix of another, the longer must win.
  clean.sort((a, b) => b.length - a.length);
  _valueRe = new RegExp(clean.map(escapeRe).join('|'), 'g');
  return _valueRe;
}

/**
 * Redact secrets from a string. Exact known values first, then vendor shapes.
 * @param {string} text
 * @param {{ onHit?: (label:string)=>void }} [opts]
 * @returns {string} the text with every credential replaced by [REDACTED]
 */
function redact(text, opts = {}) {
  if (typeof text !== 'string' || !text) return text;
  const hit = opts.onHit || null;
  let out = text;
  const vre = valueMatcher();
  if (vre) {
    vre.lastIndex = 0;
    out = out.replace(vre, () => { if (hit) hit('known-value'); return MARK; });
  }
  for (const s of SHAPES) {
    s.re.lastIndex = 0;
    if (s.keep != null) {
      out = out.replace(s.re, (m, ...g) => { if (hit) hit(s.label); return g[s.keep - 1] + MARK; });
    } else {
      out = out.replace(s.re, () => { if (hit) hit(s.label); return MARK; });
    }
  }
  return out;
}

/** True if `text` contains anything this module would redact. Does not allocate a new string. */
function hasSecret(text) {
  if (typeof text !== 'string' || !text) return false;
  const vre = valueMatcher();
  if (vre) { vre.lastIndex = 0; if (vre.test(text)) return true; }
  for (const s of SHAPES) { s.re.lastIndex = 0; if (s.re.test(text)) return true; }
  return false;
}

/**
 * Redact every string inside a tool result, in place where possible.
 *
 * Walks rather than JSON round-tripping so a result carrying a Buffer, a big base64 screenshot or a
 * circular reference is not destroyed or re-serialized on every single tool call. Depth- and
 * breadth-capped: a pathological structure costs bounded time, and the cap is far above any real
 * tool result.
 *
 * @param {*} value any tool result
 * @param {{ onHit?: Function, _depth?: number, _seen?: WeakSet }} [opts]
 * @returns {*} the same shape, with strings redacted
 */
function redactDeep(value, opts = {}) {
  const depth = opts._depth || 0;
  if (depth > 8) return value;
  if (typeof value === 'string') return redact(value, opts);
  if (!value || typeof value !== 'object') return value;
  // Never walk into binary — a Buffer/TypedArray has no secrets we can match and stringifying it
  // would be ruinous on a multi-MB screenshot.
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
  const seen = opts._seen || new WeakSet();
  if (seen.has(value)) return value;
  seen.add(value);
  const next = { ...opts, _depth: depth + 1, _seen: seen };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 5000; i++) value[i] = redactDeep(value[i], next);
    return value;
  }
  for (const k of Object.keys(value)) {
    try { value[k] = redactDeep(value[k], next); } catch { /* frozen/getter-only — leave it */ }
  }
  return value;
}

module.exports = { redact, redactDeep, hasSecret, setSecretProvider, MARK, SHAPES, MIN_VALUE_LEN };
