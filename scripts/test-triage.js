'use strict';
// Phase A2 — the triage rule ladder. These assertions encode the SAFETY properties, not just the
// happy path: the expensive failure here is archiving something that mattered.
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { classify, decide } = require(path.join(ROOT, 'lib', 'triage'));
const { fromGmail } = require(path.join(ROOT, 'lib', 'signals'));

let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }

// Build a realistic Gmail message the way google.gmailScan returns them.
function msg({ from, subject = '', to = 'siddhantbhat3@gmail.com', unsub = false, labels = ['INBOX', 'UNREAD'], date = Date.now(), extra = {} }) {
  return fromGmail({
    id: 'm' + Math.abs(String(from + subject).split('').reduce((a, c) => a + c.charCodeAt(0), 0)),
    threadId: 't1', labelIds: labels, internalDate: date,
    headers: { From: from, To: to, Subject: subject, Date: new Date(date).toUTCString(), ...(unsub ? { 'List-Unsubscribe': '<mailto:u@x.com>' } : {}), ...extra },
  }, { account: 'siddhantbhat3@gmail.com', ...(extra._ctx || {}) });
}
const cls = (m, ctx) => classify(m, ctx).class;

console.log('[triage]');

// ── I3 + principle 1: the three REAL deadline mails sitting unactioned in the inbox. Every one is a
// no-reply@ business sender that a "real person" heuristic would have demoted to noise.
{
  const live = [
    msg({ from: 'Manus <no-reply@manus.im>', subject: 'Action Required: Your data will be permanently deleted on Aug 23' }),
    msg({ from: 'Google Cloud <googlecloud@google.com>', subject: 'Your free trial has ended — upgrade to keep what you have built' }),
    msg({ from: 'Anthropic <noreply@anthropic.com>', subject: 'Your API access is disabled — you are out of credits' }),
  ];
  for (const m of live) assert.strictEqual(cls(m), 'urgent', `should be urgent: ${m.subject}`);
  ok('the 3 live deadline mails all fire R1 (business senders, still urgent)');
}

// ── I5: sibling addresses. Same domain, opposite verdicts. Domain matching would destroy this.
{
  assert.strictEqual(cls(msg({ from: 'service@paypal.com', subject: 'Receipt for your payment' })), 'urgent');
  assert.strictEqual(cls(msg({ from: 'noreply@news.paypal.com', subject: 'New ways to pay this season', unsub: true })), 'noise');
  assert.strictEqual(cls(msg({ from: 'no.reply.alerts@chase.com', subject: 'Your statement is ready' })), 'urgent');
  assert.strictEqual(cls(msg({ from: 'chase@mcmap.chase.com', subject: 'You are pre-qualified for a new card', unsub: true })), 'noise');
  ok('sibling addresses on one domain resolve to opposite classes');
}

// ── I3: R1 outranks the VIP table. A security alert is not downgraded by who else is important.
{
  const v = classify(msg({ from: 'no-reply@accounts.google.com', subject: 'New sign-in to your account' }));
  assert.strictEqual(v.class, 'urgent');
  assert.strictEqual(v.rule, 'R1');
  ok('R1 security outranks every person rule');
}

// ── I2: NOTHING is noise because it came from a business. An unknown business sender with no bulk
//    headers is left alone, never archived.
{
  const v = classify(msg({ from: 'someone@randomstartup.io', subject: 'Following up on our conversation' }));
  assert.notStrictEqual(v.class, 'noise', 'an unknown business sender must never be auto-noise');
  assert.strictEqual(v.class, 'ambiguous');
  ok('an unknown business sender is never classified noise (person-test only promotes)');
}

// ── I4: archiving requires BOTH a noise match AND List-Unsubscribe. This is the guard that stops a
//    single bad table entry from archiving real mail.
{
  const withUnsub = msg({ from: 'nytdirect@nytimes.com', subject: 'Your Evening Briefing', unsub: true });
  const without = msg({ from: 'nytdirect@nytimes.com', subject: 'Re: your account — please respond' });
  assert.strictEqual(cls(withUnsub), 'noise');
  assert.notStrictEqual(cls(without), 'noise', 'no List-Unsubscribe → must NOT archive even a known noise sender');
  assert.strictEqual(cls(without), 'ambiguous');
  ok('archiving requires List-Unsubscribe AND a noise match (I4)');
}

