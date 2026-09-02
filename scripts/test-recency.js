'use strict';
// Second-brain recency + autoprune (lib/recency.js).
//
// The Gardener keeps edges honest; this keeps NODES honest. Three bugs it exists to fix, each with a
// test below:
//   • a deleted file kept its node forever (still embedded, still proposed as a connection)
//   • an EDITED file kept its old vector forever — hydrate() replaces `text` but lib/brain.js's
//     upsertNode carries `embedding` forward, so every similarity claim about that file was made
//     against what it used to say
//   • project importance was set once at import, so the graph could not tell this week's work from
//     something abandoned in April
//
// planRecency is pure (clock + fs probes injected), so all of this runs with no disk and no brain.
const assert = require('assert');
const recency = require('../lib/recency');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const NOW = Date.parse('2026-08-21T00:00:00Z');
const D = 864e5;
const file = (id, project, path, mtime, extra = {}) => ({
  id, type: 'file', ref: id.replace('file:', ''), status: 'confirmed',
  updatedAt: NOW - 60 * D, importance: 1, meta: { path, project, repo: project, mtime }, ...extra,
});
const project = (ref, extra = {}) => ({ id: 'project:' + ref, type: 'project', ref, label: ref.toUpperCase(), status: 'confirmed', importance: 1, meta: { repo: ref }, ...extra });
const partOf = (from, to) => ({ id: 'e:' + from + to, from, to, type: 'part-of', status: 'confirmed' });

// ── 1. VANISHED FILES ─────────────────────────────────────────────────────────────────────────
{
  const nodes = [file('file:a', 'p', '/p/gone.js', NOW - 10 * D), file('file:b', 'p', '/p/here.js', NOW - 10 * D), project('p')];
  const plan = recency.planRecency({ nodes, edges: [partOf('file:a', 'project:p'), partOf('file:b', 'project:p')] },
    { now: NOW, exists: (x) => x !== '/p/gone.js', mtimeOf: () => NOW - 10 * D, touches: new Map() });
  ok(plan.vanished.length === 1 && plan.vanished[0].id === 'file:a', 'a file that no longer exists on disk is queued for pruning');
  ok(!plan.vanished.some((v) => v.id === 'file:b'), 'a file that still exists is untouched');
  ok(plan.stats.vanishAborted == null, 'one deletion out of two is below the safety threshold... ');
}
// ── 2. THE SAFETY VALVE ───────────────────────────────────────────────────────────────────────
{
  // An unmounted drive / permissions change makes EVERY probe fail. Pruning then would silently
  // delete most of the second brain in one pass, so the vanish pass must abort instead.
  const nodes = Array.from({ length: 40 }, (_, i) => file('file:' + i, 'p', '/vol/' + i, NOW - D));
  nodes.push(project('p'));
  const plan = recency.planRecency({ nodes, edges: [] }, { now: NOW, exists: () => false, mtimeOf: () => 0, touches: new Map() });
  ok(plan.vanished.length === 0, 'when everything looks missing, NOTHING is pruned');
  ok(/unreachable filesystem/.test(plan.stats.vanishAborted || ''), 'and the abort says why, rather than reporting a quiet success');
}
{
  const nodes = Array.from({ length: 10 }, (_, i) => file('file:' + i, 'p', '/vol/' + i, NOW - D));
  const plan = recency.planRecency({ nodes, edges: [] }, { now: NOW, exists: () => false, mtimeOf: () => 0, touches: new Map() });
  ok(plan.vanished.length === 10, 'below minVanishToCheckFraction the valve does not fire — a small sample is not evidence of a broken mount');
}

// ── 3. STALE VECTORS ──────────────────────────────────────────────────────────────────────────
{
  const edited = file('file:e', 'p', '/p/edited.js', NOW - 30 * D, { embedding: [0.1, 0.2] });
  const same = file('file:s', 'p', '/p/same.js', NOW - 30 * D, { embedding: [0.1, 0.2] });
  const novec = file('file:n', 'p', '/p/novec.js', NOW - 30 * D);
  const plan = recency.planRecency({ nodes: [edited, same, novec, project('p')], edges: [] }, {
    now: NOW, exists: () => true, touches: new Map(),
    mtimeOf: (p) => (p === '/p/edited.js' ? NOW - D : NOW - 30 * D),
  });
  const ids = plan.refresh.map((r) => r.id);
  ok(ids.includes('file:e'), 'a file whose mtime moved forward since it was embedded is queued for re-vectoring');
  ok(!ids.includes('file:s'), 'an unchanged file is not');
  ok(!ids.includes('file:n'), 'a file with no vector yet is not "stale" — connect() will embed it anyway');
  ok(plan.refresh[0].mtime === NOW - D && plan.refresh[0].wasMtime === NOW - 30 * D, 'the refresh entry carries both the new and the known mtime');
}

