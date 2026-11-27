'use strict';
// lib/brainhealth.js — deterministic health checks over SYNAPSE (the second brain): ~/.bhatbot/brain
// (graph.json, vectors.f32, archive/) and the headless worker's log + LaunchAgent. Pure + DI (no
// Electron, no network, no model): every fs/launchctl/clock touch comes in through `deps`, so it runs in
// the app, in the worker, or in a test against a temp dir.
//
// READ-ONLY on the brain. It never writes, renames or deletes anything under the brain dir — repairs
// are *suggested* (suggestedFix) for the user to approve. The only thing it writes, and only via
// saveReport(), is its own report under ~/.bhatbot/brainhealth/, never the brain.
//
// check() → { score 0-100, grade, findings:[{severity, what, evidence, suggestedFix}], stats, at }

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DAY = 864e5;
const MB = 1024 * 1024;
const LABEL = 'com.bhatbot.synapse';
const SEVERITY = ['critical', 'high', 'medium', 'low', 'info'];
const PENALTY = { critical: 30, high: 15, medium: 7, low: 2, info: 0 };
const THRESH = {
  cycleStaleMin: 90,          // worker ticks every ~30 min; >90 means it is not running
  staleFileBytes: 10 * MB,    // leftovers bigger than this are worth naming
  proposedBacklog: 500,       // unreviewed proposed edges
  prunedShare: 0.9,           // of decided edges, how many rejected before the connector is wasting spend
  orphanShare: 0.5,           // of live nodes
  dupShare: 0.02,
  growthNodes: 0.25,          // node growth between two reports that deserves a look
};

const defaults = () => ({
  dir: path.join(os.homedir(), '.bhatbot', 'brain'),
  logPath: path.join(os.homedir(), '.bhatbot', 'logs', 'synapse-worker.log'),
  healthDir: path.join(os.homedir(), '.bhatbot', 'brainhealth'),
});

function readJson(fsx, p) {
  let raw;
  try { raw = fsx.readFileSync(p, 'utf8'); } catch (e) { return { missing: e.code === 'ENOENT', error: e.message }; }
  try { return { value: JSON.parse(raw), bytes: Buffer.byteLength(raw) }; } catch (e) { return { error: 'unparseable JSON: ' + e.message }; }
}

/** Validate vectors.f32 (BBV1: magic, u32 header length, JSON header {entries:[[id,dim]…]}, floats) without loading the floats. */
function inspectVectors(fsx, file) {
  let buf;
  try { buf = fsx.readFileSync(file); } catch (e) { return { missing: e.code === 'ENOENT', error: e.message }; }
  try {
    if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'BBV1') return { error: 'not a BBV1 vector file' };
    const hlen = buf.readUInt32LE(4);
    if (8 + hlen > buf.length) return { error: 'header runs past the end of the file' };
    const header = JSON.parse(buf.toString('utf8', 8, 8 + hlen));
    const entries = header.entries || [];
    const total = entries.reduce((n, e) => n + e[1], 0);
    const dataStart = (8 + hlen + 3) & ~3;
    if (dataStart + total * 4 > buf.length) return { error: `truncated: header promises ${total} floats, file holds ${Math.floor((buf.length - dataStart) / 4)}` };
    return { ids: entries.map((e) => e[0]), dims: [...new Set(entries.map((e) => e[1]))], bytes: buf.length };
  } catch (e) { return { error: e.message }; }
}

/** Parse the worker log: last cycle line, consecutive budget-exhausted cycles, log time (local "YYYY-MM-DD HH:MM:SS"). */
function inspectLog(text) {
  const lines = String(text || '').split('\n');
  const stamp = (l) => { const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(l); return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
  let lastCycle = null, lastAt = null, exhaustedStreak = 0, streakOpen = true, lastError = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/cycle done in/.test(l)) {
      if (!lastCycle) { lastCycle = l; lastAt = stamp(l); }
      if (streakOpen) { if (/paid pass skipped \(budget exhausted/.test(l)) exhaustedStreak++; else streakOpen = false; }
    }
    if (!lastError && /(\bERROR\b|failed|⚠|Unhandled|ECONN)/i.test(l) && !/cycle done/.test(l)) lastError = l.slice(0, 200);
  }
  return { lastCycle, lastAt, exhaustedStreak, lastError };
}

