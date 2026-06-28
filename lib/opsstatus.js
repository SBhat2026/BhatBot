'use strict';
// lib/opsstatus.js — the "what is BhatBot managing right now?" aggregator. Pulls a single live snapshot
// of every background service + active work so Siddhant can SEE, at any time, that BhatBot is working:
// the autonomous loops (self-heal, self-drive, patrol, ambient, scheduler, health monitor), the live
// agent fleet, upcoming scheduled tasks, rate-limit budget, today's spend, and the recent event stream.
//
// Pure: every signal is an INJECTED probe (main.js wires them to the real subsystems), each called
// defensively so one missing/broken subsystem degrades to {state:'unknown'} instead of throwing. The
// desktop "Manage" panel + the phone ops view poll gather() on a short interval.

function safe(fn, dflt) { try { const v = fn && fn(); return (v === undefined || v === null) ? dflt : v; } catch { return dflt; } }

// One service row. probe() returns a partial {state, detail, last, next}.
function svc(name, icon, probe) {
  const p = safe(probe, {}) || {};
  return { name, icon, state: p.state || 'unknown', detail: p.detail || '', last: p.last || null, next: p.next || null };
}

function gather(deps = {}) {
  const d = deps;
  // Each probe calls the injected fn DIRECTLY (no inner catch) so svc()'s safe() maps a thrown or
  // missing probe → state 'unknown' (honest degradation), while present probes report real state.
  const services = [
    svc('Self-heal', '🩺', () => { const s = d.selfheal(); return { state: s.enabled ? (s.cooldownActive ? 'cooldown' : 'on') : 'off', detail: s.enabled ? `${(s.queue || []).length} queued · ${s.today || 0} fixed today` : 'disabled', }; }),
    svc('Self-drive', '🚀', () => { const s = d.selfdrive(); return { state: s.running ? 'running' : (s.enabled ? 'idle' : 'off'), detail: s.running ? 'improving on ' + ((s.lastSession && s.lastSession.branch) || 'a branch') : (s.lastSession ? `last: ${s.lastSession.reason_halted || ''} (${s.lastSession.resolved || 0} resolved)` : 'on-demand'), last: s.lastSession && s.lastSession.ended_at }; }),
    svc('Patrol', '📡', () => { const on = d.patrolOn(); return { state: on ? 'on' : 'off', detail: on ? 'health watch + relay' : 'disabled' }; }),
    svc('Ambient', '👁', () => { const s = d.ambient(); return { state: s.enabled ? 'on' : 'off', detail: s.enabled ? ((s.sources || []).join(', ') || 'calendar/mail') : 'disabled' }; }),
    svc('Scheduler', '⏰', () => { const en = d.schedules().filter((x) => x.enabled !== false); const next = en.map((x) => x.nextRun).filter(Boolean).sort()[0]; return { state: en.length ? 'on' : 'idle', detail: `${en.length} active`, next }; }),
    svc('Health monitor', '❤', () => { const h = d.health(); return { state: h.monitoring ? 'on' : (h.configured ? 'idle' : 'off'), detail: h.configured ? ('last sync ' + (h.last_sync ? new Date(h.last_sync).toLocaleString() : 'never')) : 'not set up', last: h.last_sync }; }),
    svc('Cloud relay', '☁', () => { const c = d.cloudConnected(); return { state: c ? 'on' : 'off', detail: c ? 'phone reachable' : 'local only' }; }),
  ];

  const fleet = safe(d.fleet, { active: 0, agents: [] });
  const schedules = safe(d.schedules, []).map((s) => ({ id: s.id, title: s.title || s.id, kind: s.kind, nextRun: s.nextRun, enabled: s.enabled !== false }));
  const budgets = safe(d.budgets, []);   // [{model, outFree, outSafe}]
  const cost = safe(d.costToday, null);
  const events = safe(d.recentEvents, []);

  const activeCount = services.filter((s) => ['on', 'running', 'cooldown'].includes(s.state)).length;
  return {
    generated_at: new Date().toISOString(),
    healthy: true,
    summary: `${activeCount}/${services.length} services active · ${fleet.active || 0} agents · ${schedules.filter((s) => s.enabled).length} schedules`,
    services,
    fleet,
    schedules,
    selfdrive: safe(d.selfdrive, {}),
    selfheal: safe(d.selfheal, {}),
    health: safe(d.health, {}),
    budgets,
    cost,
    recent_events: events.slice(-20),
  };
}

module.exports = { gather, svc };
