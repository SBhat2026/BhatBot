'use strict';
// ── THE WEAVER — the second brain's always-on connection loop ─────────────────────────────────────
// synapse.connect() is a BATCH: embed everything that lacks a vector, propose every link, write
// rationales, done. That shape is wrong for a loop that should run continuously while the app is
// open on a fanless 16GB laptop:
//   • it embeds ~1,700 nodes in one burst (minutes of network + a visible spend spike);
//   • it is all-or-nothing — interrupt it and the work is lost, because nothing is checkpointed;
//   • it gives the UI nothing to show until it finishes, so "watch connections being made" is
//     impossible by construction.
//
// The Weaver is the same work re-shaped into SLICES. Each tick does a bounded amount — embed a few,
// link a few, explain one or two — records a cursor, and emits what it just found. Interrupting it
// costs one slice. The UI gets a live feed because the loop is inherently incremental.
//
// FOUR PHASES, in priority order. Each tick runs at most one, so a tick stays short:
//   1. EMBED     — nodes with no vector. Cheap ($0.02/M tokens) and everything else depends on it.
//   2. LINK      — propose edges for a moving window of nodes. Free (cosine, local).
//   3. EXPLAIN   — one LLM sentence for the strongest un-explained link. The expensive phase, so it
//                  is rate-limited independently of the tick rate.
//   4. SUGGEST   — periodically turn the strongest links into "what to move ahead on" / "this looks
//                  like a new project". Rarest and most expensive; gated on there being new links
//                  since the last suggestion, so it never re-bills for an unchanged graph.
//
// EVERY tick is gated on: the budget, the thermal/memory governor, idleness, and a window being
// open. The user asked for "constantly running while open" — `while open` is doing real work in that
// sentence, and so is the governor: a loop that cooks the laptop would get switched off.
//
// Pure + DI. No Electron, no timers of its own (the caller owns cadence). See scripts/test-weaver.js.

const DEFAULTS = {
  embedPerTick: 24,          // nodes embedded per tick — one batch, ~1s
  linkScanPerTick: 120,      // nodes considered for linking per tick
  explainPerTick: 1,         // LLM rationales per tick (the costly one)
  explainMinGapMs: 45_000,   // ...and never more often than this, regardless of tick rate
  suggestMinGapMs: 30 * 60_000,
  suggestMinNewLinks: 5,     // don't re-bill for a graph that hasn't changed
  maxFeed: 60,               // live feed depth kept in RAM for the UI
};

function createWeaver({ synapse, brain, governor = null, isIdle = () => true, now = () => Date.now(), log = () => {}, onEvent = () => {}, config = {} } = {}) {
  if (!synapse) throw new Error('weaver: synapse required');
  const cfg = { ...DEFAULTS, ...config };

  let running = false;          // a tick is in flight
  let enabled = false;          // the loop is switched on
  let cursor = 0;               // link-scan position, wraps
  // null = NEVER, not "at epoch 0". Initializing these to 0 makes `now() - last >= gap` false on a
  // zero-based clock, so the first explain/suggest would never fire — the same first-poll trap the
  // governor had. Real Date.now() hides it; a test clock does not.
  let lastExplainAt = null, lastSuggestAt = null;
  let newLinksSinceSuggest = 0;
  let phase = 'idle';
  const feed = [];              // most-recent-last: what the weaver just discovered
  const stats = { ticks: 0, embedded: 0, linked: 0, explained: 0, suggested: 0, skipped: 0, errors: 0 };

  function emit(kind, data) {
    const e = { kind, ts: now(), ...data };
    if (kind === 'link' || kind === 'explain' || kind === 'suggest') {
      feed.push(e);
      while (feed.length > cfg.maxFeed) feed.shift();
    }
    try { onEvent(e); } catch {}
    return e;
  }

  // Why a tick was skipped is worth reporting — a silently idle background loop is indistinguishable
  // from a broken one, and this loop is meant to be visibly always-on.
  function blockedReason() {
    if (!enabled) return 'disabled';
    if (running) return 'busy';
    if (!isIdle()) return 'agent-busy';
    if (governor && !governor.allowBackgroundTick('weaver')) return 'thermal';
    try { if (synapse.budget && synapse.budget().left <= 0) return 'budget'; } catch {}
    return null;
  }

  async function tick() {
    const blocked = blockedReason();
    if (blocked) { stats.skipped++; return { skipped: blocked }; }
    running = true; stats.ticks++;
    try {
      // 1 ── EMBED
      // Learn the current embedder's dimension first: if the store is full of vectors from a
      // PREVIOUS model, nothing looks unembedded and the loop would never migrate the graph.
      if (synapse.ensureEmbedDim) { try { await synapse.ensureEmbedDim(); } catch {} }
      const need = synapse.unembedded ? synapse.unembedded() : [];
      if (need.length) {
        phase = 'embedding';
        emit('phase', { phase, remaining: need.length });
        const n = await synapse.embedSome(cfg.embedPerTick);
        stats.embedded += n;
        return { phase, embedded: n, remaining: need.length - n };
      }

      // 2 ── LINK (free, local)
      phase = 'linking';
      const res = synapse.linkSlice({ from: cursor, count: cfg.linkScanPerTick });
      cursor = res.nextCursor;
      if (res.created.length) {
        stats.linked += res.created.length;
        newLinksSinceSuggest += res.created.length;
        for (const l of res.created) emit('link', l);
        return { phase, created: res.created.length };
      }

      // 3 ── EXPLAIN (paced independently of tick rate — this is the phase that costs money)
      if (lastExplainAt === null || now() - lastExplainAt >= cfg.explainMinGapMs) {
        const pending = synapse.unexplained ? synapse.unexplained(cfg.explainPerTick) : [];
        if (pending.length) {
          phase = 'explaining';
          emit('phase', { phase, remaining: pending.length });
          lastExplainAt = now();
          const done = await synapse.explainEdges(pending);
          stats.explained += done.length;
          for (const d of done) emit('explain', d);
          return { phase, explained: done.length };
        }
      }

      // 4 ── SUGGEST (rarest; only when the graph actually changed)
      if ((lastSuggestAt === null || now() - lastSuggestAt >= cfg.suggestMinGapMs) && newLinksSinceSuggest >= cfg.suggestMinNewLinks) {
        phase = 'suggesting';
        emit('phase', { phase });
        lastSuggestAt = now();
        newLinksSinceSuggest = 0;
        const s = await synapse.suggest();
        const items = (s && s.suggestions) || [];
        stats.suggested += items.length;
        emit('suggest', { items });
        return { phase, suggestions: items.length };
      }

      phase = 'settled';
      return { phase, idle: true };
    } catch (e) {
      stats.errors++;
      log('[weaver] tick failed: ' + e.message);
      return { error: e.message };
    } finally { running = false; }
  }

  function start() { enabled = true; log('[weaver] on'); emit('state', { enabled: true }); }
  function stop() { enabled = false; phase = 'idle'; log('[weaver] off'); emit('state', { enabled: false }); }
  function status() {
    let budget = null;
    try { budget = synapse.budget ? synapse.budget() : null; } catch {}
    return { enabled, running, phase, cursor, stats: { ...stats }, budget, blocked: blockedReason(), newLinksSinceSuggest, feed: feed.slice(-20) };
  }

  return { tick, start, stop, status, feed: () => feed.slice(), _setCursor: (c) => { cursor = c; } };
}

module.exports = { createWeaver, DEFAULTS };
