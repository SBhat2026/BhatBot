'use strict';
// ── FLEET SUPERVISOR (FORGE-sprint Phase 1 / D1) ──────────────────────────────────────────────────
// Spawns, monitors, and collects a fleet of drones (lib/drone.js). Responsibilities the sprint spec
// names: heartbeats on the blackboard; a stalled drone (no board post within staleMs) gets ONE nudge
// then termination with a `partial` result; total fleet spend tracked live, exceeding the envelope
// pauses new spawns; results use the drone result-envelope contract.
//
// DECISION — width is budget-derived, spend is envelope-gated, count is hard-capped:
//   • per-call pacing is admission's job (lib/admission.js), injected as deps.admission — the fleet
//     doesn't re-implement rate limiting; it governs the WALLET (envelopeUsd) and the ROSTER (hardCap).
//   • reaping is cooperative: an in-process drone promise can't be force-killed, so on stall we resolve
//     the supervised race with a `partial` reaped envelope and abandon the drone (its late result is
//     ignored) — identical semantics to jobs.js cancellation. terminate() marks it on the board.
//   • spawns are admission-gated one-by-one so a wide fleet self-throttles instead of convoy-stalling;
//     between spawns we check the live envelope and stop launching if the wallet is spent.
//
// Pure + DI: deps = { agentRun, board?, admission?, now?, sleep?, log?, onEvent? }. Testable headless.
const fs = require('fs');
const os = require('os');
const path = require('path');
const blackboard = require('./blackboard');
const { createDrone } = require('./drone');

// TWO DIFFERENT CEILINGS, previously two lookalike numbers in two files (main.js FLEET_CAP = 24,
// fleet.js hardCap = 6) with nothing saying which was which:
//   FLEET_HARD_CAP        — the CONCURRENCY ceiling. How many agents may be in flight at once across
//                           the whole app; lib/admission.js paces against live OTPM below this.
//   DRONE_ROSTER_DEFAULT  — the ROSTER default for ONE deploy_drones call. How many drones a single
//                           mission gets unless the caller says otherwise. Nothing to do with pacing.
const FLEET_HARD_CAP = 24;
const DRONE_ROSTER_DEFAULT = 6;

// Where a fleet run's artifacts live. main.js already mints ~/.bhatbot/drones/run-<ts>/ and the
// blackboard already writes blackboard.jsonl there; run.json joins them.
const RUNS_DIR = path.join(os.homedir(), '.bhatbot', 'drones');
const RUN_FILE = 'run.json';

