'use strict';
// ── DRONE (FORGE-sprint Phase 1 / D1) ─────────────────────────────────────────────────────────────
// A drone is a scoped-down instance of BhatBot: its own persona, a STRICT tool subset, its own
// workspace + memory scratchpad, a budget slice, and a blackboard handle so it can see and inform
// siblings. It is deployed as part of a fleet (lib/fleet.js) and reports a structured result envelope
// (the same contract as lib/agents/roles) rather than a transcript.
//
// DECISION — in-process, DI-driven (not child_process) for STANDARD drones:
//   • In-process reuses the existing agent-loop machinery and, crucially, the SAME admission ledger
//     (lib/admission.js) natively — fleet width stays budget-derived with zero IPC plumbing. main.js
//     injects the real agent runner; tests inject a mock. This is option (a) from the sprint spec.
//   • Drones that must run GENERATED or UNTRUSTED code do NOT get more trust here — they route that
//     code through lib/sandboxexec.js (scrubbed env, no secrets/keychain/network). The `hermetic` flag
//     is recorded on the spec and surfaced to the runner; a full child_process drone-runtime is the
//     documented next step, but the untrusted-CODE wall already exists and is where isolation lives.
//   • The drone enforces its tool allow-list itself (belt): even if the runner is handed a wider set,
//     scopeTools() intersects with the drone's grant, and the runner is told the grant explicitly.
//
// Pure + DI: deps = { agentRun(ctx,task)->envelope, board?, admission?, now?, log? }. No app/network deps.
const path = require('path');

let ROLE_TOOLS = {};
try { ROLE_TOOLS = require('./agents/roles').ROLE_TOOLS || {}; } catch { ROLE_TOOLS = {}; }

// The universe of tool names a drone MAY be granted (a drone can never exceed a role preset's spirit;
// callers pass explicit `tools` or a `role` whose preset is used). Kept permissive-but-scoped.
function presetTools(role) { return (ROLE_TOOLS[role] || []).slice(); }

// scopeTools — the enforced allow-list: intersection of the requested grant with the offered defs.
function scopeTools(grant, offeredDefs) {
  const allow = new Set(grant || []);
  return (offeredDefs || []).filter((t) => allow.has(t.name));
}

// createDrone(spec, deps) → a drone with run(task). spec:
//   { id, persona:{name,brief,style}, role?, tools?, wsDir, budget:{usd,maxTurns}, model?, hermetic? }
function createDrone(spec = {}, deps = {}) {
  const now = deps.now || (() => Date.now());
  const id = spec.id || 'drone-' + Math.random().toString(36).slice(2, 8);
  const persona = spec.persona || { name: id, brief: 'a scoped BhatBot instance', style: 'concise' };
  const tools = (spec.tools && spec.tools.length) ? spec.tools.slice() : presetTools(spec.role || 'research');
  const wsDir = spec.wsDir || path.join('/tmp', 'drone-' + id);
  const budget = { usd: (spec.budget && spec.budget.usd) || 0.25, maxTurns: (spec.budget && spec.budget.maxTurns) || 8 };
  const model = spec.model || null;   // null = router picks per task class
  const board = deps.board || null;

  let spent = 0, turns = 0, terminated = false;

  // The identity block the drone's system prompt states plainly (D3): scoped BhatBot, persona, budget,
  // siblings exist, MUST post status ≥ every 3 turns + findings as it learns.
  function identityPrompt() {
    const siblings = board ? board.fleetStatusBlock() : '';
    return [
      `You are ${persona.name}, a SCOPED instance of BhatBot (a "drone"). Persona: ${persona.brief}. Style: ${persona.style || 'concise'}.`,
      `Your tools are LIMITED to: ${tools.join(', ') || '(none)'}. You may use no others.`,
      `Budget: up to ${budget.maxTurns} turns / ~$${budget.usd}. Work toward your goal, then stop and report a short result.`,
      `You are one of several sibling drones on this mission. Post a 'status' to the shared blackboard at least every 3 turns, and a 'finding' whenever you learn something siblings should know.`,
      spec.hermetic ? `Any code you GENERATE runs only in the sandbox (scrubbed env — no secrets, no network). Never assume access to real credentials.` : '',
      siblings ? '\n' + siblings : '',
    ].filter(Boolean).join('\n');
  }

  // record spend/turn from a runner step; returns whether budget remains.
  function charge({ usd = 0 } = {}) { spent += usd || 0; turns += 1; return turns < budget.maxTurns && spent < budget.usd; }

  function heartbeat(text) { if (board) { try { board.heartbeat(persona.name, id, text); } catch {} } }
  function terminate(reason) { terminated = true; if (board) { try { board.post({ agent: persona.name, taskId: id, kind: 'status', text: 'terminated: ' + (reason || 'reaped') }); } catch {} } }

  // run(task) — hand the scoped context to the injected agent runner and normalize its output into a
  // fleet result envelope. The runner is expected to honor `tools` + `system` + call back onStep for
  // heartbeats/charging; a minimal runner that just returns {summary} also works.
  async function run(task) {
    const startedAt = now();
    if (board) { try { board.post({ agent: persona.name, taskId: id, kind: 'status', text: 'deployed: ' + String(task.goal || task).slice(0, 120) }); } catch {} }
    const ctx = {
      id, persona, tools, wsDir, model, budget, hermetic: !!spec.hermetic,
      system: identityPrompt(),
      onStep: (info = {}) => { const budgetLeft = charge(info); heartbeat(info.note || 'working'); return { budgetLeft, terminated }; },
      board,
    };
    let envelope;
    try {
      const raw = await deps.agentRun(ctx, task);
      envelope = normalizeEnvelope(raw);
    } catch (e) {
      envelope = { status: 'failed', summary: 'drone error: ' + (e && e.message || e) };
    }
    const result = {
      droneId: id, persona: persona.name, status: envelope.status || 'ok',
      summary: envelope.summary || '', artifacts: envelope.artifacts || [],
      spend: { usd: Number(spent.toFixed(6)), turns }, ms: now() - startedAt, terminated,
    };
    if (board) { try { board.post({ agent: persona.name, taskId: id, kind: 'finding', text: `[${result.status}] ${result.summary}`.slice(0, 280) }); } catch {} }
    return result;
  }

  function normalizeEnvelope(raw) {
    if (!raw) return { status: 'failed', summary: '(no output)' };
    if (typeof raw === 'string') return { status: 'ok', summary: raw };
    return { status: raw.status || 'ok', summary: raw.summary || raw.result || raw.text || '', artifacts: raw.artifacts || [] };
  }

  return {
    id, persona, tools, wsDir, budget, hermetic: !!spec.hermetic,
    run, identityPrompt, heartbeat, terminate,
    get spent() { return spent; }, get turns() { return turns; }, get terminated() { return terminated; },
  };
}

module.exports = { createDrone, scopeTools, presetTools };
