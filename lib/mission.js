'use strict';
// ── MISSIONS — durable state for work that outlives one turn ──────────────────────────────────────
// A mission is a DURABLE SIDECAR to a normal agentLoop turn, not a replacement for it. agentLoop is
// still the only loop; it just gains a handle it can journal into, park, and pick back up.
//
// The problem this solves (all verified in main.js before this module existed):
//   • the original goal lives at the HEAD of history, and trimHistory summarizes the head first —
//     so the longer a run goes, the more surely it forgets what it was asked to do (goal drift);
//   • a rate-budget abort did `history = []`, throwing away hours of work over a pacing failure;
//   • hitting the step ceiling produced a summary and stopped, forever — no way to continue;
//   • nothing survived a crash or a quit: lib/jobs.js is an in-RAM Map.
//
// Design follows what the long-horizon literature converges on (Anthropic's long-running harnesses,
// LangGraph checkpointers, Temporal/Restate journals, Inngest step memoization) and what this repo
// already had lying around unwired:
//   • EXTERNALIZED GOAL — stored verbatim, re-injected after every trim. Never summarized.
//   • PLAN ARTIFACT — a durable todo list, so the agent can't re-plan in circles (the AutoGPT failure).
//   • STEP JOURNAL — append-only (name, argsHash, resultDigest), enabling memoized replay on resume.
//   • CHECKPOINT — reuses the shape lib/context.js already writes (open_tasks/recent_decisions/
//     next_actions), minus its lib/state.js coupling (a mission has no orchestrator workspace).
//   • DURABLE CIRCUIT BREAKERS — resumeCount/spendUsd/age live in mission.json, not RAM, so a restart
//     cannot reset them. This is the difference between "resumable" and "runaway".
//
// Pure + fs-backed + DI (no Electron), same contract as lib/brain.js / lib/blackboard.js — so it runs
// in the GUI, in a headless worker, and in tests. See scripts/test-mission.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { toolSig } = require('./pure');

const STATUSES = ['running', 'parked', 'done', 'failed', 'abandoned'];
const PLAN_STATUSES = ['todo', 'doing', 'done', 'blocked'];
const PLAN_MARK = { todo: ' ', doing: '~', done: 'x', blocked: '!' };
const MARK_PLAN = { ' ': 'todo', '~': 'doing', x: 'done', '!': 'blocked' };

const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;   // same bound lib/runtime-state.js puts on events.jsonl
const REPLAY_MAX = 200;                       // cached steps offered back on resume
const DIGEST_CHARS = 400;                     // how much of a tool result we keep verbatim

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

// Atomic write — a reader (bhatctl, the mission panel, another process) never sees a half-written file.
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// A tool result is journaled as a DIGEST, never the payload: the journal has to stay small enough to
// read back in full on resume, and some results are megabytes of page text or base64 image data.
function digestResult(result) {
  let s;
  try { s = typeof result === 'string' ? result : JSON.stringify(result); } catch { s = String(result); }
  s = s || '';
  return { head: s.slice(0, DIGEST_CHARS), sha: sha(s), bytes: s.length, truncated: s.length > DIGEST_CHARS };
}

// ── plan artifact (plan.md) ──────────────────────────────────────────────────────────────────────
// Markdown on purpose: the user can open it, and a model can read it without a schema. Round-trips
// through parse/render so a hand-edit survives.
function renderPlan(items) {
  return items.map((it, i) => `- [${PLAN_MARK[it.status] || ' '}] ${it.text}${it.note ? `  — ${it.note}` : ''}`).join('\n') + '\n';
}
function parsePlan(text) {
  return String(text || '').split('\n').map((line) => {
    const m = /^\s*-\s*\[(.)\]\s*(.*)$/.exec(line);
    if (!m) return null;
    const rest = m[2];
    const sep = rest.indexOf('  — ');
    return {
      status: MARK_PLAN[m[1] === 'X' ? 'x' : m[1]] || 'todo',
      text: (sep >= 0 ? rest.slice(0, sep) : rest).trim(),
      note: sep >= 0 ? rest.slice(sep + 4).trim() : '',
    };
  }).filter((x) => x && x.text);
}