/** Parse `launchctl list <label>` output → { loaded, pid, lastExit }. */
function parseLaunchctl(out) {
  const s = String(out || '');
  if (!s.trim() || /Could not find service/i.test(s)) return { loaded: false };
  const pid = /"PID"\s*=\s*(\d+)/.exec(s);
  const exit = /"LastExitStatus"\s*=\s*(-?\d+)/.exec(s);
  return { loaded: true, pid: pid ? +pid[1] : null, lastExit: exit ? +exit[1] : null };
}

const sh = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (e, out, err) => resolve(String(out || '') + String(e ? err || e.message : ''))));

/** Everything the checks touch, injectable. Production defaults shown. */
function realDeps() {
  return {
    fs,
    now: () => Date.now(),
    launchctl: () => sh('/bin/launchctl', ['list', LABEL]),
    loadConfig: () => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8')); } catch { return {}; } },
  };
}

function dirSize(fsx, dir) {
  let n = 0, files = 0;
  try { for (const f of fsx.readdirSync(dir)) { try { n += fsx.statSync(path.join(dir, f)).size; files++; } catch {} } } catch {}
  return { bytes: n, files };
}

const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
const mb = (n) => (n / MB).toFixed(1) + ' MB';

/**
 * Run every check. opts: { dir, logPath, prev (a previous report's stats, for growth) }. Never throws:
 * a check that cannot run becomes a finding.
 */
