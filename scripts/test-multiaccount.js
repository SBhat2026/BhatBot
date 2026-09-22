#!/usr/bin/env node
'use strict';
// ── MULTIPLE GMAIL ACCOUNTS ───────────────────────────────────────────────────────────────────────
// One OAuth app, many refresh tokens. The policy being asserted here, in one line:
//
//     READS fan out across every connected account; WRITES go to one.
//
// That asymmetry is the point. A search that misses the inbox the thing is actually in is a wrong
// ANSWER; a draft sent from the wrong mailbox is a wrong ACTION. The first is worth spending an
// extra API round-trip on by default, the second is not worth ever guessing at.
//
// Everything below is pure — accounts(), accountFor() and mergeFanout() take a config and return a
// value — so the account model is testable without a token, a network, or Electron's vault.
const assert = require('assert');
const path = require('path');
const google = require(path.join(__dirname, '..', 'lib', 'google'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };

const CFG = {
  clientId: 'cid', clientSecret: 'csecret',
  accounts: [
    { email: 'Siddhant@Personal.com', refreshToken: 'tok-personal', primary: true, triage: true },
    { email: 'sb@school.edu', refreshToken: 'tok-school', label: 'school' },
    { email: 'me@work.io', refreshToken: 'tok-work', triage: true },
  ],
};

console.log('[multiaccount]');

// ── the account list ──────────────────────────────────────────────────────────────────────────────
{
  const a = google.accounts(CFG);
  assert.strictEqual(a.length, 3);
  assert.strictEqual(a[0].email, 'siddhant@personal.com', 'addresses normalise to lowercase — they are matched against user text');
  assert.ok(a[0].primary, 'the primary sorts first');
  assert.deepStrictEqual(a.filter((x) => x.triage).map((x) => x.email), ['siddhant@personal.com', 'me@work.io']);
  assert.strictEqual(a[1].triage, false, 'triage is OFF unless explicitly true — connecting an inbox must not enrol it');
  ok('accounts() normalises, orders primary first, and defaults triage to off');
}

// ── the legacy shape must keep working ────────────────────────────────────────────────────────────
{
  // Every config that predates this feature has one token at the top level. If that stops working,
  // multi-account is not a feature, it is a migration everyone has to perform by hand.
  const legacy = { clientId: 'c', clientSecret: 's', refreshToken: 'tok-old' };
  const a = google.accounts(legacy);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].refreshToken, 'tok-old');
  assert.ok(a[0].primary, 'the single legacy token is the primary, so writes still have a home');
  assert.strictEqual(google.accountFor(undefined, legacy).refreshToken, 'tok-old');
  ok('a pre-multi-account config is presented as one primary account, unchanged');
}

// ── selection ─────────────────────────────────────────────────────────────────────────────────────
{
  const by = (sel) => { const a = google.accountFor(sel, CFG); return a && a.email; };
  assert.strictEqual(by(undefined), 'siddhant@personal.com', 'no selector = the primary');
  assert.strictEqual(by('primary'), 'siddhant@personal.com');
  assert.strictEqual(by('sb@school.edu'), 'sb@school.edu', 'exact address');
  assert.strictEqual(by('school'), 'sb@school.edu', 'the label');
  assert.strictEqual(by('work'), 'me@work.io', 'a substring of the address');
  assert.strictEqual(by('SB@School.EDU'), 'sb@school.edu', 'case does not matter');
  ok('an account resolves by address, label, or substring');
}
{
  // THE IMPORTANT NEGATIVE. An unrecognised selector must NOT quietly fall back to the primary:
  // "draft this from my work address", typo'd, would then send from the personal one. Returning
  // null makes the caller deal with it.
  assert.strictEqual(google.accountFor('nonexistent-inbox', CFG), null);
  assert.strictEqual(google.accountFor('all', CFG), null, "'all' is a fan-out, not an account");
  ok('an unknown account selector returns null rather than silently using the primary');
}

// ── which accounts are usable ─────────────────────────────────────────────────────────────────────
{
  // A CRED_REF that never decrypted is configured on paper and unusable in practice — the exact
  // failure that made isConfigured() return true for weeks while nothing worked.
  const half = { ...CFG, accounts: [CFG.accounts[0], { email: 'x@y.com', refreshToken: 'CRED_REF_GOOGLE_X' }] };
  const usable = google.usableAccounts(half);
  assert.deepStrictEqual(usable.map((a) => a.email), ['siddhant@personal.com']);
  const refs = google.unresolvedRefs(half);
  assert.ok(refs.some((r) => r.includes('x@y.com')), 'the report names WHICH account is unresolved: ' + JSON.stringify(refs));
  ok('an unresolved token makes only its own account unusable, and it is named');
}
{
  // If every account's token is a handle, no writes have a home and the primary flag is meaningless.
  const dead = { clientId: 'c', clientSecret: 's', accounts: [{ email: 'a@b.c', refreshToken: 'CRED_REF_A' }] };
  assert.strictEqual(google.usableAccounts(dead).length, 0);
  assert.strictEqual(google.accountFor(undefined, dead), null);
  ok('with every token unresolved there is no primary to fall back to');
}

