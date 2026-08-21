'use strict';
// SUBAGENT DIFFERENTIATION — do the roles actually specialize, or are they six names for one agent?
//
// A fan-out is only worth its cost if the agents differ. Three ways that quietly stops being true:
//   1. tool sets converge, so every agent can do everything and the split buys nothing;
//   2. a role's tools are declared somewhere that nothing reads (this was live: `ROLES[x].tools`
//      granted nothing — base.js and drone.js both read ROLE_TOOLS — and the two lists had drifted
//      apart on 4 of 6 roles, so the creative agent advertised 2 tools while running with 5);
//   3. a role references a tool that no longer exists, so it silently runs without it.
//
// These assert all three, plus that identity (codename) is shared across every subsystem that
// spawns agents, so "FORGE" means the same thing in the FLEET tab, a drone run and a DAG task.
const assert = require('assert');
const roles = require('../lib/agents/roles');
const TOOLS = require('../lib/tools-schema')({ MEMORY_SECTIONS: ['a'] });

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const live = new Set(TOOLS.map((t) => t.name));

// ── one declaration, and it is the one that is read ───────────────────────────────────────────
{
  for (const [name, spec] of Object.entries(roles.ROLES)) {
    ok(spec.tools === undefined, `${name}: no phantom ROLES.tools key (ROLE_TOOLS is the only grant list)`);
  }
  const v = roles.validateRoleTools([...live]);
  ok(v.ok, 'every tool every role can call actually exists in the live catalog: ' + JSON.stringify(v.missing));
  // The validator must FAIL if someone reintroduces the second list — otherwise the drift returns.
  const poisoned = { ...roles.ROLES, coding: { ...roles.ROLES.coding, tools: ['read_file'] } };
  const saved = roles.ROLES.coding.tools;
  roles.ROLES.coding.tools = ['read_file'];
  ok(roles.validateRoleTools([...live]).ok === false, 'reintroducing ROLES.tools is caught, not silently ignored');
  if (saved === undefined) delete roles.ROLES.coding.tools; else roles.ROLES.coding.tools = saved;
  ok(roles.validateRoleTools([...live]).ok, 'validator is clean again once the phantom key is removed');
  void poisoned;
}

// ── the roles genuinely differentiate ─────────────────────────────────────────────────────────
{
  const sets = Object.entries(roles.ROLE_TOOLS).filter(([, v]) => v.length);
  ok(sets.length >= 4, 'there are several tool-bearing roles to differentiate');
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = new Set(sets[i][1]), b = new Set(sets[j][1]);
      const inter = [...a].filter((x) => b.has(x)).length;
      const jac = inter / new Set([...a, ...b]).size;
      ok(jac < 0.7, `${sets[i][0]} vs ${sets[j][0]} are distinct (Jaccard ${jac.toFixed(2)} < 0.70) — the split earns its cost`);
    }
  }
  // Each specialist must own something no one else has, or it is not a specialist.
  for (const [name, tools] of sets) {
    if (name === 'orchestrator') continue;
    const others = new Set(sets.filter(([n]) => n !== name).flatMap(([, t]) => t));
    ok(tools.some((t) => !others.has(t)), `${name} has at least one tool no other role has (a real specialty)`);
  }
}

// ── the orchestrator plans, it does not do ────────────────────────────────────────────────────
{
  ok((roles.ROLE_TOOLS.orchestrator || []).length === 0,
    'the orchestrator gets NO tools — it decomposes and delegates; giving it tools is how a fan-out collapses into one agent doing everything');
  ok(/decompose|task list/i.test(roles.ROLES.orchestrator.system), 'and its prompt tells it to decompose into a task list');
  ok(/needs/.test(roles.ROLES.orchestrator.system), 'and to express DEPENDENCIES, so independent subtasks can run in parallel');
}

// ── every role is routable and contract-bound ─────────────────────────────────────────────────
{
  for (const [name, spec] of Object.entries(roles.ROLES)) {
    ok(typeof spec.class === 'string' && spec.class, `${name} declares a task class (that is what select.js routes a model on)`);
    ok(typeof spec.system === 'string' && spec.system.length > 80, `${name} has a real system prompt, not a stub`);
    if (name !== 'orchestrator') {
      ok(spec.system.includes('"kind":"result"'), `${name} is bound to the result envelope, so its output is machine-readable by the DAG`);
    }
  }
  const classes = new Set(Object.values(roles.ROLES).map((s) => s.class));
  ok(classes.size >= 4, `roles span ${classes.size} distinct task classes, so the model selector can route them differently`);
}

// ── identity is shared across every subsystem that spawns agents ──────────────────────────────
{
  const codes = Object.values(roles.CODENAMES);
  ok(new Set(codes).size === codes.length, 'codenames are unique — two agents cannot both be FORGE');
  for (const r of Object.keys(roles.ROLES)) ok(roles.CODENAMES[r], `${r} has a codename (the FLEET tab, drones and the DAG all label by it)`);
  // lib/drone.js grants tools via presetTools(role) → ROLE_TOOLS, so a drone with a role gets
  // exactly the same kit as the DAG agent of that role. Assert the coupling actually holds.
  const drone = require('../lib/drone');
  if (typeof drone.presetTools === 'function') {
    for (const r of Object.keys(roles.ROLE_TOOLS)) {
      assert.deepStrictEqual(drone.presetTools(r), roles.ROLE_TOOLS[r]);
      pass++;
    }
    ok(true, 'a drone spawned with a role gets the SAME kit as the DAG agent of that role');
  }
}

// ── the ensemble roles are adversarially distinct, not three phrasings of "answer it" ─────────
{
  const orch = require('../lib/orchestrator');
  const ens = orch.DEFAULT_ROLES || [];
  if (ens.length) {
    ok(ens.length >= 3, 'the ensemble fans out to at least three perspectives');
    ok(new Set(ens.map((r) => r.codename)).size === ens.length, 'ensemble codenames are unique');
    const personas = ens.map((r) => r.persona.toLowerCase());
    ok(personas.some((p) => /skeptic|red.?team|attack|failure mode/.test(p)),
      'one ensemble role is an adversary — a panel that only agrees is an expensive way to get one opinion');
    ok(personas.some((p) => /synthes|trade.?off|overall/.test(p)), 'one role synthesizes across the others');
    ok(personas.some((p) => /implement|solve|concrete/.test(p)), 'one role actually produces the answer');
  }
}

console.log(`✅ agent roles: ${pass} assertions passed`);
