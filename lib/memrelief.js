'use strict';
// ── MEMORY RELIEF — when the Mac is short of memory, offer to quit what is using it ──────────────
//
// 2026-11-14: "when throttling due to shortage of memory, it should be able to quit apps using the
// most memory, but obviously asking me." The governor already sheds BhatBot's OWN load when memory
// runs short (local models evicted, background ticks skipped). This is the next step out: the
// biggest apps he has open, each offered by name and size, quit only on his yes — and quit politely
// (the app's own Quit, so it can ask to save), never killed.
//
// Pure: `ps` output in, ranked apps out. The asking and quitting live in main.js.

// Apps that are never offered: BhatBot itself, the Mac's own shell, and the app this very agent
// harness runs in. Quitting any of them to save memory would be cutting off the branch.
const PROTECTED = new Set(['bhatbot', 'finder', 'dock', 'systemuiserver', 'controlcenter', 'notificationcenter', 'loginwindow',
  'system settings', 'system preferences', 'claude', 'codex', 'activity monitor', 'window server', 'spotlight']);
const APP_ROOTS = /^(\/Applications|\/System\/Applications|\/Users\/[^/]+\/Applications)\//;

/**
 * topApps(psText, { minMb, protect }) → [{ name, mb, pids }] largest first.
 * psText is `ps -axo pid=,rss=,comm=`. Helper processes (Chrome's renderers, Slack's GPU process)
 * are counted toward the app that owns them: the outermost .app in the path.
 */
function topApps(psText, { minMb = 700, protect = [] } = {}) {
  const extra = new Set(protect.map((p) => String(p).toLowerCase()));
  const apps = new Map();
  for (const line of String(psText || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const comm = m[3];
    if (!APP_ROOTS.test(comm)) continue;
    const a = /^(.*?\/([^/]+)\.app)(\/|$)/.exec(comm);
    if (!a) continue;
    const name = a[2];
    const key = name.toLowerCase();
    if (PROTECTED.has(key) || extra.has(key)) continue;
    const row = apps.get(key) || { name, kb: 0, pids: [] };
    row.kb += Number(m[2]) || 0; row.pids.push(Number(m[1]));
    apps.set(key, row);
  }
  return [...apps.values()].map((r) => ({ name: r.name, mb: Math.round(r.kb / 1024), pids: r.pids }))
    .filter((r) => r.mb >= minMb).sort((a, b) => b.mb - a.mb);
}

/**
 * shouldOffer({ freePct, level, lastAskAt, now }) → boolean. Only when the governor is actually
 * shedding for memory (hot/critical), and not more than once every 20 minutes — a card every minute
 * while he decides would be its own kind of memory leak.
 */
function shouldOffer({ freePct, hotPct = 11, lastAskAt = 0, now = Date.now(), everyMs = 20 * 60 * 1000 } = {}) {
  if (!Number.isFinite(freePct) || freePct >= hotPct) return false;
  return now - lastAskAt >= everyMs;
}

const fmt = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');
/** The AppleScript that asks an app to quit itself — so it can prompt to save, unlike kill. */
const quitScript = (name) => `tell application ${JSON.stringify(String(name))} to quit`;

// Ignore single-sample dips; recovery needs headroom to avoid repeated shed/restore cycles.
function createPressureTracker() {
  let low = 0, clear = 0, active = false;
  return freePct => {
    if (!Number.isFinite(freePct)) return { active, level: active ? 'hot' : 'nominal' };
    if (freePct < 11) { low++; clear=0; if (low >= 2 || freePct < 6) active=true; }
    else { low=0; if (freePct >= 18) { clear++; if (clear >= 3) active=false; } else clear=0; }
    return { active, level: freePct < 6 ? 'critical' : active ? 'hot' : freePct < 18 ? 'warm' : 'nominal' };
  };
}
module.exports = { createPressureTracker, topApps, shouldOffer, quitScript, fmt, PROTECTED };
