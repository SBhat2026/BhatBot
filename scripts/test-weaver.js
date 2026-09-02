'use strict';
// The always-on connection loop. What matters here is that it stays BOUNDED and INTERRUPTIBLE —
// it runs forever on a fanless laptop with a real dollar budget attached.
const assert = require('assert');
const path = require('path');
const { createWeaver } = require(path.join(__dirname, '..', 'lib', 'weaver'));

let pass = 0;
function ok(n) { pass++; console.log('  ✓ ' + n); }

// A synapse stand-in that records exactly how it was driven.
function mockSynapse({ toEmbed = 0, links = [], unexplained = [], budgetLeft = 1 } = {}) {
  const calls = { embedSome: [], linkSlice: [], explainEdges: [], suggest: 0 };
  let remaining = toEmbed;
  let linkQueue = [...links];
  let unexp = [...unexplained];
  return {
    calls,
    budget: () => ({ limit: 1, spent: 1 - budgetLeft, left: budgetLeft }),
    unembedded: () => new Array(remaining).fill(0),
    embedSome: async (n) => { calls.embedSome.push(n); const did = Math.min(n, remaining); remaining -= did; return did; },
    linkSlice: ({ from, count }) => {
      calls.linkSlice.push({ from, count });
      const created = linkQueue.splice(0, 2);
      return { created, nextCursor: from + count, scanned: count };
    },
    unexplained: (n) => unexp.slice(0, n),
    explainEdges: async (edges) => { calls.explainEdges.push(edges.length); unexp = unexp.slice(edges.length); return edges.map((e) => ({ id: e.id, rationale: 'because.' })); },
    suggest: async () => { calls.suggest++; return { suggestions: [{ project: 'PRISM', why: 'w', next: 'n' }] }; },
  };
}