async function check(opts = {}, depsIn = {}) {
  const d = { ...realDeps(), ...depsIn };
  const o = { ...defaults(), ...opts };
  const fsx = d.fs;
  const now = d.now();
  const findings = [];
  const add = (severity, what, evidence, suggestedFix) => findings.push({ severity, what, evidence, suggestedFix: suggestedFix || '' });
  const stats = { at: now };

  // ── graph.json: integrity + shape ──────────────────────────────────────────────────────────────
  const gr = readJson(fsx, path.join(o.dir, 'graph.json'));
  let nodes = {}, edges = {}, meta = {};
  if (gr.error) {
    add('critical', gr.missing ? 'graph.json is missing' : 'graph.json is unreadable', gr.error,
      'Restore the newest snapshot from brain/archive/ (graph-*.jsonl.gz) — do not let the worker re-import over it until restored.');
  } else {
    const g = gr.value || {};
    nodes = g.nodes && typeof g.nodes === 'object' ? g.nodes : {};
    edges = g.edges && typeof g.edges === 'object' ? g.edges : {};
    meta = g.meta || {};
    stats.graphBytes = gr.bytes;
    if (!g.nodes || !g.edges) add('critical', 'graph.json has no nodes/edges maps', `keys: ${Object.keys(g).join(', ') || '(none)'}`, 'Restore from brain/archive/.');
  }
  const nodeList = Object.values(nodes), edgeList = Object.values(edges);
  const live = nodeList.filter((n) => n.status !== 'pruned');
  const liveEdges = edgeList.filter((e) => e.status !== 'pruned');
  const byStatus = (list) => list.reduce((m, x) => { m[x.status || 'unknown'] = (m[x.status || 'unknown'] || 0) + 1; return m; }, {});
  stats.nodes = nodeList.length; stats.liveNodes = live.length; stats.edges = edgeList.length; stats.liveEdges = liveEdges.length;
  stats.nodeStatus = byStatus(nodeList); stats.edgeStatus = byStatus(edgeList);

  // ── growth since the previous report ───────────────────────────────────────────────────────────
  if (o.prev && typeof o.prev.nodes === 'number' && o.prev.nodes > 0) {
    const dn = stats.nodes - o.prev.nodes, de = stats.edges - o.prev.edges;
    stats.growth = { nodes: dn, edges: de, sinceMs: now - (o.prev.at || now) };
    if (dn / o.prev.nodes > THRESH.growthNodes) add('medium', 'Graph is growing fast', `${o.prev.nodes}→${stats.nodes} nodes (+${dn}), ${o.prev.edges}→${stats.edges} edges (+${de}) since last checkup`, 'Review what was imported; consider tightening the file-index ignore list.');
    if (dn < 0 && -dn / o.prev.nodes > THRESH.growthNodes) add('medium', 'Graph shrank sharply', `${o.prev.nodes}→${stats.nodes} nodes since last checkup`, 'Compare against brain/archive/ snapshots; restore if the loss was not a deliberate prune.');
  }

  // ── proposed vs confirmed vs pruned ────────────────────────────────────────────────────────────
  const es = stats.edgeStatus;
  const proposed = es.proposed || 0, confirmed = es.confirmed || 0, pruned = es.pruned || 0;
  const connectorDecided = edgeList.filter((e) => e.createdBy === 'connector' && e.status !== 'proposed');
  const connectorPruned = connectorDecided.filter((e) => e.status === 'pruned').length;
  stats.edgeRatio = { proposed, confirmed, pruned };
  if (proposed > THRESH.proposedBacklog) add('medium', 'Large backlog of unreviewed proposed edges', `${proposed} proposed vs ${confirmed} confirmed vs ${pruned} pruned`, 'Review in the Brain window: confirm the good ones, prune the rest (prune teaches the Gardener).');
  if (connectorDecided.length >= 50 && connectorPruned / connectorDecided.length > THRESH.prunedShare) add('low', 'Connector proposals are almost all rejected', `${connectorPruned}/${connectorDecided.length} decided connector edges pruned (${pct(connectorPruned, connectorDecided.length)}%)`, 'Raise the connect threshold (synapse meta connectThreshold) — the paid pass is spending on links nobody keeps.');

  // ── dangling edges, orphans, duplicates, provenance ────────────────────────────────────────────
  const dangling = edgeList.filter((e) => !nodes[e.from] || !nodes[e.to]);
  if (dangling.length) add('high', 'Edges point at nodes that do not exist', `${dangling.length} edges, e.g. ${dangling.slice(0, 3).map((e) => e.id).join(', ')}`, 'Propose dropping these edges (a Gardener pass); do not hand-edit graph.json.');
  const touched = new Set();
  for (const e of liveEdges) { touched.add(e.from); touched.add(e.to); }
  const orphans = live.filter((n) => !touched.has(n.id));
  stats.orphans = orphans.length;
  const orphanProjects = orphans.filter((n) => n.type === 'project');
  if (live.length && orphans.length / live.length > THRESH.orphanShare) add('low', 'Most live nodes have no connections', `${orphans.length}/${live.length} (${pct(orphans.length, live.length)}%) orphans`, 'Expected for freshly indexed files; if it persists, the Connector is not linking — check the budget finding.');
  if (orphanProjects.length) add('low', 'Project nodes with no connections', `${orphanProjects.length}: ${orphanProjects.slice(0, 5).map((n) => n.label).join(', ')}`, 'Add a README/status file to those projects so they link, or prune dead ones.');
  const seen = new Map(); let dupes = 0; const dupEx = [];
  for (const n of live) {
    if (n.type === 'file') continue;   // README.md exists in every project; only memories/projects/findings should be unique
    const k = n.type + '|' + String(n.label || '').trim().toLowerCase();
    if (seen.has(k)) { dupes++; if (dupEx.length < 3) dupEx.push(`${n.type}:${n.label}`); } else seen.set(k, n.id);
  }
  stats.duplicateLabels = dupes;
  if (live.length && dupes / live.length > THRESH.dupShare) add('low', 'Duplicate labels among live nodes', `${dupes} duplicates (${pct(dupes, live.length)}%), e.g. ${dupEx.join('; ')}`, 'Run the Gardener merge pass (proposes merges; confirmed nodes are never touched).');
  const unsourced = liveEdges.filter((e) => e.createdBy !== 'import' && (!String(e.rationale || '').trim() || !e.provenance || !Object.keys(e.provenance).length));
  stats.unsourcedEdges = unsourced.length;
  if (unsourced.length) add('medium', 'Edges missing rationale or provenance', `${unsourced.length} non-import edges, e.g. ${unsourced.slice(0, 3).map((e) => e.id).join(', ')}`, 'Propose pruning these (an unsourced link cannot be audited) or re-running the Connector over them.');

  // ── vectors.f32 ────────────────────────────────────────────────────────────────────────────────
  const vr = inspectVectors(fsx, path.join(o.dir, 'vectors.f32'));
  if (vr.error) {
    add(vr.missing ? 'medium' : 'critical', vr.missing ? 'vectors.f32 is missing' : 'vectors.f32 is corrupt', vr.error, vr.missing ? 'The worker re-embeds on the next cycle (costs budget); nothing to restore.' : 'Move the file aside and let the worker re-embed; keep the corrupt copy until it has.');
  } else {
    stats.vectors = vr.ids.length; stats.vectorBytes = vr.bytes;
    const ghost = vr.ids.filter((id) => !nodes[id]);
    if (vr.dims.length > 1) add('high', 'Vectors have mixed dimensions', `dims ${vr.dims.join(', ')}`, 'Embedding model changed mid-store; re-embed everything with one model.');
    if (ghost.length) add('low', 'Vectors for nodes that no longer exist', `${ghost.length} orphaned vectors`, 'Safe to drop on the next save; the Gardener does this.');
    if (meta.embedDim && vr.dims.length === 1 && vr.dims[0] !== meta.embedDim) add('high', 'Vector dimension differs from graph meta', `vectors ${vr.dims[0]} vs meta.embedDim ${meta.embedDim}`, 'Re-embed with the configured model.');
  }

  // ── budget ─────────────────────────────────────────────────────────────────────────────────────
  const cfg = d.loadConfig() || {};
  const limit = Number(cfg.synapseBudgetUsd) > 0 ? Number(cfg.synapseBudgetUsd) : 1;
  const today = new Date(now).toISOString().slice(0, 10);
  const spent = meta.spendDay === today ? Number(meta.spendTodayUsd) || 0 : 0;
  stats.budget = { limit, spent, lifetime: Number(meta.spendUsd) || 0 };
  let logText = '';
  try { logText = fsx.readFileSync(o.logPath, 'utf8'); } catch {}
  const log = inspectLog(logText.length > 400000 ? logText.slice(-400000) : logText);
  stats.log = { lastCycle: log.lastCycle, lastAt: log.lastAt, exhaustedStreak: log.exhaustedStreak };
  if (log.exhaustedStreak >= 3 || spent >= limit - 0.02) {
    add(log.exhaustedStreak >= 3 ? 'high' : 'medium', 'Paid pass is blocked by the daily budget',
      `$${spent.toFixed(3)}/$${limit.toFixed(2)} today; ${log.exhaustedStreak} consecutive cycles skipped (hydrate-only)`,
      `Raise synapseBudgetUsd in ~/.bhatbot/config.json (currently ${limit}) or accept hydrate-only; no new links are proposed while blocked.`);
  }

  // ── worker freshness + LaunchAgent ─────────────────────────────────────────────────────────────
  if (!log.lastAt) add('high', 'No synapse cycle found in the worker log', o.logPath, 'Check the LaunchAgent and ~/.bhatbot/logs/synapse-worker.log.');
  else {
    const ageMin = Math.round((now - log.lastAt) / 60000);
    stats.lastCycleAgeMin = ageMin;
    if (ageMin > THRESH.cycleStaleMin) add(ageMin > 24 * 60 ? 'critical' : 'high', 'Synapse worker has not completed a cycle recently', `last cycle ${ageMin} min ago`, `launchctl kickstart -k gui/$(id -u)/${LABEL}`);
  }
  let lc = { loaded: null };
  try { lc = parseLaunchctl(await d.launchctl()); } catch {}
  stats.launchd = lc;
  if (lc.loaded === false) add('high', `LaunchAgent ${LABEL} is not loaded`, 'launchctl list reports no such service', `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${LABEL}.plist`);
  else if (lc.loaded && !lc.pid) add('medium', `LaunchAgent ${LABEL} is loaded but not running`, `last exit status ${lc.lastExit}`, `launchctl kickstart -k gui/$(id -u)/${LABEL}`);
  if (log.lastError && log.lastAt && now - log.lastAt < DAY) add('low', 'Recent error in the worker log', log.lastError, 'Read synapse-worker.log around that line.');

  // ── stale files ────────────────────────────────────────────────────────────────────────────────
  const known = new Set(['graph.json', 'vectors.f32', 'archive', 'standard-actions.json']);
  let entries = [];
  try { entries = fsx.readdirSync(o.dir); } catch {}
  const stale = [];
  for (const f of entries) {
    if (known.has(f)) continue;
    try { const st = fsx.statSync(path.join(o.dir, f)); stale.push({ f, size: st.size, ageDays: Math.round((now - st.mtimeMs) / DAY) }); } catch {}
  }
  stats.staleFiles = stale;
  for (const s of stale.filter((x) => x.size >= THRESH.staleFileBytes || /\.(pre-|corrupt-|bak)/.test(x.f))) {
    add(s.size >= THRESH.staleFileBytes ? 'low' : 'info', `Leftover file in the brain dir: ${s.f}`, `${mb(s.size)}, ${s.ageDays} days old`,
      `Once graph.json and vectors.f32 are confirmed good, delete it: rm ${path.join(o.dir, s.f)} (needs your OK; the Psychiatrist will not do it).`);
  }
  const arch = dirSize(fsx, path.join(o.dir, 'archive'));
  stats.archive = arch;
  if (arch.bytes > 500 * MB) add('low', 'Brain archive is large', `${arch.files} files, ${mb(arch.bytes)}`, 'Prune old snapshots, keeping the newest few.');

  findings.sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  const score = Math.max(0, 100 - findings.reduce((n, f) => n + (PENALTY[f.severity] || 0), 0));
  const grade = score >= 90 ? 'healthy' : score >= 70 ? 'fair' : score >= 40 ? 'unwell' : 'critical';
  return { score, grade, findings, stats, at: now };
}

