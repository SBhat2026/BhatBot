'use strict';
// ── SHARED BLACKBOARD (FORGE-sprint Phase 0 / T5) ─────────────────────────────────────────────────
// The one genuine coordination gap: fleet agents (orchestrator tasks, persistent subagents, drones)
// run BLIND to each other during a parallel batch — coordination only happened at integration time.
// costBlock() already proves per-turn injected context works; this is the sibling-state equivalent.
//
// A blackboard is a per-workspace, append-only ledger of short posts that every agent on the same
// goal can read. It is the substrate for cross-agent relay, soft resource claims (avoid two agents
// editing one file), heartbeats, and the drone fleet's liveness signal.
//
// DECISION — JSONL + in-memory tail cache (not SQLite, not an EventEmitter bus):
//   • append-only JSONL is crash-safe, human-inspectable, and needs zero schema/daemon — matches the
//     codebase's audit.log / router.jsonl / events.jsonl convention exactly.
//   • an in-memory tail cache makes read()/fleetStatusBlock() O(1) on the hot path (injected into
//     EVERY agent call) without re-reading the file; the file is the durable truth for cold restart.
//   • it is deliberately NOT an event bus: agents PULL sibling state when they act (bounded, cheap),
//     they are not pushed mid-await — that keeps context injection predictable and token-bounded.
//
// Pure + DI ({ dir }); no Electron/network. Testable headless.
const fs = require('fs');
const path = require('path');

const KINDS = ['status', 'finding', 'claim', 'need', 'heartbeat'];
const TEXT_CAP = 280;              // one post ≤ 280 chars — a blackboard note, not a document
const TAIL_MAX = 200;             // in-RAM cache depth; older truth stays only on disk

function createBlackboard({ dir } = {}) {
  if (!dir) throw new Error('blackboard: dir required');
  const file = path.join(dir, 'blackboard.jsonl');
  let tail = [];                  // most-recent-last, capped at TAIL_MAX
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      tail = lines.slice(-TAIL_MAX).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { tail = []; }
  }

  // post — append one entry. Returns the normalized, persisted entry. Bad kinds coerce to 'status'
  // (never throw on the hot path — a mis-tagged post must not sink an agent turn).
  function post(entry = {}) {
    ensureLoaded();
    const e = {
      ts: entry.ts || new Date().toISOString(),
      agent: String(entry.agent || 'unknown').slice(0, 60),
      taskId: entry.taskId != null ? String(entry.taskId).slice(0, 60) : null,
      kind: KINDS.includes(entry.kind) ? entry.kind : 'status',
      text: String(entry.text == null ? '' : entry.text).replace(/\s+/g, ' ').trim().slice(0, TEXT_CAP),
      resource: entry.resource ? String(entry.resource).slice(0, 200) : undefined,
    };
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(file, JSON.stringify(e) + '\n'); } catch {}
    tail.push(e);
    if (tail.length > TAIL_MAX) tail = tail.slice(-TAIL_MAX);
    return e;
  }

  // read — recent entries, optionally since a timestamp / of a kind. Newest last.
  function read({ sinceTs, kind, limit = 20 } = {}) {
    ensureLoaded();
    let rows = tail;
    if (sinceTs) { const t = new Date(sinceTs).getTime() || 0; rows = rows.filter((r) => new Date(r.ts).getTime() > t); }
    if (kind) rows = rows.filter((r) => r.kind === kind);
    return rows.slice(-Math.max(1, limit));
  }

  // fleetStatusBlock — the compact string injected into every sibling agent's context: one line per
  // ACTIVE agent's LATEST status + the last few findings/claims/needs. Bounded so it never balloons
  // the prompt. `activeAgents` (optional) restricts the status roster to agents believed live.
  function fleetStatusBlock({ activeAgents = null, maxFindings = 5 } = {}) {
    ensureLoaded();
    if (!tail.length) return '';
    const latestStatus = new Map();          // agent → latest status/heartbeat text
    for (const e of tail) {
      if (e.kind === 'status' || e.kind === 'heartbeat') {
        if (activeAgents && !activeAgents.includes(e.agent)) continue;
        latestStatus.set(e.agent, e);
      }
    }
    const findings = tail.filter((e) => e.kind === 'finding' || e.kind === 'claim' || e.kind === 'need').slice(-maxFindings);
    const lines = ['[FLEET BLACKBOARD — what your siblings are doing right now]'];
    for (const [agent, e] of latestStatus) lines.push(`• ${agent}: ${e.text || '(working)'}`);
    if (findings.length) {
      lines.push('recent findings/claims:');
      for (const f of findings) lines.push(`  - [${f.kind}] ${f.agent}: ${f.text}`);
    }
    return lines.join('\n');
  }

  // claim / isClaimed — SOFT coordination (not a lock). claim posts a 'claim' entry; isClaimed checks
  // whether any recent claim (within the tail, or since a cutoff) names the resource and isn't released.
  function claim(resource, agent, taskId) { return post({ agent, taskId, kind: 'claim', text: `claiming ${resource}`, resource }); }
  function isClaimed(resource, { byOther = null } = {}) {
    ensureLoaded();
    for (let i = tail.length - 1; i >= 0; i--) {
      const e = tail[i];
      if (e.kind === 'claim' && e.resource === resource) return byOther ? e.agent !== byOther : true;
    }
    return false;
  }

  // heartbeat — a liveness ping the fleet supervisor reads to detect stalls. lastPost(agent) → entry.
  function heartbeat(agent, taskId, text) { return post({ agent, taskId, kind: 'heartbeat', text: text || 'alive' }); }
  function lastPost(agent) { ensureLoaded(); for (let i = tail.length - 1; i >= 0; i--) if (tail[i].agent === agent) return tail[i]; return null; }

  function all() { ensureLoaded(); return tail.slice(); }

  return { post, read, fleetStatusBlock, claim, isClaimed, heartbeat, lastPost, all, file, KINDS, TEXT_CAP };
}

module.exports = { createBlackboard, KINDS, TEXT_CAP };
