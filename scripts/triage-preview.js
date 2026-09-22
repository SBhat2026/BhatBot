#!/usr/bin/env node
'use strict';
// ── WHAT WOULD TRIAGE DO, AND WHAT DOES CARE CHANGE? ──────────────────────────────────────────────
// Reads one account's inbox and runs the real classifier over it under BOTH care levels, side by
// side, touching nothing. Read-only: it never calls decide() with mode 'act', so there is no path
// from here to a mutation.
//
// It exists because "high care is safer" is a claim about behaviour, and the only way to know is to
// point it at the actual mailbox and see which messages change verdict. A rule that never fires on
// real mail is not protection, it is decoration.
//
//   npx electron scripts/triage-preview.js sb9699@princeton.edu [days]
const path = require('path');
const ROOT = path.join(__dirname, '..');

async function ready() {
  if (!process.versions.electron) return false;
  const { app } = require('electron');
  try { app.setName('bhatbot'); } catch {}
  await app.whenReady();
  return true;
}

(async () => {
  const vault = await ready();
  const google = require(path.join(ROOT, 'lib', 'google'));
  const signals = require(path.join(ROOT, 'lib', 'signals'));
  const triage = require(path.join(ROOT, 'lib', 'triage'));

  const args = process.argv.filter((a) => !/electron|triage-preview/.test(a) && !a.startsWith('-'));
  const want = args.find((a) => a.includes('@')) || '';
  const days = Number(args.find((a) => /^\d+$/.test(a))) || 2;

  const acct = google.accountFor(want || 'primary');
  if (!acct) { console.error('no such account: ' + want); process.exit(1); }
  console.log(`\npreview: ${acct.email}   care=${acct.care}   last ${days}d   vault:${vault ? 'yes' : 'no'}`);
  console.log('READ-ONLY — nothing is labelled, archived or marked.\n');

  const scan = await google.gmailScan(`in:inbox newer_than:${days}d`, { limit: 60, account: acct });
  if (!scan || scan.success === false) { console.error('scan failed: ' + (scan && (scan.error || scan.reason))); process.exit(1); }

  const ownDomain = (acct.email.split('@')[1] || '');
  const rows = [];
  for (const m of scan.results || []) {
    const sig = signals.fromGmail(m, { account: acct.email });
    const v = triage.classify(sig, { now: Date.now() });
    // Both verdicts computed as if acting, so the COMPARISON is meaningful. Nothing is executed.
    const std = triage.decide(sig, v, { mode: 'act' });
    const high = triage.decide(sig, v, { mode: 'act', care: 'high', ownDomain });
    rows.push({ sig, v, std, high });
  }

  const mark = (d) => (d.act ? 'ARCHIVE' : 'ask    ');
  console.log('  standard │ high care │ class      from');
  console.log('  ─────────┼───────────┼────────────────────────────────────────────────');
  for (const r of rows) {
    const differs = r.std.act !== r.high.act;
    console.log(`  ${mark(r.std)}  │ ${mark(r.high)}   │ ${String(r.v.class).padEnd(9)}  ${String(r.sig.from).slice(0, 38)}${differs ? '   ← high care SPARED this' : ''}`);
  }

  const spared = rows.filter((r) => r.std.act && !r.high.act);
  console.log(`\n  ${rows.length} scanned · standard would archive ${rows.filter((r) => r.std.act).length} · high care would archive ${rows.filter((r) => r.high.act).length}`);
  if (spared.length) {
    console.log('\n  SPARED BY HIGH CARE — the standard ladder would have archived these:');
    for (const r of spared) console.log(`    ${String(r.sig.from).slice(0, 40).padEnd(42)} ${r.high.why}`);
  } else {
    console.log('\n  Nothing differed in this window. That is a real result, not a pass: on this sample the');
    console.log('  extra rules never fired, so try a longer window before concluding they protect anything.');
  }
  if (process.versions.electron) { try { require('electron').app.exit(0); } catch {} }
})().catch((e) => { console.error('✗', e.message); if (process.versions.electron) { try { require('electron').app.exit(1); } catch {} } });
