'use strict';
// Proactive scheduler — DB-backed. Ticks every 30s, runs any due schedule through the agent
// (autonomously, no one watching), records the result to the activity feed. Survives restarts
// because schedules live in SQLite. Lets the cloud act on its own: reminders, recurring checks.
const db = require('./db');
const { runTurn } = require('./agent');

const now = () => Date.now();
const genId = () => 's_' + now().toString(36) + Math.random().toString(36).slice(2, 6);

const _ins = db.db.prepare('INSERT INTO schedules (id,title,prompt,kind,at,every_ms,run_at,next_run,enabled,last_run,created_at) VALUES (@id,@title,@prompt,@kind,@at,@every_ms,@run_at,@next_run,@enabled,@last_run,@created_at)');
const _all = db.db.prepare('SELECT * FROM schedules ORDER BY created_at DESC');
const _due = db.db.prepare('SELECT * FROM schedules WHERE enabled=1 AND next_run IS NOT NULL AND next_run<=?');
const _del = db.db.prepare('DELETE FROM schedules WHERE id=?');
const _setEnabled = db.db.prepare('UPDATE schedules SET enabled=? WHERE id=?');
const _setNext = db.db.prepare('UPDATE schedules SET next_run=?, last_run=? WHERE id=?');

function computeNext(s, from = now()) {
  if (s.kind === 'once') return s.run_at && s.run_at > from ? s.run_at : (s.last_run ? null : s.run_at);
  if (s.kind === 'interval') return from + (s.every_ms || 3600000);
  if (s.kind === 'daily' || s.kind === 'weekly') {
    const [h, m] = String(s.at || '09:00').split(':').map(Number);
    const d = new Date(from); d.setHours(h || 0, m || 0, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + (s.kind === 'weekly' ? 7 : 1));
    return d.getTime();
  }
  return null;
}

function add(partial = {}) {
  const s = {
    id: genId(), title: partial.title || 'Task', prompt: partial.prompt || '',
    kind: partial.kind || (partial.run_at ? 'once' : 'daily'), at: partial.at || null,
    every_ms: partial.every_ms || (partial.everyMinutes ? partial.everyMinutes * 60000 : partial.everyHours ? partial.everyHours * 3600000 : null),
    run_at: partial.run_at || (partial.inMinutes ? now() + partial.inMinutes * 60000 : null),
    next_run: null, enabled: 1, last_run: null, created_at: now(),
  };
  s.next_run = computeNext(s);
  _ins.run(s); return s;
}
const list = () => _all.all();
const remove = (id) => ({ removed: _del.run(id).changes > 0 });
const setEnabled = (id, on) => ({ ok: _setEnabled.run(on ? 1 : 0, id).changes > 0 });

let timer = null;
const running = new Set();
function start() {
  if (timer) return;
  timer = setInterval(tick, 30000);
  timer.unref && timer.unref();
  console.log('[scheduler] started (30s tick), ' + list().length + ' schedule(s)');
}
async function tick() {
  let due = []; try { due = _due.all(now()); } catch { return; }
  for (const s of due) {
    if (running.has(s.id)) continue;
    running.add(s.id);
    runScheduled(s).finally(() => running.delete(s.id));
  }
}
async function runScheduled(s) {
  try {
    db.pushActivity('schedule', `▶ ${s.title}`);
    const convId = 'schedule:' + s.id;
    const r = await runTurn(convId, `[Scheduled task "${s.title}"] ${s.prompt}\n\nAutonomous run (no one watching). Do it, then reply with a short summary.`, { reset: true });
    db.pushActivity('schedule', `✓ ${s.title}: ${(r.text || '').slice(0, 160)}`);
  } catch (e) {
    db.pushActivity('schedule', `✗ ${s.title}: ${e.message}`);
  } finally {
    const next = s.kind === 'once' ? null : computeNext(s);
    _setNext.run(next, now(), s.id);
  }
}

module.exports = { start, add, list, remove, setEnabled };
