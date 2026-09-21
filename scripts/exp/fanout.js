#!/usr/bin/env node
'use strict';
// ── EXPERIMENT: DOES AGENT FAN-OUT ACTUALLY BEAT ONE AGENT? ───────────────────────────────────────
//
// BhatBot can deploy a fleet. Nothing here has ever measured whether that is worth the money, because
// every previous fleet run was judged by reading its output and deciding it looked good. This runs
// the SAME mission two ways against a mechanically-computed answer key, so the comparison is a
// number rather than an impression.
//
//   ARM A (solo)     one agent, one budget, the whole of lib/
//   ARM B (fan-out)  four drones over four shards of lib/, then one synthesis pass over their reports
//
// Both arms get the SAME total turn allowance and the SAME tools, so what is being compared is the
// topology and nothing else. Predictions are pre-registered to disk BEFORE the API key is used
// (scripts/exp/prereg.json); scoring is scripts/exp/groundtruth.js, which decides nothing by taste.
//
// It also drives the 3D office live: every model call, tool call and blackboard post is written to
// live.json, which src/proto/experiment.html polls and forwards into src/presence.html. The office
// is not decoration here — "does the room tell the truth about what the agents are doing" is
// hypothesis H4, and it is scored like the others.
//
//   node scripts/exp/fanout.js --prereg     # print + write the pre-registration. $0.00
//   node scripts/exp/fanout.js --go         # run both arms for real
//   node scripts/exp/fanout.js --go --arm=b # one arm only
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const llm = require(path.join(ROOT, 'lib', 'llm'));
const fleet = require(path.join(ROOT, 'lib', 'fleet'));
const blackboard = require(path.join(ROOT, 'lib', 'blackboard'));
const { makeAgentRun, priceOf } = require('./agentrun');
const truth = require('./groundtruth');

const ARGV = process.argv.slice(2);
const GO = ARGV.includes('--go');
const ARM = (ARGV.find((a) => a.startsWith('--arm=')) || '--arm=both').split('=')[1];
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DIR = path.join(os.homedir(), '.bhatbot', 'experiments', RUN_ID);
const LIVE = path.join(os.homedir(), '.bhatbot', 'experiments', 'live.json');   // stable path the office polls

// ── the mission ───────────────────────────────────────────────────────────────────────────────────
// Chosen so the answer is (a) genuinely useful, (b) spread across more files than any one agent can
// read inside a budget, and (c) decidable from the source text — without which there is no score.
const MISSION = [
  'You are auditing the BhatBot codebase at ' + ROOT + '.',
  '',
  'FIND: every module under lib/ that makes an OUTBOUND NETWORK CALL which can hang forever —',
  'a fetch(), https.request() or axios call with NO timeout, NO AbortSignal and NO AbortController',
  'anywhere in the file. A file that has any of those guards does NOT count, even if only one of its',
  'calls is guarded.',
  '',
  'You have list_directory and read_file only. There is no grep and no shell, so you must choose',
  'which files are worth opening. Reading every file is not possible inside your budget.',
  '',
  'YOUR CONTEXT IS PRUNED. Only the last two rounds of file contents stay visible; older ones are',
  'replaced by a stub. So in the SAME message in which you read a file, write one line recording your',
  'verdict on it — "maps.js: fetch, no guard → HIT" or "brain.js: no network → skip". Those lines are',
  'the only memory you have. Batch several read_file calls per turn; you have few turns.',
  '',
  'REPORT, as the last thing you say, a single line of exactly this form and nothing after it:',
  'ANSWER: file1.js, file2.js, file3.js',
  'using paths relative to lib/ (e.g. "maps.js", "integrations/trellis.js"). List ONLY files you',
  'actually opened and confirmed. A wrong name costs you as much as a missing one.',
].join('\n');

// Four shards, split alphabetically so the partition is obvious to each drone and provably covers
// lib/ exactly once. The personas exist so the office has someone to show, and so each drone's
// blackboard posts are attributable at a glance.
const SHARDS = [
  { name: 'Vale',   range: ['a', 'd'], brief: 'a codebase auditor working the a–d slice of lib/' },
  { name: 'Orrin',  range: ['e', 'l'], brief: 'a codebase auditor working the e–l slice of lib/' },
  { name: 'Sable',  range: ['m', 'r'], brief: 'a codebase auditor working the m–r slice of lib/' },
  { name: 'Quill',  range: ['s', 'z'], brief: 'a codebase auditor working the s–z slice of lib/, INCLUDING the subdirectories agents/ integrations/ schemas/' },
];