(async () => {
  console.log('[weaver]');

  // 1. PHASE ORDER: embedding blocks everything downstream, so it must go first and exclusively.
  {
    const s = mockSynapse({ toEmbed: 100 });
    const w = createWeaver({ synapse: s, config: { embedPerTick: 24 } });
    w.start();
    const r = await w.tick();
    assert.strictEqual(r.phase, 'embedding');
    assert.strictEqual(r.embedded, 24, 'exactly one bounded batch');
    assert.strictEqual(s.calls.linkSlice.length, 0, 'must not link while vectors are still missing');
    ok('embedding runs first, one bounded batch per tick');
  }

  // 2. Once embedded, it moves to linking and REPORTS what it created (this is the live feed).
  {
    const s = mockSynapse({ toEmbed: 0, links: [{ id: 'e1', fromLabel: 'A', toLabel: 'B', confidence: 0.9 }, { id: 'e2', fromLabel: 'C', toLabel: 'D', confidence: 0.88 }] });
    const events = [];
    const w = createWeaver({ synapse: s, onEvent: (e) => events.push(e), config: { explainMinGapMs: 10 ** 9 } });
    w.start();
    const r = await w.tick();
    assert.strictEqual(r.phase, 'linking');
    assert.strictEqual(r.created, 2);
    const linkEvents = events.filter((e) => e.kind === 'link');
    assert.strictEqual(linkEvents.length, 2, 'every new link is emitted for the UI');
    assert.strictEqual(linkEvents[0].fromLabel, 'A');
    assert.strictEqual(w.status().feed.length, 2, 'and retained in the feed');
    ok('linking emits each new connection as it is made (the live feed)');
  }

  // 3. The cursor ADVANCES and WRAPS — otherwise the loop would re-scan the same window forever.
  {
    const s = mockSynapse({ links: [] });
    const w = createWeaver({ synapse: s, config: { linkScanPerTick: 50, explainMinGapMs: 10 ** 9, suggestMinGapMs: 10 ** 9 } });
    w.start();
    await w.tick(); await w.tick(); await w.tick();
    const froms = s.calls.linkSlice.map((c) => c.from);
    assert.deepStrictEqual(froms, [0, 50, 100], 'cursor must advance each tick');
    ok('the link cursor advances across ticks (no re-scanning the same window)');
  }

  // 4. EXPLAIN is rate-limited INDEPENDENTLY of tick rate — it is the phase that costs money, and a
  //    fast tick must not turn into a fast spend.
  {
    const s = mockSynapse({ unexplained: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] });
    let t = 0;
    const w = createWeaver({ synapse: s, now: () => t, config: { explainMinGapMs: 45000, explainPerTick: 1, suggestMinGapMs: 10 ** 9 } });
    w.start();
    await w.tick();                       // explains one
    assert.strictEqual(s.calls.explainEdges.length, 1);
    t += 1000; await w.tick();            // too soon → must NOT explain
    assert.strictEqual(s.calls.explainEdges.length, 1, 'explain must respect its own clock, not the tick clock');
    t += 45000; await w.tick();
    assert.strictEqual(s.calls.explainEdges.length, 2);
    ok('LLM explanation is rate-limited independently of tick rate');
  }

  // 5. SUGGEST only fires when the graph actually changed — never re-bill for a static graph.
  {
    const s = mockSynapse({ links: [] });
    let t = 10 ** 9;
    const w = createWeaver({ synapse: s, now: () => t, config: { suggestMinGapMs: 1000, suggestMinNewLinks: 5, explainMinGapMs: 10 ** 9 } });
    w.start();
    t += 5000; await w.tick();
    assert.strictEqual(s.calls.suggest, 0, 'no new links → no suggestion call');
    ok('suggestions do not re-bill for an unchanged graph');
  }

  // 6. ...and DOES fire once enough new links have accumulated.
  {
    const links = Array.from({ length: 6 }, (_, i) => ({ id: 'e' + i, fromLabel: 'a', toLabel: 'b' }));
    const s = mockSynapse({ links });
    let t = 10 ** 9;
    const w = createWeaver({ synapse: s, now: () => t, config: { suggestMinGapMs: 0, suggestMinNewLinks: 5, explainMinGapMs: 10 ** 9 } });
    w.start();
    for (let i = 0; i < 3; i++) { await w.tick(); t += 10; }   // drains 2 links per tick → 6 total
    await w.tick();
    assert.strictEqual(s.calls.suggest, 1, 'enough new links → one suggestion pass');
    assert.ok(w.status().feed.some((e) => e.kind === 'suggest'));
    ok('suggestions fire once enough new links have accumulated');
  }

  // 6b. A BLOCKED PHASE MUST NOT HOLD THE PIPELINE.
  //
  // The live failure, exactly: 1,821 nodes carried vectors from a retired embedder so they always
  // looked unembedded, and the budget was spent so embedSome could never shrink that queue. Phase 1
  // returned on every tick regardless, and the weaver never reached LINK, EXPLAIN or SUGGEST again —
  // for ten days, while reporting itself "on" and busy "embedding".
  {
    const s = mockSynapse({ toEmbed: 1821, links: [[{ id: 'x', from: 'a', to: 'b', confidence: 0.9 }]] });
    s.embedSome = async () => 0;                       // cannot embed: budget spent / no key / offline
    const w = createWeaver({ synapse: s });
    w.start();
    for (let i = 0; i < 5; i++) await w.tick();
    assert.ok(s.calls.linkSlice.length > 0, 'a stalled EMBED phase falls through to LINK instead of blocking it forever');
    assert.ok(s.calls.suggest > 0 || s.calls.linkSlice.length >= 5, 'and keeps reaching the later phases every tick');
    assert.ok(w.status().embedStalled === true, 'the stall is reported rather than looking like normal progress');
    ok('a phase that cannot make progress does not hold the pipeline');

    // ...and it must recover on its own once embedding works again, without a restart.
    let canEmbed = false;
    const s2 = mockSynapse({ toEmbed: 50 });
    const realEmbed = s2.embedSome;
    s2.embedSome = async (n) => (canEmbed ? realEmbed(n) : 0);
    const w2 = createWeaver({ synapse: s2 });
    w2.start();
    await w2.tick();
    assert.ok(w2.status().embedStalled === true, 'stalled while blocked');
    canEmbed = true;
    await w2.tick();
    assert.ok(w2.status().embedStalled === false, 'and clears itself the moment embedding works again');
    ok('the stall is a state, not a latch');
  }

  // 7. EVERY GATE. A background loop that ignores the budget, the heat, or the user is a liability.
  {
    const s = mockSynapse({ toEmbed: 100 });
    // BUDGET — bounded at the point of SPENDING, not by refusing to think.
    // This assertion used to read `skipped === 'budget'`, which pinned a real bug as the contract:
    // an exhausted budget skipped the entire tick, including LINK, which is local cosine over
    // vectors already paid for. Live, that left the second brain inert for ten days. The money is
    // still bounded — embedSome/explainEdges/suggest each check `left()` themselves.
    const broke = createWeaver({ synapse: { ...mockSynapse({ toEmbed: 0 }), budget: () => ({ limit: 1, spent: 1, left: 0 }) } });
    broke.start();
    const brokeTick = await broke.tick();
    assert.ok(!brokeTick.skipped, 'a spent budget does not skip the tick: ' + JSON.stringify(brokeTick));
    assert.ok(broke.status().budgetSpent === true, 'but status still reports the budget as spent, so the UI can say so');

    // thermal
    const hot = createWeaver({ synapse: s, governor: { allowBackgroundTick: () => false } });
    hot.start();
    assert.strictEqual((await hot.tick()).skipped, 'thermal');

    // the user is mid-turn
    const busy = createWeaver({ synapse: s, isIdle: () => false });
    busy.start();
    assert.strictEqual((await busy.tick()).skipped, 'agent-busy');

    // not started
    const off = createWeaver({ synapse: s });
    assert.strictEqual((await off.tick()).skipped, 'disabled');
    ok('budget / thermal / agent-busy / disabled each stop a tick, and say which');
  }

  // 8. Overlapping ticks cannot run concurrently — the caller may tick faster than a tick completes.
  {
    let inside = 0, maxInside = 0;
    const s = mockSynapse({ toEmbed: 100 });
    s.embedSome = async () => { inside++; maxInside = Math.max(maxInside, inside); await new Promise((r) => setTimeout(r, 40)); inside--; return 1; };
    const w = createWeaver({ synapse: s });
    w.start();
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    assert.strictEqual(maxInside, 1, 'ticks must not overlap');
    ok('overlapping ticks are refused (one slice at a time)');
  }

  // 9. A throwing phase is contained: recorded, and the loop keeps running.
  {
    const s = mockSynapse({ toEmbed: 10 });
    s.embedSome = async () => { throw new Error('network down'); };
    const w = createWeaver({ synapse: s });
    w.start();
    const r = await w.tick();
    assert.ok(/network down/.test(r.error));
    assert.strictEqual(w.status().stats.errors, 1);
    assert.strictEqual(w.status().running, false, 'must release even when a phase throws');
    ok('a failing phase is contained and the loop stays alive');
  }

  // 10. status() is what the UI renders — it must expose the live state.
  {
    const s = mockSynapse({ links: [{ id: 'e1', fromLabel: 'A', toLabel: 'B', confidence: 0.9 }] });
    const w = createWeaver({ synapse: s, config: { explainMinGapMs: 10 ** 9, suggestMinGapMs: 10 ** 9 } });
    w.start(); await w.tick();
    const st = w.status();
    assert.strictEqual(st.enabled, true);
    assert.ok(st.budget && typeof st.budget.left === 'number');
    assert.ok(st.stats.ticks >= 1);
    assert.ok(Array.isArray(st.feed));
    w.stop();
    assert.strictEqual(w.status().enabled, false);
    ok('status() exposes phase, budget, counters and the live feed');
  }

  console.log(`[weaver] ${pass} assertions passed`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
