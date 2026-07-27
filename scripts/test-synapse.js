#!/usr/bin/env node
'use strict';
// Tests for lib/synapse.js — the second brain's engine, lifted out of main.js so it can run headless.
// What these lock down, in priority order:
//   1. HYDRATE IS FREE. It must produce a graph with no embedder, no LLM, and no API key — because a
//      headless worker usually cannot decrypt the vault, and this pass is most of the value. The
//      original in-app worker's silent failure is the reason this module exists.
//   2. THE BUDGET CAP IS REAL. The $1 ledger is cumulative and persisted in graph meta; a restart must
//      not reset it, and an exhausted budget must stop paid work rather than merely slow it.
//   3. PRUNED LINKS STAY DEAD. A connection the user rejected must never be re-proposed.
//   4. SKIPS ARE REPORTED, never swallowed — a worker that quietly does nothing is the bug.
// Stubbed embedder/LLM + temp $HOME → no network, no cost. Wired into `npm run verify`.
//   node scripts/test-synapse.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-synapse-'));
const { createSynapse, scanRepos, readSemanticRecords, tok } = require('../lib/synapse');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// A deterministic 8-dim "embedding": two texts sharing a rare token land close together.
const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
const fakeVec = (t) => VOCAB.map((w) => (String(t).toLowerCase().includes(w) ? 1 : 0.01));

let embedCalls = 0, llmCalls = 0;
const embedBatch = async (texts) => { embedCalls++; return { vecs: texts.map(fakeVec) }; };
const llm = async ({ content }) => { llmCalls++; return /NONE-PLEASE/.test(content) ? 'NONE' : 'Both apply the same retrieval refit.'; };

// A tiny fake project set that will produce two genuinely-similar cross-project nodes.
const PROJECTS = [
  { slug: 'p-alpha', name: 'Alpha Engine', status: 'active' },
  { slug: 'p-beta', name: 'Beta Engine', status: 'active' },
];
const PROJECT_DATA = {
  'p-alpha': { slug: 'p-alpha', name: 'Alpha Engine', summary: 'alpha gamma retrieval refit', highlights: ['alpha gamma'] },
  'p-beta': { slug: 'p-beta', name: 'Beta Engine', summary: 'alpha gamma retrieval refit too', highlights: ['alpha gamma'] },
};

function mk(dirName, extra = {}) {
  return createSynapse({
    dir: path.join(TMP, dirName),
    deps: {
      listProjects: () => PROJECTS,
      getProject: (s) => PROJECT_DATA[s],
      loadConfig: () => ({ synapseBudgetUsd: 1 }),
      home: path.join(TMP, 'nohome'),      // no repos to scan by default
      log: () => {},
      ...extra,
    },
  });
}