const PREREG = {
  runId: RUN_ID,
  question: 'Does deploying four scoped drones over a partitioned codebase find more real defects, '
          + 'per dollar and per minute, than one agent given the same total turn allowance?',
  answerKeySize: truth.hits.length,
  networkedFiles: truth.networked.length,
  totalLibModules: null,   // filled at prereg time
  arms: {
    a: { topology: 'solo', agents: 1, turnsEach: 24, budgetUsd: 0.60 },
    b: { topology: 'fan-out', agents: 4, turnsEach: 6, budgetUsd: 0.15, plusSynthesis: false },
  },
  hypotheses: [
    { id: 'H1', claim: 'Fan-out RECALL beats solo recall.',
      why: 'The key is spread over 111 modules. Solo cannot open them all in 16 turns, so its ceiling is set by how well it guesses which files to open. Four drones each guess within a quarter of the space.',
      predict: 'solo recall 2–4 of 7 (29–57%); fan-out recall 5–7 of 7 (71–100%).' },
    { id: 'H2', claim: 'Fan-out PRECISION is no better than solo, and probably worse.',
      why: 'A shard-local drone sees a quarter of the codebase and is under pressure to produce names. Confident guessing is the cheapest way to look productive, and nothing in its context contradicts a guess.',
      predict: 'solo precision ≥ 0.75; fan-out precision 0.5–0.8.' },
    { id: 'H3', claim: 'Fan-out costs 2–4× more and finishes in less wall clock.',
      why: 'Four system prompts and four tool transcripts are paid for separately, but they run at the same time.',
      predict: 'cost ratio B/A between 2 and 4; wall-clock ratio B/A between 0.35 and 0.8.' },
    { id: 'H4', claim: 'The office tells the truth: every state the room shows was a state a drone was really in, within ~1.5s.',
      why: 'The roster is derived from the same trace that scores the run, so a divergence would be a bug in the bridge rather than a lag.',
      predict: 'zero orphan agents, zero states shown that the trace does not contain, max feed lag under 1.5s.' },
    { id: 'H5', claim: 'The drones will TALK but not LISTEN.',
      why: 'The blackboard is in every drone\'s system prompt and they are instructed to post findings, but the shards are independent — nothing one drone learns changes what another should open. Coordination machinery does not create a reason to coordinate.',
      predict: 'each drone posts ≥2 board entries; ZERO drones cite or act on a sibling\'s finding.' },
  ],
  amendment: 'Run 1 (2026-09-21T23:29) was VOID — an instrument failure, not a result. Every agent in '
           + 'both arms hit its cap mid-audit and returned "(out of budget before reporting)", so no '
           + 'arm produced an answer to score. Two causes, both in the runner rather than in either '
           + 'topology: a tool loop re-sends its whole transcript, so cost grew with the square of '
           + 'the turn count; and running out of budget during a tool call ended the drone with its '
           + 'work unreported. Fixed by pruning old tool results and by forcing one final tool-free '
           + 'wrap-up turn. Budgets re-cut for PARITY: 24 turns and $0.60 per arm either way. The '
           + 'five hypotheses and their predicted ranges are UNCHANGED from the pre-run commit.',
  scoring: 'precision = TP/(TP+FP); recall = TP/7. A named file that is networked-but-guarded is '
         + 'scored as a NEAR MISS (judgement error) and counted separately from a name that touches '
         + 'no network at all (fabrication).',
  spendCap: 1.40,
};

// ── live feed for the 3D office ───────────────────────────────────────────────────────────────────
const roster = new Map();     // name → presence record
const transcript = [];        // everything said, by anyone, in order
let liveArm = '—', liveSpend = 0, liveStart = Date.now();

function flush() {
  const payload = {
    t: Date.now(), runId: RUN_ID, arm: liveArm,
    elapsedMs: Date.now() - liveStart,
    spendUsd: Number(liveSpend.toFixed(4)),
    agents: [...roster.values()],
    transcript: transcript.slice(-120),
  };
  try { fs.mkdirSync(path.dirname(LIVE), { recursive: true }); fs.writeFileSync(LIVE, JSON.stringify(payload)); } catch {}
}

function say(from, to, kind, text, extra = {}) {
  transcript.push({ t: Date.now(), from, to, kind, text: String(text || '').slice(0, 500), ...extra });
  flush();
}

function setAgent(name, patch) {
  const a = roster.get(name) || { id: 'exp-' + name, name, state: 'idle', status: 'spawned', task: '', step: '', tool: null, since: Date.now(), steerable: false };
  if (patch.state && patch.state !== a.state) a.since = Date.now();
  Object.assign(a, patch);
  roster.set(name, a);
  flush();
}

