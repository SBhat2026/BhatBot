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
  const { loadConfig, telegramNotify, notifyUser, cloudConnected, selfhealStatus, crashCount, shouldSpare, log = () => {} } = ctx;
  let timer = null;
  let last = null;                 // previous snapshot, for change detection
  let cloudDownSince = 0;

  function snapshot() {
    let heal = {}; try { heal = selfhealStatus ? selfhealStatus() : {}; } catch {}
    return {
      cloud: cloudConnected ? !!cloudConnected() : true,
      healPending: heal.pending || (Array.isArray(heal.queue) ? heal.queue.length : 0) || 0,
      healFixed: heal.fixed || heal.totalFixed || 0,
      crashes: crashCount ? crashCount() : 0,
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
    const everyMs = Math.max(5, Number((c.patrol || {}).intervalMin) || 15) * 60 * 1000;
    timer = setInterval(tick, everyMs);
    setTimeout(tick, 90 * 1000);                           // first check ~90s after launch
    log(`[patrol] ambient monitoring on (${everyMs / 60000}m cycle; relays on change only)`);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  return { start, stop, tick };
};
