#!/usr/bin/env node
'use strict';
// Tests for lib/brainhealth.js — the Psychiatrist's deterministic checks over the second brain. What must hold:
//   1. A healthy synthetic brain scores high with no high/critical findings.
//   2. Each real fault found in the live brain is reported: exhausted budget, stale pre-f32 file,
//      corrupt/truncated vectors, dangling edges, unsourced edges, dead worker, unloaded LaunchAgent.
//   3. READ-ONLY: checking never changes a byte under the brain dir.
//   4. The Psychiatrist is a single standing hire: found by id or mark, never re-hired; its prompt forbids brain edits.
// Pure + DI: a temp brain dir, injected clock/launchctl/config. No Electron, no network.
//   node scripts/test-brainhealth.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bh = require('../lib/brainhealth');
const ao = require('../lib/agentoffice');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };
const T = 1_800_000_000_000;
const stamp = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

function vectors(ids, dim = 4) {
  const header = Buffer.from(JSON.stringify({ v: 1, n: ids.length, entries: ids.map((i) => [i, dim]) }));
  const start = (8 + header.length + 3) & ~3;
  const out = Buffer.alloc(start + ids.length * dim * 4);
  out.write('BBV1', 0, 'latin1'); out.writeUInt32LE(header.length, 4); header.copy(out, 8);
  return out;
}
function makeBrain(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-bhealth-'));
  const nodes = { 'project:a': { id: 'project:a', type: 'project', label: 'a', status: 'confirmed' }, 'memory:m': { id: 'memory:m', type: 'memory', label: 'm', status: 'confirmed' }, ...(over.nodes || {}) };
  const edges = { e1: { id: 'e1', from: 'project:a', to: 'memory:m', type: 'relates-to', rationale: 'same topic', provenance: { via: 'embedding' }, status: 'confirmed', createdBy: 'connector' }, ...(over.edges || {}) };
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ v: 1, nodes, edges, meta: { spendDay: new Date(T).toISOString().slice(0, 10), spendTodayUsd: 0.05, embedDim: 4, ...(over.meta || {}) } }));
  fs.writeFileSync(path.join(dir, 'vectors.f32'), over.vec || vectors(Object.keys(nodes)));
  fs.mkdirSync(path.join(dir, 'archive'));
  const logPath = path.join(dir, '..', path.basename(dir) + '.log');
  fs.writeFileSync(logPath, over.log != null ? over.log : `${stamp(T - 10 * 60e3)} cycle done in 2s — 2 nodes / 1 edges · $0.05 of $1.00\n`);
  return { dir, logPath };
}
const running = '{\n\t"PID" = 123;\n\t"LastExitStatus" = 0;\n};';
const mk = (o = {}) => ({ now: () => T, launchctl: async () => (o.launchctl != null ? o.launchctl : running), loadConfig: () => ({ synapseBudgetUsd: 1, ...(o.config || {}) }) });
const snap = (dir) => {
  const h = crypto.createHash('sha1');
  (function walk(d) { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f), st = fs.statSync(p); if (st.isDirectory()) walk(p); else { h.update(f); h.update(fs.readFileSync(p)); h.update(String(st.mtimeMs)); } } })(dir);
  return h.digest('hex');
};
const has = (r, re) => r.findings.some((f) => re.test(f.what));

