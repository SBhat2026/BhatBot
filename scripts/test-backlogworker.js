'use strict';
// BACKLOG WORKER — the specialists work real items while Siddhant is away.
//
// This is the one background loop that spends money on work nobody asked for in the moment, so the
// interesting tests are not "does it run" but "does it REFUSE". Every guard below exists because
// the failure it prevents is expensive, invisible, or both:
//   • running during a foreground turn steals the rate budget from the person actually waiting;
//   • running twice at once doubles spend for one result;
//   • re-attempting an item that needs a human is an infinite loop that looks like progress;
//   • no daily cap means an agent that quietly bills all night, which is a worse bug than the idle
//     office this was built to fix.
//
// Pure: plan/parse/route/record take a clock and return decisions, so all of it runs with no API
// key, no fleet and no spend.
const assert = require('assert');
const w = require('../lib/backlogworker');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const DAY = 864e5;
const NOW = Date.parse('2026-08-21T12:00:00Z');
const today = new Date(NOW).toISOString().slice(0, 10);

// ── parsing: take the open work, leave what is not ours ───────────────────────────────────────
const MD = `# Backlog

## Open

### Split main.js
- ⬜ **B1** — extract the agent loop into \`lib/loop.js\`
- ⬜ **B2** — extract the tool registry into \`lib/tools/\`

### Second brain
- ⬜ **P3 Scout** — web enrichment of graph nodes, none exists today
- ✅ P4 — already done, should never be picked up

## Needs Siddhant, not code
- ⬜ **Cloud deploy** — your keys live there, so it is your call
- ⬜ **Stable tunnel** — needs a domain on your CF account

## Known-good, do not "fix"
- ⬜ \`lib/brain.js\` keeps its own cosine on purpose
`;
{
  const items = w.parseBacklog(MD);
  const texts = items.map((i) => i.text);
  ok(items.length === 3, `took only the actionable items (${items.length})`);
  ok(texts.some((t) => /B1/.test(t)) && texts.some((t) => /P3 Scout/.test(t)), 'picked up the real open work');
  ok(!texts.some((t) => /Cloud deploy|Stable tunnel/.test(t)),
    '"Needs Siddhant" is excluded — an agent cannot deploy with your credentials and should not try');
  ok(!texts.some((t) => /cosine/.test(t)),
    '"Known-good, do not fix" is excluded — that section exists precisely to stop a well-meaning agent from "fixing" it');
  ok(!texts.some((t) => /already done/.test(t)), 'a ✅ line is not an open item');
  ok(items.every((i) => i.section && i.text.length > 11), 'each item carries its section for routing context');
}
{
  ok(w.parseBacklog('').length === 0, 'an empty file yields nothing rather than throwing');
  ok(w.parseBacklog(null).length === 0, 'so does null');
  ok(w.parseBacklog('- ⬜ tiny').length === 0, 'a too-short line is noise, not a task');
}

// ── routing: free and deterministic, because it runs before any model call ────────────────────
{
  ok(w.routeFor('extract the agent loop into lib/loop.js') === 'coding', 'code work → the coding specialist');
  ok(w.routeFor('web enrichment: research and compare sources') === 'research', 'investigation → research');
  ok(w.routeFor('deploy the cloud and set up the domain tunnel') === 'lifeadmin', 'logistics → life-admin');
  ok(w.routeFor('something entirely unclassifiable zzz') === 'research',
    'anything unmatched goes to research — the READ-ONLY specialist is the safe default for work we could not classify');
  ok(w.routeFor('') === 'research', 'empty text is routed, not crashed');
}