// ── R2 reciprocity: behaviour beats heuristics, and it is self-maintaining.
{
  const stranger = msg({ from: 'newperson@unknown.org', subject: 'Question about your paper' });
  assert.strictEqual(cls(stranger), 'ambiguous');
  const known = fromGmail(
    { id: 'x', threadId: 't', labelIds: ['INBOX'], internalDate: Date.now(), headers: { From: 'newperson@unknown.org', Subject: 'Question about your paper' } },
    { sentContacts: { 'newperson@unknown.org': { count: 3, lastAt: Date.now() } } },
  );
  assert.strictEqual(cls(known), 'important', 'having emailed them promotes to important');
  ok('reciprocity (you have emailed them) promotes a stranger to important');
}

// ── R3 + its exception: a .edu professor is important; a .edu mass digest is not.
{
  assert.strictEqual(cls(msg({ from: 'akaz@princeton.edu', subject: 'draft figures' })), 'important');
  assert.strictEqual(cls(msg({ from: 'randomprof@stanford.edu', subject: 'your application' })), 'important');
  const digest = classify(msg({ from: 'mitdaily@mit.edu', subject: 'MIT Daily', unsub: true }));
  assert.strictEqual(digest.class, 'routine', 'a bulk .edu digest is routine, NOT important');
  assert.strictEqual(digest.rule, 'R3x');
  ok('.edu is important, but a .edu bulk digest drops to routine');
}

// ── Family/research are important even with plain subjects.
{
  assert.strictEqual(cls(msg({ from: 'pramodv@princeton.edu', subject: 'call me' })), 'important');
  assert.strictEqual(cls(msg({ from: 'gijs@adaptyvbio.com', subject: 'binder results' })), 'important');
  assert.strictEqual(cls(msg({ from: 'gautham@eigenlabs.org', subject: 'next steps' })), 'important');
  ok('family and active research collaborators classify important');
}

// ── Admissions DECAY: he matriculated. Still important while live, demoted after a long silence.
{
  const recent = fromGmail({ id: 'a', threadId: 't', labelIds: ['INBOX'], internalDate: Date.now(),
    headers: { From: 'uaoffice@princeton.edu', Subject: 'Housing' } }, { sentContacts: { 'uaoffice@princeton.edu': { count: 1, lastAt: Date.now() - 5 * 86400000 } } });
  assert.strictEqual(cls(recent), 'important', 'recently-active admissions contact stays important');

  const stale = fromGmail({ id: 'b', threadId: 't', labelIds: ['INBOX'], internalDate: Date.now(),
    headers: { From: 'map@psatellite.com', Subject: 'Interview follow-up' } }, { sentContacts: {} });
  const v = classify(stale);
  assert.strictEqual(v.rule, 'R2d', 'a long-quiet admissions contact decays');
  assert.notStrictEqual(v.class, 'noise', 'decay must demote to ambiguous, never to noise');
  ok('admissions tier decays after matriculation but never to noise');
}

// ── R4: receipts are marked read but KEPT — they are reference material.
{
  const v = classify(msg({ from: 'receipts@openrouter.ai', subject: 'Your receipt' }));
  assert.strictEqual(v.class, 'routine');
  assert.strictEqual(v.proposedAction, 'mark_read');
  assert.notStrictEqual(v.proposedAction, 'mark_read_archive', 'receipts must not be archived out of the inbox');
  ok('transactional receipts are marked read but stay in the inbox');
}

// ── R6: project keywords rescue the residue.
{
  assert.strictEqual(cls(msg({ from: 'unknown@conf.org', subject: 'Your AlphaFold workshop slot' })), 'important');
  assert.strictEqual(cls(msg({ from: 'unknown@conf.org', subject: 'ISEF registration' })), 'important');
  ok('project keywords promote otherwise-unmatched mail');
}

// ── I1: Gmail's IMPORTANT label must NEVER change a verdict. It covers 74% of the inbox.
{
  const plain = msg({ from: 'nytdirect@nytimes.com', subject: 'Briefing', unsub: true, labels: ['INBOX', 'UNREAD'] });
  const flagged = msg({ from: 'nytdirect@nytimes.com', subject: 'Briefing', unsub: true, labels: ['INBOX', 'UNREAD', 'IMPORTANT'] });
  assert.strictEqual(cls(plain), cls(flagged), "Gmail's IMPORTANT label must not influence classification");
  assert.strictEqual(cls(flagged), 'noise');
  ok("Gmail's own IMPORTANT label is never an input (I1)");
}

