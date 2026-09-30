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
// ── THE PLAN IS A GRAPH NOW, AND STILL A DOCUMENT ────────────────────────────────────────────────
//
// An item may carry an `id`, the ids it `needs`, and a `role`. They ride in a leading parenthetical:
//
//     - [ ] (t3 ← t1,t2 · coding) Rebuild the figure pipeline  — FORGE
//     - [x] (t1 · research) Pull the last 40 PubMed hits
//     - [ ] An item with no parenthetical is exactly what it has always been
//
// Two decisions about where the metadata lives, both load-bearing:
//
// NOT IN THE NOTE. lib/supervisor.js greps notes for escalation ids in three places; putting
// structure there would collide with all three, and the note is the one field a human edits freely.
//
// ANCHORED ON `t<digits>`, not on "a parenthetical". An item legitimately reading
// `(optional) reconcile the ledger` must not have "optional" read as its id — and it cannot, because
// `optional` is not `t\d+`. Legacy plans and hand-written lines survive by construction rather than
// by luck, which is the only way a format change to a file people edit is safe.
const DAG_RE = /^\(\s*(t\d+)\s*(?:←\s*([a-z0-9_,\s]+?)\s*)?(?:·\s*([a-z_]+)\s*)?\)\s*/i;

function renderPlan(items) {
  return items.map((it) => {
    const head = it.id
      ? `(${it.id}${(it.needs || []).length ? ` ← ${(it.needs || []).join(',')}` : ''}${it.role ? ` · ${it.role}` : ''}) `
      : '';
    return `- [${PLAN_MARK[it.status] || ' '}] ${head}${it.text}${it.note ? `  — ${it.note}` : ''}`;
  }).join('\n') + '\n';
}
function parsePlan(text) {
  return String(text || '').split('\n').map((line) => {
    const m = /^\s*-\s*\[(.)\]\s*(.*)$/.exec(line);
    if (!m) return null;
    let rest = m[2];
    let id = '', needs = [], role = '';
    const d = DAG_RE.exec(rest);
    if (d) {
      id = d[1];
      needs = d[2] ? d[2].split(',').map((x) => x.trim()).filter(Boolean) : [];
      role = d[3] || '';
      rest = rest.slice(d[0].length);
    }
    // lastIndexOf, not indexOf. The renderer always appends the note LAST, so the final separator is
    // the real one — while the first might be inside the item's own text. An item reading
    // "check the  —  separator handling" lost half of itself into its note under indexOf, which is a
    // silent corruption of the one field a human wrote.
    const sep = rest.lastIndexOf('  — ');
    return {
      status: MARK_PLAN[m[1] === 'X' ? 'x' : m[1]] || 'todo',
      id, needs, role,
      text: (sep >= 0 ? rest.slice(0, sep) : rest).trim(),
      note: sep >= 0 ? rest.slice(sep + 4).trim() : '',
    };
  }).filter((x) => x && x.text);
}

/**
 * cycleOf(nodes) → the id that closes a cycle, or null.
 *
 * Three-colour DFS, the same shape lib/planner.js uses on its own step list. It lives here too rather
 * than being imported from there because planner.validate() does far more than check for cycles — it
 * slices to HARD_MAX_STEPS *before* building its id set and renames the fields on the way through, so
 * calling it on a 40-item mission plan would drop 32 items and silently orphan every edge into them.
 * A cycle check is twelve lines; importing a coercing sanitiser to get one is the wrong trade.
 */
