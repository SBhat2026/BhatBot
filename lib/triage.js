'use strict';
// ── TRIAGE ENGINE (Phase A2) ──────────────────────────────────────────────────────────────────────
// Deterministic, first-match-wins rule ladder over a normalized Signal (lib/signals.js). The full
// statement of what "important" means — and why — lives in lib/triage-table.js; this file is the
// mechanism that applies it.
//
// WHY DETERMINISTIC RULES AND NOT A MODEL. This runs continuously, on every inbound message, on a
// fanless 16GB laptop. A model on that path is a thermal problem, a latency problem, and an
// auditability problem. Rules resolve the overwhelming majority of real mail, they explain
// themselves (every verdict carries the rule id that fired), and they are testable against labelled
// fixtures. Only the genuine residue is left `ambiguous` — and per the current deployment there is
// no local model slot, so `ambiguous` simply means "surface it, touch nothing".
//
// THE INVARIANTS. These are assertions in the code and assertions in the tests, not comments:
//   I1  Gmail's own IMPORTANT label is never read. (74% of the inbox carries it.)
//   I2  Nothing is classified noise BECAUSE the sender is a business. The person-test only promotes.
//   I3  R1 (security/money/deadline) outranks every person rule.
//   I4  A message is archivable only with List-Unsubscribe present AND a noise-sender match.
//   I5  Sibling addresses are matched exactly, never by domain, wherever a demotion is possible.
//   I6  urgent and important are NEVER mutated, in any mode.
//   I7  The model pass (if one is ever wired) may only promote; it can never demote a rules match.
//
// Pure + DI, never throws — a mis-classification must not sink a background tick. The engine returns
// `ambiguous` on any internal error, which is the do-nothing outcome.

const T = require('./triage-table');

const CLASSES = ['urgent', 'important', 'routine', 'noise', 'ambiguous'];
const ACTIONS = ['surface_now', 'surface_digest', 'mark_read', 'mark_read_archive', 'none'];

// class → what the action ladder does. urgent/important deliberately map to no mutation at all.
const LADDER = {
  urgent: { action: 'surface_now', read: false, archive: false },
  important: { action: 'surface_digest', read: false, archive: false },
  routine: { action: 'mark_read', read: true, archive: false },
  noise: { action: 'mark_read_archive', read: true, archive: true },
  ambiguous: { action: 'none', read: false, archive: false },
};

const has = (set, v) => !!v && set.has(String(v).toLowerCase());
const verdict = (cls, rule, confidence, reasons) => ({
  class: cls, rule, confidence, reasons: [].concat(reasons),
  proposedAction: LADDER[cls].action, mutates: LADDER[cls].read || LADDER[cls].archive,
});

