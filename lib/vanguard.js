'use strict';
// VANGUARD — the unified codename roster for BhatBot's agent fleet (Phase 1).
// One codename per FUNCTION, reused across all three fleet systems (ensemble roles in
// lib/orchestrator, persistent sub-agents in lib/subagents, project-DAG roles in
// lib/agents/roles) so identity is SHARED: FORGE always means "coding" whether it is a
// suit, a standing sub-agent, or a DAG node. Collective fleet name: VANGUARD.
//
// Surfaced in: the live Legion panel labels, fleet/admission log lines, and any new fleet code.
// Per the Phase-1 directive we prefer applying these in NEW code + role tables over a global
// find-replace of every legacy variable.

const FLEET_NAME = 'VANGUARD';

// function (normalized role key) → codename
const CODENAMES = {
  orchestrator: 'OVERMIND',   // commands the fleet, owns the DAG
  planner:      'OVERMIND',
  lead:         'OVERMIND',
  synthesizer:  'OVERMIND',
  coding:       'FORGE',      // builds / repairs
  implementer:  'FORGE',
  research:     'ORACLE',     // knowledge & synthesis
  analysis:     'ORACLE',
  browser:      'SCOUT',      // navigates the field
  web:          'SCOUT',
  memory:       'VAULT',      // durable store / knowledge graph
  creative:     'ATELIER',    // studio + image gen
  design:       'ATELIER',
  tester:       'SENTINEL',   // guards quality / red-team QA
  qa:           'SENTINEL',
  lifeadmin:    'WARDEN',     // scheduling / logistics
  schedule:     'WARDEN',
  selfheal:     'MEDIC',      // fixes the agent itself
  maintenance:  'MEDIC',
  skeptic:      'ECHO',       // adversarial angle
};

function normKey(role) {
  return String(role || '').toLowerCase().replace(/[^a-z]/g, '');
}

// Map a role/agent name to its VANGUARD codename. Unknown roles → uppercased name (still readable),
// empty → the collective name.
function codename(role) {
  if (!role) return FLEET_NAME;
  const k = normKey(role);
  return CODENAMES[k] || String(role).toUpperCase();
}

// "FORGE (coding)" style label for panels/logs; collapses to just the codename when the role
// name carries no extra info.
function label(role) {
  const c = codename(role);
  const plain = String(role || '').toUpperCase();
  return (!role || c === plain) ? c : `${c} · ${role}`;
}

module.exports = { FLEET_NAME, CODENAMES, codename, label };
