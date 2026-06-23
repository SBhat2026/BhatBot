'use strict';
// Agent-to-Agent (A2A) handoff envelope (W7). BhatBot's sub-agents (lib/subagents.js) hand work to
// each other today through ad-hoc task strings. This standardizes the handoff on a Google-A2A-shaped
// message so the architecture is future-proof: the SAME envelope that routes to an in-process
// sub-agent now can route to an EXTERNAL agent later (e.g. a research agent on Princeton's cluster)
// over HTTP, with no change to callers. We implement the envelope + a local adapter now; the network
// transport is a drop-in later (handoff() just gains a remote branch).
//
// Envelope (A2A "Task message" shape, trimmed to what we use):
//   { id, from, to, task, context, artifacts:[], status:'submitted'|'working'|'completed'|'failed',
//     result, ts, history:[{status,ts,note}] }
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const LOG_PATH = path.join(os.homedir(), '.bhatbot', 'a2a.jsonl');

function newId() { return 'a2a_' + crypto.randomBytes(6).toString('hex'); }

// makeEnvelope({from,to,task,context,artifacts}) → a normalized envelope in 'submitted' status.
function makeEnvelope({ from = 'main', to, task, context = '', artifacts = [] } = {}) {
  if (!to || !task) throw new Error('a2a: `to` and `task` are required');
  const ts = new Date().toISOString();
  return {
    id: newId(), from: String(from), to: String(to),
    task: String(task), context: String(context || ''),
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    status: 'submitted', result: null, ts,
    history: [{ status: 'submitted', ts, note: `handoff ${from}→${to}` }],
  };
}

function transition(env, status, note, extra = {}) {
  env.status = status;
  env.history.push({ status, ts: new Date().toISOString(), note: note || '' });
  Object.assign(env, extra);
  return env;
}

function record(env) { try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); fs.appendFileSync(LOG_PATH, JSON.stringify(env) + '\n'); } catch {} }

// Flatten task + context + artifacts into the single instruction string a sub-agent consumes.
function renderTask(env) {
  let s = env.task;
  if (env.context) s += `\n\nContext:\n${env.context}`;
  if (env.artifacts && env.artifacts.length) s += `\n\nArtifacts:\n` + env.artifacts.map((a) => `- ${typeof a === 'string' ? a : JSON.stringify(a)}`).join('\n');
  return s;
}

/**
 * handoff(envelope, deps) → Promise<envelope (completed|failed)>
 *   deps.run(to, taskString, opts) → { success, result?, error? }   (local adapter = subagents.run)
 *   deps.remote(envelope) → Promise<envelope>   (optional; used when `to` isn't a local agent)
 *   deps.localAgents: string[]   (names runnable locally; default: try local first)
 *   deps.onStatus(envelope)      (optional progress callback)
 */
async function handoff(env, deps = {}) {
  record(transition(env, 'working', `dispatch → ${env.to}`));
  if (deps.onStatus) try { deps.onStatus(env); } catch {}
  const isLocal = !deps.localAgents || deps.localAgents.includes(env.to);
  try {
    if (!isLocal && deps.remote) {
      const out = await deps.remote(env);
      record(out);
      return out;
    }
    if (typeof deps.run !== 'function') throw new Error('no local runner provided');
    const r = await deps.run(env.to, renderTask(env), deps.opts || {});
    if (r && r.success !== false) {
      transition(env, 'completed', 'done', { result: r.result != null ? r.result : r });
      env.artifacts = [...env.artifacts, { kind: 'result', from: env.to, value: env.result }];
    } else {
      transition(env, 'failed', (r && r.error) || 'failed');
    }
  } catch (e) {
    transition(env, 'failed', String(e && e.message ? e.message : e));
  }
  record(env);
  if (deps.onStatus) try { deps.onStatus(env); } catch {}
  return env;
}

// recent(n) — last n handoff envelopes (newest first), for inspection/diagnostics.
function recent(n = 20) {
  try {
    return fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

module.exports = { makeEnvelope, handoff, record, transition, renderTask, recent, LOG_PATH };