function classify(sig, ctx = {}) {
  try {
    if (!sig) return verdict('ambiguous', 'R0', 0, 'no signal');
    const now = ctx.now || Date.now();
    const from = String(sig.from || '').toLowerCase();
    const dom = String(sig.fromDomain || '').toLowerCase();
    const subj = String(sig.subject || '');
    const table = ctx.table || T;

    // ── R1 · URGENT — security, money, deadlines. Runs FIRST, before any person rule (I3), because
    // the highest-stakes mail in this inbox arrives from no-reply@ business addresses that every
    // person-heuristic would demote. Never auto-touched.
    if (has(table.SECURITY_SENDERS, from)) {
      return verdict('urgent', 'R1', 0.97, `security/financial sender ${from}`);
    }
    if (table.URGENT_SUBJECT.test(subj)) {
      // A newsletter shouting "ACTION REQUIRED" about a sale is not urgent. Bulk headers are the
      // discriminator: a real deadline notice is not sent with List-Unsubscribe.
      if (!sig.listUnsubscribe) return verdict('urgent', 'R1', 0.9, `deadline/security language in subject: "${subj.slice(0, 70)}"`);
    }
    if (dom === 'github.com' && table.GITHUB_SECURITY.test(subj)) {
      return verdict('urgent', 'R1', 0.88, 'GitHub security notice');
    }

    // ── R2 · IMPORTANT — a known person. Reciprocity first: behaviour beats heuristics.
    const people = table.flatPeople();
    if (people.includes(from)) {
      // Admissions decays: he matriculated, so those contacts stop promoting after a quiet spell.
      const isAdmissions = table.PEOPLE.admissions.includes(from);
      if (isAdmissions) {
        const last = sig.senderInSentHistory ? sig.senderInSentHistory.lastRepliedAt : 0;
        const quietDays = last ? (now - last) / 86400000 : Infinity;
        if (quietDays > table.ADMISSIONS_DECAY_DAYS) {
          return verdict('ambiguous', 'R2d', 0.5, `admissions contact, no contact in ${Math.round(quietDays)}d — decayed`);
        }
      }
      return verdict('important', 'R2', 0.96, `known person (${from})`);
    }
    if (sig.iHaveRepliedInThread) {
      return verdict('important', 'R2', 0.94, 'you have corresponded with this sender');
    }
    if (sig.senderInSentHistory && sig.senderInSentHistory.count >= 1) {
      return verdict('important', 'R2', 0.9, `you have emailed this address ${sig.senderInSentHistory.count}×`);
    }
    if (sig.isCalendarInvite && !sig.listUnsubscribe) {
      return verdict('important', 'R2', 0.85, 'calendar invite from a non-bulk sender');
    }

    // ── R3 · IMPORTANT — institutional and personally addressed. The List-Unsubscribe exception is
    // what keeps this rule safe: mitdaily@mit.edu is a mass .edu digest, not a professor writing.
    const instMatch = table.INSTITUTION_DOMAINS.has(dom) || [...table.INSTITUTION_DOMAINS].some((d) => dom.endsWith('.' + d));
    if (instMatch || dom.endsWith('.edu')) {
      if (sig.listUnsubscribe) return verdict('routine', 'R3x', 0.8, `bulk digest from ${dom} — not personal mail`);
      return verdict('important', 'R3', 0.85, `institutional sender (${dom})`);
    }

    // ── R4 · ROUTINE — transactional. Mark read, KEEP in inbox: receipts are reference material.
    if (has(table.ROUTINE_SENDERS, from) || table.ROUTINE_DOMAINS.has(dom)) {
      return verdict('routine', 'R4', 0.9, `transactional sender ${from}`);
    }

    // ── R5 · NOISE — the only class that archives. Requires BOTH a noise match AND List-Unsubscribe
    // (I4), so a mis-typed table entry alone can never archive real mail.
    const noiseMatch = has(table.NOISE_SENDERS, from) || table.NOISE_DOMAINS.has(dom);
    if (noiseMatch) {
      if (has(table.NEVER_ARCHIVE, from)) {
        return verdict('routine', 'R5p', 0.9, `${from} is pinned never-archive (you rescued it before)`);
      }
      if (!sig.listUnsubscribe) {
        // A known-noise address writing WITHOUT bulk headers is unusual enough to look at.
        return verdict('ambiguous', 'R5u', 0.5, `${from} is a known bulk sender but this message has no List-Unsubscribe`);
      }
      return verdict('noise', 'R5', 0.93, `bulk mail from known noise sender ${from}`);
    }

    // ── R6 · Project keywords promote the residue rather than leaving it unseen.
    const lowSubj = subj.toLowerCase();
    const kw = table.PROJECT_KEYWORDS.find((k) => lowSubj.includes(k));
    if (kw && !sig.listUnsubscribe) {
      return verdict('important', 'R6', 0.75, `mentions active work: "${kw}"`);
    }

    // ── Default. Unmatched mail is LEFT ALONE (principle 5). Bulk-header presence is recorded as a
    // reason so the review file shows why something is a candidate, but it does not archive.
    return verdict('ambiguous', 'R7', 0.4, sig.listUnsubscribe ? 'unmatched bulk mail — review candidate' : 'unmatched');
  } catch (e) {
    return verdict('ambiguous', 'ERR', 0, 'classifier error: ' + (e && e.message));
  }
}

// Decide what to actually DO, given the verdict, the mode, and the confidence floor. Separated from
// classify() so the "what would you do" review path and the "do it" path share one decision.
// `actClasses` is the explicit allow-list of classes permitted to mutate anything. It defaults to
// ['noise'] ALONE, deliberately: the ladder marks `routine` read, but marking a receipt read is
// still a mutation of Siddhant's mailbox, and the autonomy he granted was for newsletters and promos.
// Anything not on this list is proposed and left physically untouched, whatever the ladder says.
function decide(sig, v, { mode = 'propose', minConfidence = 0.85, autoArchiveClasses = ['noise'], actClasses = null } = {}) {
  const allowed = actClasses || autoArchiveClasses || ['noise'];
  const base = { class: v.class, rule: v.rule, confidence: v.confidence, reasons: v.reasons };
  // I6 — urgent/important are never mutated, in any mode, at any confidence.
  if (v.class === 'urgent') return { ...base, act: false, action: 'surface_now', why: 'urgent is never auto-touched' };
  if (v.class === 'important') return { ...base, act: false, action: 'surface_digest', why: 'important is never auto-touched' };
  if (v.class === 'ambiguous') return { ...base, act: false, action: 'none', why: 'unclassified — left alone' };
  if (!sig.actionable) return { ...base, act: false, action: 'none', why: 'signal is not actionable (AppleScript source)' };
  if (v.confidence < minConfidence) return { ...base, act: false, action: 'none', why: `confidence ${v.confidence} < ${minConfidence}` };

  const wantsArchive = v.class === 'noise';
  const action = wantsArchive ? 'mark_read_archive' : 'mark_read';
  if (mode !== 'act') return { ...base, act: false, action: 'proposed:' + action, why: 'propose mode' };
  if (!allowed.includes(v.class)) return { ...base, act: false, action: 'proposed:' + action, why: `${v.class} is not in actClasses (${allowed.join(',')})` };
  return {
    ...base, act: true, action,
    addLabels: [], removeLabels: wantsArchive ? ['UNREAD', 'INBOX'] : ['UNREAD'],
    why: 'acting per ladder',
  };
}

// Summarize a batch for the digest / review file.
function summarize(verdicts = []) {
  const byClass = {};
  for (const v of verdicts) byClass[v.class] = (byClass[v.class] || 0) + 1;
  return { total: verdicts.length, byClass };
}

module.exports = { classify, decide, summarize, CLASSES, ACTIONS, LADDER };
