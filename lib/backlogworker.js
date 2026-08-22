'use strict';
// ── BACKLOG WORKER — the specialists actually work while you are away ────────────────────────────
//
// Two problems, one answer.
//
// The FLEET office was populated but STATIC: the standing specialists stand there idle, because
// nothing ever gives them anything to do. An office of motionless people is only marginally better
// than an empty one. Meanwhile BACKLOG.md lists real, verified open work that nobody is doing.
//
// So: give the specialists the backlog. They move because they are genuinely working, not because
// something is animating them for show. State transitions in the office are then a truthful readout
// of what is happening, which is the only kind worth rendering.
//
// WHAT IT WILL NOT DO, and why:
//   • no unsupervised code changes. It produces PLANS, RESEARCH and FINDINGS. Editing the repo
//     unattended is what lib/selfdrive.js is for, and that is human-gated on purpose.
//   • never while you are working. Foreground turns own the rate budget and the machine.
//   • never twice at once, and never against a live lock held by weaver/synapse/self-heal.
//   • never past a daily spend cap. An agent that quietly bills all night is a worse bug than an
//     idle office.
//
// PURE: every dependency is injected, so the whole policy — selection, routing, budgeting, the
// refusal conditions — is testable with no API key, no fleet and no spend.

const DEFAULTS = {
  everyMin: 20,             // how often to consider starting an item
  maxPerDay: 8,             // hard stop on items attempted per day
  usdPerDay: 0.75,          // hard stop on spend per day
  minIdleMs: 120000,        // how long the agent must have been idle before we start (2 min)
  maxItemMs: 600000,        // give up on a single item after 10 min
};

// Route an item to the specialist best suited to it. Keyword-based on purpose: this runs before any
// model call, so it must be free and deterministic. Anything unmatched goes to research, which is
// the read-only specialist — the safe default for work we could not classify.
const ROUTES = [
  { agent: 'coding', re: /\b(extract|refactor|lib\/|\.js\b|module|split|test|implement|wire|build|api|schema|tool)\b/i },
  { agent: 'research', re: /\b(research|investigate|compare|evaluate|survey|find|enrich|scout|web|paper|benchmark)\b/i },
  { agent: 'lifeadmin', re: /\b(schedule|calendar|remind|deploy|install|account|token|domain|tunnel)\b/i },
];
function routeFor(text) {
  for (const r of ROUTES) if (r.re.test(String(text || ''))) return r.agent;
  return 'research';
}

/**
 * Parse open items out of BACKLOG.md.
 * `⬜` is the open marker; a line with ✅ or under "Needs Siddhant" is not ours to do.
 */
function parseBacklog(md) {
  const out = [];
  let section = '';
  let mine = true;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim();
    if (/^#{2,3}\s/.test(line)) {
      section = line.replace(/^#+\s*/, '');
      // Two sections are explicitly not the worker's: things only Siddhant can do, and the
      // "do not fix" list, which exists precisely to stop well-meaning agents from "fixing" it.
      mine = !/needs siddhant|known-good|do not/i.test(section);
      continue;
    }
    if (!mine) continue;
    const m = /^[-*]?\s*⬜\s*(.+)$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/\*\*/g, '').trim();
    if (text.length < 12) continue;
    out.push({ id: text.slice(0, 60), section, text: text.slice(0, 400), agent: routeFor(section + ' ' + text) });
  }
  return out;
}