// ── the fan-out merge ─────────────────────────────────────────────────────────────────────────────
{
  const A = { email: 'a@x.com', label: 'a' }, B = { email: 'b@y.com', label: 'b' };
  const merged = google.mergeFanout([
    { account: A, ok: true, result: { success: true, results: [{ id: '1', subject: 'lease' }] } },
    { account: B, ok: true, result: { success: true, results: [{ id: '2', subject: 'lease renewal' }] } },
  ]);
  assert.strictEqual(merged.count, 2);
  // WHICH INBOX a result came from is the whole reason to fan out — a merged list that does not say
  // is worse than two separate lists.
  assert.deepStrictEqual(merged.results.map((r) => r.account), ['a@x.com', 'b@y.com']);
  assert.deepStrictEqual(merged.accounts, ['a@x.com', 'b@y.com']);
  assert.ok(!merged.errors, 'a clean fan-out reports no errors key');
  ok('a fan-out merges and tags every row with the account it came from');
}
{
  // ONE DEAD ACCOUNT MUST NOT FAIL THE CALL. A partial answer is useful; it just has to say so.
  const A = { email: 'a@x.com', label: 'a' }, B = { email: 'b@y.com', label: 'school' };
  const merged = google.mergeFanout([
    { account: A, ok: true, result: { success: true, results: [{ id: '1' }] } },
    { account: B, ok: false, error: 'invalid_grant' },
  ]);
  assert.strictEqual(merged.count, 1, 'the healthy account still answers');
  assert.ok(merged.success);
  assert.ok(merged.errors && merged.errors.some((e) => e.includes('school') && e.includes('invalid_grant')),
    'the broken account is named, with its reason: ' + JSON.stringify(merged.errors));
  ok('one expired account degrades the answer and says which — it does not withhold it');
}
{
  // ...and a fan-out where EVERYTHING failed must not look like "no results found".
  const merged = google.mergeFanout([
    { account: { email: 'a@x.com', label: 'a' }, ok: false, error: 'invalid_grant' },
    { account: { email: 'b@y.com', label: 'b' }, ok: false, error: 'invalid_grant' },
  ]);
  assert.strictEqual(merged.count, 0);
  assert.strictEqual(merged.success, false, 'zero results from two failures is a FAILURE, not an empty inbox');
  assert.strictEqual(merged.errors.length, 2);
  ok('an all-failed fan-out reports failure rather than an empty result set');
}
{
  // A skipped account (Google not configured for it) is reported the same way as a thrown one.
  const merged = google.mergeFanout([
    { account: { email: 'a@x.com', label: 'a' }, ok: true, result: { skipped: true, reason: 'not configured' } },
    { account: { email: 'b@y.com', label: 'b' }, ok: true, result: { success: true, results: [{ id: '9' }] } },
  ]);
  assert.strictEqual(merged.count, 1);
  assert.ok(merged.errors[0].includes('not configured'));
  ok('a skipped account is surfaced, not swallowed');
}

// ── isConfigured across accounts ──────────────────────────────────────────────────────────────────
{
  const saved = google.cfg;
  const withCfg = (c) => { google.setConfigResolver(() => ({ google: c })); return google.isConfigured(); };
  assert.strictEqual(withCfg(CFG), true);
  assert.strictEqual(withCfg({ clientId: 'c', clientSecret: 's', accounts: [] }), false, 'app creds alone are not configured');
  assert.strictEqual(withCfg({ clientId: 'CRED_REF_C', clientSecret: 's', accounts: CFG.accounts }), false,
    'an unresolved CLIENT id is not configured, however many accounts are listed');
  assert.strictEqual(withCfg({ clientId: 'c', clientSecret: 's', refreshToken: 'legacy' }), true, 'the legacy shape is configured');
  google.setConfigResolver(null);
  void saved;
  ok('isConfigured is true only with app credentials AND at least one usable account');
}

console.log(`[multiaccount] ${pass} groups passed`);
