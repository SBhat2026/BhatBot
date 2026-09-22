#!/usr/bin/env node
'use strict';
// ── HIGH CARE ─────────────────────────────────────────────────────────────────────────────────────
// For a mailbox where a wrong archive is expensive. The asymmetry is the whole point: leaving a
// newsletter unread costs nothing, burying a note from an advisor, a registrar or a dean costs
// something real, and the ordinary ladder treats both mistakes as equal.
//
// "Act on noise, ask on the rest" — with a much narrower definition of noise. High care does not
// change the CLASSIFIER, only what the classifier is allowed to act on.
const assert = require('assert');
const path = require('path');
const triage = require(path.join(__dirname, '..', 'lib', 'triage'));

let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };

const sig = (o = {}) => ({
  source: 'gmail', actionable: true, id: 'm1', threadId: 't1',
  from: 'news@promo.example.com', fromDomain: 'promo.example.com', subject: 'Weekly digest',
  listUnsubscribe: true, labelIds: ['INBOX', 'UNREAD'], unread: true, inInbox: true,
  senderInSentHistory: null, iHaveRepliedInThread: false, isCalendarInvite: false, ...o,
});
const noise = (c = 0.97) => ({ class: 'noise', rule: 'R5', confidence: c, reasons: 'bulk' });
const ACT = { mode: 'act', care: 'high', ownDomain: 'princeton.edu' };

console.log('[highcare]');

{
  const d = triage.decide(sig(), noise(), ACT);
  assert.strictEqual(d.act, true, 'proven bulk from outside the institution is still archived: ' + d.why);
  ok('obvious outside bulk mail is still acted on — high care is not a mute');
}
{
  // THE CASE IT EXISTS FOR. A departmental listserv carries a List-Unsubscribe and is still the one
  // you cannot afford to bury, so the institution's own domain is excluded even when every other
  // signal says noise.
  const d = triage.decide(sig({ from: 'registrar@princeton.edu', fromDomain: 'princeton.edu' }), noise(0.99), ACT);
  assert.strictEqual(d.act, false);
  assert.match(d.why, /inside princeton\.edu/);
  assert.ok(d.action.startsWith('proposed:'), 'it is still proposed, not discarded');
  ok('mail from inside the institution is never auto-archived, even at 0.99 confidence');
}
{
  const d = triage.decide(sig({ from: 'x@eng.princeton.edu', fromDomain: 'eng.princeton.edu' }), noise(0.99), ACT);
  assert.strictEqual(d.act, false, 'a subdomain is still the institution');
  ok('subdomains of the institution are covered too');
}
{
  // Bulk must be DECLARED, not inferred. "This looks like a newsletter" is a guess; List-Unsubscribe
  // is the sender saying so. On a high-care mailbox only the declaration counts.
  const d = triage.decide(sig({ listUnsubscribe: false }), noise(0.99), ACT);
  assert.strictEqual(d.act, false);
  assert.match(d.why, /List-Unsubscribe/);
  ok('without a List-Unsubscribe header nothing is archived, however confident the classifier');
}
{
  const d = triage.decide(sig(), noise(0.9), ACT);
  assert.strictEqual(d.act, false);
  assert.match(d.why, /0\.95/);
  // ...and the same message clears the ordinary floor, which is what makes this a real difference.
  const std = triage.decide(sig(), noise(0.9), { mode: 'act' });
  assert.strictEqual(std.act, true, 'the standard ladder would have archived this one');
  ok('the confidence floor rises to 0.95 — a message the standard ladder archives, high care proposes');
}
{
  // High care must not weaken anything. urgent/important are untouchable in EVERY mode.
  for (const cls of ['urgent', 'important', 'ambiguous']) {
    const d = triage.decide(sig(), { class: cls, rule: 'R1', confidence: 0.99, reasons: '' }, ACT);
    assert.strictEqual(d.act, false, cls + ' must never be acted on');
  }
  ok('urgent, important and ambiguous remain untouchable');
}
{
  // Nothing changes for the ordinary mailboxes.
  const d = triage.decide(sig({ from: 'x@princeton.edu', fromDomain: 'princeton.edu' }), noise(0.9), { mode: 'act' });
  assert.strictEqual(d.act, true, 'standard care is unaffected by the high-care rules');
  ok('standard-care mailboxes behave exactly as before');
}
{
  // And in propose mode high care is irrelevant — nothing acts either way.
  const d = triage.decide(sig(), noise(0.99), { mode: 'propose', care: 'high', ownDomain: 'princeton.edu' });
  assert.strictEqual(d.act, false);
  assert.strictEqual(d.why, 'propose mode', 'propose mode short-circuits first: ' + d.why);
  ok('propose mode still wins — high care only narrows what ACT may touch');
}

console.log(`[highcare] ${pass} assertions passed`);