// ── 4. ORPHANS — conservative on purpose ──────────────────────────────────────────────────────
{
  const linked = file('file:l', 'p', '/p/l.js', NOW - 90 * D);
  const orphan = file('file:o', 'p', '/p/o.js', NOW - 90 * D);
  const fresh = file('file:f', 'p', '/p/f.js', NOW, { updatedAt: NOW - 2 * D });
  const promoted = file('file:i', 'p', '/p/i.js', NOW - 90 * D, { importance: 3 });
  const used = file('file:u', 'p', '/p/u.js', NOW - 90 * D);
  const nodes = [linked, orphan, fresh, promoted, used, project('p')];
  const plan = recency.planRecency({ nodes, edges: [partOf('file:l', 'project:p')] }, {
    now: NOW, exists: () => true, mtimeOf: () => NOW - 90 * D, touches: new Map([['/p/u.js', NOW - D]]),
  });
  const ids = plan.orphans.map((o) => o.id);
  ok(ids.includes('file:o'), 'an unlinked, unimportant, long-untouched node is an orphan');
  ok(!ids.includes('file:l'), 'a node with a live edge is never an orphan');
  ok(!ids.includes('file:f'), 'a recently imported node is never an orphan (it has not had a chance to be linked)');
  ok(!ids.includes('file:i'), 'a node the Gardener promoted is never an orphan');
  ok(!ids.includes('file:u'), 'a node whose file was recently used through BhatBot is never an orphan');
  ok(!plan.orphans.some((o) => o.id.startsWith('project:')), 'a project is never orphan-pruned — an empty project is still a real project');
}

// ── 5. PROJECT RECENCY — the ranking the Projects tab now sorts on ─────────────────────────────
{
  const nodes = [
    file('file:new1', 'active', '/active/a.js', NOW - D),
    file('file:new2', 'active', '/active/b.js', NOW - 2 * D),
    ...Array.from({ length: 20 }, (_, i) => file('file:old' + i, 'huge', '/huge/' + i, NOW - 200 * D)),
    project('active'), project('huge', { importance: 5 }),
  ];
  const plan = recency.planRecency({ nodes, edges: [] }, { now: NOW, exists: () => true, mtimeOf: () => 0, touches: new Map() });
  const [first, second] = plan.projects;
  ok(first.ref === 'active', 'a small recently-worked project outranks a large dormant one (rank is the point, not size)');
  ok(second.ref === 'huge' && second.activity < first.activity, 'the dormant 20-file project ranks below on activity despite 10x the files');
  ok(first.importance > second.importance, 'importance follows rank, so the graph renders and proposes what is current');
  ok(first.recentFiles.length === 2 && first.recentFiles[0].ref === 'new1', 'recentFiles lists the most recent first');
}
{
  // A read through BhatBot counts for MORE than a bare mtime: a file you asked about but did not
  // edit is still a file you are working on.
  const nodes = [file('file:r', 'read', '/read/x.js', NOW - 60 * D), file('file:m', 'mod', '/mod/y.js', NOW - 60 * D), project('read'), project('mod')];
  const plan = recency.planRecency({ nodes, edges: [] }, {
    now: NOW, exists: () => true, mtimeOf: () => 0, touches: new Map([['/read/x.js', NOW - D]]),
  });
  ok(plan.projects[0].ref === 'read', 'a project whose file BhatBot touched outranks one with the same stale mtime');
  ok(plan.projects[0].recentFiles[0].viaAgent === true, 'and the entry records that the signal came from the agent ledger, not the filesystem');
}
{
  const plan = recency.planRecency({ nodes: [project('cold')], edges: [] }, { now: NOW, exists: () => true, mtimeOf: () => 0, touches: new Map() });
  ok(plan.projects.length === 0, 'a project with no files is simply not ranked (rather than ranked at zero and demoted)');
}