// ── the refusals ──────────────────────────────────────────────────────────────────────────────
const items = w.parseBacklog(MD);
const base = { now: NOW, items, idleSince: NOW - 10 * 60000, busy: false, lockHeld: false, state: {} };
{
  ok(w.plan(base).run === true, 'idle, in budget, with work available → runs');
  ok(w.plan({ ...base, busy: true }).run === false, 'REFUSES while a foreground turn is running — the person waiting owns the rate budget');
  ok(/busy/.test(w.plan({ ...base, busy: true }).reason), 'and says why');
  ok(w.plan({ ...base, lockHeld: true }).run === false, 'REFUSES when another background worker holds the lock');
  ok(w.plan({ ...base, idleSince: NOW - 1000 }).run === false, 'REFUSES a second after a turn ends — "away" has to mean something');
  ok(w.plan({ ...base, idleSince: 0 }).run === false, 'REFUSES when the idle clock was never set');
  ok(w.plan({ ...base, cfg: { enabled: false } }).run === false, 'an explicit off switch works');
  ok(w.plan({ ...base, items: [] }).run === false, 'nothing to do → does not run');
}
{
  const spent = { ...base, state: { day: today, spentUsd: 5 } };
  ok(w.plan(spent).run === false && /spend cap/.test(w.plan(spent).reason), 'REFUSES past the daily spend cap');
  const many = { ...base, state: { day: today, countToday: 99 } };
  ok(w.plan(many).run === false && /item cap/.test(w.plan(many).reason), 'REFUSES past the daily item cap');
  // Caps are PER DAY — yesterday's spend must not silence it forever.
  const yesterday = { ...base, state: { day: '2026-08-20', spentUsd: 99, countToday: 99 } };
  ok(w.plan(yesterday).run === true, "yesterday's caps do not carry over");
}
{
  // An item that needs a human would otherwise be retried forever, looking like progress.
  const key = w.itemKey(items[0]);
  const justTried = { ...base, state: { attempted: { [key]: NOW - 3600000 } } };
  const d = w.plan(justTried);
  ok(d.run === true && w.itemKey(d.item) !== key, 'a recently-attempted item is skipped in favour of another');
  const allTried = { ...base, state: { attempted: Object.fromEntries(items.map((i) => [w.itemKey(i), NOW - 3600000])) } };
  ok(w.plan(allTried).run === false, 'when everything was tried recently it stops rather than grinding');
  const stale = { ...base, state: { attempted: Object.fromEntries(items.map((i) => [w.itemKey(i), NOW - 5 * DAY])) } };
  ok(w.plan(stale).run === true, 'but an item untouched for days becomes eligible again');
}
{
  // Ordering: NEVER-attempted first, then least-recently-attempted. Both fall out of sorting on
  // `attempted[key] || 0`, and together they mean the list gets worked THROUGH rather than the top
  // item being ground on repeatedly.
  const st = { attempted: { [w.itemKey(items[0])]: NOW - 4 * DAY, [w.itemKey(items[1])]: NOW - 6 * DAY } };
  const d = w.plan({ ...base, state: st });
  ok(w.itemKey(d.item) === w.itemKey(items[2]), 'a never-attempted item outranks both previously-attempted ones');
  // With the untried one removed, the older attempt wins.
  const d2 = w.plan({ ...base, items: [items[0], items[1]], state: st });
  ok(w.itemKey(d2.item) === w.itemKey(items[1]), 'between two tried items, the least-recently-tried is chosen');
}

// ── the brief asks for a WRITE-UP, never a change ─────────────────────────────────────────────
{
  const b = w.briefFor(items[0]);
  ok(/WRITE-UP — not a code change/.test(b), 'the brief is explicit that nothing is to be edited');
  ok(/Nothing you do here is committed/.test(b), 'and that nothing is committed, so the agent does not try to be helpful');
  ok(/ALREADY DONE/.test(b), 'it is told that "this is already done" is the most valuable answer — which has happened repeatedly here');
  ok(b.includes(items[0].text), 'the item text is actually in the brief');
  ok(/confidence/i.test(b), 'and it must report confidence rather than asserting flatly');
}

// ── recording folds state forward correctly ───────────────────────────────────────────────────
{
  const r = w.record({}, items[0], { ok: true, usd: 0.12 }, NOW);
  ok(r.day === today && r.countToday === 1, 'first run of the day starts the counters');
  ok(r.spentUsd === 0.12 && r.attempted[w.itemKey(items[0])] === NOW, 'spend and attempt are both recorded');
  const r2 = w.record(r, items[1], { ok: false, usd: 0.08 }, NOW);
  ok(r2.countToday === 2 && Math.abs(r2.spentUsd - 0.2) < 1e-9, 'a second run accumulates');
  ok(r2.last.ok === false, 'a failure is recorded as a failure, not silently dropped');
  const rNew = w.record(r2, items[0], { ok: true, usd: 0.05 }, NOW + DAY);
  ok(rNew.countToday === 1 && rNew.spentUsd === 0.05, 'a new day resets the counters');
  ok(Object.keys(rNew.attempted).length === 2, 'but the attempt history survives the day boundary');
  ok(w.record({}, items[0], null, NOW).spentUsd === 0, 'a run that reported no cost records zero, not NaN');
}

