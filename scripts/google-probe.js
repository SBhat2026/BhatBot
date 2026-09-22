#!/usr/bin/env node
'use strict';
// ── WHAT DO THE CONNECTED GOOGLE ACCOUNTS ACTUALLY RETURN? ────────────────────────────────────────
// A read-only probe, run under Electron so it can reach the vault: every connected account, asked
// the same question directly, with no model in the loop.
//
// This exists because asking the AGENT "did the fan-out work?" cannot answer the question. The model
// summarises, and two consecutive identical prompts came back with four results and then two — which
// could have been a broken fan-out, a caching bug, or the model simply reporting differently. A
// diagnostic that goes through a language model is not a diagnostic.
//
//   npx electron scripts/google-probe.js              # per-account, then the merged fan-out
//   npx electron scripts/google-probe.js "is:unread"  # same, with your own query
const path = require('path');
const ROOT = path.join(__dirname, '..');

async function ensureVault() {
  if (!process.versions.electron) return false;
  const { app } = require('electron');
  // safeStorage derives its Keychain item from the APP NAME; a script launched as `electron foo.js`
  // is called "Electron" and reads a different entry. Claim the real identity before ready.
  try { app.setName('bhatbot'); } catch {}
  await app.whenReady();
  return true;
}

(async () => {
  const electron = await ensureVault();
  const google = require(path.join(ROOT, 'lib', 'google'));
  const query = process.argv.find((a) => !a.startsWith('-') && !/electron|google-probe/.test(a)) || 'in:inbox';

  console.log(`\nprobe: gmailSearch(${JSON.stringify(query)}, { limit: 2 })   vault:${electron ? 'yes' : 'NO — run under electron'}\n`);

  const list = google.accounts();
  if (!list.length) { console.log('no accounts connected.'); process.exit(1); }

  console.log('── per account, asked directly ' + '─'.repeat(48));
  for (const a of list) {
    const r = await google.gmailSearchOne(query, { limit: 2, account: a });
    const n = (r && r.results && r.results.length) || 0;
    const why = r && (r.error || r.reason);
    console.log(`  ${a.primary ? '●' : '○'} ${(a.email || a.label).padEnd(32)} ${String(n).padStart(2)} result(s)${why ? '   ✗ ' + why : ''}`);
    for (const m of (r.results || [])) console.log(`      ${String(m.subject || '(no subject)').slice(0, 64)}`);
  }

  console.log('\n── the merged fan-out (what a tool call with no `account` returns) ' + '─'.repeat(13));
  const merged = await google.gmailSearch(query, { limit: 2 });
  console.log(`  success:${merged.success}  count:${merged.count}  accounts:[${(merged.accounts || []).join(', ')}]`);
  for (const m of (merged.results || [])) {
    console.log(`    ${String(m.account || '(untagged)').padEnd(32)} ${String(m.subject || '').slice(0, 52)}`);
  }
  if (merged.errors) console.log('  errors: ' + merged.errors.join(' | '));

  // The assertion that matters: the merge saw every account the per-account pass did.
  const tagged = new Set((merged.results || []).map((m) => m.account));
  const expected = list.filter((a) => a.usable).map((a) => a.email || a.label);
  const missing = expected.filter((e) => !tagged.has(e));
  console.log('\n' + (missing.length
    ? `⚠ ${missing.length} account(s) contributed nothing to the merge: ${missing.join(', ')}\n  (empty inbox, or the fan-out is not reaching them — compare with the per-account rows above)`
    : '✓ every connected account contributed to the merged result'));

  if (process.versions.electron) { try { require('electron').app.exit(0); } catch {} }
})().catch((e) => {
  console.error('✗', e.message);
  if (process.versions.electron) { try { require('electron').app.exit(1); } catch {} }
  process.exit(1);
});