// ── 6. degenerate input must not throw — this runs unattended in a background worker ───────────
{
  ok(recency.planRecency({}, { now: NOW }).stats.liveNodes === 0, 'empty graph is fine');
  ok(recency.planRecency({ nodes: null, edges: null }, { now: NOW }).vanished.length === 0, 'explicit nulls are fine (a default only covers undefined)');
  ok(recency.planRecency({ nodes: [file('file:x', 'p', '/x', 0)] }, { now: NOW }).vanished.length === 0, 'with no `exists` probe injected, nothing is pruned — we never guess a file is gone');
  const pruned = { ...file('file:p', 'p', '/gone', 0), status: 'pruned' };
  ok(recency.planRecency({ nodes: [pruned] }, { now: NOW, exists: () => false, mtimeOf: () => 0 }).vanished.length === 0, 'an already-pruned node is not re-pruned');
}
{
  ok(recency.recencyWeight(NOW, NOW, 14) === 1, 'weight is 1 for something touched right now');
  ok(Math.abs(recency.recencyWeight(NOW - 14 * D, NOW, 14) - 0.5) < 1e-9, 'weight halves over one half-life');
  ok(recency.recencyWeight(0, NOW, 14) === 0, 'a missing timestamp scores zero, not NaN');
}

// ── 7. readTouches — parsing BhatBot's own audit ledger ────────────────────────────────────────
{
  const lines = [
    'PARTIAL-LINE-FROM-A-TAIL-READ',
    JSON.stringify({ ts: '2026-08-20T10:00:00Z', tool: 'read_file', args: JSON.stringify({ path: '/a.js' }) }),
    JSON.stringify({ ts: '2026-08-21T10:00:00Z', tool: 'edit_file', args: JSON.stringify({ path: '/a.js' }) }),
    JSON.stringify({ ts: '2026-08-19T10:00:00Z', tool: 'write_file', args: JSON.stringify({ path: '/b.js' }) }),
    JSON.stringify({ ts: '2026-08-19T10:00:00Z', tool: 'ask_ai', args: JSON.stringify({ path: '/never.js' }) }),
    JSON.stringify({ ts: '2026-08-19T11:00:00Z', tool: 'file_tools', args: { paths: ['/c.pdf', '/d.pdf'] } }),
    '{ not json at all',
  ].join('\n');
  const fakeFs = {
    statSync: () => ({ size: Buffer.byteLength(lines) }),
    openSync: () => 1, closeSync: () => {},
    readSync: (fd, buf) => { buf.write(lines); return buf.length; },
  };
  const t = recency.readTouches('/fake/audit.log', { fs: fakeFs });
  ok(t.get('/a.js') === Date.parse('2026-08-21T10:00:00Z'), 'the LATEST interaction wins for a path touched twice');
  ok(t.has('/b.js'), 'write_file counts as an interaction');
  ok(!t.has('/never.js'), 'a non-file tool is ignored even when its args happen to carry a path');
  ok(t.has('/c.pdf') && t.has('/d.pdf'), 'a multi-path tool call records every path');
  ok(t.size === 4, 'the mid-line fragment and the malformed line are skipped without throwing');
  ok(recency.readTouches('/definitely/not/here.log').size === 0, 'a missing audit log yields an empty map, not an exception');
}