// ── I6: urgent and important are NEVER mutated, in any mode, at any confidence.
{
  for (const m of [msg({ from: 'no-reply@accounts.google.com', subject: 'Security alert' }), msg({ from: 'pramodv@princeton.edu', subject: 'hi' })]) {
    const v = classify(m);
    for (const mode of ['propose', 'act']) {
      const d = decide(m, v, { mode, minConfidence: 0 });
      assert.strictEqual(d.act, false, `${v.class} must never act in mode=${mode}`);
      assert.ok(!/archive/.test(d.action), `${v.class} must never archive`);
    }
  }
  ok('urgent + important are never mutated in any mode (I6)');
}

// ── propose vs act. The review week depends on propose truly mutating nothing.
{
  const m = msg({ from: 'no-reply@strava.com', subject: 'You earned a badge', unsub: true });
  const v = classify(m);
  const proposed = decide(m, v, { mode: 'propose' });
  assert.strictEqual(proposed.act, false);
  assert.ok(proposed.action.startsWith('proposed:'), 'propose mode must only ever emit proposals');

  const acted = decide(m, v, { mode: 'act' });
  assert.strictEqual(acted.act, true);
  assert.strictEqual(acted.action, 'mark_read_archive');
  assert.deepStrictEqual(acted.removeLabels, ['UNREAD', 'INBOX'], 'archive = drop INBOX, mark read = drop UNREAD');
  ok('propose mode emits proposals only; act mode archives noise');
}

// ── Confidence floor: a low-confidence verdict never acts.
{
  const m = msg({ from: 'no-reply@strava.com', subject: 'badge', unsub: true });
  const weak = { ...classify(m), confidence: 0.5 };
  assert.strictEqual(decide(m, weak, { mode: 'act', minConfidence: 0.85 }).act, false);
  ok('a verdict below the confidence floor never acts');
}

// ── A non-actionable (AppleScript) signal can never be mutated, even if classified noise.
{
  const { fromAppleScriptMail } = require(path.join(ROOT, 'lib', 'signals'));
  const s = fromAppleScriptMail({ sender: 'no-reply@strava.com', subject: 'You earned a badge' });
  const d = decide(s, { class: 'noise', rule: 'R5', confidence: 0.99, reasons: [] }, { mode: 'act' });
  assert.strictEqual(d.act, false);
  assert.ok(/not actionable/.test(d.why));
  ok('an AppleScript-sourced signal can never be mutated');
}

// ── never-archive pin (the learning loop's output) beats a noise match.
{
  const T = require(path.join(ROOT, 'lib', 'triage-table'));
  const table = { ...T, NEVER_ARCHIVE: new Set(['nytdirect@nytimes.com']) };
  const m = msg({ from: 'nytdirect@nytimes.com', subject: 'Briefing', unsub: true });
  const v = classify(m, { table });
  assert.notStrictEqual(v.class, 'noise', 'a pinned sender must never be archived again');
  assert.strictEqual(v.rule, 'R5p');
  ok('a never-archive pin overrides a noise match');
}

// ── The engine never throws — a bad signal must not sink a background tick.
{
  for (const bad of [null, undefined, {}, { from: null, subject: null }, { from: 12345 }]) {
    const v = classify(bad);
    assert.ok(v && v.class, 'classify must always return a verdict');
    assert.strictEqual(v.class, 'ambiguous', 'garbage input must degrade to the do-nothing class');
  }
  ok('malformed input degrades to ambiguous instead of throwing');
}

// ── A newsletter shouting "ACTION REQUIRED" is not urgent — bulk headers discriminate.
{
  const shouty = msg({ from: 'hello@vuori.com', subject: 'ACTION REQUIRED: your cart expires today', unsub: true });
  assert.notStrictEqual(cls(shouty), 'urgent', 'marketing urgency language must not reach urgent');
  assert.strictEqual(cls(shouty), 'noise');
  ok('marketing "ACTION REQUIRED" does not fake its way to urgent');
}

console.log(`[triage] ${pass} assertions passed`);
