#!/usr/bin/env node
'use strict';
// Tests for lib/escalate.js — how an agent asks Siddhant for help without stopping the run.
//
// The behaviours worth guarding are the ones that only show up in an unattended hour:
//   • nothing blocks by default, so a question during a lecture does not freeze the run;
//   • six agents hitting the same unknown produce ONE interruption;
//   • the interruption budget is a hard ceiling, and over it the run proceeds on a stated assumption
//     rather than going quiet or calling nine times;
//   • a reply is attributed to the right question, and when it cannot be, it SAYS it guessed;
//   • wait() always returns, because an unattended run must not be able to wait forever.
//
//   node scripts/test-escalate.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEscalations } = require('../lib/escalate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const TMP = () => fs.mkdtempSync(path.join(os.tmpdir(), 'esc-test-'));

// A fake notify that records what it was asked to send and how loudly. The real one (main.js
// notifyUser) is what applies the calendar gate; this module must not second-guess it.
function fakeNotify(sink, r = { sent: true, via: 'call' }) {
  return async (msg, urgency, opts) => { sink.push({ msg, urgency, opts }); return r; };
}

(async () => {
  // ── it does not block ────────────────────────────────────────────────────────────────────────────
  {
    const sent = [];
    let t = 1758600000000;
    const E = createEscalations({ dir: TMP(), notify: fakeNotify(sent), now: () => t });
    const t0 = Date.now();
    const e = await E.ask({ question: 'Which Princeton account should the draft come from?', assumption: 'sb9699@princeton.edu', agent: 'VALE', options: ['sb9699', 'personal'] });
    ok(Date.now() - t0 < 500, 'ask() returns immediately — it does not wait for a human');
    ok(e.ok && /^esc_/.test(e.id) && e.status === 'open', 'it hands back an id and an open status');
    ok(sent.length === 1 && sent[0].urgency === 'call', 'it asked to CALL by default — notifyUser is what downgrades to Telegram when the calendar says he is busy');
    ok(sent[0].opts.awaitReply && sent[0].opts.taskId === e.id, 'the notification registers a pending reply keyed to this escalation');
    ok(sent[0].msg.includes('sb9699') && sent[0].msg.includes("assume"), 'the message carries the options AND what will be assumed if he does not reply');
    ok(sent[0].msg.includes(e.id), 'the id is in the message, so a quoted reply lands exactly right');
    ok(E.pending().length === 1, 'it is outstanding until answered');
    ok(E.summary().includes('Which Princeton account'), 'summary() is the block a report or a prompt carries');
  }

  // ── dedupe: six agents, one interruption ─────────────────────────────────────────────────────────
  {
    const sent = [];
    let t = 1758600000000;
    const E = createEscalations({ dir: TMP(), notify: fakeNotify(sent), now: () => t });
    const q = 'What budget may I spend on the Replicate renders?';
    const first = await E.ask({ question: q, agent: 'VALE' });
    const again = await E.ask({ question: 'what budget may i spend on the replicate renders???', agent: 'ORRIN' });
    const third = await E.ask({ question: q, agent: 'SABLE' });
    ok(sent.length === 1, 'the same question from three agents interrupts him ONCE');
    ok(again.deduped && again.id === first.id && third.id === first.id, 'the later askers join the existing escalation');
    ok(E.get(first.id).askedBy.length === 3, 'all three agents are recorded as waiting on it, so the answer reaches all of them');

    const different = await E.ask({ question: 'Should I use the Princeton calendar or the personal one?', agent: 'VALE' });
    ok(sent.length === 2 && !different.deduped, 'a genuinely different question does interrupt');
  }

  // ── the interruption budget ──────────────────────────────────────────────────────────────────────
  {
    const sent = [];
    let t = 1758600000000;
    const E = createEscalations({ dir: TMP(), notify: fakeNotify(sent), now: () => t, opts: { maxPerHour: 2 } });
    await E.ask({ question: 'q one', assumption: 'a1' });
    await E.ask({ question: 'q two', assumption: 'a2' });
    const third = await E.ask({ question: 'q three', assumption: 'use the default template' });
    ok(sent.length === 2, 'past the ceiling his phone stays quiet');
    ok(third.throttledOut && third.status === 'assumed' && third.answer === 'use the default template',
      'the throttled question proceeds on its stated assumption instead of stalling');
    ok(E.get(third.id).throttled.ceiling === 2, 'the throttle is recorded on the escalation, so the report can say what was assumed and why');

    const noAssumption = await E.ask({ question: 'q four with nothing to fall back on' });
    ok(noAssumption.status === 'open', 'a throttled question with NO assumption stays open rather than inventing one');

    // An hour later the budget has rolled.
    t += 3600 * 1000 + 1000;
    await E.ask({ question: 'q five, an hour later' });
    ok(sent.length === 3, 'the budget is a rolling hour, not a lifetime cap');
  }

  // ── attribution ──────────────────────────────────────────────────────────────────────────────────
  {
    const sent = [];
    let t = 1758600000000;
    const E = createEscalations({ dir: TMP(), notify: fakeNotify(sent), now: () => t, opts: { maxPerHour: 99 } });

    const a = await E.ask({ question: 'Should the slide deck use the Princeton branding?' });
    ok(E.answer('yes').matched && E.answer('anything') .matched === false,
      'with exactly one question open, any reply answers it — and then nothing is waiting');
    ok(E.get(a.id).answer === 'yes' && E.get(a.id).answerAssumed === false,
      'a single-question answer is not flagged as a guess, because it was not one');

    const b = await E.ask({ question: 'Which Replicate model should the renders use?' });
    const c = await E.ask({ question: 'Should I archive the Princeton newsletters?' });
    const byWords = E.answer('archive the newsletters, yes');
    ok(byWords.matched && byWords.id === c.id && !byWords.assumed,
      'with two open, word overlap routes the reply to the right one and does not call it a guess');

    const d = await E.ask({ question: 'Another unrelated matter entirely' });
    const byId = E.answer(`sure go ahead ${b.id}`);
    ok(byId.matched && byId.id === b.id, 'an id quoted in the reply wins over everything else');

    const e2 = await E.ask({ question: 'One more thing about the scheduler' });
    const guessed = E.answer('ok');
    ok(guessed.matched && guessed.assumed === true,
      'a bare "ok" with several open lands on the most recent AND is flagged as a guess — a misrouted answer acted on confidently is the bad outcome');
    ok(guessed.alsoOpen.length >= 1, 'the caller is told what is still open, so it knows the guess might be wrong');
  }

  // ── wait() always returns ────────────────────────────────────────────────────────────────────────
  {
    const sent = [];
    const E = createEscalations({ dir: TMP(), notify: fakeNotify(sent), opts: { maxPerHour: 99 } });

    const a = await E.ask({ question: 'blocking question', assumption: 'the safe default' });
    const to = await E.wait(a.id, 60);
    ok(!to.answered && to.timedOut && to.assumption === 'the safe default',
      'wait() times out and hands back the assumption to fall back on — an unattended run cannot wait forever');

    const b = await E.ask({ question: 'second blocking question' });
    const p = E.wait(b.id, 5000);
    setTimeout(() => E.answer('here is your answer'), 30);
    const got = await p;
    ok(got.answered && got.answer === 'here is your answer', 'a reply resolves a live waiter immediately');

  }

  // ── durability: an answer that arrives after a restart still lands ───────────────────────────────
  {
    const dir = TMP();
    const sent = [];
    const E1 = createEscalations({ dir, notify: fakeNotify(sent), opts: { maxPerHour: 99 } });
    const a = await E1.ask({ question: 'survives a restart?', assumption: 'no' });

    // A completely fresh instance — this is what a relaunched app has.
    const E2 = createEscalations({ dir, notify: fakeNotify(sent), opts: { maxPerHour: 99 } });
    ok(E2.pending().length === 1 && E2.pending()[0].id === a.id, 'a new process sees the outstanding question');
    const r = E2.answer('yes it does');
    ok(r.matched && r.id === a.id, 'and can answer it');
    ok(E1.isAnswered(a.id).answer === 'yes it does', 'the original instance sees the answer on disk — no in-RAM state was needed');

    // A waiter in THIS process resolves from the file when the timer fires, which is the only way an
    // answer delivered by another process (the cloud bridge, a second window) can ever reach it.
    const b = await E1.ask({ question: 'answered elsewhere' });
    const p = E1.wait(b.id, 80);
    createEscalations({ dir, notify: fakeNotify(sent) }).answer('from the other process', { id: b.id });
    const got = await p;
    ok(got.answered && got.answer === 'from the other process',
      'a waiter re-reads the file on timeout, so an answer delivered by another process is not lost');
  }

  // ── expiry ───────────────────────────────────────────────────────────────────────────────────────
  {
    let t = 1758600000000;
    const E = createEscalations({ dir: TMP(), notify: fakeNotify([]), now: () => t, opts: { expireMs: 1000, maxPerHour: 99 } });
    const a = await E.ask({ question: 'nobody will ever answer this' });
    t += 5000;
    ok(E.pending().length === 0 && E.get(a.id).status === 'expired',
      'a question nobody answered ages out, so "open" keeps meaning "still worth an answer"');
    ok(E.answer('late reply').matched === false, 'a reply to an expired question is not silently applied to something else');
  }

  // ── it survives a broken channel ─────────────────────────────────────────────────────────────────
  {
    const E = createEscalations({ dir: TMP(), notify: async () => { throw new Error('twilio is down'); }, opts: { maxPerHour: 99 } });
    const a = await E.ask({ question: 'asked while the phone line is down', assumption: 'the default' });
    ok(a.ok && a.notified === false, 'a dead notification channel does not throw out of ask() — the question is still recorded');
    ok(E.pending().length === 1, 'and it is still outstanding, so it can be re-sent or answered in the app');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} escalate: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
