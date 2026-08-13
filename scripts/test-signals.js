'use strict';
// Phase A1 — the normalizer. The load-bearing assertion is that AppleScript-sourced signals are
// structurally incapable of being mutated.
const assert = require('assert');
const path = require('path');
const S = require(path.join(__dirname, '..', 'lib', 'signals'));

let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }

console.log('[signals]');

// 1. Both sources normalize to the same key set — triage must not care where a signal came from.
{
  const g = S.normalize({ id: 'm1', threadId: 't1', labelIds: ['INBOX'], internalDate: Date.now(),
    headers: { From: 'A <a@b.com>', Subject: 'hi', To: 'me@x.com' } }, 'gmail');
  const a = S.normalize({ sender: 'A <a@b.com>', subject: 'hi' }, 'applescript-mail');
  assert.deepStrictEqual(Object.keys(g).sort(), Object.keys(a).sort(), 'both sources must produce the same shape');
  ok('gmail and AppleScript signals normalize to an identical shape');
}

// 2. THE SAFETY PROPERTY: AppleScript is never actionable, and assertActionable enforces it.
{
  const a = S.normalize({ sender: 'x@y.com', subject: 's' }, 'applescript-mail');
  const c = S.normalize({ summary: 'Standup', start: new Date().toISOString() }, 'applescript-cal');
  assert.strictEqual(a.actionable, false);
  assert.strictEqual(c.actionable, false);
  assert.strictEqual(a.id, null, 'no stable id exists for an AppleScript message');
  assert.throws(() => S.assertActionable(a), /refusing to mutate/);
  assert.throws(() => S.assertActionable(c), /refusing to mutate/);
  ok('AppleScript signals are never actionable and assertActionable refuses them');
}

// 3. A gmail signal IS actionable — but only with an id.
{
  const g = S.normalize({ id: 'm1', threadId: 't', labelIds: [], headers: { From: 'a@b.com' } }, 'gmail');
  assert.strictEqual(g.actionable, true);
  assert.strictEqual(S.assertActionable(g), true);
  const noId = S.normalize({ threadId: 't', labelIds: [], headers: { From: 'a@b.com' } }, 'gmail');
  assert.throws(() => S.assertActionable(noId), /no message id/, 'actionable but id-less must still be refused');
  ok('gmail signals are actionable, but an id-less one is still refused');
}

// 4. Address parsing: display names, angle brackets, casing, multi-recipient.
{
  const g = S.normalize({ id: 'm', labelIds: [], headers: {
    From: '"Prof. Sanjay Sane" <Sane@NCBS.res.in>',
    To: 'me@x.com, Second <two@y.org>', Cc: 'three@z.net',
    'Reply-To': 'Reply <reply@ncbs.res.in>',
  } }, 'gmail');
  assert.strictEqual(g.from, 'sane@ncbs.res.in', 'addresses lowercase');
  assert.strictEqual(g.fromName, 'Prof. Sanjay Sane');
  assert.strictEqual(g.fromDomain, 'ncbs.res.in');
  assert.strictEqual(g.replyTo, 'reply@ncbs.res.in');
  assert.deepStrictEqual(g.to, ['me@x.com', 'two@y.org']);
  assert.deepStrictEqual(g.cc, ['three@z.net']);
  ok('addresses, display names and multi-recipient headers parse correctly');
}

// 5. List-Unsubscribe / List-Id → the bulk flag that gates all archiving.
{
  const bulk = S.normalize({ id: 'm', labelIds: [], headers: { From: 'a@b.com', 'List-Unsubscribe': '<mailto:u@b.com>' } }, 'gmail');
  const bulkById = S.normalize({ id: 'm', labelIds: [], headers: { From: 'a@b.com', 'List-Id': '<news.b.com>' } }, 'gmail');
  const plain = S.normalize({ id: 'm', labelIds: [], headers: { From: 'a@b.com' } }, 'gmail');
  assert.strictEqual(bulk.listUnsubscribe, true);
  assert.strictEqual(bulkById.listUnsubscribe, true, 'List-Id also marks bulk');
  assert.strictEqual(plain.listUnsubscribe, false);
  ok('List-Unsubscribe and List-Id both set the bulk flag');
}

// 6. Reciprocity is derived from the injected sent-history index, not a per-message fetch.
{
  const g = S.normalize({ id: 'm', labelIds: [], headers: { From: 'friend@x.com' } }, 'gmail',
    { sentContacts: { 'friend@x.com': { count: 4, lastAt: 1700000000000 } } });
  assert.strictEqual(g.iHaveRepliedInThread, true);
  assert.strictEqual(g.senderInSentHistory.count, 4);
  const stranger = S.normalize({ id: 'm', labelIds: [], headers: { From: 'nobody@x.com' } }, 'gmail', { sentContacts: {} });
  assert.strictEqual(stranger.iHaveRepliedInThread, false);
  assert.strictEqual(stranger.senderInSentHistory, null);
  ok('sent-history drives reciprocity without a per-message thread fetch');
}

// 7. labelIds pass through verbatim — the ledger needs them for exact undo.
{
  const g = S.normalize({ id: 'm', labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS', 'IMPORTANT'], headers: { From: 'a@b.com' } }, 'gmail');
  assert.deepStrictEqual(g.labelIds, ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS', 'IMPORTANT']);
  assert.strictEqual(g.unread, true);
  assert.strictEqual(g.inInbox, true);
  assert.strictEqual(g.gmailCategory, 'promotions');
  ok('labelIds pass through verbatim (required for exact undo)');
}

// 8. Garbage in → a usable signal out, never a throw. This runs on a background tick.
{
  for (const bad of [{}, { headers: null }, { headers: { From: null } }, { id: 1, headers: {} }]) {
    const g = S.normalize(bad, 'gmail');
    assert.ok(g, 'must return a signal');
    assert.strictEqual(typeof g.from, 'string');
    assert.strictEqual(typeof g.subject, 'string');
  }
  assert.strictEqual(S.normalize({}, 'nonsense-source'), null, 'an unknown source returns null, not a fake signal');
  ok('malformed input yields a usable signal; an unknown source returns null');
}

console.log(`[signals] ${pass} assertions passed`);
