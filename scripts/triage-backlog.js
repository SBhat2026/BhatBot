'use strict';
// ── BACKLOG SWEEP (Phase A5) — DRY RUN BY DEFAULT ────────────────────────────────────────────────
// ~4,100 unarchived threads on the primary account, ~3,178 on the secondary. This is the largest
// single operation the system will ever perform and the one with the most downside if the rules are
// wrong, so it is dry-run unless --execute is passed AND a review file already exists.
//
//   node scripts/triage-backlog.js                          # dry run, primary, 30d+ → BACKLOG_REVIEW.md
//   node scripts/triage-backlog.js --older-than 90d --limit 2000
//   node scripts/triage-backlog.js --execute                # requires the review file to exist first
//
// Even with --execute it only ever touches class `noise` — never urgent/important/routine/ambiguous.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const google = require(path.join(ROOT, 'lib', 'google'));
const { fromGmail } = require(path.join(ROOT, 'lib', 'signals'));
const { classify, decide } = require(path.join(ROOT, 'lib', 'triage'));
const { createActionLog } = require(path.join(ROOT, 'lib', 'actionlog'));

const argv = process.argv.slice(2);
const flag = (name, def = null) => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def; };
const EXECUTE = argv.includes('--execute');
const OLDER = String(flag('older-than', '30d'));
const LIMIT = Number(flag('limit', 1500));
const OUT = path.join(ROOT, 'BACKLOG_REVIEW.md');

// The Google secrets live in the vault as CRED_REF handles and only decrypt through Electron's
// safeStorage — a bare `node scripts/triage-backlog.js` physically cannot read them. So this script
// runs under Electron (`npm run triage:backlog`) and waits for app-ready before touching the vault.
// A plain-node run still works if GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are exported.
async function ensureVaultReady() {
  if (!process.versions.electron) return;
  try {
    const { app } = require('electron');
    // CRITICAL, and non-obvious: macOS safeStorage derives its Keychain item from the APP NAME.
    // Launching a bare script as `electron scripts/foo.js` yields app.name === 'Electron', which
    // looks up a DIFFERENT Keychain entry and fails decryption with a generic
    // "Error while decrypting the ciphertext" — nothing that points at the real cause. The app runs
    // as `bhatbot` (package.json name), so this script must claim the same identity, BEFORE ready.
    app.setName(require(path.join(ROOT, 'package.json')).name);
    await app.whenReady();
    app.on('window-all-closed', () => {});      // no windows: don't let Electron quit under us
  } catch {}
}