// ── arm B: the fleet ──────────────────────────────────────────────────────────────────────────────
async function runFanout(apiKey) {
  liveArm = 'B — fan-out (4 drones)'; liveStart = Date.now();
  const wsDir = path.join(DIR, 'arm-b');
  fs.mkdirSync(wsDir, { recursive: true });
  const board = blackboard.createBlackboard({ dir: wsDir });
  const trace = [];

  const onTrace = (ev) => {
    trace.push({ t: Date.now(), ...ev });
    if (ev.kind === 'tool') {
      setAgent(ev.drone, { state: 'working', status: 'reading', step: ev.tool + ' ' + ev.text, tool: ev.tool });
      say(ev.drone, 'tools', 'tool', ev.tool + '  ' + ev.text);
    } else if (ev.kind === 'thinking') {
      setAgent(ev.drone, { state: 'thinking', status: ev.text, step: '' });
    } else if (ev.kind === 'turn') {
      // Cost is charged per TURN. The header used to add it once per TOOL CALL, which made a turn
      // with four parallel reads look four times as expensive as it was.
      liveSpend += ev.usd || 0;
    } else if (ev.kind === 'say') {
      setAgent(ev.drone, { state: 'thinking', status: 'reporting' });
      say(ev.drone, 'Siddhant', 'say', ev.text);
    }
  };

  const agentRun = makeAgentRun({ apiKey, onTrace });
  const specs = SHARDS.map((s, i) => ({
    id: 'shard-' + i,
    persona: { name: s.name, brief: s.brief, style: 'terse, evidence-first' },
    tools: ['read_file', 'list_directory'],
    wsDir,
    budget: { usd: PREREG.arms.b.budgetUsd, maxTurns: PREREG.arms.b.turnsEach },
  }));
  for (const s of specs) setAgent(s.persona.name, { state: 'idle', status: 'deployed', task: 'audit lib/ ' + SHARDS[specs.indexOf(s)].range.join('–') });

  // Each drone gets the same mission narrowed to its own slice. runFleet asks for this through
  // opts.taskFor rather than baking a task into the spec, which is what lets one mission be
  // partitioned without the supervisor knowing anything about partitioning.
  const goalFor = (i) => MISSION
    + '\n\nYOUR SHARD: only files directly in lib/ whose FILENAME begins with a letter from '
    + SHARDS[i].range[0] + ' to ' + SHARDS[i].range[1] + ' inclusive.'
    + (SHARDS[i].range[0] === 's' ? ' Also audit lib/agents/, lib/integrations/ and lib/schemas/ in full.' : '')
    + '\nA sibling drone owns every other file. Do not audit outside your shard, and do not report a'
    + '\nfile outside it even if you are sure about it.';

  const t0 = Date.now();
  const out = await fleet.runFleet(specs, {
    agentRun, board,
    onEvent: (e) => say('FLEET', 'Siddhant', 'fleet', JSON.stringify(e)),
  }, {
    wsDir, envelopeUsd: 1.0, hardCap: 4, staleMs: 120000, pollMs: 800,
    taskFor: (drone) => ({ goal: goalFor(specs.findIndex((x) => x.id === drone.id)) }),
  });

  for (const r of out.results || []) setAgent(r.persona, { state: r.status === 'failed' ? 'error' : 'done', status: r.status, step: '' });
  return { out, trace, board, ms: Date.now() - t0 };
}

// ── arm A: the soloist ────────────────────────────────────────────────────────────────────────────
async function runSolo(apiKey) {
  liveArm = 'A — solo (1 agent)'; liveStart = Date.now();
  const wsDir = path.join(DIR, 'arm-a');
  fs.mkdirSync(wsDir, { recursive: true });
  const trace = [];
  const onTrace = (ev) => {
    trace.push({ t: Date.now(), ...ev });
    if (ev.kind === 'tool') { setAgent(ev.drone, { state: 'working', status: 'reading', step: ev.tool + ' ' + ev.text, tool: ev.tool }); say(ev.drone, 'tools', 'tool', ev.tool + '  ' + ev.text); }
    else if (ev.kind === 'turn') liveSpend += ev.usd || 0;
    else if (ev.kind === 'thinking') setAgent(ev.drone, { state: 'thinking', status: ev.text });
    else if (ev.kind === 'say') { setAgent(ev.drone, { state: 'thinking', status: 'reporting' }); say(ev.drone, 'Siddhant', 'say', ev.text); }
  };
  const { createDrone } = require(path.join(ROOT, 'lib', 'drone'));
  const d = createDrone({
    id: 'solo', persona: { name: 'Marlowe', brief: 'a single auditor with the whole of lib/ to cover', style: 'terse, evidence-first' },
    tools: ['read_file', 'list_directory'], wsDir,
    budget: { usd: PREREG.arms.a.budgetUsd, maxTurns: PREREG.arms.a.turnsEach },
  }, { agentRun: makeAgentRun({ apiKey, onTrace }) });
  setAgent('Marlowe', { state: 'idle', status: 'deployed', task: 'audit all of lib/' });
  const t0 = Date.now();
  const r = await d.run({ goal: MISSION });
  setAgent('Marlowe', { state: r.status === 'failed' ? 'error' : 'done', status: r.status, step: '' });
  return { result: r, trace, ms: Date.now() - t0 };
}