function cycleOf(nodes) {
  const byId = new Map((nodes || []).filter((n) => n && n.id).map((n) => [n.id, n]));
  const colour = new Map();
  let found = null;
  const walk = (id) => {
    if (found) return;
    const c = colour.get(id);
    if (c === 2) return;
    if (c === 1) { found = id; return; }
    colour.set(id, 1);
    for (const d of (byId.get(id) || {}).needs || []) if (byId.has(d)) walk(d);
    colour.set(id, 2);
  };
  for (const id of byId.keys()) { walk(id); if (found) break; }
  return found;
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
function createMissions({ dir, now = () => Date.now(), log = () => {}, journalMaxBytes = JOURNAL_MAX_BYTES } = {}) {
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
  /**
   * Reads the journal ACROSS a rotation. Keeping a `.1` generation and then reading only the live file
   * would make the rotation a more elaborate way of losing the same data: `replay()` would still miss
   * every step before the roll and re-run work already done.
   */
  function readJournal(id, n = Infinity) {
    let raw = '';
    try { raw = fs.readFileSync(pathFor(id, 'journal.jsonl'), 'utf8'); } catch { return []; }
    // Only pay for the previous generation when the caller actually wants more than the live file has.
    let lines = raw.split('\n').filter(Boolean);
    if (n === Infinity || lines.length < n) {
      let old = '';
      try { old = fs.readFileSync(pathFor(id, 'journal.jsonl') + '.1', 'utf8'); } catch {}
      if (old) lines = old.split('\n').filter(Boolean).concat(lines);
    }
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
    // seq is the HIGHEST seq on record, not the number of rows. Counting rows is what let it drift past
    // the file when the journal was wiped, and a rotation marker or a torn line would each shift a
    // count by one while leaving identities intact. Identity is the thing seq is for.
    //
    // COMPUTED LAZILY, on the first step() and not on attach(). Establishing it eagerly parses the
    // WHOLE journal, and attach() is called far more often than step(): main.js re-attaches on every
    // progress event just to read the plan — 973 times in the 62-minute baseline — so an hour-long run
    // was parsing something like a million journal rows in the Electron main process, on the UI path,
    // to answer a question almost none of those callers asked. Rotation made it worse by adding the
    // previous generation to every one of those parses.
    let _seq = null;
    const peekSeq = () => {
      if (_seq === null) _seq = readJournal(id).reduce((mx, r) => Math.max(mx, Math.floor(Number(r && r.seq) || 0)), 0);
      return _seq;
    };
    const nextSeq = () => { peekSeq(); return ++_seq; };

    const api = {
      id,
      get meta() { return readMeta(id); },
      dir: path.join(base, id),

      // --- journal ---
      step({ name, input, result, tokensIn, tokensOut, ms, spanId, status } = {}) {
        try {
          fs.mkdirSync(path.join(base, id), { recursive: true });
          // ROTATE, DO NOT WIPE. This used to be `writeFileSync(jfile, '')`: at the bound, the entire
          // audit trail and the replay() cache vanished mid-run while `seq` kept counting past a
          // now-empty file, so the journal claimed rows 400+ in a file that started at 1. On a
          // four-hour run that is the difference between "here is what happened" and a blank page,
          // and it lands silently, in the middle, with no event to say so. One soak produced 591 rows
          // in half an hour from three livelocked items, so the bound is reachable.
          //
          // The rotation keeps ONE previous generation (.1) — enough to reconstruct the run across a
          // roll, bounded at 2× JOURNAL_MAX_BYTES on disk — and leaves `seq` monotonic, because seq is
          // an identity and not a row offset. An event is emitted through the journal itself, as the
          // first row of the new file, since that is the one place a later reader is guaranteed to look.
          try {
            if (fs.statSync(jfile).size > journalMaxBytes) {
              const prev = jfile + '.1';
              try { fs.rmSync(prev, { force: true }); } catch {}
              fs.renameSync(jfile, prev);
              fs.appendFileSync(jfile, JSON.stringify({
                // Resolved here, not left at 0: the rotation marker is written BEFORE the row that
                // triggered it, so an unresolved seq would file the marker at 0.5 and put it ahead of
                // every row in the old generation instead of between the two.
                seq: peekSeq() + 0.5, ts: now(), name: 'journal:rotated',
                head: `journal passed ${journalMaxBytes} bytes; previous generation kept at ${path.basename(prev)}`,
                status: 'ok',
              }) + '\n');
            }
          } catch {}
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
            seq: nextSeq(), ts: now(), name: String(name || ''),
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
          // CARRY THE GRAPH. This used to normalise to exactly {text, status, note} and drop id,
          // needs and role on the floor — and lib/supervisor.js calls it on every batch of work an
          // agent discovers, so the first `newItems` would have erased every edge in the plan.
          const norm = (items || []).map((it) => (typeof it === 'string'
            ? { text: it, status: 'todo', note: '', id: '', needs: [], role: '' }
            : {
              text: String(it.text || ''),
              status: PLAN_STATUSES.includes(it.status) ? it.status : 'todo',
              note: String(it.note || ''),
              id: String(it.id || ''),
              needs: Array.isArray(it.needs) ? it.needs.map(String).filter(Boolean) : [],
              role: String(it.role || ''),
            }
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
        const r = patchMeta(id, { status: 'parked', parkedAt: now(), lastError: String(reason || '').slice(0, 400) });
        // Parking means "I have stopped; somebody may pick this up", so the lease goes back. Holding
        // it across a park is what would make a mission durable in name and unresumable in fact.
        releaseLease(id);
        return r;
      },
      // UNPARK IS NOT A RESUME. A run that parks itself for ninety seconds while it waits for an
      // answer, then carries on, is the SAME attempt — but `resume()` bumps resumeCount, which is the
      // durable circuit breaker that decides how many times a long job may be picked back up. Two
      // internal waits would therefore spend a tenth of the chaining allowance on nothing, and a run
      // that waits often would quietly run out of permission to continue. The counter is for attempts
      // that failed or were cut short, not for a pause the run made on purpose.
      // The lease is deliberately RE-TAKEN rather than assumed: park() handed it back, and in the
      // window between the two another process may legitimately have started this mission. Carrying
      // on without checking is the exact double-run the lease exists to prevent.
      unpark() {
        if (!acquireLease(id)) { log(`[mission] ${id}: unpark refused, another process took it`); return null; }
        return patchMeta(id, { status: 'running', heartbeatAt: now(), parkedAt: null });
      },
      close(status = 'done', note) {
        if (!STATUSES.includes(status)) status = 'done';
        const r = patchMeta(id, { status, endedAt: now(), lastError: note ? String(note).slice(0, 400) : (readMeta(id) || {}).lastError });
        releaseLease(id);
        return r;
      },
      abandon(reason) {
        const r = patchMeta(id, { status: 'abandoned', endedAt: now(), lastError: String(reason || '').slice(0, 400) });
        releaseLease(id);
        return r;
      },
      /** Who holds this mission right now, for diagnosis — `null` means nobody. */
      lease() { return readLease(id); },
      discard() { try { fs.rmSync(path.join(base, id), { recursive: true, force: true }); return true; } catch { return false; } },
    };
    return api;
  }

  // ── top-level API ──────────────────────────────────────────────────────────────────────────────
  function open({ goal, traceId, budgetUsd, plan, kind } = {}) {
    const id = genId();
    const t = now();
    writeMeta(id, {
      id, goal: String(goal || ''), status: 'running',
      // WHO SHOULD PICK THIS UP. A mission parked by the supervisor has a plan, a roster and a width;
      // handing it to a single-threaded agent turn on resume would quietly change the execution model
      // out from under it — one agent trying to do forty items in one turn, with no escalation routing
      // and no forge. The auto-resume tick reads this to route it back where it came from.
      kind: kind || 'turn',
      stepsUsed: 0, spendUsd: 0, resumeCount: 0,
      budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : null,
      traceId: traceId || null, lastError: '',
      createdAt: t, updatedAt: t, heartbeatAt: t, parkedAt: null, endedAt: null,
    });
    // A brand-new mission is ours from the first instant. The id is freshly minted so this cannot
    // contend, but taking it here means "running" and "leased" are never out of step — and it is the
    // release on park/close that makes the pair mean anything.
    acquireLease(id);
    const h = handle(id);
    if (plan && plan.length) h.plan.set(plan);
    log('[mission] opened ' + id);
    return h;
  }

  function attach(id) { return readMeta(id) ? handle(id) : null; }

  // Mark a parked mission as running again and bump the durable resume counter. The counter is the
  // circuit breaker — it MUST live on disk, or a crash-loop resets it and the mission runs forever.
  // ── the lease ───────────────────────────────────────────────────────────────────────────────────
  //
  // TWO PROCESSES CAN RESUME THE SAME MISSION. The Electron main process and the headless
  // synapse-worker both hold a missions handle over the same directory, and `/waiting on/` is on the
  // auto-resume allowlist with a 5-second backoff — so a mission parked for its five-MINUTE idle wait
  // is "due" after five seconds. Today the only thing preventing a double resume is a module-scope
  // variable, which is per-process and therefore not a guard at all. Two loops on one plan.md
  // interleave their marks and each refunds the other's attempts.
  //
  // `openSync(..., 'wx')` is the primitive: it creates the file or fails, atomically, and unlike a
  // read-then-write it cannot be interleaved. A lease is stolen only when its holder has stopped
  // heartbeating, because the alternative — waiting forever on a crashed process — is how a mission
  // becomes unresumable.
  const LEASE_STALE_MS = 5 * 60 * 1000;
  const leaseFile = (id) => pathFor(id, 'lease.json');

  function readLease(id) { return readJson(leaseFile(id), null); }

  /** Try to take the lease. Returns true if we hold it afterwards, false if somebody live holds it. */
  function acquireLease(id) {
    fs.mkdirSync(path.join(base, id), { recursive: true });
    const mine = { pid: process.pid, at: now(), host: os.hostname() };
    try {
      const fd = fs.openSync(leaseFile(id), 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(mine)); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      if (e && e.code !== 'EEXIST') return false;
    }
    // Somebody holds it. Ours already? Then this is a re-entrant resume in the same process.
    const held = readLease(id);
    if (held && held.pid === process.pid) { writeAtomic(leaseFile(id), JSON.stringify(mine)); return true; }
    // ON THIS HOST, PID LIVENESS IS AUTHORITATIVE, and it decides both ways. `process.kill(pid, 0)`
    // asks the kernel directly, which beats a heartbeat in both directions: a live process that is
    // simply busy keeps its lease, and a dead one loses it at once. Falling through to the staleness
    // check after proving the holder is dead is what made the first version of this refuse forever —
    // the mission's own heartbeatAt is fresh, because the process that wrote it died a moment ago.
    if (held && held.host === os.hostname() && held.pid) {
      let alive = true;
      try { process.kill(held.pid, 0); } catch (e) { alive = (e && e.code === 'EPERM'); }   // EPERM = alive, not ours
      if (alive) return false;
      writeAtomic(leaseFile(id), JSON.stringify({ ...mine, stolenFrom: held }));
      return true;
    }
    // Another machine, or a lease with no host: staleness is all that can be known from here.
    const m = readMeta(id);
    const beat = Math.max(Number(held && held.at) || 0, Number(m && m.heartbeatAt) || 0);
    if (now() - beat < LEASE_STALE_MS) return false;
    writeAtomic(leaseFile(id), JSON.stringify({ ...mine, stolenFrom: held || null }));
    return true;
  }

  function releaseLease(id) {
    const held = readLease(id);
    if (held && held.pid !== process.pid) return false;   // never drop somebody else's lease
    try { fs.rmSync(leaseFile(id), { force: true }); } catch {}
    return true;
  }

  function resume(id) {
    const m = readMeta(id);
    if (!m) return null;
    // REFUSING IS THE POINT. Both call sites already treat null as "not mine to run", so a contended
    // mission is simply left to whoever holds it rather than being run twice.
    if (!acquireLease(id)) { log(`[mission] ${id}: resume refused, lease held by pid ${(readLease(id) || {}).pid}`); return null; }
    patchMeta(id, { status: 'running', resumeCount: (m.resumeCount || 0) + 1, heartbeatAt: now(), parkedAt: null, ownerPid: process.pid });
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
      // The dead process cannot hand its lease back, so the reaper does it. Without this the mission
      // is parked, due, and permanently refused — visible in the list and impossible to run.
      try { fs.rmSync(leaseFile(m.id), { force: true }); } catch {}
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
      // THE MISSION'S OWN CEILING WINS, when it declared one.
      //
      // `maxSpendUsd` is a global safety net, default $5. But hours are chained by parking on the wall
      // clock and resuming, so a run opened with budgetUsd $12 would be retired at roughly hop two and
      // told "spend limit ($5)" — a limit nobody chose for it, reported as an expiry rather than as
      // the budget it was actually given. A declared budget is the real ceiling; the global value is
      // the floor for anything that never stated one.
      const cap = Math.max(Number(m.budgetUsd) > 0 ? Number(m.budgetUsd) : 0, maxSpendUsd);
      if ((m.spendUsd || 0) >= cap) { expired.push({ id: m.id, reason: `spend limit ($${cap})` }); continue; }
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

  return { open, attach, resume, list, reapOrphans, dueForResume, prune, dir: base,
    acquireLease, releaseLease, readLease, LEASE_STALE_MS, STATUSES, PLAN_STATUSES };
}

module.exports = { createMissions, renderAnchor, renderPlan, parsePlan, cycleOf, digestResult, STATUSES, PLAN_STATUSES, JOURNAL_MAX_BYTES, REPLAY_MAX, DAG_RE };
