'use strict';
// ── ESCALATION — the one door an agent uses to reach Siddhant ───────────────────────────────────────
//
// An hour-long unattended run has exactly two ways to fail badly. It can grind on a guess it should
// have checked, or it can freeze on a question nobody is awake to answer. This module is the whole
// answer to both, and the shape of the answer is:
//
//   ASK, THEN KEEP WORKING. Nothing here blocks by default.
//
// An escalation returns an id immediately. The supervisor goes and does everything that does not
// depend on the answer, and only parks when it has genuinely run out of other work. That is the
// difference between a run that survives you being in a lecture and one that spends the lecture
// staring at a question.
//
// CHANNEL CHOICE IS NOT MADE HERE. It is made by main.js notifyUser, which already knows the rules
// Siddhant asked for: a call, unless the calendar says he is in class, in which case Telegram; unless
// it is the middle of the night, in which case also not a call. This module injects `notify` and stays
// out of it — one place decides how loud to be, and it is the place that can see his calendar.
//
// THREE THINGS THAT MATTER FOR A RUN NOBODY IS WATCHING:
//
//  • DEDUPE. Two agents hitting the same missing fact ask once. Without this, a fleet of six turns one
//    unknown into six phone calls, and the answer to all six is the same sentence.
//  • A BUDGET ON INTERRUPTIONS. `maxPerHour` is a hard ceiling. Past it, the question is recorded and
//    the run proceeds on its stated assumption instead — being asked nine times in an hour is worse
//    than being asked once and told what was assumed.
//  • ATTRIBUTION. With several questions open, a bare "yes" is ambiguous. Matching is by explicit id,
//    then by word overlap, then by recency — and when it lands on recency the answer is flagged
//    `assumed`, because a misrouted answer acted on confidently is worse than one acted on carefully.
//
// Durable: every escalation is a file, so a restart still knows what is outstanding and an answer that
// arrives after a crash still lands. Pure + fs-backed + DI. See scripts/test-escalate.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.bhatbot', 'escalations');
const DEFAULTS = {
  maxPerHour: 4,            // interruptions, not questions: the rest are recorded and assumed
  dedupeWindowMs: 6 * 3600 * 1000,
  expireMs: 24 * 3600 * 1000,
  urgency: 'call',          // notifyUser downgrades to Telegram when the calendar says he is busy
  // QUIET HOURS ARE NOT A CALENDAR ENTRY. The calendar gate in notifyUser catches "he is in a
  // seminar"; it does not catch 3am, because nobody puts sleep in their calendar. An unattended run
  // is exactly the thing that is working at 3am, so without this the first overnight run wakes him
  // to ask which citation style to use. A question at 3am goes to Telegram, silently, and the run
  // proceeds on its stated assumption — the written record is still there in the morning.
  quietFrom: 23,
  quietTo: 7,
  quietUrgency: 'low',      // Telegram only, no SMS, no ring
};

const STATUSES = ['open', 'answered', 'assumed', 'expired'];

const id6 = () => Math.random().toString(36).slice(2, 8);
// Normalised for dedupe only. Punctuation and case are noise; the words are the question.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 3));

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/**
 * createEscalations(deps) → the door.
 *
 * deps:
 *   notify  — async (message, urgency, opts) => { sent, via, downgraded }  (main.js notifyUser)
 *   dir, now, log, onEvent, opts{maxPerHour, dedupeWindowMs, expireMs, urgency}
 */
