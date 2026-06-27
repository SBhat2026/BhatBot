#!/usr/bin/env node
'use strict';
// Tests for lib/introspect.js (Phase-5 self-portrait). The directive's HARD CONSTRAINT: it must
// degrade gracefully when telemetry is missing/empty — reflect on what it has, never crash — and be
// HONEST about gaps (emit a `_gaps` list rather than invent numbers). introspect feeds reflect, so a
// throw here would break self_reflect. Temp $HOME isolates telemetry. Wired into `npm run verify`.
//   node scripts/test-introspect.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-introspect-'));
fs.mkdirSync(path.join(TMP, '.bhatbot'), { recursive: true });
process.env.HOME = TMP;
const { buildSelfPortrait } = require('../lib/introspect');
const REPO = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- 1. EMPTY telemetry → graceful, structured, honest about gaps ----
let p;
try { p = buildSelfPortrait({ toolNames: ['ask_ai', 'write_file'], roleNames: ['scout', 'builder'], repoDir: REPO }); ok(true, 'empty telemetry → buildSelfPortrait did NOT throw'); }
catch (e) { ok(false, 'buildSelfPortrait threw on empty telemetry: ' + e.message); p = {}; }

for (const k of ['performance', 'capabilities', 'knowledge', 'structure', 'history', 'agents', '_gaps', 'generated_at'])
  ok(k in p, `portrait has "${k}"`);
ok(Array.isArray(p._gaps) && p._gaps.length > 0, '_gaps is a non-empty array (honest about what it can\'t measure)');
ok(p._gaps.some((g) => /depth/i.test(g)) , '_gaps notes depth.jsonl absent (cold model)');
ok(p._gaps.some((g) => /audit/i.test(g)), '_gaps notes audit.log empty (no tool stats)');
ok(p.performance && p.performance.turns_logged === 0, 'performance.turns_logged === 0 with no router log (not a crash, not invented)');
ok(p.agents && JSON.stringify(p.agents.roster) === JSON.stringify(['scout', 'builder']), 'agents.roster reflects injected roleNames');
ok(p.performance && p.performance.correction_rate === null, 'correction_rate is null (not fabricated) when no data');

// ---- 2. POPULATED telemetry → real numbers (not gaps) ----
fs.writeFileSync(path.join(TMP, '.bhatbot', 'router.jsonl'),
  [{ taskType: 'ops', model: 'm', ms: 1000, usd: 0.01, corrected: false },
   { taskType: 'research', model: 'm', ms: 3000, usd: 0.02, corrected: true }].map((x) => JSON.stringify(x)).join('\n') + '\n');
fs.writeFileSync(path.join(TMP, '.bhatbot', 'costs.json'),
  JSON.stringify({ '2026-06-27': { usd: 0.5, calls: 10 } }));
fs.writeFileSync(path.join(TMP, '.bhatbot', 'audit.log'),
  [{ tool: 'ask_ai', ok: true }, { tool: 'ask_ai', ok: false }, { tool: 'write_file', ok: true }].map((x) => JSON.stringify(x)).join('\n') + '\n');

const p2 = buildSelfPortrait({ toolNames: ['ask_ai', 'write_file', 'never_used_tool'], roleNames: ['scout'], repoDir: REPO });
ok(p2.performance.turns_logged === 2, 'populated: turns_logged === 2');
ok(p2.performance.correction_rate === 0.5, 'populated: correction_rate computed (1/2)');
ok(p2.performance.p90_latency_ms != null && p2.performance.p90_latency_ms > 0, 'populated: p90 latency computed from real data');
ok(p2.performance.task_distribution && p2.performance.task_distribution.ops === 1, 'populated: task distribution counted');
ok(!p2._gaps.some((g) => /audit\.log empty/i.test(g)), 'populated: audit-empty gap is gone once audit has data');

// ---- 3. structure degrades on a bogus repoDir (no throw) ----
let p3;
try { p3 = buildSelfPortrait({ repoDir: path.join(TMP, 'does-not-exist') }); ok(true, 'bogus repoDir → no throw'); }
catch (e) { ok(false, 'threw on bogus repoDir: ' + e.message); }
ok(p3 && typeof p3.structure === 'object', 'bogus repoDir → structure is still an object (graceful)');

// ---- 4. real repo structure picks up main.js size ----
const p4 = buildSelfPortrait({ repoDir: REPO });
const structStr = JSON.stringify(p4.structure);
ok(/main/i.test(structStr) || p4.structure.error, 'real repo → structure references main.js (or degrades cleanly)');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
