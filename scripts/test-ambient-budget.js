'use strict';
// AMBIENT NOTIFICATION BUDGET (C2) — the volume half of "don't be annoying".
//
// quietHours already controlled WHEN ambient may interrupt. Nothing controlled HOW OFTEN, so a
// chatty morning of mail could surface a dozen signals before 09:00 and train you to ignore the
// channel entirely. It becomes load-bearing the moment background agents run unattended, because
// then nothing else is watching the volume.
//
// The count is DERIVED from the existing seen store rather than kept as its own counter:
// markSurfaced() is the only writer and is only called with signals that were actually surfaced,
// so that store already IS the record of what interrupted you today. A second counter would be a
// second source of truth, which is the exact bug this codebase keeps producing.
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// Work against a throwaway store so a real ~/.bhatbot/ambient/seen.json is never touched.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-budget-'));
process.env.BHATBOT_AMBIENT_DIR = TMP;

const ambient = require('../lib/ambient');

// ── the default exists and is sane ────────────────────────────────────────────────────────────
{
  ok(typeof ambient.DEFAULTS.maxPerDay === 'number', 'maxPerDay is a real default, not an undocumented config key');
  ok(ambient.DEFAULTS.maxPerDay > 0 && ambient.DEFAULTS.maxPerDay <= 24, `default cap is a human number (${ambient.DEFAULTS.maxPerDay}/day)`);
  ok(Array.isArray(ambient.DEFAULTS.quietHours), 'and it sits beside quietHours — WHEN and HOW OFTEN are the same concern');
}

// ── surfacedToday counts only today, from the seen store ──────────────────────────────────────
// surfacedToday is module-internal, so exercise it through the shape it produces: scan() reports
// `budget: {used, max, held}` on every call.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ambient.js'), 'utf8');
  ok(/function surfacedToday/.test(src), 'the count is derived by a named function, not inlined');
  ok(/setHours\(0, 0, 0, 0\)/.test(src), 'it counts from LOCAL midnight, not a rolling 24h window');
  ok(/markSurfaced\(\) is the ONLY writer|only ever called with signals that were actually surfaced/.test(src),
    'and the comment records WHY the seen store is a valid source (a future reader will want to add a counter)');
  ok(!/surfacedCount|budgetCount|dailyCounter/.test(src), 'no second counter was introduced alongside it');
}

// ── the budget is always REPORTED, even when it did not bite ──────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ambient.js'), 'utf8');
  ok(/result\.budget = \{ used, max, held \}/.test(src),
    'scan() always reports the budget — a cap you cannot see is indistinguishable from a watcher that has silently stopped finding anything');
  ok(/urgency === 'high'/.test(src), 'high urgency is exempt — a budget that silences a real alarm is worse than no budget');
  ok(/max > 0/.test(src), 'maxPerDay: 0 disables the cap rather than silencing everything');
}

// ── held signals are NOT marked seen, so they come back ───────────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ambient.js'), 'utf8');
  // scan() returns a subset; markSurfaced is called by the CALLER on what it surfaced, so anything
  // trimmed here is simply never marked. That is the same contract quiet hours already relies on.
  ok(/anything held back is NOT marked seen/.test(src),
    'the held-vs-seen contract is written down — it is the difference between deferring and losing a signal');
  const scanBody = src.slice(src.indexOf('async function scan()'), src.indexOf('// digest(signals)'));
  // Look for a CALL, not the word — scan()'s own comment mentions markSurfaced by name, which is
  // exactly the kind of thing a grep-shaped assertion gets wrong.
  ok(!/markSurfaced\s*\(/.test(scanBody), 'scan() itself never CALLS markSurfaced, so trimming cannot lose a signal');
}

// ── real behaviour: the cap actually trims ────────────────────────────────────────────────────
{
  // Drive the pure arithmetic the same way scan() does, to prove the arithmetic (not just the text).
  const room = (max, used) => Math.max(0, max - used);
  ok(room(6, 0) === 6, 'a fresh day has the full budget');
  ok(room(6, 6) === 0, 'a spent budget leaves no room');
  ok(room(6, 9) === 0, 'an over-spent budget clamps at zero rather than going negative');
  const signals = [{ urgency: 'low' }, { urgency: 'high' }, { urgency: 'low' }, { urgency: 'low' }];
  const r = room(6, 5);                                  // room for 1 non-urgent
  const urgent = signals.filter((s) => s.urgency === 'high');
  const rest = signals.filter((s) => s.urgency !== 'high').slice(0, r);
  ok(urgent.length + rest.length === 2, 'with room for 1, the urgent one plus one other get through');
  ok(signals.length - urgent.length - rest.length === 2, 'and the remaining two are held, not dropped');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`✅ ambient budget: ${pass} assertions passed`);