// ── runItem: reports state transitions so the office can animate from real work ───────────────
(async () => {
  {
    const seen = [];
    const res = await w.runItem(items[0], {
      runAgent: async () => ({ success: true, result: 'findings', usd: 0.03 }),
      onState: (s) => seen.push(s.status), now: () => NOW,
    });
    ok(res.ok === true, 'a successful item reports ok');
    assert.deepStrictEqual(seen, ['working', 'done']); pass++;
    ok(true, 'it emits working → done, which is what walks the character to a desk and back');
  }
  {
    const seen = [];
    const res = await w.runItem(items[0], { runAgent: async () => { throw new Error('model down'); }, onState: (s) => seen.push(s.status), now: () => NOW });
    ok(res.ok === false && /model down/.test(res.error), 'a thrown agent is caught and reported');
    ok(seen[seen.length - 1] === 'failed', 'and the character is marked failed rather than left working forever');
  }
  {
    const res = await w.runItem(items[0], { runAgent: async () => ({ success: false, error: 'no key' }), onState: () => {}, now: () => NOW });
    ok(res.ok === false, 'an unsuccessful (not thrown) result is also a failure');
  }
  {
    const res = await w.runItem(items[0], {});
    ok(res.ok === false && /runAgent/.test(res.error), 'a missing dependency is reported, not thrown');
  }
  // ── the wall clock is ENFORCED, not merely passed along ─────────────────────────────────────
  // The first cut handed `timeoutMs` to runAgent and trusted it. The live wiring in main.js then
  // ignored the argument, so `maxItemMs` was a documented guarantee that did nothing — a background
  // loop with no deadline. The underlying run is step-capped too, but a step cap is not a clock.
  {
    const t0 = Date.now();
    const res = await w.runItem(items[0], {
      runAgent: () => new Promise(() => {}),          // never settles
      onState: () => {}, now: () => Date.now(),
    }, { maxItemMs: 300 });
    const took = Date.now() - t0;
    ok(res.ok === false, 'an item that never finishes is a failure, not a hang');
    ok(/budget/.test(res.error || ''), 'and the error names the budget it blew: ' + res.error);
    ok(took < 4000, `and it actually returns (${took}ms) rather than waiting forever`);
  }
  {
    // The budget must be handed DOWN, so the agent can bound itself too.
    let sawOpts = null;
    await w.runItem(items[0], { runAgent: async (n, b, o) => { sawOpts = o; return { success: true }; }, onState: () => {}, now: () => NOW }, { maxItemMs: 1234, maxSteps: 3 });
    ok(sawOpts && sawOpts.timeoutMs === 1234, 'runAgent receives the wall-clock budget');
    ok(sawOpts && sawOpts.maxSteps === 3, 'and the step cap, so a write-up does not burn a full tool loop');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
    ok(/runAgent: async \(name, brief, o = \{\}\)/.test(src), 'and the LIVE wiring in main.js actually accepts them (it used to drop the argument)');
    ok(/maxSteps: o\.maxSteps \|\| 5/.test(src), 'and passes maxSteps through to subagents.run');
  }

  // ── a failure must SAY WHY, and spend must be MEASURED not volunteered ──────────────────────
  // Both of these were live gaps found by watching the real loop: it logged a bare ✗ with a
  // duration (so a 1-second failure and a 2h50m one looked identical), and it recorded usd:0 on
  // every item because subagents.run does not report cost — meaning the daily $ cap, in the one
  // loop that spends money unattended, could never fire.
  {
    const r = w.record({}, items[0], { ok: false, error: 'rate limited', ms: 1200, usd: 0.04 }, NOW);
    ok(r.last.error === 'rate limited', 'the failure reason is persisted, not just logged to a file that rolls');
    ok(r.last.ms === 1200 && r.last.usd === 0.04, 'along with how long it took and what it cost');
    const ok2 = w.record({}, items[0], { ok: true, ms: 5, usd: 0.01 }, NOW);
    ok(ok2.last.error === undefined, 'a success carries no error field');
    const bare = w.record({}, items[0], { ok: false }, NOW);
    ok(/no error reported/.test(bare.last.error), 'a failure with no message still records that fact rather than an empty string');

    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
    ok(/const before = costToday\(\)\.usd/.test(src), 'the live wiring MEASURES spend from the real cost ledger');
    ok(/const spent = Math\.max\(0, \(costToday\(\)\.usd \|\| 0\) - before\)/.test(src), 'as a before/after delta, so tool spend inside the run counts too');
    ok(/no error reported/.test(src), 'and the log line reports the failure reason');
  }

  // ── transient refusals retry; permanent ones wait ───────────────────────────────────────────
  // The boot tick lands at 90s against a 120s idle threshold — a guaranteed no, for a condition
  // that clears 30 seconds later. Without the hint the worker then waited a full 20-minute cycle,
  // which is the same "a transient refusal costs a whole period" bug as the lock skip.
  {
    const t = (ctx) => w.plan({ now: NOW, items, state: {}, idleSince: NOW - 9e6, busy: false, lockHeld: false, ...ctx });
    ok(t({ idleSince: NOW - 5000 }).retry === true, 'not-idle-long-enough retries shortly — it clears on its own');
    ok(t({ busy: true }).retry === true, 'busy retries — a foreground turn ends');
    ok(t({ lockHeld: true }).retry === true, 'a lock skip retries — the holder finishes');
    ok(!t({ state: { day: today, countToday: 99 } }).retry, 'a daily cap does NOT retry — nothing clears until tomorrow');
    ok(!t({ items: [] }).retry, 'nothing-to-do does NOT retry — spinning on an empty list is pointless');
    ok(!t({ cfg: { enabled: false } }).retry, 'and disabled does not retry');

    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
    ok(/decision\.retry && _blOnSkip/.test(src), 'the live wiring acts on the hint');
    ok(/if \(_blRetry\) return;/.test(src), 'and keeps at most ONE pending retry, so it can never become a queue');
  }

  console.log(`✅ backlog worker: ${pass} assertions passed`);
})().catch((e) => { console.error('❌ backlog worker:', e.message); process.exit(1); });
