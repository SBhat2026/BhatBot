'use strict';
// ── TRIAGE RUN (Phase A4 core) ────────────────────────────────────────────────────────────────────
// One pass of proactive mail triage: scan → normalize → classify → decide → (ledger, then act).
//
// Extracted from main.js's timer so the decision loop is testable without Electron and reusable by
// the headless worker. Everything external is injected: the Google client, the action ledger, and
// the config. No timers, no IPC, no globals.
//
// THE ORDER INSIDE act() IS A SAFETY PROPERTY, not a style choice:
//   1. assertActionable — an AppleScript-sourced signal has no id and can never be mutated.
//   2. ledger.record(prevLabelIds) — written BEFORE the API call. A crash between the two leaves a
//      ledger entry for an action that never happened (undo is then a harmless no-op). The reverse
//      order would lose the record of an action that DID happen, which is unrecoverable.
//   3. the mutation.
//
// See scripts/test-triage-tick.js.

const signals = require('./signals');
const triage = require('./triage');

const DEFAULTS = {
  mode: 'propose',
  minConfidence: 0.85,
  autoArchiveClasses: ['noise'],
  lookback: '1d',
  maxPerTick: 60,
};

function createTriageRun({ google, actionLog, config = {}, log = () => {}, now = () => Date.now() } = {}) {
  if (!google) throw new Error('triagerun: google client required');
  if (!actionLog) throw new Error('triagerun: actionLog required — nothing may mutate without a ledger');

  // PER-ACCOUNT STATE. Reciprocity is the strongest signal the classifier has ("you have emailed
  // this person"), and it is a fact about ONE mailbox — your school contacts are not evidence about
  // your personal inbox, and pooling them would promote a stranger in one account because they are
  // a correspondent in another. Both the index and the already-handled set are therefore keyed by
  // account, and a message id is only unique within its own mailbox anyway.
  const sentByAccount = new Map();     // account key → { contacts, builtAt }
  const seenByAccount = new Map();     // account key → Set of message ids handled this process
  const keyOf = (a) => (a && (a.email || a.label)) || 'primary';
  const seenFor = (k) => { if (!seenByAccount.has(k)) seenByAccount.set(k, new Set()); return seenByAccount.get(k); };

  // The reciprocity index is a few hundred API calls, far too expensive for a 20-minute tick.
  // Rebuilt at most daily; a failure is non-fatal (classification degrades, it does not stop).
  async function ensureSentContacts({ force = false, account } = {}) {
    const k = keyOf(account);
    const cur = sentByAccount.get(k) || { contacts: {}, builtAt: 0 };
    if (!force && now() - cur.builtAt < 24 * 3600 * 1000 && Object.keys(cur.contacts).length) return cur.contacts;
    try {
      const r = await google.gmailSentContacts({ limit: 400, ...(account ? { account } : {}) });
      if (r && r.contacts && !r.skipped && r.success !== false) {
        sentByAccount.set(k, { contacts: r.contacts, builtAt: now() });
        log(`[triage] ${k} sent-history: ${Object.keys(r.contacts).length} addresses`);
        return r.contacts;
      }
    } catch (e) { log(`[triage] ${k} sent-history build failed: ` + e.message); }
    return cur.contacts;
  }

  /**
   * One pass over EVERY opted-in account. Triage is opt-in per mailbox
   * (config.google.accounts[].triage) rather than "wherever we can reach", because connecting an
   * inbox so it can be searched must not, by itself, enrol it in something that proposes to archive.
   * An account that fails is recorded and the rest continue: one dead token must not stop the others.
   */
  async function runOnce(overrides = {}) {
    const cfg = { ...DEFAULTS, ...config, ...overrides };
    const out = { scanned: 0, urgent: [], acted: [], proposed: [], skipped: 0, errors: [], accounts: [] };

    if (!google.isConfigured || !google.isConfigured()) {
      out.errors.push('google-not-configured');
      return out;
    }

    // A client that predates accounts — or any injected test double — has no triageAccounts(). That
    // is not "no mailbox opted in", it is a single-mailbox client, and it must keep working: passing
    // `undefined` as the account is exactly what every call did before multi-account existed.
    const enrolled = (typeof google.triageAccounts === 'function') ? google.triageAccounts() : [undefined];
    if (!enrolled.length) {
      // Not an error, and worth saying plainly: the difference between "no mail to triage" and "no
      // mailbox has opted in" is the whole reason this subsystem sat silent for a month.
      out.errors.push('no-account-opted-in: set config.google.accounts[].triage = true on the inboxes triage should handle');
      return out;
    }

    for (const acct of enrolled) {
      const one = await runAccount(acct, cfg);
      out.accounts.push({ account: keyOf(acct), scanned: one.scanned, urgent: one.urgent.length, proposed: one.proposed.length, acted: one.acted.length, errors: one.errors });
      out.scanned += one.scanned; out.skipped += one.skipped;
      out.urgent.push(...one.urgent); out.acted.push(...one.acted); out.proposed.push(...one.proposed);
      out.errors.push(...one.errors.map((e) => `${keyOf(acct)}: ${e}`));
    }
    return out;
  }

  async function runAccount(acct, cfg) {
    const out = { scanned: 0, urgent: [], acted: [], proposed: [], skipped: 0, errors: [] };
    const seen = seenFor(keyOf(acct));
    const sentContacts = await ensureSentContacts({ account: acct });

    const scan = await google.gmailScan(`in:inbox newer_than:${cfg.lookback}`, { limit: cfg.maxPerTick, account: acct });
    if (!scan || scan.success === false || scan.skipped || !Array.isArray(scan.results)) {
      out.errors.push('scan-failed: ' + ((scan && scan.error) || 'unknown'));
      return out;
    }
    out.scanned = scan.results.length;

    for (const m of scan.results) {
      if (seen.has(m.id)) { out.skipped++; continue; }
      seen.add(m.id);
      const sig = signals.fromGmail(m, { sentContacts, account: keyOf(acct) });
      const v = triage.classify(sig, { now: now() });
      const d = triage.decide(sig, v, cfg);

      if (v.class === 'urgent') { out.urgent.push({ sig, v }); continue; }

      if (!d.act) {
        if (String(d.action).startsWith('proposed:')) {
          try {
            actionLog.record({
              messageId: sig.id, threadId: sig.threadId, account: sig.account, from: sig.from,
              subject: sig.subject, cls: v.class, confidence: v.confidence, rule: v.rule,
              action: d.action, reasons: v.reasons,
            });
            out.proposed.push({ sig, v });
          } catch (e) { out.errors.push('record: ' + e.message); }
        }
        continue;
      }

      try {
        signals.assertActionable(sig);                    // 1
        actionLog.record({                                // 2 — before the mutation, always
          messageId: sig.id, threadId: sig.threadId, account: sig.account, from: sig.from,
          subject: sig.subject, cls: v.class, confidence: v.confidence, rule: v.rule,
          action: d.action, prevLabelIds: sig.labelIds, reasons: v.reasons,
        });
        // The mutation MUST name the account. Without it the label call would go to the primary
        // mailbox while the ledger recorded the message's real one — and the undo, which replays
        // from the ledger, would then be aimed at an inbox that never held the message.
        const r = await google.gmailLabel(sig.id, { add: d.addLabels || [], remove: d.removeLabels || [], account: acct });
        if (r && r.success === false) throw new Error(r.error || 'gmail refused');
        out.acted.push({ sig, v });                       // 3
      } catch (e) { out.errors.push(`act ${sig.id}: ${e.message}`); }
    }

    while (seen.size > 4000) seen.delete(seen.values().next().value);
    return out;
  }

  return { runOnce, runAccount, ensureSentContacts,
    _seen: (k) => seenFor(k || 'primary'), _sentContacts: (k) => (sentByAccount.get(k || 'primary') || {}).contacts || {} };
}

module.exports = { createTriageRun, DEFAULTS };
