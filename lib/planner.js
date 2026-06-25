'use strict';
// B1 — Planner (the team's brain). Decomposes ONE high-level goal into the FEWEST parallelizable
// subtasks as a small task DAG, validates it (acyclic, bounded width/size — anti-rabbit-hole), and
// orders it into execution layers. Execution itself reuses the guardrailed fleet (lib/orchestrator),
// so BhatBot stays in control: it plans + dispatches, the agents do the legwork.
//
// Pure logic. Deps: { anthropicRequest, apiKey, models:{sonnet} }.
//   plan(goal, deps, opts) → { success, steps:[{id,role,task,tools?,dependsOn[]}], rationale }
//   layers(steps) → [[step,...], ...]   (topological; each inner array runs in parallel)

const HARD_MAX_STEPS = 8;     // never decompose into more than this many subtasks
const HARD_MAX_WIDTH = 6;     // never run more than this many at once (matches fleet cap)

function stripFences(s) {
  return String(s || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
}
function extractJson(text) {
  const t = stripFences(text);
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);     // first {...} block
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// Validate + sanitize a plan: unique ids, resolvable deps, no cycles, bounded size. Returns a
// cleaned step list or throws with a reason (caller falls back to a single step).
function validate(steps, maxSteps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('no steps');
  const cap = Math.min(maxSteps || HARD_MAX_STEPS, HARD_MAX_STEPS);
  const clean = steps.slice(0, cap).map((s, i) => ({
    id: String(s.id || ('s' + (i + 1))),
    role: String(s.role || ('step ' + (i + 1))).slice(0, 40),
    task: String(s.task || '').trim(),
    tools: Array.isArray(s.tools) && s.tools.length ? s.tools.map(String) : undefined,
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
  })).filter((s) => s.task);
  if (!clean.length) throw new Error('no valid tasks');
  const ids = new Set(clean.map((s) => s.id));
  // Drop dangling deps (and deps to dropped steps).
  for (const s of clean) s.dependsOn = s.dependsOn.filter((d) => ids.has(d) && d !== s.id);
  // Cycle check (DFS).
  const state = {};   // id → 0 unvisited / 1 in-stack / 2 done
  const byId = Object.fromEntries(clean.map((s) => [s.id, s]));
  const dfs = (id) => {
    if (state[id] === 1) throw new Error('dependency cycle at ' + id);
    if (state[id] === 2) return;
    state[id] = 1;
    for (const d of byId[id].dependsOn) dfs(d);
    state[id] = 2;
  };
  for (const s of clean) dfs(s.id);
  return clean;
}

// Topological layers (Kahn): each layer is a set of steps whose deps are all satisfied → run in
// parallel. Width is capped (excess spills to the next layer) so we never exceed HARD_MAX_WIDTH.
function layers(steps) {
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  const done = new Set();
  const out = [];
  let remaining = steps.slice();
  while (remaining.length) {
    let ready = remaining.filter((s) => s.dependsOn.every((d) => done.has(d) || !byId[d]));
    if (!ready.length) ready = remaining.slice();   // safety: broken deps → just run the rest
    const layer = ready.slice(0, HARD_MAX_WIDTH);
    out.push(layer);
    layer.forEach((s) => done.add(s.id));
    remaining = remaining.filter((s) => !done.has(s.id));
  }
  return out;
}

async function plan(goal, deps, opts = {}) {
  if (!goal) return { success: false, error: 'goal required' };
  const maxSteps = Math.min(opts.maxSteps || 6, HARD_MAX_STEPS);
  const maxWidth = Math.min(opts.maxParallel || 4, HARD_MAX_WIDTH);
  const sys = `You are BhatBot's PLANNER. Decompose the user's GOAL into the FEWEST subtasks that get it done, favoring tasks that can run IN PARALLEL. Add a dependency ONLY when a task genuinely needs another's output. Keep it tight — no busywork, no speculative tasks, no scope creep. At most ${maxSteps} subtasks total and ${maxWidth} running at once.
Each subtask: {"id":"s1","role":"short label","task":"one concrete, self-contained instruction","tools":["optional","tool","scope"],"dependsOn":["ids"]}.
Output ONLY JSON: {"steps":[...],"rationale":"one short line on the split"}. No prose, no fences.`;
  try {
    const resp = await deps.anthropicRequest({ model: deps.models.sonnet, max_tokens: 1500, system: sys,
      messages: [{ role: 'user', content: 'GOAL: ' + goal }] }, deps.apiKey);
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const parsed = extractJson(text);
    if (!parsed) throw new Error('planner did not return JSON');
    const steps = validate(parsed.steps, maxSteps);
    return { success: true, goal, steps, layers: layers(steps), rationale: String(parsed.rationale || '').slice(0, 300) };
  } catch (e) {
    // Fallback: one step = the whole goal (still runs, just not decomposed).
    const steps = [{ id: 's1', role: 'do it', task: goal, dependsOn: [] }];
    return { success: true, goal, steps, layers: [steps], rationale: 'planner fallback (single step): ' + (e && e.message || e), fallback: true };
  }
}

// Diagnose a FAILED step and produce a corrected, self-contained retry instruction + a severity
// rating, so execution can self-heal without the user. "serious" = likely needs human attention /
// risky / blocks the goal (caller alerts the user but keeps trying); "minor" = transient/fixable.
async function diagnose(step, errorText, deps) {
  const sys = `A subtask inside an automated plan FAILED. Diagnose the likely cause in one line and write a CORRECTED, self-contained instruction to retry it (fix what went wrong; do not just repeat it). Rate severity: "serious" = likely needs a human, is risky/irreversible, or blocks the whole goal; "minor" = transient or easily fixed. Output ONLY JSON: {"severity":"minor|serious","reason":"one line","fix":"corrected instruction"}. No prose, no fences.`;
  try {
    const resp = await deps.anthropicRequest({ model: deps.models.sonnet, max_tokens: 600, system: sys,
      messages: [{ role: 'user', content: `Task: ${step.task}\n\nFailure: ${String(errorText || '').slice(0, 1500)}` }] }, deps.apiKey);
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const j = extractJson(text) || {};
    return { severity: j.severity === 'serious' ? 'serious' : 'minor', reason: String(j.reason || 'unknown').slice(0, 200), fix: String(j.fix || step.task) };
  } catch (e) {
    return { severity: 'minor', reason: 'diagnosis unavailable (' + (e && e.message || e) + ')', fix: step.task };
  }
}

module.exports = { plan, layers, validate, diagnose, HARD_MAX_STEPS, HARD_MAX_WIDTH };
