'use strict';
// Encrypted credential vault (Phase 6.4). Secrets are encrypted at rest via Electron
// safeStorage (macOS Keychain-backed) and stored under opaque CRED_REF_* handles. The model
// only ever sees the handle; executeTool resolves it to the real secret in-process, ~ms
// before the tool runs, and the audit log records the handle, not the secret.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CREDS_FILE = path.join(os.homedir(), '.bhatbot', 'credentials.json');

function load() { try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); } catch { return {}; } }
function save(c) { fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true }); fs.writeFileSync(CREDS_FILE, JSON.stringify(c, null, 2)); }

function safe() { try { return require('electron').safeStorage; } catch { return null; } }
// True only inside the running app with OS-keychain-backed encryption available. Callers gate
// vault writes/migration on this (a plain node script / test process returns false).
function canStore() { const ss = safe(); try { return !!(ss && ss.isEncryptionAvailable()); } catch { return false; } }

function store(label, domain, username, secret) {
  const ss = safe();
  if (!ss || !ss.isEncryptionAvailable()) throw new Error('safeStorage unavailable (run inside the app)');
  // Unique handle: timestamp ALONE collides when two secrets are stored in the same millisecond
  // (e.g. the startup migration loop) — add random entropy so each ref is unique. (Phase 4 hardening.)
  const ref = `CRED_REF_${String(label).toUpperCase().replace(/\W+/g, '_')}_${Date.now().toString(36).toUpperCase()}${require('crypto').randomBytes(2).toString('hex').toUpperCase()}`;
  const c = load();
  c[ref] = { encrypted: ss.encryptString(String(secret)).toString('base64'), domain: domain || '', username: username || '', label };
  save(c);
  return ref;
}

function resolve(ref) {
  const ss = safe();
  const c = load();
  if (!c[ref]) throw new Error(`Unknown credential ref: ${ref}`);
  if (!ss) throw new Error('safeStorage unavailable');
  return ss.decryptString(Buffer.from(c[ref].encrypted, 'base64'));
}

function list() {
  return Object.entries(load()).map(([ref, v]) => ({ ref, label: v.label, domain: v.domain, username: v.username }));
}
function remove(ref) { const c = load(); delete c[ref]; save(c); }

// Resolve any CRED_REF_* placeholders inside a tool-input object to real secrets. Pure +
// testable (the resolver fn is injected so it can be mocked). Non-ref strings pass through.
function resolveRefs(obj, resolver = resolve) {
  if (typeof obj === 'string') return obj.replace(/CRED_REF_[A-Z0-9_]+/g, (ref) => { try { return resolver(ref); } catch { return ref; } });
  if (Array.isArray(obj)) return obj.map((v) => resolveRefs(v, resolver));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(v, resolver)]));
  return obj;
}
function hasRef(obj) { try { return /CRED_REF_[A-Z0-9_]+/.test(JSON.stringify(obj)); } catch { return false; } }

module.exports = { store, resolve, list, remove, resolveRefs, hasRef, canStore, CREDS_FILE };
