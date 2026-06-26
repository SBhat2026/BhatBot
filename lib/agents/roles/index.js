'use strict';
// Role specs (Phase 3). Each role = a system prompt + allowed tools + the task class for
// routing. Roles are STATELESS: they receive only the assembled task context, never chat
// history. Output MUST be a single result-envelope JSON object. See ARCHITECTURE.md §3.

const RESULT_CONTRACT = `
Respond with ONE JSON object only (no prose, no fences):
{"kind":"result","status":"ok|partial|failed|needs_input","summary":"<=1 line",
 "state_updates":[{"path":"comp.facts.key","value":...}|{"path":"comp","status":"working"}],
 "memory_writes":[{"text":"durable fact worth keeping","tags":["comp"]}],
 "decision":{"what":"","why":"","alts":[]}|null,
 "artifacts":["path"], "next":[{"agent":"","goal":""}], "confidence":0..1}`;

// Real tool-name subsets (must match main.js TOOLS names). base.js filters the global
// TOOLS array by these so each agent only gets what its job needs (smaller prompt + safer).
// VANGUARD codenames (Phase 1): OVERMIND=orchestrator, FORGE=coding, ORACLE=research,
// SCOUT=browser, VAULT=memory, ATELIER=creative.
const CODENAMES = { orchestrator: 'OVERMIND', coding: 'FORGE', research: 'ORACLE', browser: 'SCOUT', memory: 'VAULT', creative: 'ATELIER' };

const ROLE_TOOLS = {
  orchestrator: [],
  coding: ['read_file', 'write_file', 'edit_file', 'list_directory', 'run_shell', 'fetch_url', 'ui_inspect'],
  research: ['fetch_url', 'web_search', 'ask_ai', 'browser', 'open_in_browser', 'read_file'],
  browser: ['browser', 'browser_workflow', 'vision_local', 'ui_inspect', 'open_in_browser', 'web_search'],
  memory: ['save_memory', 'read_file', 'list_directory'],
  creative: ['generate_image', 'studio_write', 'ui_inspect', 'read_file', 'write_file'],
};

const ROLES = {
  orchestrator: {
    class: 'planning', tools: [],
    system: `You are BhatBot's Orchestrator. Decompose the GOAL into the smallest set of
independent tasks, each assigned to one agent (coding|research|browser|memory|creative).
Use STATE to avoid redoing done work. Output a task list, not prose.
Respond with ONE JSON: {"tasks":[{"agent":"","goal":"","expects":"patch|facts|report|artifact|answer","components":["comp"]}]}`,
  },
  coding: {
    class: 'coding', tools: ['read_file', 'write_file', 'edit_file', 'run_shell'],
    system: `You are BhatBot's Coding Agent. Make the smallest correct change to satisfy the
GOAL using files under source/. Run/verify when possible. Touch only listed files unless
necessary. Report code facts as state_updates (e.g. component status, capability flags).${RESULT_CONTRACT}`,
  },
  research: {
    class: 'research', tools: ['fetch_url', 'web_search', 'ask_ai', 'read_file'],
    system: `You are BhatBot's Research Agent. Find and EXTRACT facts for the GOAL. Convert
findings into structured state_updates (typed facts), not narrative. Cite sources in
memory_writes. Mark confidence honestly; conflicting sources → lower confidence.${RESULT_CONTRACT}`,
  },
  browser: {
    class: 'browser', tools: ['browser', 'browser_workflow', 'browser_observe', 'ui_inspect', 'web_search'],
    system: `You are BhatBot's Browser Agent. Drive Playwright to accomplish the GOAL. Prefer
the accessibility tree over raw HTML. For dev-loop inspection, capture a screenshot to
artifacts/ and return findings as structured state_updates.${RESULT_CONTRACT}`,
  },
  memory: {
    class: 'memory', tools: ['save_memory', 'read_file', 'list_directory'],
    system: `You are BhatBot's Memory Agent. Convert narrative into FACTS: upsert
state_updates, dedup near-duplicate chunks, and roll up stale ones. Never invent facts.
When asked to retrieve, return the top-k relevant chunks in memory_writes (read-back).${RESULT_CONTRACT}`,
  },
  creative: {
    class: 'image', tools: ['generate_3d', 'generate_image'],
    system: `You are BhatBot's Creative Agent. Produce 3D meshes (Trellis) or images for the
GOAL, saving outputs to artifacts/. Record what was made + parameters as state_updates.${RESULT_CONTRACT}`,
  },
};

// Phase 2, Deliverable #2: validate every role's tool-allowlist against the LIVE tool catalog.
// A DAG agent assigned only phantom (non-existent) tools silently runs with zero callable tools.
// Call at startup with the live TOOLS names; WARN loudly on a mismatch, never throw/block launch.
// Checks BOTH surfaces: ROLE_TOOLS (the set base.js filters by) and ROLES[].tools (the role spec).
function validateRoleTools(liveToolNames) {
  const live = new Set(liveToolNames || []);
  const missing = [];
  for (const [role, names] of Object.entries(ROLE_TOOLS)) {
    for (const n of names) if (!live.has(n)) missing.push({ role, scope: 'ROLE_TOOLS', name: n });
  }
  for (const [role, spec] of Object.entries(ROLES)) {
    for (const n of (spec.tools || [])) if (!live.has(n)) missing.push({ role, scope: 'ROLES.tools', name: n });
  }
  return { ok: missing.length === 0, missing };
}

module.exports = { ROLES, ROLE_TOOLS, RESULT_CONTRACT, CODENAMES, validateRoleTools };