(async () => {
  // 1. healthy
  { const b = makeBrain(); const r = await bh.check(b, mk());
    ok(r.score >= 90 && r.grade === 'healthy', `healthy brain scores ${r.score}`);
    ok(!r.findings.some((f) => f.severity === 'high' || f.severity === 'critical'), 'no high/critical findings when healthy');
    ok(r.stats.nodes === 2 && r.stats.edges === 1 && r.stats.vectors === 2, 'counts: nodes, edges, vectors');
    ok(r.findings.every((f) => bh.SEVERITY.includes(f.severity) && 'what' in f && 'evidence' in f && 'suggestedFix' in f), 'finding shape {severity, what, evidence, suggestedFix}'); }

  // 2a. budget exhausted every cycle
  { const line = (m) => `${stamp(T - m * 60e3)} cycle done in 2s — 2 nodes · $0.262 of $0.25 · paid pass skipped (budget exhausted ($0.262/$0.25))\n`;
    const b = makeBrain({ meta: { spendTodayUsd: 0.262 }, log: line(90) + line(60) + line(30) + line(5) });
    const r = await bh.check(b, mk({ config: { synapseBudgetUsd: 0.25 } }));
    ok(has(r, /budget/i) && r.findings.find((f) => /budget/i.test(f.what)).severity === 'high', 'exhausted budget flagged high');
    ok(/4 consecutive/.test(r.findings.find((f) => /budget/i.test(f.what)).evidence), 'budget evidence counts consecutive skipped cycles'); }

  // 2b. stale file, corrupt vectors, dangling + unsourced edges
  { const b = makeBrain({ edges: { bad: { id: 'bad', from: 'project:a', to: 'ghost', type: 'relates-to', rationale: '', provenance: {}, status: 'proposed', createdBy: 'connector' } } });
    fs.writeFileSync(path.join(b.dir, 'vectors.json.pre-f32'), Buffer.alloc(11 * 1024 * 1024));
    const r = await bh.check(b, mk());
    ok(has(r, /vectors\.json\.pre-f32/), 'stale pre-f32 file reported');
    ok(has(r, /do not exist/), 'dangling edge reported');
    ok(has(r, /missing rationale/), 'edge without rationale/provenance reported'); }
  { const b = makeBrain({ vec: vectors(['project:a', 'memory:m']).subarray(0, 30) });
    const r = await bh.check(b, mk());
    ok(r.findings.some((f) => f.severity === 'critical' && /vectors/.test(f.what)), 'truncated vectors.f32 is critical');
    ok(r.score <= 70, 'critical finding drags the score'); }
  { const b = makeBrain(); fs.writeFileSync(path.join(b.dir, 'graph.json'), '{not json');
    const r = await bh.check(b, mk());
    ok(r.findings[0].severity === 'critical' && /graph\.json/.test(r.findings[0].what), 'unparseable graph.json is critical and sorted first'); }

  // 2c. orphans, duplicates (files exempt), growth
  { const b = makeBrain({ nodes: { 'memory:d1': { id: 'memory:d1', type: 'memory', label: 'Same', status: 'proposed' }, 'memory:d2': { id: 'memory:d2', type: 'memory', label: 'same', status: 'proposed' }, 'file:r1': { id: 'file:r1', type: 'file', label: 'README.md', status: 'confirmed' }, 'file:r2': { id: 'file:r2', type: 'file', label: 'README.md', status: 'confirmed' } } });
    const r = await bh.check({ ...b, prev: { nodes: 2, edges: 1, at: T - 864e5 } }, mk());
    ok(has(r, /Duplicate labels/) && /1 duplicates/.test(r.findings.find((f) => /Duplicate/.test(f.what)).evidence), 'duplicate memory labels flagged; duplicate file names ignored');
    ok(r.stats.orphans >= 4, 'orphans counted');
    ok(r.stats.growth.nodes === 4 && has(r, /growing fast/), 'growth vs previous report'); }

  // 2d. worker dead / launchd
  { const b = makeBrain({ log: `${stamp(T - 5 * 3600e3)} cycle done in 2s — 2 nodes\n` });
    const r = await bh.check(b, mk({ launchctl: 'Could not find service "com.bhatbot.synapse" in domain for port' }));
    ok(has(r, /not completed a cycle/), 'stale last cycle flagged');
    ok(has(r, /LaunchAgent .* not loaded/), 'unloaded LaunchAgent flagged'); }
  { const b = makeBrain(); const r = await bh.check(b, mk({ launchctl: '{\n\t"LastExitStatus" = 256;\n};' }));
    ok(has(r, /loaded but not running/), 'loaded-but-not-running LaunchAgent flagged'); }
  { const b = makeBrain({ log: '' }); const r = await bh.check(b, mk());
    ok(has(r, /No synapse cycle/), 'empty worker log flagged'); }

  // 3. read-only
  { const b = makeBrain({ log: '' }); fs.writeFileSync(path.join(b.dir, 'vectors.json.pre-f32'), 'x');
    const before = snap(b.dir); await bh.check(b, mk()); ok(snap(b.dir) === before, 'check() leaves the brain dir byte-for-byte unchanged'); }
  { const b = makeBrain(); const hd = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-bhealth-r-'));
    const before = snap(b.dir);
    const r1 = await bh.run({ ...b, healthDir: hd }, mk());
    const r2 = await bh.run({ ...b, healthDir: hd }, mk());
    ok(fs.existsSync(path.join(hd, 'latest.json')) && bh.loadReport(hd).at === r2.at, 'run() saves the report in its OWN dir');
    ok(r2.stats.growth && r2.stats.growth.nodes === 0, 'run() feeds the previous report in for growth');
    ok(snap(b.dir) === before, 'run() also never touches the brain'); }

  // 4. Psychiatrist
  { const p = ao.psychiatristPrompt('REPORT-X');
    ok(p.startsWith(ao.PSYCHIATRIST_MARK) && /READ-ONLY/.test(p) && /must NOT edit/.test(p) && /PROPOSAL/.test(p), 'prompt carries the mark and the read-only / propose-only rules');
    ok(p.includes('REPORT-X') && !ao.psychiatristPrompt().includes('REPORT-X'), 'first-checkup report is embedded only when given');
    const ws = [{ id: 'a1', deskId: 'desk-6', prompt: 'something else' }, { id: 'b2', deskId: 'desk-7', prompt: p }];
    ok(ao.psychiatristFind(ws, null).id === 'b2', 'standing hire is found by its mark');
    ok(ao.psychiatristFind(ws, 'a1').id === 'a1', 'a remembered worker id wins');
    ok(ao.psychiatristFind([ws[0]], null) === undefined, 'absent → not found (caller hires once)');
    ok(ao.HIRE_DESKS[0] === 'desk-6' && !ao.HIRE_DESKS.some((d) => ao.RESERVED.has(d)), 'hires land on desks >= 6'); }
  { const f = bh.format(await bh.check(makeBrain(), mk())); ok(/Brain health \d+\/100/.test(f), 'format() produces the one-glance summary'); }
  { const log = bh.inspectLog(`${stamp(T)} cycle done in 1s — x · paid pass skipped (budget exhausted (a))\n${stamp(T)} cycle done in 1s — y\n`);
    ok(log.exhaustedStreak === 0, 'streak counts only the most recent consecutive skipped cycles'); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