/** A stable key for "have we already attempted this item", independent of wording tweaks. */
function itemKey(item) {
  return String(item.text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

/**
 * Decide whether to run, and what. PURE — returns a decision, performs nothing.
 *
 * @param {object} ctx
 *   now, items, state {attempted:{key:ts}, spentUsd, day}, idleSince, busy, lockHeld, cfg
 * @returns {{ run:boolean, reason:string, item?:object }}
 */
function plan(ctx = {}) {
  const cfg = { ...DEFAULTS, ...(ctx.cfg || {}) };
  const now = ctx.now || 0;
  if (cfg.enabled === false) return { run: false, reason: 'disabled' };
  if (ctx.busy) return { run: false, reason: 'agent is busy — foreground work owns the machine' };
  if (ctx.lockHeld) return { run: false, reason: 'another background worker holds the lock' };
  if (!ctx.idleSince || now - ctx.idleSince < cfg.minIdleMs) {
    return { run: false, reason: `idle for less than ${Math.round(cfg.minIdleMs / 1000)}s` };
  }
  const st = ctx.state || {};
  const today = new Date(now).toISOString().slice(0, 10);
  const sameDay = st.day === today;
  const doneToday = sameDay ? (st.countToday || 0) : 0;
  const spentToday = sameDay ? (st.spentUsd || 0) : 0;
  if (doneToday >= cfg.maxPerDay) return { run: false, reason: `daily item cap reached (${doneToday}/${cfg.maxPerDay})` };
  if (spentToday >= cfg.usdPerDay) return { run: false, reason: `daily spend cap reached ($${spentToday.toFixed(2)}/$${cfg.usdPerDay})` };

  const attempted = st.attempted || {};
  // Don't re-attempt something tried in the last 3 days — a backlog item that needs a human is
  // otherwise an infinite loop that looks like progress.
  const fresh = (ctx.items || []).filter((i) => {
    const t = attempted[itemKey(i)];
    return !t || (now - t) > 3 * 864e5;
  });
  if (!fresh.length) return { run: false, reason: 'every open item was attempted recently' };

  // Oldest-untried first, so the list is worked through rather than the top item being ground on.
  fresh.sort((a, b) => (attempted[itemKey(a)] || 0) - (attempted[itemKey(b)] || 0));
  return { run: true, reason: 'idle, in budget, item available', item: fresh[0], budget: { doneToday, spentToday, cfg } };
}

/** The instruction handed to the specialist. Deliberately asks for a WRITE-UP, not a change. */
function briefFor(item) {
  return `You are working an item from BhatBot's own backlog, unattended, while Siddhant is away.

ITEM (section "${item.section}"):
${item.text}

Produce a concise, concrete WRITE-UP — not a code change. Nothing you do here is committed.
Cover, in this order:
1. What is actually true in the codebase right now regarding this item. Read the relevant files
   before asserting anything. If it turns out this is ALREADY DONE, say so plainly and stop — that
   is the single most valuable outcome you can produce, and it has happened repeatedly here.
2. The smallest correct approach, naming real files and functions.
3. What could go wrong, and what would have to be verified.
4. A confidence level, and what you are unsure about.

Be terse. If you cannot make progress, say why in one line rather than padding.`;
}

/**
 * Run one item. IO is injected: `runAgent(name, brief)` performs the work, `onState` reports
 * progress so the caller can drive the FLEET office, `now` is the clock.
 */
async function runItem(item, deps = {}, opts = {}) {
  const { runAgent, onState = () => {}, now = () => Date.now(), log = () => {} } = deps;
  if (typeof runAgent !== 'function') return { ok: false, error: 'no runAgent injected' };
  const t0 = now();
  const id = 'backlog:' + itemKey(item).replace(/\s+/g, '-').slice(0, 40);
  onState({ id, agent: item.agent, item, status: 'working', step: 'reading the code' });
  log(`[backlog] ${item.agent} → ${item.text.slice(0, 70)}`);
  const budgetMs = opts.maxItemMs || DEFAULTS.maxItemMs;
  let budgetTimer = null;
  try {
    // ENFORCE the wall clock rather than merely passing it along. The first version handed
    // `timeoutMs` to runAgent and trusted it; the live wiring then dropped the argument on the
    // floor, so `maxItemMs` was a documented guarantee that did nothing — a background loop with no
    // deadline, which is precisely the shape of an agent that quietly bills all night. The
    // underlying run is also step-capped (subagents.run maxSteps), but a step cap is not a clock:
    // eight slow steps against a 700KB file is not the same bound at all.
    const res = await Promise.race([
      runAgent(item.agent, briefFor(item), { timeoutMs: budgetMs, maxSteps: opts.maxSteps }),
      new Promise((_, rej) => { budgetTimer = setTimeout(() => rej(new Error(`item exceeded its ${Math.round(budgetMs / 1000)}s budget`)), budgetMs); }),
    ]);
    const ok = !!(res && res.success !== false);
    onState({ id, agent: item.agent, item, status: ok ? 'done' : 'failed', step: '' });
    return { ok, id, agent: item.agent, item, ms: now() - t0, usd: (res && res.usd) || 0, text: (res && (res.result || res.text)) || '' };
  } catch (e) {
    onState({ id, agent: item.agent, item, status: 'failed', step: '' });
    return { ok: false, id, agent: item.agent, item, ms: now() - t0, error: (e && e.message) || String(e) };
  } finally {
    // CLEAR, don't unref. A leaked 10-minute timer per item is a slow handle leak; unref'ing it
    // instead would stop it holding the event loop open, which sounds tidy and is actually worse —
    // in a bare harness node then exits before the deadline can fire, so the guarantee evaporates
    // exactly where you would go to verify it.
    if (budgetTimer) clearTimeout(budgetTimer);
  }
}

/** Fold a completed run into the persisted state (pure — caller writes it). */
function record(state, item, result, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const sameDay = state.day === today;
  return {
    day: today,
    countToday: (sameDay ? (state.countToday || 0) : 0) + 1,
    spentUsd: +(((sameDay ? (state.spentUsd || 0) : 0) + ((result && result.usd) || 0)).toFixed(4)),
    attempted: { ...(state.attempted || {}), [itemKey(item)]: now },
    last: {
      item: item.text.slice(0, 120), agent: item.agent, ok: !!(result && result.ok),
      at: new Date(now).toISOString(),
      ms: (result && result.ms) || 0,
      usd: (result && result.usd) || 0,
      // Carry the error forward. A ✗ with no reason is the same as no record at all, and the app
      // log rolls at 5MB — the state file is where you look days later.
      ...(result && result.ok ? {} : { error: String((result && result.error) || 'no error reported').slice(0, 300) }),
    },
  };
}

module.exports = { plan, parseBacklog, routeFor, itemKey, briefFor, runItem, record, DEFAULTS, ROUTES };