function createEscalations(deps = {}) {
  const dir = deps.dir || DIR;
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const onEvent = deps.onEvent || (() => {});
  const notify = deps.notify || (async () => ({ sent: false, error: 'no notify channel wired' }));
  // `opts` may be an object OR a function. A function is re-read on every ask, so changing
  // config.escalation.maxPerHour or the quiet window takes effect on the next question rather than on
  // the next app restart — and "restart the app to stop it calling you so often" is not a setting.
  //
  // Nothing is read HERE, either. main.js constructs this at module scope, long before Electron is
  // ready, and lib/config's own notes are explicit that an early read is how a config cache gets
  // poisoned for a whole session. `cfg` is a getter for the same reason `opts` is a function.
  const readOpts = typeof deps.opts === 'function' ? deps.opts : () => (deps.opts || {});
  const conf = () => ({ ...DEFAULTS, ...(readOpts() || {}) });
  /** Is `t` inside the quiet window? Handles the wrap through midnight, which is the normal case. */
  function isQuiet(t) {
    const c = conf();
    const h = new Date(t).getHours();
    return c.quietFrom > c.quietTo ? (h >= c.quietFrom || h < c.quietTo) : (h >= c.quietFrom && h < c.quietTo);
  }

  // In-RAM waiters for the fast path: a live process that asked and is now waiting gets resolved the
  // instant a reply arrives, without polling a file. The file is the durable record; this is latency.
  const waiters = new Map();     // id → [resolve]
  // A per-process counter that breaks askedAt ties. It only has to order questions raised by THIS
  // process in the same millisecond, which is the only case a wall-clock tie can arise from.
  let _seq = 0;

  const file = (eid) => path.join(dir, eid + '.json');

  // ORDER BY (askedAt, seq), NOT BY askedAt ALONE.
  //
  // Two escalations raised in the same millisecond — six agents hitting a wall at once, or anything
  // running on a fixed clock — tie on askedAt, and a tie fell through to `fs.readdirSync` order,
  // which is the filesystem's business and not chronology. "Falls back to the most recent" then meant
  // "falls back to whichever file the directory happened to list last", so a bare "ok" could be
  // attributed to the OLDER question while the result confidently reported it as the newest. A flaky
  // test found this; it would have been a mis-routed answer in production, which is the failure this
  // whole attribution path exists to avoid.
  function all() {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f))).filter(Boolean)
        .sort((a, b) => (a.askedAt || 0) - (b.askedAt || 0) || (a.seq || 0) - (b.seq || 0));
    } catch { return []; }
  }
  function save(e) { writeAtomic(file(e.id), JSON.stringify(e, null, 2)); return e; }
  function get(eid) { return readJson(file(String(eid || ''))); }

  /** Age out anything nobody ever answered, so `open` means "still worth an answer". */
  function expire() {
    const cutoff = now() - conf().expireMs;
    const out = [];
    for (const e of all()) {
      if (e.status === 'open' && (e.askedAt || 0) < cutoff) { e.status = 'expired'; save(e); out.push(e.id); }
    }
    return out;
  }

  function pending() { expire(); return all().filter((e) => e.status === 'open'); }

  /** How many times we have actually interrupted him in the last hour. */
  function recentInterruptions() {
    const since = now() - 3600 * 1000;
    return all().filter((e) => e.notified && (e.askedAt || 0) >= since).length;
  }

  /**
   * ask({ question, why, assumption, options, agent, missionId, urgency, dedupe }) → escalation
   *
   * Returns immediately. The caller goes and does something else; `wait(id, ms)` is there for the case
   * where there is genuinely nothing else to do.
   *
   * `assumption` is required in spirit and merely recommended in code: it is what the run will proceed
   * on if the answer does not come, and an escalation without one turns a missing answer into a stall.
   */
  async function ask(spec = {}) {
    const question = String(spec.question || '').trim();
    if (!question) return { ok: false, error: 'an escalation needs a question' };

    // DEDUPE — same question inside the window, still open, means one interruption, not two.
    if (spec.dedupe !== false) {
      const since = now() - conf().dedupeWindowMs;
      const twin = all().find((e) => (e.askedAt || 0) >= since && e.status !== 'expired' && norm(e.question) === norm(question));
      if (twin) {
        twin.askedBy = [...new Set([...(twin.askedBy || []), spec.agent || 'agent'])];
        save(twin);
        log(`[escalate] ${twin.id} already asked — ${spec.agent || 'agent'} joined it`);
        onEvent({ type: 'escalation-joined', id: twin.id, agent: spec.agent || 'agent' });
        return { ...twin, ok: true, deduped: true };
      }
    }

    const e = {
      id: 'esc_' + id6(),
      question,
      why: String(spec.why || '').slice(0, 500),
      assumption: String(spec.assumption || '').slice(0, 500),
      options: Array.isArray(spec.options) ? spec.options.map(String).slice(0, 6) : [],
      agent: spec.agent || 'agent',
      askedBy: [spec.agent || 'agent'],
      missionId: spec.missionId || null,
      urgency: spec.urgency || conf().urgency,
      quiet: isQuiet(now()),
      status: 'open',
      askedAt: now(),
      seq: ++_seq,
      notified: false,
      via: null,
      answer: null,
      answeredAt: null,
    };

    // THE INTERRUPTION BUDGET. Over the ceiling the question is still RECORDED — so it is answerable
    // later and visible in the report — but his phone stays quiet and the run proceeds on its stated
    // assumption. Nine calls in an hour is a worse outcome than one call and a written note of what
    // was assumed.
    const ceiling = conf().maxPerHour;
    const used = recentInterruptions();
    if (used >= ceiling) {
      e.status = e.assumption ? 'assumed' : 'open';
      e.answer = e.assumption || null;
      e.throttled = { used, ceiling };
      save(e);
      log(`[escalate] ${e.id} NOT sent — ${used}/${ceiling} interruptions this hour; ${e.assumption ? 'proceeding on the stated assumption' : 'left open'}`);
      onEvent({ type: 'escalation-throttled', id: e.id, question, used, ceiling });
      return { ...e, ok: true, throttledOut: true };
    }

    save(e);
    const msg = [
      question,
      e.why ? `(why: ${e.why})` : '',
      e.options.length ? `Options: ${e.options.join(' / ')}` : '',
      e.assumption ? `If you don't reply I'll assume: ${e.assumption}` : '',
      `[${e.id}]`,
    ].filter(Boolean).join('\n');

    // At 3am the loudest honest channel is the quiet one. The question still goes out and is still
    // recorded; it just does not ring. If it has an assumption it also stops being a blocker, because
    // waiting until morning for an answer nobody is awake to give is not waiting, it is stopping.
    const urgency = e.quiet ? conf().quietUrgency : e.urgency;
    if (e.quiet && e.assumption) { e.status = 'assumed'; e.answer = e.assumption; }

    let r = {};
    try { r = await notify(msg, urgency, { awaitReply: true, taskId: e.id }) || {}; } catch (err) { r = { sent: false, error: String(err && err.message || err) }; }
    e.sentUrgency = urgency;
    e.notified = !!r.sent;
    e.via = r.via || null;
    e.downgraded = r.downgraded || null;
    save(e);
    log(`[escalate] ${e.id} → ${r.via || 'nowhere'}${e.quiet ? ' (quiet hours — did not ring)' : ''}${r.downgraded ? ' (' + r.downgraded + ')' : ''}: ${question.slice(0, 80)}`);
    onEvent({ type: 'escalation-asked', id: e.id, question, via: e.via, downgraded: e.downgraded, quiet: e.quiet });
    return { ...e, ok: true };
  }

  /**
   * answer(text, { id }) → { matched, id, assumed } | { matched:false, reason }
   *
   * Called from every inbound surface — SMS, Telegram, the app — with whatever Siddhant actually said.
   * The hard part is ATTRIBUTION when more than one question is open, and the honest thing to do when
   * it is unclear is to say the match was assumed rather than to act as if it was certain.
   */
  function answer(text, opts = {}) {
    const body = String(text || '').trim();
    if (!body) return { matched: false, reason: 'empty' };
    const open = pending();
    if (!open.length) return { matched: false, reason: 'nothing was waiting for an answer' };

    let target = null, assumed = false;

    // 1. an explicit id, which is how a reply quoting the message lands exactly right.
    const byId = opts.id ? open.find((e) => e.id === opts.id) : null;
    const quoted = body.match(/\besc_[a-z0-9]{6}\b/i);
    target = byId || (quoted ? open.find((e) => e.id.toLowerCase() === quoted[0].toLowerCase()) : null);

    // 2. word overlap with the question or its options. "use the second one" won't match; "yes, the
    //    Princeton account" will.
    if (!target && open.length > 1) {
      const rw = words(body);
      let best = null, bestScore = 0;
      for (const e of open) {
        const ew = words(e.question + ' ' + e.options.join(' '));
        let score = 0;
        for (const w of rw) if (ew.has(w)) score++;
        if (score > bestScore) { bestScore = score; best = e; }
      }
      if (bestScore > 0) target = best;
    }

    // 3. one open question takes any reply; several with no signal falls back to the most recent and
    //    SAYS it guessed.
    if (!target) {
      target = open[open.length - 1];
      assumed = open.length > 1;
    }

    target.status = 'answered';
    target.answer = body.slice(0, 2000);
    target.answeredAt = now();
    target.answerAssumed = assumed;
    save(target);

    const ws = waiters.get(target.id) || [];
    waiters.delete(target.id);
    for (const res of ws) { try { res({ answered: true, answer: target.answer, assumed }); } catch {} }

    log(`[escalate] ${target.id} answered${assumed ? ' (attribution GUESSED — ' + open.length + ' were open)' : ''}: ${body.slice(0, 80)}`);
    onEvent({ type: 'escalation-answered', id: target.id, answer: target.answer, assumed });
    return { matched: true, id: target.id, assumed, escalation: target, alsoOpen: open.filter((e) => e.id !== target.id).map((e) => e.id) };
  }

  /**
   * wait(id, ms) → { answered, answer, assumed } | { answered:false, timedOut:true }
   *
   * For when there is genuinely nothing else to do. It ALWAYS returns — an unattended run must not be
   * able to wait forever, and the caller is expected to fall back to the stated assumption on timeout.
   */
  function wait(eid, ms = 15 * 60 * 1000) {
    const e = get(eid);
    if (!e) return Promise.resolve({ answered: false, error: 'no such escalation' });
    if (e.status === 'answered' || e.status === 'assumed') return Promise.resolve({ answered: true, answer: e.answer, assumed: !!e.answerAssumed });
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
      const t = setTimeout(() => {
        // Re-read before giving up: an answer may have landed in another process (the cloud bridge,
        // a second window) which has no way to resolve an in-RAM waiter here.
        const fresh = get(eid);
        if (fresh && (fresh.status === 'answered' || fresh.status === 'assumed')) return finish({ answered: true, answer: fresh.answer, assumed: !!fresh.answerAssumed });
        finish({ answered: false, timedOut: true, assumption: (fresh && fresh.assumption) || '' });
      }, Math.max(1, ms));
      const arr = waiters.get(eid) || [];
      arr.push(finish);
      waiters.set(eid, arr);
    });
  }

  /** isAnswered(id) → the answer, or null. The non-blocking check a tick loop uses. */
  function isAnswered(eid) {
    const e = get(eid);
    if (!e) return null;
    if (e.status === 'answered' || e.status === 'assumed') return { answer: e.answer, assumed: !!e.answerAssumed, status: e.status };
    return null;
  }

  /** The block a report or a prompt carries: what is still outstanding, in Siddhant's words. */
  function summary() {
    const open = pending();
    if (!open.length) return '';
    return `WAITING ON YOU (${open.length}):\n` + open.map((e) => `  • ${e.question}${e.assumption ? `  — assuming ${e.assumption} meanwhile` : ''}  [${e.id}]`).join('\n');
  }

  return { ask, answer, wait, isAnswered, pending, all, get, expire, summary, recentInterruptions, isQuiet, conf, get cfg() { return conf(); } };
}

module.exports = { createEscalations, DEFAULTS, STATUSES, DIR, norm };