async function runFleet(specs = [], deps = {}, opts = {}) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const board = deps.board || blackboard.createBlackboard({ dir: opts.wsDir || require('os').tmpdir() });
  const onEvent = deps.onEvent || (() => {});
  // Reaping is a LIVENESS check, not a latency check. The old defaults (15s + 3s) reaped a drone that
  // was doing real work: a single run_shell/browser/vision call routinely exceeds 18s, and the shared
  // rate pacer (waitForBudget) deliberately sleeps up to ~60s. main.js already passes 90s/15s on the
  // deploy_drones path; these defaults now match it so every other caller gets the same sane window.
  const staleMs = opts.staleMs || 90000;
  const grace = opts.nudgeGraceMs || 15000;
  const pollMs = opts.pollMs || Math.max(50, Math.min(2000, Math.floor(staleMs / 4)));
  const envelopeUsd = opts.envelopeUsd != null ? opts.envelopeUsd : 2;
  const hardCap = opts.hardCap || DRONE_ROSTER_DEFAULT;
  const startedAt = now();

  const toRun = specs.slice(0, hardCap);
  const skipped = specs.slice(hardCap).map((s) => ({ persona: (s.persona && s.persona.name) || s.id, status: 'skipped', summary: 'over fleet hard cap' }));

  const drones = toRun.map((s) => createDrone(s, { board, admission: deps.admission, now, agentRun: deps.agentRun }));
  let totalSpend = 0, envelopeExceeded = false, launched = 0;
  const results = [];

  // Supervise one drone: race its run() against a stall watchdog reading blackboard heartbeats.
  async function supervise(drone, task) {
    let done = false;
    const runP = drone.run(task).then((r) => { done = true; return r; }).catch((e) => { done = true; return { droneId: drone.id, persona: drone.persona.name, status: 'failed', summary: String(e && e.message || e), spend: { usd: drone.spent, turns: drone.turns } }; });
    const watch = new Promise((resolve) => {
      let nudged = false, nudgedAt = 0;
      (async () => {
        while (!done) {
          await sleep(pollMs);
          if (done) return;
          const last = board.lastPost(drone.persona.name);
          const age = last ? now() - new Date(last.ts).getTime() : Infinity;
          if (age > staleMs) {
            if (!nudged) { nudged = true; nudgedAt = now(); try { board.post({ agent: 'FLEET', kind: 'need', text: `${drone.persona.name} silent ${Math.round(age / 1000)}s — post a status` }); } catch {} onEvent({ type: 'drone-nudge', drone: drone.persona.name }); }
            else if (now() - nudgedAt > grace) {
              drone.terminate('stalled'); onEvent({ type: 'drone-reaped', drone: drone.persona.name });
              return resolve({ droneId: drone.id, persona: drone.persona.name, status: 'partial', summary: `reaped — no heartbeat for ${Math.round(age / 1000)}s`, spend: { usd: drone.spent, turns: drone.turns }, reaped: true });
            }
          }
        }
      })();
    });
    return Promise.race([runP, watch]);
  }

  onEvent({ type: 'fleet-start', count: drones.length, envelopeUsd });
  // Launch admission-gated: acquire a slot per drone (budget-derived width), stop if wallet spent.
  const supervised = [];
  for (const drone of drones) {
    if (totalSpend >= envelopeUsd) { envelopeExceeded = true; results.push({ persona: drone.persona.name, status: 'skipped', summary: 'fleet budget envelope reached' }); continue; }
    if (deps.admission && deps.admission.acquire) { try { await deps.admission.acquire(drone.model || 'sonnet', 2000, drone.budget.usd * 1000 || 4096, { label: drone.persona.name }); } catch {} }
    launched++;
    const task = drone._task || (opts.taskFor ? opts.taskFor(drone) : { goal: opts.mission || 'work the mission' });
    supervised.push(supervise(drone, task).then((r) => {
      totalSpend += (r.spend && r.spend.usd) || 0;
      if (deps.admission && deps.admission.release) { try { deps.admission.release(drone.model || 'sonnet', 2000, drone.budget.usd * 1000 || 4096); } catch {} }
      onEvent({ type: 'drone-done', drone: r.persona, status: r.status });
      return r;
    }));
  }
  const settled = await Promise.all(supervised);
  results.push(...settled, ...skipped);

  onEvent({ type: 'fleet-done', launched, totalSpend, reaped: settled.filter((r) => r.reaped).length });
  const out = {
    results, totalSpend: Number(totalSpend.toFixed(6)), launched, skipped: skipped.length,
    envelopeExceeded, reaped: settled.filter((r) => r.reaped).length,
    board,
  };

  // PERSIST the run. Until now a fleet's entire output lived in this return value — a restart, a
  // crash, or simply scrolling past the panel lost it, along with the record of what was actually
  // spent. The workspace dir and its blackboard.jsonl already survive; this makes the run itself
  // readable after the fact (bhatctl fleet list|show, and any future UI).
  if (opts.wsDir) {
    try {
      fs.mkdirSync(opts.wsDir, { recursive: true });
      const rec = {
        id: path.basename(opts.wsDir),
        mission: opts.mission || null,
        startedAt, endedAt: now(), ms: now() - startedAt,
        launched, skipped: skipped.length, reaped: out.reaped,
        totalSpend: out.totalSpend, envelopeUsd, envelopeExceeded,
        // Personas + goals only — never the full spec, which can carry tool grants and prompts.
        specs: specs.map((s) => ({ persona: (s.persona && s.persona.name) || s.id || null, role: s.role || null, goal: (s._task && s._task.goal) || null })),
        results: results.map((r) => ({
          persona: r.persona, status: r.status, reaped: !!r.reaped,
          summary: String(r.summary || '').slice(0, 4000),
          spend: r.spend || null, ms: r.ms || null,
          artifacts: (r.artifacts || []).slice(0, 20),
        })),
        board: path.join(opts.wsDir, 'blackboard.jsonl'),
      };
      const tmp = path.join(opts.wsDir, RUN_FILE + '.tmp');
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
      fs.renameSync(tmp, path.join(opts.wsDir, RUN_FILE));   // atomic — a reader never sees a partial run
      out.runFile = path.join(opts.wsDir, RUN_FILE);
    } catch (e) { (deps.log || (() => {}))('[fleet] could not persist run: ' + e.message); }
  }
  return out;
}

/** Past fleet runs, newest first. Reads straight off disk, so it works with the app closed. */
function listRuns({ dir = RUNS_DIR, limit = 50 } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((d) => d.startsWith('run-')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n, RUN_FILE), 'utf8'))); }
    catch { /* a run that died before it could persist — skip, don't fail the listing */ }
  }
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, limit);
}

/** One past run by id (the run-<ts> directory name), or null. */
function readRun(id, { dir = RUNS_DIR } = {}) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, id, RUN_FILE), 'utf8')); } catch { return null; }
}

module.exports = { runFleet, listRuns, readRun, FLEET_HARD_CAP, DRONE_ROSTER_DEFAULT, RUNS_DIR };
