'use strict';
// Phase A4 — one full triage pass, against a mocked Gmail. The decisive assertions:
// propose mode must make ZERO mutating calls, and act mode must touch ONLY noise.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { createTriageRun } = require(path.join(ROOT, 'lib', 'triagerun'));
const { createActionLog } = require(path.join(ROOT, 'lib', 'actionlog'));

let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bhattick-'));

// A realistic inbox: one of each class.
const INBOX = [
  { id: 'u1', from: 'no-reply@accounts.google.com', subject: 'Security alert: new sign-in', unsub: false },
  { id: 'u2', from: 'Manus <no-reply@manus.im>', subject: 'Action Required: your data will be permanently deleted on Aug 23', unsub: false },
  { id: 'i1', from: 'pramodv@princeton.edu', subject: 'dinner sunday', unsub: false },
  { id: 'i2', from: 'gijs@adaptyvbio.com', subject: 'binder round 3 results', unsub: false },
  { id: 'r1', from: 'receipts@openrouter.ai', subject: 'Your receipt', unsub: false },
  { id: 'n1', from: 'no-reply@strava.com', subject: 'You earned a badge!', unsub: true },
  { id: 'n2', from: 'nytdirect@nytimes.com', subject: 'Your Evening Briefing', unsub: true },
  { id: 'n3', from: 'hello@vuori.com', subject: '40% off everything', unsub: true },
  { id: 'a1', from: 'stranger@nowhere.xyz', subject: 'quick question', unsub: false },
];

function mockGoogle(inbox = INBOX) {
  const calls = { label: [], batch: [], scan: 0, sent: 0 };
  const labels = new Map(inbox.map((m) => [m.id, ['INBOX', 'UNREAD']]));
  return {
    calls, labels,
    isConfigured: () => true,
    gmailSentContacts: async () => { calls.sent++; return { success: true, contacts: { 'gijs@adaptyvbio.com': { count: 6, lastAt: Date.now() } } }; },
    gmailScan: async () => {
      calls.scan++;
      return { success: true, count: inbox.length, results: inbox.map((m) => ({
        id: m.id, threadId: 't_' + m.id, labelIds: labels.get(m.id) || ['INBOX', 'UNREAD'], internalDate: Date.now(),
        headers: { From: m.from, Subject: m.subject, To: 'siddhantbhat3@gmail.com', ...(m.unsub ? { 'List-Unsubscribe': '<mailto:u@x>' } : {}) },
      })) };
    },
    gmailLabel: async (id, { add = [], remove = [] } = {}) => {
      calls.label.push({ id, add, remove });
      const cur = new Set(labels.get(id) || []);
      for (const l of remove) cur.delete(l);
      for (const l of add) cur.add(l);
      labels.set(id, [...cur]);
      return { success: true };
    },
  };
}

