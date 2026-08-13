'use strict';
// ── SIGNALS — one shape for everything triage looks at (Phase A1) ────────────────────────────────
// Two sources feed proactive awareness and they are NOT interchangeable:
//   • lib/google.js  — OAuth Gmail/Calendar. Returns real message ids, so a signal from here can be
//                      acted on: labelled, marked read, archived, undone.
//   • lib/ambient.js — AppleScript over local Mail.app/Calendar.app. Returns prose. There is no
//                      stable id, so a signal from here can be SURFACED but never mutated.
//
// The `actionable` flag encodes that difference structurally rather than by convention. Every
// mutation path asserts on it, so it is impossible to try to archive a message you only ever saw
// through AppleScript — a class of bug that would otherwise be easy to write and hard to notice.
//
// Pure, zero deps, no I/O. See scripts/test-signals.js.

const ADDR_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function addr(v) {
  const m = String(v || '').toLowerCase().match(ADDR_RE);
  return m ? m[0] : '';
}
function addrList(v) {
  const m = String(v || '').toLowerCase().match(ADDR_RE);
  return m ? [...new Set(m)] : [];
}
function domainOf(a) { const i = String(a || '').indexOf('@'); return i < 0 ? '' : a.slice(i + 1); }

// The display name, when there is one: "Prof. Sane <sane@ncbs.res.in>" → "Prof. Sane".
function displayName(v) {
  const s = String(v || '').trim();
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(s);
  return m ? m[1].trim() : '';
}

// Gmail message (from google.gmailScan) → Signal.
function fromGmail(msg = {}, { account = '', sentContacts = {}, now = Date.now() } = {}) {
  const h = msg.headers || {};
  const from = addr(h.From);
  const labelIds = msg.labelIds || [];
  const sent = sentContacts[from] || null;
  // Gmail's category is derived from labelIds (CATEGORY_PROMOTIONS etc). Useful as corroboration,
  // never as a decision on its own.
  const cat = (labelIds.find((l) => l.startsWith('CATEGORY_')) || '').replace('CATEGORY_', '').toLowerCase();
  return {
    source: 'gmail',
    actionable: true,
    account,
    id: msg.id || null,
    threadId: msg.threadId || null,
    from,
    fromName: displayName(h.From),
    fromDomain: domainOf(from),
    replyTo: addr(h['Reply-To']),
    to: addrList(h.To),
    cc: addrList(h.Cc),
    subject: String(h.Subject || '').trim(),
    date: msg.internalDate || Date.parse(h.Date) || 0,
    ageDays: msg.internalDate ? Math.floor((now - msg.internalDate) / 86400000) : null,
    snippet: String(msg.snippet || '').slice(0, 200),
    // Machine-checkable proof of bulk mail. This is the gate on archiving, so it is extracted
    // rather than inferred: no List-Unsubscribe → never archived, whatever else matches.
    listUnsubscribe: !!(h['List-Unsubscribe'] || h['List-Id']),
    precedence: String(h.Precedence || '').toLowerCase() || null,
    autoSubmitted: String(h['Auto-Submitted'] || '').toLowerCase() || null,
    gmailCategory: cat || null,
    labelIds,
    unread: labelIds.includes('UNREAD'),
    inInbox: labelIds.includes('INBOX'),
    // Reciprocity — the strongest signal available. Derived from the sent-history index rather than
    // a per-message thread fetch, which would be one extra API round-trip per message.
    senderInSentHistory: sent ? { count: sent.count, lastRepliedAt: sent.lastAt } : null,
    iHaveRepliedInThread: !!(sent && sent.count > 0),
    isCalendarInvite: /\binvitation:|\binvite\b|\bmeeting\b/i.test(String(h.Subject || '')) && /calendar|meet|zoom/i.test(String(h.From || '') + String(h.Subject || '')),
  };
}

// AppleScript Mail.app signal → Signal. ALWAYS actionable:false — no stable id exists.
function fromAppleScriptMail(raw = {}) {
  const from = addr(raw.sender || raw.from);
  return {
    source: 'applescript-mail',
    actionable: false,
    account: raw.account || '',
    id: null, threadId: null,
    from,
    fromName: displayName(raw.sender || raw.from),
    fromDomain: domainOf(from),
    replyTo: '', to: [], cc: [],
    subject: String(raw.subject || '').trim(),
    date: raw.date ? (Date.parse(raw.date) || 0) : 0,
    ageDays: null,
    snippet: '',
    listUnsubscribe: false, precedence: null, autoSubmitted: null,
    gmailCategory: null, labelIds: [], unread: raw.unread !== false, inInbox: true,
    senderInSentHistory: null, iHaveRepliedInThread: false, isCalendarInvite: false,
  };
}

function fromAppleScriptCalendar(raw = {}) {
  return {
    source: 'applescript-cal',
    actionable: false,
    account: '', id: null, threadId: null,
    from: '', fromName: '', fromDomain: '', replyTo: '', to: [], cc: [],
    subject: String(raw.summary || raw.title || '').trim(),
    date: raw.start ? (Date.parse(raw.start) || 0) : 0,
    ageDays: null, snippet: '',
    listUnsubscribe: false, precedence: null, autoSubmitted: null,
    gmailCategory: null, labelIds: [], unread: false, inInbox: false,
    senderInSentHistory: null, iHaveRepliedInThread: false, isCalendarInvite: true,
  };
}

function normalize(raw, source, opts = {}) {
  switch (source) {
    case 'gmail': return fromGmail(raw, opts);
    case 'applescript-mail': return fromAppleScriptMail(raw);
    case 'applescript-cal': return fromAppleScriptCalendar(raw);
    default: return null;
  }
}

// A signal may only be mutated if it came from the API. Callers assert on this before acting.
function assertActionable(sig) {
  if (!sig || !sig.actionable) throw new Error('signals: refusing to mutate a non-actionable signal (source=' + (sig && sig.source) + ')');
  if (!sig.id) throw new Error('signals: refusing to mutate a signal with no message id');
  return true;
}

module.exports = { normalize, fromGmail, fromAppleScriptMail, fromAppleScriptCalendar, assertActionable, addr, addrList, domainOf, displayName };