(async () => {
  await ensureVaultReady();
  if (!google.isConfigured()) {
    const unresolved = google.unresolvedRefs();
    if (unresolved.length) {
      console.error(`Google credentials are vaulted and could not be decrypted here: ${unresolved.join(', ')}.`);
      console.error('Run this through Electron so safeStorage is available:  npm run triage:backlog');
      console.error('...or export GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN for a plain-node run.');
    } else {
      console.error('Google is not configured. Run `npm run google:auth` first.');
    }
    process.exit(1);
  }
  if (EXECUTE && !fs.existsSync(OUT)) {
    console.error(`Refusing to execute: ${path.basename(OUT)} does not exist.\nRun the dry run first and READ it before passing --execute.`);
    process.exit(1);
  }

  console.log(`[backlog] ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} · in:inbox older_than:${OLDER} · limit ${LIMIT}`);

  // A Google API failure must stop the run immediately and explain itself. `invalid_grant` in
  // particular means the REFRESH TOKEN is dead (Google expires them after 7 days while an OAuth app
  // is still in "Testing" publishing status) — that is a re-auth, not a bug, and saying so beats a
  // downstream TypeError. NOTE: process.exit() does not reliably halt under Electron, so these
  // guards throw instead.
  const die = (stage, r) => {
    const err = String((r && r.error) || 'unknown');
    let hint = '';
    if (/invalid_grant/.test(err)) hint = '\n  → The Google refresh token is EXPIRED or REVOKED. Re-run: npm run google:auth\n    (Google expires refresh tokens after 7 days while the OAuth app is in "Testing" status —\n     publish the app to "In production" in the Google Cloud console to stop this recurring.)';
    else if (/invalid_client/.test(err)) hint = '\n  → clientId/clientSecret did not resolve. Run this via `npm run triage:backlog` (Electron).';
    throw new Error(`${stage} failed: ${err}${hint}`);
  };

  console.log('[backlog] building sent-history index (the reciprocity signal)…');
  const sc = await google.gmailSentContacts({ limit: 400 });
  if (!sc || sc.success === false || sc.skipped) die('sent-history scan', sc);
  const sentContacts = sc.contacts || {};
  console.log(`[backlog] ${Object.keys(sentContacts).length} addresses you have written to`);

  const q = `in:inbox older_than:${OLDER}`;
  const scan = await google.gmailScan(q, { limit: LIMIT });
  if (!scan || scan.success === false || scan.skipped || !Array.isArray(scan.results)) die('inbox scan', scan);
  console.log(`[backlog] scanned ${scan.count} messages`);

  const rows = [];
  for (const m of scan.results) {
    const sig = fromGmail(m, { sentContacts });
    const v = classify(sig);
    const d = decide(sig, v, { mode: EXECUTE ? 'act' : 'propose', minConfidence: 0.85 });
    rows.push({ sig, v, d });
  }

  const byClass = {};
  for (const r of rows) (byClass[r.v.class] = byClass[r.v.class] || []).push(r);
  const senderCounts = {};
  for (const r of rows) senderCounts[r.sig.from] = (senderCounts[r.sig.from] || 0) + 1;
  const topSenders = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]).slice(0, 25);

  const archivable = rows.filter((r) => r.v.class === 'noise' && r.d.action.replace('proposed:', '') === 'mark_read_archive');

  // ── the review file ────────────────────────────────────────────────────────────────────────────
  const L = [];
  L.push('# BACKLOG REVIEW — proposed triage of the existing inbox', '');
  L.push(`_${EXECUTE ? 'EXECUTED' : 'Dry run'} · query \`${q}\` · ${scan.count} messages scanned · generated ${new Date().toISOString()}_`, '');
  L.push('## Summary', '');
  L.push('| class | count | what would happen |', '|---|---|---|');
  const WHAT = { urgent: 'surfaced immediately, **never touched**', important: 'left unread in the inbox, shown in the digest', routine: 'marked read, **kept** in the inbox', noise: 'marked read **and archived** (reversible)', ambiguous: '**left completely alone**' };
  for (const c of ['urgent', 'important', 'routine', 'noise', 'ambiguous']) {
    L.push(`| ${c} | ${(byClass[c] || []).length} | ${WHAT[c]} |`);
  }
  L.push('', `**${archivable.length} messages would be archived.** Everything else is left in place.`, '');
  L.push('> Read the `noise` table below before running with `--execute`. Any sender you would rescue should be added to `NEVER_ARCHIVE` in `lib/triage-table.js` first.', '');

  L.push('## Top senders by volume', '', '| n | sender | class |', '|---|---|---|');
  for (const [from, n] of topSenders) {
    const c = (rows.find((r) => r.sig.from === from) || {}).v;
    L.push(`| ${n} | ${from} | ${c ? c.class : '?'} |`);
  }
  L.push('');

  for (const c of ['urgent', 'important', 'noise', 'routine', 'ambiguous']) {
    const list = byClass[c] || [];
    if (!list.length) continue;
    L.push(`## ${c} — ${list.length}`, '');
    if (c === 'urgent') L.push('**These need your attention. Nothing here is ever auto-touched.**', '');
    L.push('| sender | subject | rule | conf | why |', '|---|---|---|---|---|');
    for (const r of list.slice(0, c === 'ambiguous' ? 150 : 400)) {
      const esc = (s) => String(s || '').replace(/\|/g, '\\|').slice(0, 90);
      L.push(`| ${esc(r.sig.from)} | ${esc(r.sig.subject)} | ${r.v.rule} | ${r.v.confidence} | ${esc(r.v.reasons[0])} |`);
    }
    if (list.length > 400) L.push(`| … | _${list.length - 400} more not shown_ | | | |`);
    L.push('');
  }
  fs.writeFileSync(OUT, L.join('\n'));
  console.log(`[backlog] wrote ${path.relative(ROOT, OUT)}`);
  console.log(`[backlog] class counts:`, Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.length])));

  if (!EXECUTE) {
    console.log(`\n[backlog] DRY RUN — nothing was modified. ${archivable.length} messages would be archived.`);
    console.log('[backlog] read BACKLOG_REVIEW.md, then re-run with --execute to apply.');
    return;
  }

  // ── execute: noise only, ledger first, batched ────────────────────────────────────────────────
  const alog = createActionLog({ dir: path.join(os.homedir(), '.bhatbot'), gmailLabel: google.gmailLabel });
  console.log(`[backlog] EXECUTING — archiving ${archivable.length} messages…`);
  for (const r of archivable) {
    alog.record({
      messageId: r.sig.id, threadId: r.sig.threadId, account: r.sig.account,
      from: r.sig.from, subject: r.sig.subject, cls: r.v.class, confidence: r.v.confidence,
      rule: r.v.rule, action: 'mark_read_archive', prevLabelIds: r.sig.labelIds, reasons: r.v.reasons,
    });
  }
  const res = await google.gmailBatchModify(archivable.map((r) => r.sig.id), { remove: ['UNREAD', 'INBOX'] });
  console.log(`[backlog] archived ${res.modified || 0}. Undo everything with: bhatbot "undo what you archived today"`);
})()
  .then(() => process.exit(0))            // under Electron nothing else would end the process
  .catch((e) => { console.error('[backlog] failed:', e && e.stack || e); process.exit(1); });