// ── scoring ───────────────────────────────────────────────────────────────────────────────────────
const KEY = new Set(truth.hits);
const NETWORKED = new Set(truth.networked);

function parseAnswer(text) {
  const m = String(text || '').match(/ANSWER:\s*([^\n]+)/i);
  if (!m) return [];
  return m[1].split(/[,;]/).map((s) => s.trim().replace(/^lib\//, '').replace(/[`'"]/g, '')).filter((s) => /\.js$/.test(s));
}

function score(names) {
  const uniq = [...new Set(names)];
  const tp = uniq.filter((n) => KEY.has(n));
  const near = uniq.filter((n) => !KEY.has(n) && NETWORKED.has(n));
  const fab = uniq.filter((n) => !NETWORKED.has(n));
  return {
    named: uniq, tp, near, fabricated: fab, missed: [...KEY].filter((k) => !uniq.includes(k)),
    precision: uniq.length ? +(tp.length / uniq.length).toFixed(3) : 0,
    recall: +(tp.length / KEY.size).toFixed(3),
  };
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  PREREG.totalLibModules = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).length;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'prereg.json'), JSON.stringify(PREREG, null, 2));
  fs.writeFileSync(path.join(DIR, 'prereg.json'), JSON.stringify(PREREG, null, 2));

  if (!GO) {
    console.log('PRE-REGISTRATION — written, nothing spent.\n');
    console.log('Question: ' + PREREG.question + '\n');
    console.log(`Answer key: ${truth.hits.length} of ${truth.networked.length} networked modules, out of ${PREREG.totalLibModules} in lib/.`);
    console.log('  ' + truth.hits.join(', ') + '\n');
    for (const h of PREREG.hypotheses) console.log(`${h.id}  ${h.claim}\n    predict: ${h.predict}`);
    console.log('\nSpend cap $' + PREREG.spendCap.toFixed(2) + '. Re-run with --go.');
    process.exit(0);
  }

  const apiKey = llm.resolveKey('anthropic');
  if (!apiKey) { console.error('no key'); process.exit(1); }

  const report = { prereg: PREREG, arms: {} };
  if (ARM === 'a' || ARM === 'both') {
    console.log('\n── ARM A: solo ' + '─'.repeat(62));
    const a = await runSolo(apiKey);
    const s = score(parseAnswer(a.result.summary));
    report.arms.a = { ...s, ms: a.ms, spendUsd: a.result.spend.usd, turns: a.result.spend.turns, status: a.result.status, raw: a.result.summary, trace: a.trace };
    console.log(`  ${a.result.status} · ${a.result.spend.turns} turns · $${a.result.spend.usd.toFixed(4)} · ${(a.ms / 1000).toFixed(1)}s`);
    console.log(`  named ${s.named.length}: ${s.named.join(', ') || '(none)'}`);
    console.log(`  precision ${s.precision}  recall ${s.recall}  near-miss ${s.near.length}  fabricated ${s.fabricated.length}`);
  }
  if (ARM === 'b' || ARM === 'both') {
    console.log('\n── ARM B: fan-out ' + '─'.repeat(59));
    const b = await runFanout(apiKey);
    const all = [];
    for (const r of b.out.results || []) all.push(...parseAnswer(r.summary));
    const s = score(all);
    const posts = b.board.all ? b.board.all() : [];
    report.arms.b = {
      ...s, ms: b.ms, spendUsd: Number((b.out.totalSpend || 0).toFixed(4)),
      perDrone: (b.out.results || []).map((r) => ({ persona: r.persona, status: r.status, turns: r.spend.turns, usd: r.spend.usd, named: parseAnswer(r.summary), summary: r.summary })),
      boardPosts: posts.length, board: posts, trace: b.trace,
    };
    console.log(`  ${(b.out.results || []).map((r) => r.persona + ':' + r.status).join(' ')} · $${(b.out.totalSpend || 0).toFixed(4)} · ${(b.ms / 1000).toFixed(1)}s`);
    console.log(`  named ${s.named.length}: ${s.named.join(', ') || '(none)'}`);
    console.log(`  precision ${s.precision}  recall ${s.recall}  near-miss ${s.near.length}  fabricated ${s.fabricated.length}`);
    console.log(`  blackboard posts: ${posts.length}`);
  }

  fs.writeFileSync(path.join(DIR, 'result.json'), JSON.stringify(report, null, 2));
  liveArm = 'complete'; flush();
  console.log('\nwritten → ' + DIR);
})();