(async () => {
  // ---- 1. hydrate is FREE and works with nothing injected ----
  {
    const s = mk('free');
    const r = await s.hydrate();
    ok(r.nodes >= 2, 'hydrate: builds a graph with NO embedder, NO llm, NO api key');
    ok(s.budget().spent === 0, 'hydrate: costs nothing');
    ok(embedCalls === 0 && llmCalls === 0, 'hydrate: makes no paid calls at all');
    ok(fs.existsSync(path.join(TMP, 'free', 'graph.json')), 'hydrate: persists the graph to disk');

    // Re-hydrating must UPDATE, never duplicate — the worker does this every 30 minutes forever.
    const before = s.stats().nodes;
    await s.hydrate();
    ok(s.stats().nodes === before, 'hydrate: is idempotent (deterministic ids → upsert, not duplicate)');
  }

  // ---- a broken source must not cost us the others ----
  {
    const s = mk('resilient', { listProjects: () => { throw new Error('projects exploded'); } });
    const r = await s.hydrate();
    ok(r && typeof r.nodes === 'number', 'hydrate: one failing source degrades instead of throwing');
    const s2 = mk('resilient2', { notionPages: async () => { throw new Error('notion 500'); } });
    const r2 = await s2.hydrate();
    ok(r2.nodes >= 2, 'hydrate: a failing Notion still leaves the project nodes imported');
  }

  // ---- 2. connect: embeds, proposes, rationalizes ----
  {
    embedCalls = 0; llmCalls = 0;
    const s = mk('connect', { embedBatch, llm });
    await s.hydrate();
    const r = await s.connect({ threshold: 0.5 });
    ok(embedCalls > 0, 'connect: embeds nodes that lack a vector');
    ok(r.proposed > 0, 'connect: proposes cross-project links');
    ok(r.rationalized > 0 && llmCalls > 0, 'connect: writes an LLM rationale for the strongest links');
    ok(s.budget().spent > 0, 'connect: charges the budget ledger');

    // 3. A pruned link must never come back — that is the whole promise of the curation UI.
    const edge = s.brain.edges()[0];
    s.prune('edge', edge.id);
    ok(s.brain.edges().find((e) => e.id === edge.id).status === 'pruned', 'prune: marks the edge pruned');
    const r2 = await s.connect({ threshold: 0.5 });
    const still = s.brain.edges().find((e) => e.id === edge.id);
    ok(still.status === 'pruned', 'connect: a PRUNED link is never re-proposed (rejection is permanent)');
    ok(r2.proposed === 0, 'connect: nothing new to propose on a second pass over the same graph');
  }

  // ---- a "NONE" verdict drops the edge instead of inventing a relationship ----
  {
    const s = mk('none', {
      embedBatch,
      llm: async () => 'NONE',
      getProject: (x) => PROJECT_DATA[x],
    });
    await s.hydrate();
    const r = await s.connect({ threshold: 0.5 });
    ok(r.rejected > 0, 'connect: a "NONE" rationale REJECTS the link (no fabricated relationships)');
    ok(r.proposed === 0, 'connect: rejected links are not counted as proposed');
  }

  // ---- 2b. the budget cap actually stops paid work ----
  {
    const s = createSynapse({
      dir: path.join(TMP, 'broke'),
      deps: {
        listProjects: () => PROJECTS, getProject: (x) => PROJECT_DATA[x],
        embedBatch, llm, log: () => {},
        home: path.join(TMP, 'nohome'),
        loadConfig: () => ({ synapseBudgetUsd: 0.0000001 }),   // effectively zero
      },
    });
    await s.hydrate();
    const before = embedCalls;
    const r = await s.connect({ threshold: 0.5 });
    ok(embedCalls === before + 1, 'budget: embedding stops after the first batch blows the cap');
    ok(s.budget().left === 0, 'budget: reports zero remaining');
    ok(r.rationalized === 0, 'budget: no rationales are bought once the cap is hit');
    const sug = await s.suggest();
    ok(sug.budgetExhausted === true, 'budget: suggest refuses and SAYS SO (never silently no-ops)');
  }

  // ---- the ledger is cumulative and survives a reload ----
  {
    const dir = path.join(TMP, 'ledger');
    const s1 = createSynapse({ dir, deps: { listProjects: () => PROJECTS, getProject: (x) => PROJECT_DATA[x], embedBatch, llm, home: path.join(TMP, 'nohome'), loadConfig: () => ({ synapseBudgetUsd: 1 }), log: () => {} } });
    await s1.hydrate();
    await s1.connect({ threshold: 0.5 });
    const spent = s1.budget().spent;
    ok(spent > 0, 'ledger: spend recorded');
    const s2 = createSynapse({ dir, deps: { listProjects: () => PROJECTS, getProject: (x) => PROJECT_DATA[x], home: path.join(TMP, 'nohome'), loadConfig: () => ({ synapseBudgetUsd: 1 }), log: () => {} } });
    ok(Math.abs(s2.budget().spent - spent) < 1e-9, 'ledger: spend SURVIVES a reload (a restart must not reset the cap)');
  }

  // ---- 4. degradation is reported, never silent ----
  {
    const s = mk('nodeps');                       // no embedder, no llm
    await s.hydrate();
    const r = await s.connect();
    ok(r.skipped === 'no-embedder', 'connect: with no embedder it SAYS it skipped');
    const sug = await s.suggest();
    ok(sug.skipped === 'no-llm', 'suggest: with no llm it SAYS it skipped');
    ok(Array.isArray(sug.suggestions), 'suggest: still returns the previous suggestions array');
  }

  // ---- tick: the worker cycle + its gates ----
  {
    const s = mk('tick', { embedBatch, llm, isIdle: () => false });
    const r = await s.tick();
    ok(r.hydrated && r.hydrated.nodes > 0, 'tick: always runs the free hydrate');
    ok(r.paidSkipped === 'agent busy', 'tick: refuses the paid pass while the agent is busy (never spends mid-turn)');
    ok(r.connected === null, 'tick: no connect happened');

    const s2 = mk('tick2', { embedBatch, llm, isIdle: () => true });
    const r2 = await s2.tick();
    ok(r2.connected !== null, 'tick: runs the paid pass when idle and due');
    const r3 = await s2.tick();
    ok(/not due/.test(r3.paidSkipped || ''), 'tick: the paid pass is rate-limited to its interval');
    const r4 = await s2.tick({ force: true });
    ok(r4.connected !== null, 'tick: force overrides the due gate');

    const off = mk('off', { loadConfig: () => ({ synapse: { worker: false } }) });
    ok((await off.tick()).skipped === 'disabled', 'tick: config.synapse.worker=false disables the cycle');
    ok((await off.tick({ force: true })).hydrated, 'tick: force still works when disabled (manual Build in the UI)');

    const nopaid = mk('nopaid', { embedBatch, llm, loadConfig: () => ({ synapse: { paid: false } }) });
    ok(/disabled/.test((await nopaid.tick()).paidSkipped || ''), 'tick: config.synapse.paid=false blocks paid work');
  }

  // ---- graphView carries the budget (the UI reads it from there) ----
  {
    const s = mk('view');
    await s.hydrate();
    const g = s.graphView();
    ok(g.budget && typeof g.budget.limit === 'number' && typeof g.budget.left === 'number', 'graphView: carries the budget for the UI');
    ok(Array.isArray(g.nodes) || typeof g.nodes === 'object', 'graphView: carries the graph');
    let pushed = 0;
    const s2 = mk('push', { onUpdate: () => pushed++ });
    await s2.hydrate();
    ok(pushed > 0, 'onUpdate: fires after a hydrate so the UI refreshes');
  }

  // ---- repo scanning ----
  {
    const home = path.join(TMP, 'fakehome');
    fs.mkdirSync(path.join(home, 'myrepo', '.git'), { recursive: true });
    fs.writeFileSync(path.join(home, 'myrepo', 'README.md'), '# myrepo\nalpha gamma retrieval');
    fs.mkdirSync(path.join(home, 'notarepo'), { recursive: true });
    fs.writeFileSync(path.join(home, 'notarepo', 'README.md'), 'no git here');
    fs.mkdirSync(path.join(home, '.hidden', '.git'), { recursive: true });

    const repos = scanRepos({ home });
    ok(repos.length === 1 && repos[0].name === 'myrepo', 'scanRepos: finds git repos and ignores non-repos');
    ok(/alpha gamma/.test(repos[0].readme), 'scanRepos: reads the README');
    ok(!repos.some((r) => r.name.startsWith('.')), 'scanRepos: skips dotfile directories');
    ok(scanRepos({ home, max: 0 }).length === 0, 'scanRepos: honours the max cap');
    ok(scanRepos({ home: path.join(TMP, 'does-not-exist') }).length === 0, 'scanRepos: a missing home → [], no throw');

    const s = mk('repos', { home });
    const r = await s.hydrate();
    ok(r.nodes > 2, 'hydrate: repo nodes join the graph');
  }

  // ---- helpers ----
  ok(readSemanticRecords('/no/such/file.json').length === 0, 'readSemanticRecords: a missing store → [], no throw');
  {
    const p = path.join(TMP, 'sem.json');
    fs.writeFileSync(p, JSON.stringify({ records: [{ text: 'keep me' }, { text: '' }, null] }));
    ok(readSemanticRecords(p).length === 1, 'readSemanticRecords: drops empty/null records');
    fs.writeFileSync(p, 'corrupt');
    ok(readSemanticRecords(p).length === 0, 'readSemanticRecords: a corrupt store → [], no throw');
  }
  ok(tok('') === 0 && tok('abcd') === 1 && tok('a'.repeat(400)) === 100, 'tok: ~4 chars per token');


  // ---- gardener wiring: the cycle must do UPKEEP, not just re-import ----
  {
    const s = mk('garden', { embedBatch, llm, isIdle: () => true });
    const r = await s.tick();
    ok(r.gardened && r.gardened.applied, 'tick: runs a gardening pass (free — the Connector only ever adds)');
    const r2 = await s.tick();
    ok(!r2.gardened, 'tick: gardening is on its own daily cadence, not every tick');
    ok((await s.tick({ force: true })).gardened, 'tick: force runs gardening immediately');

    // The learned threshold must feed back into the Connector, or "P4 learning" is decorative.
    ok(s.connectThreshold() === 0.8, 'connectThreshold: defaults to 0.8');
    s.brain.setMeta('connectThreshold', 0.88);
    ok(s.connectThreshold() === 0.88, 'connectThreshold: reads the value the Gardener learned');
    s.brain.setMeta('connectThreshold', 'garbage');
    ok(s.connectThreshold() === 0.8, 'connectThreshold: a corrupt learned value falls back to the default');
  }

  // ---- Electron-free, which is the entire reason this module was extracted ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'synapse.js'), 'utf8');
    ok(!/require\(['"]electron['"]\)/.test(src), 'lib/synapse.js: never requires electron');
    ok(!Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/]electron[\\/]/.test(k)), 'lib/synapse.js: pulls in no electron transitively');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
