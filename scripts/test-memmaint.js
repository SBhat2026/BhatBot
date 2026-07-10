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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