// ── DORMANT PROJECTS ──────────────────────────────────────────────────────────────────────────
// Siddhant's rule: archive projects begun over 3 weeks ago with no update in the last 3 days. BOTH
// halves are required, and archiving must be reversible.
{
  const plan = (nodes, edges, opts = {}) => recency.planRecency({ nodes, edges }, { now: NOW, exists: () => true, mtimeOf: () => 0, ...opts });

  const nodes = [
    // old + quiet → archive
    project('stale'), file('file:stale/a', 'stale', '/stale/a', NOW - 60 * D),
    // old + touched yesterday → keep
    project('live'), file('file:live/a', 'live', '/live/a', NOW - 60 * D), file('file:live/b', 'live', '/live/b', NOW - 1 * D),
    // young + quiet → keep (not yet "begun over 3 weeks ago")
    project('new'), file('file:new/a', 'new', '/new/a', NOW - 5 * D),
  ];
  const edges = [partOf('file:stale/a', 'project:stale'), partOf('file:live/a', 'project:live'), partOf('file:new/a', 'project:new')];
  const p = plan(nodes, edges);
  const archived = p.dormant.map((d) => d.ref);
  ok(archived.includes('stale'), 'a project begun 60d ago and untouched for 60d is archived');
  ok(!archived.includes('live'), 'a project touched yesterday is kept, however old it is');
  ok(!archived.includes('new'), 'a project begun 5d ago is kept, however quiet it is');
  ok(/begun 60d ago/.test(p.dormant[0].reason), 'and the reason says both halves: ' + p.dormant[0].reason);

  // BOTH thresholds move independently.
  ok(plan(nodes, edges, { dormantStaleDays: 90 }).dormant.length === 0, 'widening the staleness window spares everything');
  ok(plan(nodes, edges, { dormantStartedDays: 3650 }).dormant.length === 0, 'requiring a longer history spares everything');
  ok(plan(nodes, edges, { dormantEnabled: false }).dormant.length === 0, 'and the rule can be switched off entirely');

  // ⚠ THE TRAP THIS FELL INTO. repoNodes() keys a project by absolute path, fileindex by bare name.
  // Unnormalized, the project node never matched its own files, so its activity read as zero and its
  // last update as "never recorded" — and the live run proposed archiving `bhatbot` itself while it
  // was being edited. Same bug lib/brain.js already documents for proposeConnections.
  {
    const byPath = { id: 'project:users-sid-bhatbot', type: 'project', ref: '/Users/sid/bhatbot', label: 'bhatbot',
      status: 'confirmed', importance: 1, meta: { root: '/Users/sid/bhatbot', kind: 'repo' } };
    const its = [file('file:bhatbot/x', 'bhatbot', '/Users/sid/bhatbot/x', NOW - 40 * D),
                 file('file:bhatbot/y', 'bhatbot', '/Users/sid/bhatbot/y', NOW - 1 * D)];   // edited yesterday
    const r = plan([byPath, ...its], [partOf('file:bhatbot/x', byPath.id)]);
    ok(!r.dormant.some((d) => d.id === byPath.id),
      'a project keyed by ABSOLUTE PATH still matches its files, keyed by NAME — it is not archived while being edited');
    ok(r.projects.some((x) => x.id === byPath.id && x.activity > 0), 'and its activity is measured rather than reading as zero');
  }

  // The activity signal being DEAD is different from everything genuinely being dormant.
  {
    const allOld = [project('a'), file('file:a/1', 'a', '/a/1', NOW - 60 * D),
                    project('b'), file('file:b/1', 'b', '/b/1', NOW - 60 * D),
                    project('c'), file('file:c/1', 'c', '/c/1', NOW - 60 * D),
                    project('d'), file('file:d/1', 'd', '/d/1', NOW - 60 * D),
                    project('e'), file('file:e/1', 'e', '/e/1', NOW - 60 * D)];
    const r = plan(allOld, []);
    ok(r.dormant.length === 0 && /activity signal looks dead/.test(r.stats.dormantAborted || ''),
      'when NOTHING is active the pass holds back rather than archiving everything: ' + r.stats.dormantAborted);
    // ...but one live project proves the signal works, and the rest are then trusted.
    const withOneLive = [...allOld, project('f'), file('file:f/1', 'f', '/f/1', NOW - 1 * D)];
    const r2 = plan(withOneLive, []);
    ok(r2.dormant.length === 5 && !r2.stats.dormantAborted,
      'one genuinely active project is enough to trust the signal and archive the other 5');
  }

  // REVERSIBILITY — the half that makes the whole rule safe.
  {
    const archivedNode = { id: 'project:back', type: 'project', ref: 'back', label: 'BACK', status: 'pruned',
      importance: 1, meta: { repo: 'back', archivedBy: 'recency:dormant', archivedReason: 'was quiet' } };
    const quiet = plan([archivedNode, project('live2'), file('file:live2/a', 'live2', '/l/a', NOW - 1 * D),
                        file('file:back/a', 'back', '/b/a', NOW - 40 * D)], []);
    ok(quiet.revive.length === 0, 'an archived project that is still quiet stays archived');

    const touched = plan([archivedNode, project('live2'), file('file:live2/a', 'live2', '/l/a', NOW - 1 * D),
                          file('file:back/a', 'back', '/b/a', NOW - 2 * 3600e3)], []);
    ok(touched.revive.length === 1 && touched.revive[0].id === 'project:back',
      'but working on it again brings it straight back — prune is sticky, so without this it would be archived forever');

    // Only OUR archives are revived; a node the user pruned by hand stays pruned.
    const userPruned = { ...archivedNode, meta: { repo: 'back' } };
    ok(plan([userPruned, project('live2'), file('file:live2/a', 'live2', '/l/a', NOW - 1 * D),
             file('file:back/a', 'back', '/b/a', NOW - 2 * 3600e3)], []).revive.length === 0,
      'a node the USER pruned is never resurrected by the dormancy pass');
  }
}

console.log(`✅ recency: ${pass} assertions passed`);
