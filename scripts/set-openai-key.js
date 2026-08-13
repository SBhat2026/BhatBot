#!/usr/bin/env node
'use strict';
// Set the OpenAI key WITHOUT it ever touching shell history or landing on disk in plaintext.
//
// Usage (recommended — copy the key, then):
//     pbpaste | npm run key:openai
// or:
//     npm run key:openai          # prompts, reads one line from stdin
//
// Runs under Electron because the vault is safeStorage-backed and safeStorage derives its Keychain
// item from the app NAME — a script launched as `electron scripts/foo.js` is called "Electron" and
// would write to a keychain entry the app never reads. Same trap as google-auth.js / triage-backlog.js.
//
// The key is stored as a CRED_REF_* handle in config.json with the secret in the vault, exactly as
// the app's own saveConfig would, and is then VERIFIED with a real embedding call — because "saved"
// and "working" are different questions, and a dead OpenAI key degrades silently (embedBatch returns
// {skipped:true}), which is precisely how the knowledge graph froze without anyone noticing.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');

async function ensureVault() {
  if (!process.versions.electron) return false;
  const { app } = require('electron');
  app.setName(require(path.join(ROOT, 'package.json')).name);
  await app.whenReady();
  app.on('window-all-closed', () => {});
  return true;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      process.stdout.write('Paste your OpenAI key (sk-…), then press Enter:\n> ');
    }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; if (buf.includes('\n')) { process.stdin.pause(); resolve(buf); } });
    process.stdin.on('end', () => resolve(buf));
    setTimeout(() => { if (!buf) { process.stdin.pause(); resolve(''); } }, 120000);
  });
}

// process.exit() does NOT reliably halt under Electron — the runtime keeps executing the rest of
// the async function. That bit this very script: the verification correctly REJECTED a bad key,
// printed "Nothing was saved", and then carried straight on and saved it. Anything that must stop
// execution therefore throws, and the outer catch owns the exit.
function die(msg, hint) {
  const e = new Error(msg);
  e._hint = hint;
  throw e;
}

(async () => {
  const inElectron = await ensureVault();

  const key = String(process.env.OPENAI_KEY_INPUT || await readStdin() || '').trim();
  if (!key) die('No key provided.');
  if (!/^sk-/.test(key)) die(`That does not look like an OpenAI key (expected it to start with "sk-", got "${key.slice(0, 6)}…").`);

  // 1 ── VERIFY BEFORE SAVING. Storing a dead key is worse than storing none: it looks configured
  // and fails silently forever. Test with the real embedding endpoint the app actually uses.
  process.env.OPENAI_API_KEY = key;
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'semantic'))];
  const semantic = require(path.join(ROOT, 'lib', 'semantic'));
  process.stdout.write('→ verifying against api.openai.com… ');
  const probe = await semantic.embedBatch(['bhatbot key verification']);
  if (!probe || !probe.vecs || !probe.vecs[0] || probe.local) {
    console.log('FAILED');
    die('OpenAI rejected that key: ' + (probe && (probe.error || probe.fellBackFrom) || 'unknown'),
      'Nothing was saved. The existing configuration is untouched.');
  }
  console.log(`OK (${probe.model}, ${probe.vecs[0].length}d)`);

  // 2 ── STORE. Vault it when we can; never downgrade a working vault to plaintext.
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })();
  const credentials = require(path.join(ROOT, 'lib', 'credentials'));
  let stored = key, vaulted = false;
  if (inElectron && credentials.canStore()) {
    try { stored = credentials.store('openaiKey', 'openai', '', key); vaulted = true; } catch (e) { console.warn('  (vault write failed: ' + e.message + ')'); }
  }
  cfg.openaiKey = stored;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

  console.log(`✓ Saved${vaulted ? ' to the encrypted vault (config.json holds only a handle)' : ' — PLAINTEXT, safeStorage was unavailable'}.`);
  console.log('  Restart BhatBot (or it will pick this up on next launch) and the second brain will');
  console.log('  re-embed onto OpenAI vectors automatically — the store migrates itself.');
  if (process.versions.electron) { try { require('electron').app.exit(0); } catch {} }
  process.exit(0);
})().catch((e) => {
  console.error('✗', e.message);
  if (e && e._hint) console.error('  ' + e._hint);
  if (process.versions.electron) { try { require('electron').app.exit(1); } catch {} }
  process.exit(1);
});
