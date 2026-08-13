'use strict';
// Phase A3 — the reversible ledger. If these assertions fail, autonomous mail action is not safe to
// enable, because "reversible" stops being true.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createActionLog } = require(path.join(__dirname, '..', 'lib', 'actionlog'));

let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bhatlog-'));

// A fake Gmail that actually tracks label state, so "restored exactly" is a real assertion and not
// just "we called the API".
function fakeGmail(initial = {}) {
  const state = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls, state,
    label: async (id, { add = [], remove = [] } = {}) => {
      calls.push({ id, add, remove });
      const cur = new Set(state.get(id) || []);
      for (const l of remove) cur.delete(l);
      for (const l of add) cur.add(l);
      state.set(id, [...cur]);
      return { success: true };
    },
  };
}

(async () => {
  console.log('[actionlog]');

  // 1. THE CORE CONTRACT: archive → undo restores the EXACT prior label set.
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'a-'));
    const g = fakeGmail({ m1: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'] });
    const lg = createActionLog({ dir, gmailLabel: g.label });
    const before = [...g.state.get('m1')];
    const e = lg.record({ messageId: 'm1', from: 'x@y.com', subject: 'Sale', cls: 'noise', rule: 'R5', confidence: 0.93, action: 'mark_read_archive', prevLabelIds: before });
    await g.label('m1', { remove: ['UNREAD', 'INBOX'] });          // the real mutation
    assert.deepStrictEqual([...g.state.get('m1')].sort(), ['CATEGORY_PROMOTIONS']);

    const r = await lg.undo(e.id);
    assert.strictEqual(r.success, true);
    assert.deepStrictEqual([...g.state.get('m1')].sort(), before.sort(), 'undo must restore the exact prior labels');
    ok('archive → undo restores the exact prior label set');
  }

  // 2. THE SUBTLE ONE: a message that was ALREADY archived (no INBOX) when we found it must NOT be
  //    put back into the inbox by undo. Naive "re-add INBOX" would corrupt state.
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'b-'));
    const g = fakeGmail({ m2: ['UNREAD'] });                        // already archived, still unread
    const lg = createActionLog({ dir, gmailLabel: g.label });
    const e = lg.record({ messageId: 'm2', action: 'mark_read_archive', prevLabelIds: ['UNREAD'] });
    await g.label('m2', { remove: ['UNREAD', 'INBOX'] });
    await lg.undo(e.id);
    assert.deepStrictEqual([...g.state.get('m2')].sort(), ['UNREAD'], 'undo must not resurrect INBOX on a message that never had it');
    assert.ok(!g.state.get('m2').includes('INBOX'));
    ok('undo does not re-add INBOX to a message that was already archived');
  }

  // 3. A mutating action CANNOT be recorded without prevLabelIds. Without them undo is a guess.
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'c-'));
    const lg = createActionLog({ dir, gmailLabel: fakeGmail().label });
    assert.throws(() => lg.record({ messageId: 'm', action: 'mark_read_archive' }), /prevLabelIds/);
    assert.throws(() => lg.record({ messageId: 'm', action: 'mark_read', prevLabelIds: 'INBOX' }), /prevLabelIds/);
    // ...but a PROPOSAL needs none, because nothing changed.
    assert.doesNotThrow(() => lg.record({ messageId: 'm', action: 'proposed:mark_read_archive' }));
    ok('a mutating action without prevLabelIds is refused; a proposal is allowed');
  }

  // 4. Undoing a proposal is a no-op, not an error — propose-week entries are in the same ledger.
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
    const g = fakeGmail({ m3: ['INBOX'] });
    const lg = createActionLog({ dir, gmailLabel: g.label });
    const e = lg.record({ messageId: 'm3', action: 'proposed:mark_read_archive' });
    const r = await lg.undo(e.id);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.noop, true);
    assert.strictEqual(g.calls.length, 0, 'undoing a proposal must touch no API');
    ok('undoing a proposal is a no-op that calls no API');
  }

  // 5. Idempotent: undoing twice does not double-apply.
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'e-'));
    const g = fakeGmail({ m4: ['INBOX', 'UNREAD'] });
    const lg = createActionLog({ dir, gmailLabel: g.label });
    const e = lg.record({ messageId: 'm4', action: 'mark_read_archive', prevLabelIds: ['INBOX', 'UNREAD'] });
    await g.label('m4', { remove: ['UNREAD', 'INBOX'] });
    await lg.undo(e.id);
    const n = g.calls.length;
    const again = await lg.undo(e.id);
    assert.strictEqual(again.alreadyUndone, true);
    assert.strictEqual(g.calls.length, n, 'a second undo must make no further API calls');
    ok('undo is idempotent');
  }

  // 6. undoAll rolls back a whole morning, and is itself idempotent.
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'f-'));
    const init = {}; for (let i = 0; i < 5; i++) init['n' + i] = ['INBOX', 'UNREAD'];
    const g = fakeGmail(init);
    const lg = createActionLog({ dir, gmailLabel: g.label });
    for (let i = 0; i < 5; i++) {
      lg.record({ messageId: 'n' + i, from: 's@x.com', action: 'mark_read_archive', prevLabelIds: ['INBOX', 'UNREAD'] });
      await g.label('n' + i, { remove: ['UNREAD', 'INBOX'] });
    }
    const r = await lg.undoAll({});
    assert.strictEqual(r.undone, 5);
    for (let i = 0; i < 5; i++) assert.deepStrictEqual([...g.state.get('n' + i)].sort(), ['INBOX', 'UNREAD']);
    const second = await lg.undoAll({});
    assert.strictEqual(second.attempted, 0, 'a second undoAll has nothing left to do');
    ok('undoAll restores a batch and is idempotent');
  }

  // 7. THE ORDERING GUARANTEE: the ledger line is on disk BEFORE the mutation, so a crash between
  //    the two loses nothing that matters. Simulated by reloading from disk mid-flight.
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'g-'));
    const g = fakeGmail({ m5: ['INBOX', 'UNREAD'] });
    const lg = createActionLog({ dir, gmailLabel: g.label });
    lg.record({ messageId: 'm5', action: 'mark_read_archive', prevLabelIds: ['INBOX', 'UNREAD'] });
    // ...process dies here, before the API call. A fresh instance must still see the entry.
    const reopened = createActionLog({ dir, gmailLabel: g.label });
    const rows = reopened.recent({ limit: 10 });
    assert.strictEqual(rows.length, 1, 'the ledger entry survives a crash before the mutation');
    assert.deepStrictEqual(rows[0].prevLabelIds, ['INBOX', 'UNREAD']);
    const r = await reopened.undo(rows[0].id);
    assert.strictEqual(r.success, true, 'undoing an action that never happened is harmless');
    ok('the ledger is written before the mutation and survives a crash between them');
  }

  // 8. Ledger survives a torn write (partial final line).
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'h-'));
    const g = fakeGmail({ m6: ['INBOX'] });
    const lg = createActionLog({ dir, gmailLabel: g.label });
    lg.record({ messageId: 'm6', action: 'mark_read', prevLabelIds: ['INBOX', 'UNREAD'] });
    fs.appendFileSync(path.join(dir, 'actions.jsonl'), '{"id":"act_00');
    const reopened = createActionLog({ dir, gmailLabel: g.label });
    assert.strictEqual(reopened.recent({ limit: 10 }).length, 1, 'a torn trailing line must not sink the ledger');
    ok('a torn trailing line is skipped, prior entries intact');
  }

  // 9. stats() is what the review week reads.
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'i-'));
    const lg = createActionLog({ dir, gmailLabel: fakeGmail().label });
    for (let i = 0; i < 3; i++) lg.record({ messageId: 'x' + i, from: 'no-reply@strava.com', cls: 'noise', action: 'proposed:mark_read_archive' });
    lg.record({ messageId: 'y', from: 'receipts@openrouter.ai', cls: 'routine', action: 'proposed:mark_read' });
    const s = lg.stats({});
    assert.strictEqual(s.total, 4);
    assert.strictEqual(s.byClass.noise, 3);
    assert.strictEqual(s.topSenders[0].from, 'no-reply@strava.com');
    assert.strictEqual(s.topSenders[0].n, 3);
    ok('stats() reports per-class counts and the top senders');
  }

  // 10. A gmail failure during undo is reported, and the entry stays NOT-undone so it can be retried.
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'j-'));
    const lg = createActionLog({ dir, gmailLabel: async () => ({ success: false, error: 'quota' }) });
    const e = lg.record({ messageId: 'm7', action: 'mark_read_archive', prevLabelIds: ['INBOX', 'UNREAD'] });
    const r = await lg.undo(e.id);
    assert.strictEqual(r.success, false);
    assert.ok(/quota/.test(r.error));
    assert.strictEqual(lg.recent({ limit: 5 })[0].undone, false, 'a failed undo must remain retryable');
    ok('a failed undo is reported and stays retryable');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`[actionlog] ${pass} assertions passed`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