/** One-paragraph plain text of a report (what the Psychiatrist is fed, and what the UI falls back to). */
function format(r) {
  if (!r) return 'No brain checkup yet.';
  const head = `Brain health ${r.score}/100 (${r.grade}) — ${r.stats.nodes} nodes, ${r.stats.edges} edges, ${r.findings.length} findings`;
  return [head, ...r.findings.map((f) => `[${f.severity}] ${f.what} — ${f.evidence}${f.suggestedFix ? ' → ' + f.suggestedFix : ''}`)].join('\n');
}

// ── the report on disk (its OWN dir — never the brain) ─────────────────────────────────────────────
function loadReport(healthDir = defaults().healthDir, fsx = fs) {
  try { return JSON.parse(fsx.readFileSync(path.join(healthDir, 'latest.json'), 'utf8')); } catch { return null; }
}
function saveReport(report, healthDir = defaults().healthDir, fsx = fs) {
  fsx.mkdirSync(healthDir, { recursive: true });
  const tmp = path.join(healthDir, 'latest.json.tmp');
  fsx.writeFileSync(tmp, JSON.stringify(report, null, 1));
  fsx.renameSync(tmp, path.join(healthDir, 'latest.json'));
  return path.join(healthDir, 'latest.json');
}
/** check() against the previous report for growth, then persist. */
async function run(opts = {}, deps = {}) {
  const healthDir = opts.healthDir || defaults().healthDir;
  const prev = loadReport(healthDir, (deps.fs || fs));
  const report = await check({ ...opts, prev: prev && prev.stats }, deps);
  try { saveReport(report, healthDir, deps.fs || fs); } catch {}
  return report;
}

module.exports = { check, run, format, loadReport, saveReport, inspectLog, inspectVectors, parseLaunchctl, defaults, THRESH, SEVERITY, LABEL };

// `node lib/brainhealth.js [--json]` — what the Psychiatrist runs from its terminal. Read-only on the brain.
if (require.main === module) {
  run().then((r) => { console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 1) : format(r)); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
