'use strict';
// memmaint tests — pure planMaintenance (decay + merge) and log trimming.
const mm = require('../lib/memmaint');
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const DAY = 864e5;
const now = 1000 * DAY;
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); };

// ---- decay: stale episodics dropped, fresh + semantic kept ----------------
const recs = [
  { id: 'e_old', kind: 'episodic', ts: now - 60 * DAY, vec: [1, 0] },
  { id: 'e_new', kind: 'episodic', ts: now - 2 * DAY, vec: [0, 1] },
  { id: 's_old', kind: 'semantic', ts: now - 200 * DAY, vec: [1, 1] },   // durable → never age-decayed
];
const p1 = mm.planMaintenance(recs, { now, maxEpisodicAgeDays: 45, cosine: cos });
ok(p1.decay.includes('e_old'), 'decay: stale episodic dropped');
ok(!p1.decay.includes('e_new'), 'decay: fresh episodic kept');
ok(!p1.decay.includes('s_old'), 'decay: old semantic fact NOT age-decayed');

// ---- merge: near-duplicates within kind collapse to the newer -------------
const dupes = [
  { id: 'a', kind: 'semantic', ts: now - 10 * DAY, vec: [1, 0, 0] },
  { id: 'b', kind: 'semantic', ts: now - 1 * DAY, vec: [0.999, 0.01, 0] },   // ~dup of a, newer
  { id: 'c', kind: 'semantic', ts: now, vec: [0, 1, 0] },                     // distinct
];
const p2 = mm.planMaintenance(dupes, { now, maxEpisodicAgeDays: 0, dedupThreshold: 0.95, cosine: cos });
ok(p2.merge.length === 1 && p2.merge[0].drop === 'a' && p2.merge[0].into === 'b', 'merge: older near-dup dropped into newer');
ok(p2.keep === 2, 'merge: keep count reflects the drop');

// ---- no cosine fn → no merge (graceful) -----------------------------------
const p3 = mm.planMaintenance(dupes, { now, maxEpisodicAgeDays: 0 });
ok(p3.merge.length === 0, 'merge: skipped when no cosine fn provided');

// ---- trimLog keeps the tail ----------------------------------------------
const tmp = path.join(os.tmpdir(), 'memmaint_test_' + Date.now() + '.log');
fs.writeFileSync(tmp, Array.from({ length: 100 }, (_, i) => 'line' + i).join('\n'));
const t = mm.trimLog(tmp, 30);
const after = fs.readFileSync(tmp, 'utf8').trim().split('\n');
ok(t.trimmed === 70 && after.length === 30 && after[after.length - 1] === 'line99', 'trimLog: keeps last N lines');
fs.unlinkSync(tmp);


// ---- pruneRunDirs (deploy_drones leaves a run dir behind on every call, forever) ----
{
  const fs2 = require('fs'), os2 = require('os'), path2 = require('path');
  const { pruneRunDirs } = require('../lib/memmaint');
  const D = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'bb-rundirs-'));
  const NOW = 1_700_000_000_000;
  const mk = (name, ageDays) => {
    const p = path2.join(D, name);
    fs2.mkdirSync(p, { recursive: true });
    fs2.writeFileSync(path2.join(p, 'blackboard.jsonl'), 'x');
    const t = new Date(NOW - ageDays * 864e5);
    fs2.utimesSync(p, t, t);
    return p;
  };
  mk('run-old', 30);
  mk('run-recent', 2);
  mk('keepme', 30);            // not a run dir — must never be touched
  fs2.writeFileSync(path2.join(D, 'run-afile'), 'not a directory');

  const r = pruneRunDirs(D, { maxAgeDays: 14, now: NOW });
  ok(r.removed.includes('run-old'), 'pruneRunDirs: removes a run dir past the age cutoff');
  ok(!r.removed.includes('run-recent'), 'pruneRunDirs: keeps a recent run dir (an in-flight run is never touched)');
  ok(!r.removed.includes('keepme'), 'pruneRunDirs: only touches dirs matching the prefix');
  ok(fs2.existsSync(path2.join(D, 'keepme')), 'pruneRunDirs: the unrelated dir survives on disk');
  ok(fs2.existsSync(path2.join(D, 'run-afile')), 'pruneRunDirs: a FILE named like a run dir is left alone');
  ok(!fs2.existsSync(path2.join(D, 'run-old')), 'pruneRunDirs: the pruned dir is really gone');
  ok(pruneRunDirs('/no/such/dir', {}).removed.length === 0, 'pruneRunDirs: a missing dir → no-op, no throw');
  try { fs2.rmSync(D, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
