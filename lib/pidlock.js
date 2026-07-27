'use strict';
// ── SINGLE-INSTANCE PIDFILE ───────────────────────────────────────────────────────────────────────
// Two processes now want to run the SYNAPSE cycle: the Electron app (while a window is open) and the
// headless worker (always). They share one graph file and one $1 spend ledger, so exactly one of them
// must own the cycle at a time — otherwise they double-import and double-charge against the same cap.
//
// A pidfile is the right primitive here because the two processes are unrelated (no shared parent, no
// IPC channel) and the check has to work from a plain node script with no dependencies.
//
// The subtlety that makes naive pidfiles wrong: a process that is SIGKILLed or dies in a power cut
// never runs its cleanup, so the file outlives it — and then nothing ever runs again, silently, which
// is precisely the class of failure this whole effort exists to fix. So `alive()` verifies the pid is
// a REAL LIVE process (signal 0) rather than trusting the file, and a stale file is reclaimed.
// PID reuse is possible in principle; we also record the start time and command so a reclaimed pid
// belonging to some unrelated process is recognisable in a log.

const fs = require('fs');
const os = require('os');
const path = require('path');

function pidfilePath(name) { return path.join(os.homedir(), '.bhatbot', `${name}.pid`); }

function read(name) {
  try { return JSON.parse(fs.readFileSync(pidfilePath(name), 'utf8')); } catch { return null; }
}

/** True iff a live process currently holds this lock. A stale file reads as false. */
function alive(name) {
  const rec = read(name);
  if (!rec || !rec.pid) return false;
  if (rec.pid === process.pid) return true;
  try { process.kill(rec.pid, 0); return true; }   // signal 0 = existence check, no signal delivered
  catch (e) { return e && e.code === 'EPERM'; }    // EPERM = it exists, just isn't ours
}

/**
 * acquire(name) → { ok, heldBy? }. Refuses if a LIVE process holds it; reclaims a stale file.
 * Registers cleanup for the ordinary exit paths (a hard kill is handled by alive()'s liveness check).
 */
function acquire(name, { meta = {} } = {}) {
  if (alive(name)) return { ok: false, heldBy: read(name) };
  const file = pidfilePath(name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), argv: process.argv.slice(0, 3), ...meta }, null, 2));
  } catch (e) { return { ok: false, error: e.message }; }

  let released = false;
  const cleanup = () => { if (!released) { released = true; release(name); } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanup(); process.exit(0); });
  }
  return { ok: true, release: cleanup };
}

/** Release the lock, but only if WE hold it — never clobber another process's file. */
function release(name) {
  const rec = read(name);
  if (rec && rec.pid !== process.pid) return false;
  try { fs.unlinkSync(pidfilePath(name)); return true; } catch { return false; }
}

module.exports = { acquire, release, alive, read, pidfilePath };