// ── the anchor block ─────────────────────────────────────────────────────────────────────────────
// PURE so it unit-tests without touching the filesystem. This is the highest-leverage piece of the
// whole module: it is re-injected after every context trim, which is exactly when the model has just
// lost the original request. Deliberately bounded — an anchor that grows with the run would itself
// become the thing that blows the window.
function renderAnchor(state = {}) {
  const {
    goal = '', plan = [], recent = [], spendUsd, budgetUsd, step, maxSteps,
    resumed = false, resumeCount = 0, lastError = '',
  } = state;

  const open = plan.filter((p) => p.status !== 'done').slice(0, 10);
  const doneCount = plan.filter((p) => p.status === 'done').length;

  const lines = [];
  lines.push('[MISSION ANCHOR — re-read this; the original request may have been summarized out of context]');
  lines.push(`GOAL (verbatim as given): ${goal}`);
  if (plan.length) {
    lines.push(`PLAN (${doneCount}/${plan.length} done) — open items:`);
    for (const p of open) lines.push(`  [${PLAN_MARK[p.status] || ' '}] ${p.text}${p.note ? ` — ${p.note}` : ''}`);
    if (plan.length - doneCount > open.length) lines.push(`  …and ${plan.length - doneCount - open.length} more open`);
  }
  if (recent.length) {
    lines.push('DONE SO FAR (most recent last):');
    for (const r of recent.slice(-5)) lines.push(`  · ${r.name}${r.status === 'error' ? ' ✗' : ''} — ${String(r.head || '').replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  const budget = [];
  if (Number.isFinite(spendUsd)) budget.push(`spent $${Number(spendUsd).toFixed(2)}${Number.isFinite(budgetUsd) ? ` of $${Number(budgetUsd).toFixed(2)}` : ''}`);
  if (Number.isFinite(step)) budget.push(`step ${step}${Number.isFinite(maxSteps) ? ` of ${maxSteps}` : ''}`);
  if (budget.length) lines.push(`BUDGET: ${budget.join(' · ')}`);
  if (resumed) lines.push(`NOTE: this is a RESUMED run (attempt ${resumeCount + 1}). The previous attempt stopped because: ${lastError || 'unknown'}.`);
  lines.push('Continue toward the GOAL. Do not restate the plan; act on the next open item.');
  return lines.join('\n');
}

// ── the store ────────────────────────────────────────────────────────────────────────────────────
function createMissions({ dir, now = () => Date.now(), log = () => {} } = {}) {
  const base = dir || path.join(os.homedir(), '.bhatbot', 'missions');
  const pathFor = (id, f) => path.join(base, id, f);
  let _seq = 0;
  const genId = () => 'm_' + now().toString(36) + (++_seq).toString(36) + Math.random().toString(36).slice(2, 5);

  function readMeta(id) { return readJson(pathFor(id, 'mission.json'), null); }
  function writeMeta(id, meta) {
    fs.mkdirSync(path.join(base, id), { recursive: true });
    writeAtomic(pathFor(id, 'mission.json'), JSON.stringify(meta, null, 2));
    return meta;
  }
  function patchMeta(id, patch) {
    const m = readMeta(id);
    if (!m) return null;
    return writeMeta(id, { ...m, ...patch, updatedAt: now() });
  }

  // Journal rows are one-per-line JSON. A corrupt line (a torn append after a hard kill) is SKIPPED,
  // never thrown — same filter-nulls posture as lib/blackboard.js. Losing one step beats losing the run.
  function readJournal(id, n = Infinity) {
    let raw = '';
    try { raw = fs.readFileSync(pathFor(id, 'journal.jsonl'), 'utf8'); } catch { return []; }
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(Math.max(0, lines.length - n))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  function readPlanFile(id) { try { return parsePlan(fs.readFileSync(pathFor(id, 'plan.md'), 'utf8')); } catch { return []; } }
  function writePlanFile(id, items) {
    fs.mkdirSync(path.join(base, id), { recursive: true });
    writeAtomic(pathFor(id, 'plan.md'), renderPlan(items));
    return items;
  }

  // Build the live handle a caller (agentLoop) holds for the duration of a turn.
  function handle(id) {
    const jfile = pathFor(id, 'journal.jsonl');
    let seq = readJournal(id).length;

    const api = {
      id,
      get meta() { return readMeta(id); },
      dir: path.join(base, id),

      // --- journal ---
      step({ name, input, result, tokensIn, tokensOut, ms, spanId, status } = {}) {
        try {
          fs.mkdirSync(path.join(base, id), { recursive: true });
          // Bound the journal the same way runtime-state bounds events.jsonl. A 10-hour run would
          // otherwise produce an unreadable file — and an unreadable journal defeats resume.
          try { if (fs.statSync(jfile).size > JOURNAL_MAX_BYTES) fs.writeFileSync(jfile, ''); } catch {}
          // Heal a torn tail before appending. A hard kill mid-write leaves a partial line with no
          // trailing newline; without this, the NEXT append concatenates onto it and corrupts a good
          // row too — one lost step silently becomes two.
          try {
            const st = fs.statSync(jfile);
            if (st.size > 0) {
              const fd = fs.openSync(jfile, 'r');
              const buf = Buffer.alloc(1);
              fs.readSync(fd, buf, 0, 1, st.size - 1);
              fs.closeSync(fd);
              if (buf[0] !== 0x0a) fs.appendFileSync(jfile, '\n');
            }
          } catch {}
          const d = digestResult(result);
          const row = {
            seq: ++seq, ts: now(), name: String(name || ''),
            argsHash: toolSig(name, input),
            head: d.head, sha: d.sha, bytes: d.bytes,
            status: status || (result && result.success === false ? 'error' : 'ok'),
            tokensIn, tokensOut, ms, spanId,
          };
          fs.appendFileSync(jfile, JSON.stringify(row) + '\n');
          const m = readMeta(id);
          if (m) patchMeta(id, { stepsUsed: (m.stepsUsed || 0) + 1, heartbeatAt: now() });
          return row;
        } catch (e) { log('[mission] step failed: ' + e.message); return null; }
      },
      journal(n) { return readJournal(id, n); },

      // --- history ---
      saveHistory(history) {
        try {
          fs.mkdirSync(path.join(base, id), { recursive: true });
          writeAtomic(pathFor(id, 'history.json'), JSON.stringify(history || []));
          patchMeta(id, { heartbeatAt: now() });
          return true;
        } catch (e) { log('[mission] saveHistory failed: ' + e.message); return false; }
      },
      history() { return readJson(pathFor(id, 'history.json'), []); },

      // --- checkpoint (lib/context.js shape, minus its State coupling) ---
      checkpoint() {
        const m = readMeta(id) || {};
        const plan = readPlanFile(id);
        const cp = {
          ts: new Date(now()).toISOString(),
          version: m.stepsUsed || 0,
          state_digest: sha(JSON.stringify(plan) + '|' + (m.stepsUsed || 0)),
          open_tasks: plan.filter((p) => p.status !== 'done').map((p, i) => ({ id: 'p' + i, agent: 'bhatbot', goal: p.text, status: p.status })),
          recent_decisions: readJournal(id, 5).map((r) => r.name),
          next_actions: plan.filter((p) => p.status === 'todo' || p.status === 'doing').slice(0, 5).map((p) => p.text),
        };
        try { writeAtomic(pathFor(id, 'checkpoint.json'), JSON.stringify(cp, null, 2)); } catch {}
        return cp;
      },

      // --- plan ---
      plan: {
        read: () => readPlanFile(id),
        set(items) {
          const norm = (items || []).map((it) => (typeof it === 'string'
            ? { text: it, status: 'todo', note: '' }
            : { text: String(it.text || ''), status: PLAN_STATUSES.includes(it.status) ? it.status : 'todo', note: String(it.note || '') }
          )).filter((it) => it.text);
          return writePlanFile(id, norm);
        },
        mark(index, status, note) {
          const items = readPlanFile(id);
          const i = Number(index);
          if (!items[i] || !PLAN_STATUSES.includes(status)) return null;
          items[i] = { ...items[i], status, note: note != null ? String(note) : items[i].note };
          writePlanFile(id, items);
          return items[i];
        },
        digest() {
          const items = readPlanFile(id);
          const done = items.filter((p) => p.status === 'done').length;
          return { total: items.length, done, open: items.filter((p) => p.status !== 'done') };
        },
      },

      // --- the anchor ---
      anchor(extra = {}) {
        const m = readMeta(id) || {};
        return renderAnchor({
          goal: m.goal,
          plan: readPlanFile(id),
          recent: readJournal(id, 5),
          spendUsd: m.spendUsd, budgetUsd: m.budgetUsd,
          step: m.stepsUsed, resumeCount: m.resumeCount || 0,
          lastError: m.lastError,
          ...extra,
        });
      },
      anchorResume(extra = {}) { return api.anchor({ resumed: true, ...extra }); },

      // --- memoized replay ---
      // On resume, a step whose (tool, args) signature already succeeded can return its cached digest
      // instead of re-running. Gated by the CALLER to read-only tools (main.js PARALLEL_SAFE) — this
      // module deliberately does not decide what is safe to skip, because that list lives with the
      // tools. The cache is invalidated wholesale at the first divergence: once the agent does
      // something new, the remaining prefix is no longer a faithful replay of the same run.
      replay() {
        const rows = readJournal(id).filter((r) => r.status === 'ok');
        const map = new Map();
        for (const r of rows.slice(-REPLAY_MAX)) map.set(r.argsHash, r);
        let live = true;
        return {
          size: map.size,
          get(name, input) { return live ? map.get(toolSig(name, input)) || null : null; },
          diverge() { live = false; map.clear(); },
          get active() { return live; },
        };
      },

      // --- lifecycle ---
      spend(usd) {
        const m = readMeta(id);
        if (!m) return null;
        return patchMeta(id, { spendUsd: +((m.spendUsd || 0) + (Number(usd) || 0)).toFixed(6) });
      },
      heartbeat() { return patchMeta(id, { heartbeatAt: now() }); },
      park(reason, history) {
        if (history) api.saveHistory(history);
        api.checkpoint();
        return patchMeta(id, { status: 'parked', parkedAt: now(), lastError: String(reason || '').slice(0, 400) });
      },
      close(status = 'done', note) {
        if (!STATUSES.includes(status)) status = 'done';
        return patchMeta(id, { status, endedAt: now(), lastError: note ? String(note).slice(0, 400) : (readMeta(id) || {}).lastError });
      },
      abandon(reason) { return patchMeta(id, { status: 'abandoned', endedAt: now(), lastError: String(reason || '').slice(0, 400) }); },
      discard() { try { fs.rmSync(path.join(base, id), { recursive: true, force: true }); return true; } catch { return false; } },
    };
    return api;
  }

  // ── top-level API ──────────────────────────────────────────────────────────────────────────────
  function open({ goal, traceId, budgetUsd, plan } = {}) {
    const id = genId();
    const t = now();
    writeMeta(id, {
      id, goal: String(goal || ''), status: 'running',
      stepsUsed: 0, spendUsd: 0, resumeCount: 0,
      budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : null,
      traceId: traceId || null, lastError: '',
      createdAt: t, updatedAt: t, heartbeatAt: t, parkedAt: null, endedAt: null,
    });
    const h = handle(id);
    if (plan && plan.length) h.plan.set(plan);
    log('[mission] opened ' + id);
    return h;
  }

  function attach(id) { return readMeta(id) ? handle(id) : null; }

  // Mark a parked mission as running again and bump the durable resume counter. The counter is the
  // circuit breaker — it MUST live on disk, or a crash-loop resets it and the mission runs forever.
  function resume(id) {
    const m = readMeta(id);
    if (!m) return null;
    patchMeta(id, { status: 'running', resumeCount: (m.resumeCount || 0) + 1, heartbeatAt: now(), parkedAt: null });
    return handle(id);
  }

  function list({ status } = {}) {
    let ids = [];
    try { ids = fs.readdirSync(base).filter((d) => { try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; } }); } catch { return []; }
    return ids.map(readMeta).filter(Boolean)
      .filter((m) => !status || m.status === status)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // Crash recovery. Anything still marked `running` whose heartbeat has gone stale belongs to a
  // process that died — nothing else can leave a mission in that state. Park it so the normal resume
  // path picks it up. This is the piece that makes a mission survive a quit, a crash, or a reboot.
  function reapOrphans({ staleMs = 5 * 60 * 1000 } = {}) {
    const reaped = [];
    for (const m of list({ status: 'running' })) {
      if (now() - (m.heartbeatAt || m.updatedAt || 0) < staleMs) continue;
      patchMeta(m.id, { status: 'parked', parkedAt: now(), lastError: 'process died (stale heartbeat)' });
      reaped.push(m.id);
    }
    if (reaped.length) log('[mission] reaped ' + reaped.length + ' orphan(s): ' + reaped.join(', '));
    return reaped;
  }

  // Which parked missions are eligible to resume RIGHT NOW. Pure policy, no side effects, so the
  // caller's tick stays trivial and this stays testable. Every limit is read off mission.json.
  function dueForResume({
    maxResumes = 20, maxSpendUsd = 5, maxAgeHours = 24,
    rateBackoffMs = 90000,        // a full OTPM window; waitForBudget already sleeps up to ~60s
    defaultBackoffMs = 5000,
  } = {}) {
    const t = now();
    const ready = [], expired = [];
    for (const m of list({ status: 'parked' })) {
      const ageH = (t - (m.createdAt || t)) / 3600000;
      if ((m.resumeCount || 0) >= maxResumes) { expired.push({ id: m.id, reason: `resume limit (${maxResumes})` }); continue; }
      if ((m.spendUsd || 0) >= maxSpendUsd) { expired.push({ id: m.id, reason: `spend limit ($${maxSpendUsd})` }); continue; }
      if (ageH >= maxAgeHours) { expired.push({ id: m.id, reason: `age limit (${maxAgeHours}h)` }); continue; }
      const backoff = /rate-budget/i.test(m.lastError || '') ? rateBackoffMs : defaultBackoffMs;
      if (t - (m.parkedAt || 0) < backoff) continue;   // still cooling down
      ready.push(m);
    }
    return { ready, expired };
  }

  function prune({ maxAgeDays = 14, keepActive = true } = {}) {
    const cutoff = now() - maxAgeDays * 86400000;
    const removed = [];
    for (const m of list()) {
      if (keepActive && (m.status === 'running' || m.status === 'parked')) continue;
      if ((m.endedAt || m.updatedAt || 0) > cutoff) continue;
      try { fs.rmSync(path.join(base, m.id), { recursive: true, force: true }); removed.push(m.id); } catch {}
    }
    return removed;
  }

  return { open, attach, resume, list, reapOrphans, dueForResume, prune, dir: base, STATUSES, PLAN_STATUSES };
}

module.exports = { createMissions, renderAnchor, renderPlan, parsePlan, digestResult, STATUSES, PLAN_STATUSES, JOURNAL_MAX_BYTES, REPLAY_MAX };
