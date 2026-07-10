'use strict';
// ALWAYS-ON MEMORY MAINTENANCE — the loop that keeps BhatBot's long-term memory healthy at all times,
// independent of whether the app window is open (it's a main-process timer; pair with the LaunchAgent
// daemon so the process itself is always up → memory maintained 24/7).
//
// Two layers:
//   • planMaintenance(records, opts)  — PURE decision logic (decay stale episodics, merge near-dupes).
//     No I/O, so it unit-tests without a store or embeddings. semantic.maintain() delegates to it.
//   • start()/runPass()               — the scheduler: periodically runs semantic maintenance + the
//     per-workspace compaction + trims runaway operational logs, and reports what it did.
const fs = require('fs');

// Decide what to prune/merge from a set of records. Records: {id, kind, ts, vec}.
//   • DECAY: episodic records older than maxEpisodicAgeDays are conversational noise long-term → drop.
//     Semantic records (durable facts) are never age-decayed here.
//   • MERGE: within the same kind, two records with cosine ≥ dedupThreshold are near-duplicates → keep
//     the NEWER, drop the older (upsert only dedups at write-time; the store still drifts over time).
// Returns { decay:[id], merge:[{drop,into}], keep:Number } — caller applies. cosine injected for purity.
function planMaintenance(records, { now = 0, maxEpisodicAgeDays = 45, dedupThreshold = 0.95, cosine } = {}) {
  const recs = Array.isArray(records) ? records : [];
  const dropped = new Set();
  const decay = [];
  // 1) age-decay stale episodics
  if (maxEpisodicAgeDays > 0) {
    for (const r of recs) {
      if (r.kind === 'episodic' && r.ts && (now - r.ts) / 864e5 > maxEpisodicAgeDays) { decay.push(r.id); dropped.add(r.id); }
    }
  }
  // 2) near-duplicate merge within kind (keep newer). Only if a cosine fn is available (has vectors).
  const merge = [];
  if (typeof cosine === 'function') {
    const live = recs.filter((r) => !dropped.has(r.id) && r.vec);
    for (let i = 0; i < live.length; i++) {
      const a = live[i]; if (dropped.has(a.id)) continue;
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j]; if (dropped.has(b.id) || a.kind !== b.kind || !b.vec || a.vec.length !== b.vec.length) continue;
        if (cosine(a.vec, b.vec) >= dedupThreshold) {
          const older = (a.ts || 0) <= (b.ts || 0) ? a : b;
          const newer = older === a ? b : a;
          merge.push({ drop: older.id, into: newer.id });
          dropped.add(older.id);
          if (older === a) break;   // a got dropped → stop pairing from a
        }
      }
    }
  }
  return { decay, merge, keep: recs.length - dropped.size };
}

// Keep an append-only operational log from growing without bound: retain the last `maxLines`.
// For OPERATIONAL logs only (router.jsonl telemetry, app.log) — NOT training datasets, whose whole
// value is history (router-train.jsonl / spoken.jsonl / depth.jsonl are excluded by the caller).
function trimLog(logPath, maxLines = 20000) {
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split('\n');
    if (lines.length <= maxLines + 1) return { trimmed: 0 };
    const keep = lines.slice(lines.length - maxLines);
    fs.writeFileSync(logPath, keep.join('\n'));
    return { trimmed: lines.length - keep.length };
  } catch { return { trimmed: 0 }; }
}

// Run ONE maintenance pass. deps = { semanticMaintain?(), wsCompress?(), trimLogs?:[paths], onReport?(r) }.
// Every step is optional + guarded so a missing/failed store never breaks the pass.
async function runPass(deps = {}) {
  const report = { at: deps.now || null, semantic: null, workspaces: null, logs: [] };
  try { if (deps.semanticMaintain) report.semantic = await deps.semanticMaintain(); } catch (e) { report.semantic = { error: e.message }; }
  try { if (deps.wsCompress) report.workspaces = await deps.wsCompress(); } catch (e) { report.workspaces = { error: e.message }; }
  for (const p of deps.trimLogs || []) report.logs.push({ path: p, ...trimLog(p, deps.maxLogLines || 20000) });
  try { if (deps.onReport) deps.onReport(report); } catch {}
  return report;
}

// Scheduler. start({ intervalMs, deps }) → runs a pass now-ish and every intervalMs; returns a handle
// with stop() + status(). Independent of the window: it's just a timer in whatever process hosts it.
let _timer = null, _last = null, _running = false, _startedAt = null;
function start({ intervalMs = 30 * 60 * 1000, deps = {}, immediate = true } = {}) {
  stop();
  _startedAt = Date.now();
  const tick = async () => {
    if (_running) return;                       // never overlap passes
    _running = true;
    try { _last = await runPass(deps); } catch {} finally { _running = false; }
  };
  if (immediate) setTimeout(tick, deps.firstDelayMs ?? 60 * 1000).unref?.();   // let boot settle first
  _timer = setInterval(tick, intervalMs); _timer.unref?.();
  return { stop, status };
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }
function status() { return { running: _running, startedAt: _startedAt, lastPass: _last, scheduled: !!_timer }; }

module.exports = { planMaintenance, trimLog, runPass, start, stop, status };
