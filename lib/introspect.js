'use strict';
// The Self-Portrait Engine (Phase 5, Deliverable 1). PURE DATA AGGREGATION — no LLM calls, no
// opinions. It reads every telemetry source the system already produces and assembles ONE structured
// JSON "self-portrait" across five dimensions: performance, capabilities, knowledge, structure, history.
//
// Design intent (from the phase note): the desires that reflect.js produces are only as grounded as
// this portrait is honest. So this module is SPECIFIC, reports things that are healthy as well as
// gaps, and — critically — never fabricates a metric it can't measure. When a signal isn't
// instrumented yet (e.g. depth.jsonl absent, memory-injection hit-rate not tracked), it says so
// explicitly with a `_gaps` note rather than inventing a number. Degrades gracefully: a missing or
// empty file yields nulls/empties, never a throw.
//
//   const { buildSelfPortrait } = require('./lib/introspect');
//   const portrait = buildSelfPortrait({ toolNames, roleNames, repoDir });

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = path.join(os.homedir(), '.bhatbot');
const P = {
  router: path.join(HOME, 'router.jsonl'),
  depth: path.join(HOME, 'depth.jsonl'),
  costs: path.join(HOME, 'costs.json'),
  audit: path.join(HOME, 'audit.log'),
  desires: path.join(HOME, 'desires.jsonl'),
  memory: path.join(HOME, 'memory.md'),
};

function readJsonl(file, cap = 5000) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-cap)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function safeText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
const round = (n, d = 3) => (typeof n === 'number' && isFinite(n)) ? +n.toFixed(d) : null;
function pct(n, total) { return total ? round(n / total, 3) : null; }
function p90(arr) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; }
function mean(arr) { return arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length) : null; }

// ---- performance: router + depth + costs ----
function performance(gaps) {
  const router = readJsonl(P.router);
  const corrected = router.filter((r) => r.corrected).length;
  const ms = router.map((r) => r.ms).filter((x) => typeof x === 'number');
  const usd = router.map((r) => r.usd).filter((x) => typeof x === 'number');
  const byTask = {}; for (const r of router) { const k = r.taskType || '?'; byTask[k] = (byTask[k] || 0) + 1; }

  const depth = readJsonl(P.depth);
  let clip_rate = null, over_alloc = null, by_tier = null;
  if (depth.length) {
    clip_rate = pct(depth.filter((d) => d.clipped).length, depth.length);
    const ratios = depth.filter((d) => d.alloc && d.out).map((d) => d.out / d.alloc);
    over_alloc = ratios.length ? round(ratios.filter((r) => r < 0.5).length / ratios.length, 3) : null;  // used <50% of allocation
    by_tier = {};
    for (const d of depth) { const t = d.depth || '?'; (by_tier[t] = by_tier[t] || { n: 0, clipped: 0 }); by_tier[t].n++; if (d.clipped) by_tier[t].clipped++; }
  } else gaps.push('depth.jsonl absent — clip-rate / over-allocation not measurable yet (learned-depth model still cold)');

  const costs = readJson(P.costs) || {};
  const days = Object.keys(costs).sort();
  const recent = days.slice(-7).map((d) => ({ day: d, usd: round(costs[d] && costs[d].usd, 4), calls: costs[d] && costs[d].calls }));
  const todayCost = days.length ? costs[days[days.length - 1]] : null;

  return {
    turns_logged: router.length,
    correction_rate: pct(corrected, router.length),
    corrections: corrected,
    avg_latency_ms: mean(ms),
    p90_latency_ms: p90(ms),
    avg_usd_per_turn: mean(usd),
    task_distribution: byTask,
    clip_rate, over_allocation_rate: over_alloc, clip_by_tier: by_tier,
    cost_last_7d: recent,
    avg_cost_per_turn_today: todayCost && todayCost.calls ? round(todayCost.usd / todayCost.calls, 4) : null,
  };
}

