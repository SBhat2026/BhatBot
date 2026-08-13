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

  let sentContacts = {};
  let sentBuiltAt = 0;
  const seen = new Set();      // ids handled this process — never act on the same message twice

  // The reciprocity index is a few hundred API calls, far too expensive for a 20-minute tick.
  // Rebuilt at most daily; a failure is non-fatal (classification degrades, it does not stop).
  async function ensureSentContacts({ force = false } = {}) {
    if (!force && now() - sentBuiltAt < 24 * 3600 * 1000 && Object.keys(sentContacts).length) return sentContacts;
    try {
      const r = await google.gmailSentContacts({ limit: 400 });
      if (r && r.contacts && !r.skipped && r.success !== false) {
        sentContacts = r.contacts; sentBuiltAt = now();
        log(`[triage] sent-history: ${Object.keys(sentContacts).length} addresses`);
      }
    } catch (e) { log('[triage] sent-history build failed: ' + e.message); }
    return sentContacts;
  }

  async function runOnce(overrides = {}) {
    const cfg = { ...DEFAULTS, ...config, ...overrides };
    const out = { scanned: 0, urgent: [], acted: [], proposed: [], skipped: 0, errors: [] };

    if (!google.isConfigured || !google.isConfigured()) {
      out.errors.push('google-not-configured');
      return out;
    }
    await ensureSentContacts();

    const scan = await google.gmailScan(`in:inbox newer_than:${cfg.lookback}`, { limit: cfg.maxPerTick });
    if (!scan || scan.success === false || scan.skipped || !Array.isArray(scan.results)) {
      out.errors.push('scan-failed: ' + ((scan && scan.error) || 'unknown'));
      return out;
    }
    out.scanned = scan.results.length;

    for (const m of scan.results) {
      if (seen.has(m.id)) { out.skipped++; continue; }
      seen.add(m.id);
      const sig = signals.fromGmail(m, { sentContacts });
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
        const r = await google.gmailLabel(sig.id, { add: d.addLabels || [], remove: d.removeLabels || [] });
        if (r && r.success === false) throw new Error(r.error || 'gmail refused');
        out.acted.push({ sig, v });                       // 3
      } catch (e) { out.errors.push(`act ${sig.id}: ${e.message}`); }
    }

    while (seen.size > 4000) seen.delete(seen.values().next().value);
    return out;
  }

  return { runOnce, ensureSentContacts, _seen: () => seen, _sentContacts: () => sentContacts };
}

module.exports = { createTriageRun, DEFAULTS };
