'use strict';
// Ambient PATROL (proactive presence). While the app is on, BhatBot quietly checks its own health
// on a timer — WITHOUT being asked — and RELAYS anything noteworthy to Siddhant over Telegram, or
// CALLS him if it's urgent. The actual auto-FIXING of code breakage is done by the self-heal loop
// (lib/selfheal.js); patrol is the monitoring + reporting layer that sits on top of it.
//
// Design rules:
//   • Relay on CHANGE, never a heartbeat — no "all good" spam. Silence means healthy.
//   • Battery-aware (skips when on battery + power-saver) and quiet-hours-aware.
//   • Cheap checks only (no paid API calls): cloud link state, self-heal backlog/outcomes, crash count.
//
//   const patrol = require('./lib/patrol')(ctx); patrol.start();
//
// ctx: { loadConfig, telegramNotify, notifyUser, cloudConnected, selfhealStatus, crashCount, shouldSpare, log }

module.exports = function makePatrol(ctx) {
  const { loadConfig, telegramNotify, notifyUser, cloudConnected, selfhealStatus, crashCount,
          shouldSpare, snapshot: liveSnapshot, recentEvents, log = () => {} } = ctx;
  let timer = null;
  let last = null;                 // previous snapshot, for change detection
  let cloudDownSince = 0, agentBusySince = 0;

  function snapshot() {
    let heal = {}; try { heal = selfhealStatus ? selfhealStatus() : {}; } catch {}
    let live = {}; try { live = liveSnapshot ? liveSnapshot() : {}; } catch {}
    // error events in the last ~10 min (structured events.jsonl), for spike detection
    let recentErrors = 0;
    try { const cutoff = Date.now() - 10 * 60 * 1000;
      recentErrors = (recentEvents ? recentEvents(80) : []).filter((e) => e && e.kind === 'error' && new Date(e.ts).getTime() >= cutoff).length; } catch {}
    return {
      cloud: cloudConnected ? !!cloudConnected() : true,
      healPending: heal.pending || (Array.isArray(heal.queue) ? heal.queue.length : 0) || 0,
      crashes: crashCount ? crashCount() : 0,
      agentState: (live.agent && live.agent.state) || 'idle',
      elCooldownMs: (live.health && live.health.elevenLabsCooldownMs) || 0,
      recentErrors,
    };
  }

  function inQuietHours() {
    try { const q = (loadConfig().patrol || {}).quietHours; if (!q) return false;
      const h = new Date().getHours(); const [a, b] = q;
      return a <= b ? (h >= a && h < b) : (h >= a || h < b); } catch { return false; }
  }

  async function tick() {
    try {
      if (shouldSpare && shouldSpare()) return;            // on battery + power-saver → skip
      const s = snapshot();
      if (last === null) { last = s; return; }             // first tick = baseline, don't alert
      const relays = [];

      // Cloud link dropped — phone/Telegram can't reach the Mac until it reconnects.
      if (last.cloud && !s.cloud) { cloudDownSince = Date.now(); relays.push({ urgent: false, text: '⚠️ Cloud link dropped — your phone may not reach me until it reconnects. I’ll keep retrying.' }); }
      if (!last.cloud && s.cloud && cloudDownSince) { relays.push({ urgent: false, text: '✅ Cloud link restored.' }); cloudDownSince = 0; }
      // Cloud down for a sustained period → escalate to a call.
      if (!s.cloud && cloudDownSince && Date.now() - cloudDownSince > 30 * 60 * 1000) { relays.push({ urgent: true, text: 'BhatBot’s cloud link has been down for over 30 minutes — the phone bridge is offline.' }); cloudDownSince = Date.now(); }

      // New crashes since last tick → urgent (self-heal is already trying to fix them).
      if (s.crashes > last.crashes) relays.push({ urgent: true, text: `BhatBot hit ${s.crashes - last.crashes} crash(es); self-repair is attempting a fix. I’ll confirm when it’s resolved.` });

      // Self-repair backlog building up → informational nudge (deduped by growth).
      if (s.healPending >= 3 && s.healPending > last.healPending) relays.push({ urgent: false, text: `🔧 ${s.healPending} issues queued for self-repair; working through them one at a time.` });

      // Error SPIKE in the structured event log (independent of crashes) → something is failing repeatedly.
      if (s.recentErrors >= 5 && s.recentErrors > last.recentErrors) relays.push({ urgent: s.recentErrors >= 12, text: `⚠️ ${s.recentErrors} errors in the last 10 min — investigating; self-repair is engaged.` });

      // Agent STUCK: 'running' continuously across ticks for too long usually means a hung task.
      if (s.agentState === 'running') { if (!agentBusySince) agentBusySince = Date.now(); }
      else agentBusySince = 0;
      if (agentBusySince && Date.now() - agentBusySince > 20 * 60 * 1000) { relays.push({ urgent: true, text: 'A task has been running for over 20 minutes — it may be stuck. Check the HUD or tell me to stop it.' }); agentBusySince = Date.now(); }

      // TTS voice degraded (ElevenLabs cooling down after a quota/auth hit) → informational.
      if (s.elCooldownMs > 0 && !(last.elCooldownMs > 0)) relays.push({ urgent: false, text: '🔇 ElevenLabs voice is cooling down (quota/limit) — I’ll use it again once it clears.' });

      for (const r of relays.slice(0, 3)) {                // cap per tick so a storm can't spam
        if (inQuietHours() && !r.urgent) continue;         // hold non-urgent relays during quiet hours
        try { telegramNotify && telegramNotify(r.text); } catch {}
        if (r.urgent) { try { notifyUser && notifyUser(r.text, 'call'); } catch {} }
      }
      last = s;
    } catch (e) { try { log('[patrol] tick error: ' + e.message); } catch {} }
  }

  function start() {
    const c = loadConfig();
    if (c.patrol && c.patrol.enabled === false) { log('[patrol] disabled (config.patrol.enabled === false)'); return; }
    if (timer) return;
    // Always-plugged desktop → monitor often. Default 5 min (was 15); min 1 min. config.patrol.intervalMin overrides.
    const everyMs = Math.max(1, Number((c.patrol || {}).intervalMin) || 5) * 60 * 1000;
    timer = setInterval(tick, everyMs);
    setTimeout(tick, 60 * 1000);                           // first check ~60s after launch
    log(`[patrol] ambient monitoring on (${everyMs / 60000}m cycle; relays on change only)`);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  return { start, stop, tick };
};