// ---- capabilities: audit.log per-tool counts + the live catalog ----
function capabilities(toolNames, gaps) {
  const audit = readJsonl(P.audit, 5000);
  if (!audit.length) gaps.push('audit.log empty — tool usage/failure stats unavailable');
  const byTool = {};
  for (const e of audit) {
    if (!e.tool) continue;
    const t = (byTool[e.tool] = byTool[e.tool] || { calls: 0, fails: 0 });
    t.calls++; if (e.ok === false) t.fails++;
  }
  const seen = new Set(Object.keys(byTool));
  const catalog = Array.isArray(toolNames) ? toolNames : [];
  const unused_tools = catalog.filter((n) => !seen.has(n));
  const ranked = Object.entries(byTool).map(([tool, v]) => ({ tool, calls: v.calls, fails: v.fails, fail_rate: pct(v.fails, v.calls) }));
  const most_used = [...ranked].sort((a, b) => b.calls - a.calls).slice(0, 8);
  const most_failed = ranked.filter((r) => r.fails > 0).sort((a, b) => b.fails - a.fails).slice(0, 8);
  return {
    tool_count: catalog.length,
    tools_exercised: seen.size,
    unused_tools,
    most_used,
    most_failed,
    audit_window: audit.length,
  };
}

// ---- knowledge: corrections + memory; honest about what isn't instrumented ----
function knowledge(gaps) {
  const router = readJsonl(P.router);
  const correction_count = router.filter((r) => r.corrected).length;
  const mem = safeText(P.memory);
  const memory_entries = (mem.match(/^\s*-\s+/gm) || []).length;
  const prefs = (mem.split(/^##\s+Preferences.*$/im)[1] || '').split(/^##\s/m)[0];
  const learned_preferences = (prefs.match(/^\s*-\s+/gm) || []).length;
  gaps.push('memory-injection hit-rate + episodic-reuse-rate are not yet instrumented (no per-injection telemetry) — reflect on the design gap, not a fabricated rate');
  return {
    correction_count,
    memory_entries,
    learned_preferences,
    memory_injection_hit_rate: null,   // explicitly uninstrumented
    episodic_reuse_rate: null,         // explicitly uninstrumented
  };
}

// ---- structure: code size, modules, tests, open debt from PHASE notes ----
function structure(repoDir, gaps) {
  const root = repoDir || process.cwd();
  let main_js_bytes = null, lib_module_count = null, test_count = null;
  try { main_js_bytes = fs.statSync(path.join(root, 'main.js')).size; } catch {}
  try { lib_module_count = fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).length; } catch {}
  try { test_count = (safeText(path.join(root, 'scripts', 'test-upgrade.js')).match(/✅|assert|test\(/g) || []).length; } catch {}
  // open debt = ⚠ / "out-of-scope" / "not fixed" / TODO lines across the PHASE notes
  const debt = [];
  for (const f of ['PHASE1_NOTES.md', 'PHASE2_NOTES.md', 'PHASE3_NOTES.md', 'PHASE4_NOTES.md']) {
    const txt = safeText(path.join(root, f));
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (/^#/.test(t)) continue;   // skip markdown headings (they often contain "out-of-scope")
      if (/⚠|out-of-scope|not fixed|TODO|staged|paused|still phantom|low priority/i.test(line) && t.length > 12) debt.push({ file: f, note: t.replace(/^[-*>\s]+/, '').slice(0, 180) });
    }
  }
  if (main_js_bytes && main_js_bytes > 150 * 1024) gaps.push(`main.js is ${Math.round(main_js_bytes / 1024)}KB (>150KB target) — split incomplete`);
  return { main_js_bytes, main_js_kb: main_js_bytes ? Math.round(main_js_bytes / 1024) : null, lib_module_count, test_count, open_debt_count: debt.length, open_debt: debt.slice(0, 20) };
}

// ---- history: prior desires + their resolutions (continuity loop) ----
function history() {
  const rows = readJsonl(P.desires);
  const desires = rows.filter((r) => r.type !== 'resolution');
  const resolutions = rows.filter((r) => r.type === 'resolution');
  const resolvedIds = new Set(resolutions.map((r) => r.id));
  return {
    prior_desires: desires.map((d) => ({ id: d.id, aspiration: d.aspiration, rank: d.rank, ts: d.ts, resolved: resolvedIds.has(d.id) })),
    desires_logged: desires.length,
    desires_acted_on: resolutions.length,
    desires_outstanding: desires.filter((d) => !resolvedIds.has(d.id)).length,
    resolutions: resolutions.map((r) => ({ id: r.id, outcome: r.outcome, helped: r.helped, ts: r.ts })),
  };
}

// telemetryDelta(before, after) — Phase 6. Given two self-portraits taken before/after a selfdrive
// desire was implemented, return a structured "did it actually help?" delta. Lower-is-better metrics
// (latency, cost, correction-rate, clip-rate, open-debt, main.js size) and higher-is-better
// (tools_exercised). Honest: a metric absent in either snapshot is reported as null, never invented.
function telemetryDelta(before, after) {
  const A = before || {}, B = after || {};
  const g = (o, p) => p.split('.').reduce((x, k) => (x == null ? null : x[k]), o);
  const lower = [
    ['correction_rate', 'performance.correction_rate'],
    ['avg_latency_ms', 'performance.avg_latency_ms'],
    ['p90_latency_ms', 'performance.p90_latency_ms'],
    ['avg_usd_per_turn', 'performance.avg_usd_per_turn'],
    ['clip_rate', 'performance.clip_rate'],
    ['open_debt_count', 'structure.open_debt_count'],
    ['main_js_kb', 'structure.main_js_kb'],
    ['desires_outstanding', 'history.desires_outstanding'],
  ];
  const higher = [
    ['tools_exercised', 'capabilities.tools_exercised'],
    ['lib_module_count', 'structure.lib_module_count'],
    ['test_count', 'structure.test_count'],
  ];
  const out = { improved: [], regressed: [], unchanged: [], metrics: {} };
  const consider = (label, path, betterWhenLower) => {
    const a = g(A, path), b = g(B, path);
    if (typeof a !== 'number' || typeof b !== 'number') { out.metrics[label] = { before: a, after: b, delta: null }; return; }
    const delta = +(b - a).toFixed(4);
    out.metrics[label] = { before: a, after: b, delta };
    if (delta === 0) { out.unchanged.push(label); return; }
    const better = betterWhenLower ? delta < 0 : delta > 0;
    (better ? out.improved : out.regressed).push(label + ' ' + (delta > 0 ? '+' : '') + delta);
  };
  for (const [l, p] of lower) consider(l, p, true);
  for (const [l, p] of higher) consider(l, p, false);
  out.net = out.improved.length - out.regressed.length;
  return out;
}

function buildSelfPortrait({ toolNames = [], roleNames = [], repoDir = process.cwd() } = {}) {
  const gaps = [];
  let perf, caps, know, struct, hist;
  try { perf = performance(gaps); } catch (e) { perf = { error: e.message }; }
  try { caps = capabilities(toolNames, gaps); } catch (e) { caps = { error: e.message }; }
  try { know = knowledge(gaps); } catch (e) { know = { error: e.message }; }
  try { struct = structure(repoDir, gaps); } catch (e) { struct = { error: e.message }; }
  try { hist = history(); } catch (e) { hist = { error: e.message }; }
  // VANGUARD agent roster: which roles exist (usage-vs-never is approximated from audit's agent tools).
  const agents = { roster: roleNames, note: 'per-agent dispatch counts are not separately logged; infer under-use from unused agent-only tools in capabilities' };
  return {
    generated_at: new Date().toISOString(),
    performance: perf,
    capabilities: caps,
    knowledge: know,
    structure: struct,
    history: hist,
    agents,
    _gaps: gaps,   // honest list of what could NOT be measured — reflect.js must not invent these
  };
}

module.exports = { buildSelfPortrait, telemetryDelta, PATHS: P };
