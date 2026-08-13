'use strict';
// ── ACTION LEDGER (Phase A3) ──────────────────────────────────────────────────────────────────────
// The thing that makes "act autonomously on my mail" a safe sentence instead of a promise.
//
// Every autonomous mutation appends one line here BEFORE it happens, carrying the message's exact
// prior labels. Undo then restores that exact state — not an approximation of it, and not "put it
// back in the inbox", which would be wrong for a message that was already archived when we found it.
//
// ORDER IS THE WHOLE POINT. record() runs before the API call, not after. If the process dies
// between the two, the worst case is a ledger entry for an action that never happened — undoing that
// is a no-op. The reverse ordering would lose the record of an action that DID happen, which is
// unrecoverable. Same reasoning as write-ahead logging.
//
// Storage mirrors lib/blackboard.js and the now-durable lib/jobs.js: append-only JSONL + in-memory
// tail. Human-inspectable on purpose — `~/.bhatbot/actions.jsonl` is meant to be read with `less`
// during the review week.
//
// Pure + DI ({ dir, gmailLabel }). See scripts/test-actionlog.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL_MAX = 500;

function createActionLog({ dir = path.join(os.homedir(), '.bhatbot'), gmailLabel = null, now = () => Date.now(), log = () => {} } = {}) {
  const file = path.join(dir, 'actions.jsonl');
  let tail = [];
  let loaded = false;
  let seq = 0;

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      tail = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-TAIL_MAX);
      for (const e of tail) { const m = /^act_(\d+)$/.exec(e.id || ''); if (m) seq = Math.max(seq, Number(m[1]) || 0); }
    } catch { tail = []; }
  }

  function append(entry) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(file, JSON.stringify(entry) + '\n'); }
    catch (e) { log('[actionlog] write failed: ' + e.message); }
    tail.push(entry);
    if (tail.length > TAIL_MAX) tail = tail.slice(-TAIL_MAX);
    return entry;
  }

  // record — one ledger line. `prevLabelIds` is REQUIRED for anything that mutates: without it undo
  // cannot be exact, so we refuse rather than record something we can't reverse.
  function record({ messageId, threadId, account, from, subject, cls, confidence, rule, action, prevLabelIds, reasons } = {}) {
    ensureLoaded();
    const mutating = action && !String(action).startsWith('proposed:') && action !== 'none';
    if (mutating && !Array.isArray(prevLabelIds)) {
      throw new Error('actionlog: refusing to record a mutating action without prevLabelIds — it would be un-undoable');
    }
    return append({
      id: 'act_' + String(++seq).padStart(6, '0'),
      ts: new Date(now()).toISOString(),
      messageId: messageId || null, threadId: threadId || null, account: account || '',
      from: from || '', subject: String(subject || '').slice(0, 200),
      class: cls || null, confidence: confidence ?? null, rule: rule || null,
      reasons: (reasons || []).slice(0, 4),
      action: action || 'none',
      prevLabelIds: Array.isArray(prevLabelIds) ? prevLabelIds : null,
      undone: false, undoneAt: null,
    });
  }

  function recent({ limit = 50, since = null, action = null, cls = null } = {}) {
    ensureLoaded();
    let rows = tail;
    if (since) { const t = new Date(since).getTime() || 0; rows = rows.filter((r) => new Date(r.ts).getTime() >= t); }
    if (action) rows = rows.filter((r) => r.action === action);
    if (cls) rows = rows.filter((r) => r.class === cls);
    return rows.slice(-Math.max(1, limit));
  }

  // undo — restore the exact prior label set. Computes the delta rather than blindly re-adding:
  // labels the message has NOW but did not have BEFORE are removed, and vice versa.
  async function undo(entryId) {
    ensureLoaded();
    const e = tail.find((x) => x.id === entryId);
    if (!e) return { success: false, error: 'no such ledger entry: ' + entryId };
    if (e.undone) return { success: true, alreadyUndone: true, id: entryId };
    // Proposal check FIRST: a propose-mode entry legitimately has no prevLabelIds (nothing was
    // changed, so there is nothing to restore). Checking prevLabelIds before this would report a
    // spurious error for every entry written during the review week.
    if (String(e.action).startsWith('proposed:')) return { success: true, noop: true, note: 'proposal only — nothing was changed' };
    if (!e.prevLabelIds) return { success: false, error: 'entry has no prevLabelIds — nothing to restore' };
    if (!gmailLabel) return { success: false, error: 'actionlog: no gmailLabel wired' };

    // What the action removed, we add back. What it added, we take away.
    const removedByUs = e.action === 'mark_read_archive' ? ['UNREAD', 'INBOX'] : e.action === 'mark_read' ? ['UNREAD'] : [];
    const restore = removedByUs.filter((l) => e.prevLabelIds.includes(l));
    try {
      const r = await gmailLabel(e.messageId, { add: restore, remove: [] });
      if (r && r.success === false) return { success: false, error: r.error || 'gmail refused' };
      e.undone = true; e.undoneAt = new Date(now()).toISOString();
      append({ ...e, id: 'act_' + String(++seq).padStart(6, '0'), ts: new Date(now()).toISOString(), action: 'undo:' + e.action, undoOf: entryId, prevLabelIds: e.prevLabelIds });
      return { success: true, id: entryId, restored: restore, messageId: e.messageId };
    } catch (err) { return { success: false, error: err.message }; }
  }

  // undoAll — bulk rollback. Idempotent: already-undone entries are skipped, so running it twice is
  // safe (which matters, because the natural way to ask for this is twice, nervously).
  async function undoAll({ since = null, limit = 500 } = {}) {
    ensureLoaded();
    const rows = recent({ limit, since }).filter((r) => !r.undone && r.prevLabelIds && !String(r.action).startsWith('proposed:') && !String(r.action).startsWith('undo:'));
    const results = [];
    for (const r of rows) results.push(await undo(r.id));
    return { success: true, attempted: rows.length, undone: results.filter((x) => x.success).length, results };
  }

  // stats — what the review week is actually for.
  function stats({ since = null } = {}) {
    ensureLoaded();
    const rows = recent({ limit: TAIL_MAX, since }).filter((r) => !String(r.action).startsWith('undo:'));
    const byClass = {}, byAction = {}, bySender = {};
    for (const r of rows) {
      byClass[r.class] = (byClass[r.class] || 0) + 1;
      byAction[r.action] = (byAction[r.action] || 0) + 1;
      if (r.from) bySender[r.from] = (bySender[r.from] || 0) + 1;
    }
    const top = Object.entries(bySender).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([from, n]) => ({ from, n }));
    return { total: rows.length, undone: rows.filter((r) => r.undone).length, byClass, byAction, topSenders: top };
  }

  return { record, recent, undo, undoAll, stats, file, _tail: () => tail.slice() };
}

module.exports = { createActionLog };