(async () => {
  console.log('[triage-tick]');

  // 1. PROPOSE MODE MUTATES NOTHING. This is the entire basis of a safe review week.
  {
    const g = mockGoogle();
    const alog = createActionLog({ dir: fs.mkdtempSync(path.join(TMP, 'p-')), gmailLabel: g.gmailLabel });
    const run = createTriageRun({ google: g, actionLog: alog, config: { mode: 'propose' } });
    const r = await run.runOnce();
    assert.strictEqual(g.calls.label.length, 0, 'propose mode must make ZERO gmailLabel calls');
    assert.ok(r.proposed.length >= 3, 'proposals should still be recorded');
    assert.ok(r.urgent.length === 2, 'urgent still surfaces in propose mode');
    for (const e of alog.recent({ limit: 50 })) assert.ok(e.action.startsWith('proposed:'), 'every ledger entry is a proposal');
    ok('propose mode records proposals and mutates nothing');
  }

  // 2. ACT MODE TOUCHES ONLY NOISE.
  {
    const g = mockGoogle();
    const alog = createActionLog({ dir: fs.mkdtempSync(path.join(TMP, 'a-')), gmailLabel: g.gmailLabel });
    const run = createTriageRun({ google: g, actionLog: alog, config: { mode: 'act' } });
    const r = await run.runOnce();

    const touched = new Set(g.calls.label.map((c) => c.id));
    // ONLY noise. `routine` (r1, a receipt) is deliberately NOT touched: the ladder would mark it
    // read, but marking a receipt read is still a mutation, and the autonomy granted was for
    // newsletters and promos. actClasses defaults to ['noise'] and gates this.
    assert.deepStrictEqual([...touched].sort(), ['n1', 'n2', 'n3'], 'only the three noise messages may be touched');
    for (const id of ['u1', 'u2', 'i1', 'i2', 'a1', 'r1']) assert.ok(!touched.has(id), `${id} must never be mutated`);
    // noise is archived: INBOX and UNREAD both dropped.
    for (const c of g.calls.label.filter((x) => ['n1', 'n2', 'n3'].includes(x.id))) {
      assert.deepStrictEqual(c.remove.sort(), ['INBOX', 'UNREAD']);
    }
    assert.strictEqual(r.acted.length, 3);
    ok('act mode archives only noise; urgent/important/ambiguous untouched');
  }

  // 3. EVERY MUTATION HAS A LEDGER ENTRY WITH prevLabelIds — the undo guarantee.
  {
    const g = mockGoogle();
    const dir = fs.mkdtempSync(path.join(TMP, 'l-'));
    const alog = createActionLog({ dir, gmailLabel: g.gmailLabel });
    const run = createTriageRun({ google: g, actionLog: alog, config: { mode: 'act' } });
    await run.runOnce();
    const mutating = alog.recent({ limit: 50 }).filter((e) => !e.action.startsWith('proposed:'));
    assert.strictEqual(mutating.length, g.calls.label.length, 'one ledger entry per mutation, exactly');
    for (const e of mutating) {
      assert.ok(Array.isArray(e.prevLabelIds) && e.prevLabelIds.length, 'prevLabelIds must be captured');
      assert.deepStrictEqual(e.prevLabelIds.sort(), ['INBOX', 'UNREAD']);
    }
    // ...and undo really restores them.
    const r = await alog.undoAll({});
    assert.strictEqual(r.undone, mutating.length);
    for (const id of ['n1', 'n2', 'n3']) assert.deepStrictEqual([...g.labels.get(id)].sort(), ['INBOX', 'UNREAD'], `${id} restored`);
    ok('every mutation is ledgered with prevLabelIds and is fully reversible');
  }

  // 4. Idempotent across ticks — a message already handled is never acted on twice.
  {
    const g = mockGoogle();
    const alog = createActionLog({ dir: fs.mkdtempSync(path.join(TMP, 'i-')), gmailLabel: g.gmailLabel });
    const run = createTriageRun({ google: g, actionLog: alog, config: { mode: 'act' } });
    await run.runOnce();
    const after1 = g.calls.label.length;
    const r2 = await run.runOnce();
    assert.strictEqual(g.calls.label.length, after1, 'a second tick must not re-act on the same messages');
    assert.ok(r2.skipped > 0);
    ok('a message is never acted on twice across ticks');
  }

  // 5. The confidence floor is honoured at the tick level.
  {
    const g = mockGoogle();
    const alog = createActionLog({ dir: fs.mkdtempSync(path.join(TMP, 'c-')), gmailLabel: g.gmailLabel });
    const run = createTriageRun({ google: g, actionLog: alog, config: { mode: 'act', minConfidence: 0.99 } });
    await run.runOnce();
    assert.strictEqual(g.calls.label.length, 0, 'nothing clears a 0.99 floor → nothing is touched');
    ok('raising the confidence floor stops all action');
  }

  // 6. A Gmail failure is captured, not thrown — a background tick must never crash the app.
  {
    const g = mockGoogle();
    g.gmailScan = async () => ({ success: false, error: 'invalid_grant' });
    const alog = createActionLog({ dir: fs.mkdtempSync(path.join(TMP, 'e-')), gmailLabel: g.gmailLabel });
    const run = createTriageRun({ google: g, actionLog: alog, config: { mode: 'act' } });
    const r = await run.runOnce();
    assert.ok(r.errors.some((e) => /invalid_grant/.test(e)));
    assert.strictEqual(r.acted.length, 0);
    ok('an API failure is captured in errors[] and acts on nothing');
  }

  // 7. A mid-batch label failure does not stop the rest of the batch.
  {
    const g = mockGoogle();
    const realLabel = g.gmailLabel;
    g.gmailLabel = async (id, o) => (id === 'n2' ? { success: false, error: 'rate limited' } : realLabel(id, o));
    const alog = createActionLog({ dir: fs.mkdtempSync(path.join(TMP, 'f-')), gmailLabel: g.gmailLabel });
    const run = createTriageRun({ google: g, actionLog: alog, config: { mode: 'act' } });
    const r = await run.runOnce();
    assert.ok(r.errors.some((e) => /n2/.test(e)));
    assert.strictEqual(r.acted.length, 2, 'the other two still complete');
    ok('one failed message does not abort the batch');
  }

  // 8. A ledger is MANDATORY — the module refuses to exist without one.
  {
    assert.throws(() => createTriageRun({ google: mockGoogle() }), /actionLog required/);
    ok('triage cannot be constructed without an action ledger');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`[triage-tick] ${pass} assertions passed`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
