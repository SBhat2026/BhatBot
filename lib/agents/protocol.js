'use strict';
// Agent communication protocol (Phase 3). Agents exchange typed JSON envelopes, never
// chat history. The orchestrator integrates a result by reading ONE summary line +
// applying structured state_updates — the agent's reasoning is discarded (context
// firewall). See ARCHITECTURE.md §3.
const State = require('../state');
const fs = require('fs');
const path = require('path');

const ROLES = ['orchestrator', 'coding', 'research', 'browser', 'memory', 'creative'];
// Trust ranks resolve conflicting facts: a role's claim about its own domain wins.
const TRUST = { coding: { code: 3, files: 3 }, research: { facts: 2 }, browser: { ui: 3, visual: 3 }, memory: { history: 3 }, creative: { artifact: 3 } };
const EXPECTS = ['patch', 'facts', 'report', 'artifact', 'answer'];
const STATUS = ['ok', 'partial', 'failed', 'needs_input'];

function buildTask({ id, agent, goal, context = {}, expects = 'answer', budget = {} }) {
  if (!ROLES.includes(agent)) throw new Error(`unknown agent role: ${agent}`);
  if (!EXPECTS.includes(expects)) throw new Error(`bad expects: ${expects}`);
  return {
    kind: 'task', id, agent, goal,
    context: { state: context.state || {}, memory: context.memory || [], files: context.files || [], constraints: context.constraints || [], components: context.components || null },
    expects,
    budget: { model: budget.model || 'auto', max_tokens: budget.max_tokens || 4000, max_usd: budget.max_usd ?? 0.05 },
  };
}

function validateTask(t) {
  const errs = [];
  if (t.kind !== 'task') errs.push('kind!=task');
  if (!ROLES.includes(t.agent)) errs.push('bad agent');
  if (!t.goal) errs.push('missing goal');
  return { ok: !errs.length, errs };
}

function buildResult({ task_id, agent, status = 'ok', summary = '', state_updates = [], artifacts = [], memory_writes = [], decision = null, next = [], cost = {}, confidence = 1 }) {
  if (!STATUS.includes(status)) throw new Error(`bad status: ${status}`);
  return { kind: 'result', task_id, agent, status, summary, state_updates, artifacts, memory_writes, decision, next, confidence, cost: { model: cost.model || null, tokens: cost.tokens || 0, usd: cost.usd || 0 } };
}

// Tolerant parse: agents may wrap JSON in prose/fences. Extract the result object.
function parseResult(raw, fallback = {}) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '');
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  // Couldn't parse structured output → wrap the prose as a low-confidence answer.
  return buildResult({ task_id: fallback.task_id, agent: fallback.agent, status: 'partial', summary: text.slice(0, 200), confidence: 0.4 });
}

// Orchestrator integration: apply structured deltas to disk. Returns what to keep in RAM.
function applyResult(wsDir, result) {
  const s = State.open(wsDir);
  if (result.state_updates && result.state_updates.length) s.applyUpdates(result.state_updates);
  if (result.cost && result.cost.usd) s.addCost(result.cost.usd);
  if (result.decision) appendDecision(wsDir, result);
  // memory_writes are handed to lib/memory.js by the caller (kept out of this module's deps)
  return { keep: result.summary, version: s.version() };
}

function appendDecision(wsDir, result) {
  const file = path.join(wsDir, 'decisions.json');
  let doc; try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { doc = { decisions: [] }; }
  const id = 'dec_' + String((doc.decisions.length || 0) + 1).padStart(4, '0');
  doc.decisions.push({ id, ts: new Date().toISOString(), by: result.agent, task: result.task_id, ...result.decision });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return id;
}

module.exports = { ROLES, TRUST, EXPECTS, STATUS, buildTask, validateTask, buildResult, parseResult, applyResult, appendDecision };
