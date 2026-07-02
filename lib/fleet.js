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
const blackboard = require('./blackboard');
const { createDrone } = require('./drone');

async function runFleet(specs = [], deps = {}, opts = {}) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const board = deps.board || blackboard.createBlackboard({ dir: opts.wsDir || require('os').tmpdir() });
  const onEvent = deps.onEvent || (() => {});
  const staleMs = opts.staleMs || 15000;
  const grace = opts.nudgeGraceMs || 3000;
  const pollMs = opts.pollMs || Math.max(50, Math.min(2000, Math.floor(staleMs / 4)));
  const envelopeUsd = opts.envelopeUsd != null ? opts.envelopeUsd : 2;
  const hardCap = opts.hardCap || 6;

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
  return {
    results, totalSpend: Number(totalSpend.toFixed(6)), launched, skipped: skipped.length,
    envelopeExceeded, reaped: settled.filter((r) => r.reaped).length,
    board,
  };
}

module.exports = { runFleet };
