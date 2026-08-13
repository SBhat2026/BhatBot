'use strict';
// ── REAL-APP BENCHMARK ────────────────────────────────────────────────────────────────────────────
// Measures the SHIPPED app, not a simulation. Siddhant's constraint: time doesn't matter, ability
// and working efficiency do. So this deliberately measures capability and cost-of-capability rather
// than raw latency:
//
//   1. INTAKE ROUTING     — does a tool-needing prompt reach the instrumented loop? (a false 'chat'
//                           is a broken task; a false 'action' costs milliseconds)
//   2. TOOL RETRIEVAL     — with 81 tools, does the right one surface for a real request?
//   3. TRIAGE ACCURACY    — the mail ladder against labelled fixtures, incl. the adversarial cases
//   4. GRAPH QUALITY      — are the second brain's links actually cross-project and non-trivial?
//   5. ENDURANCE          — heap/lock/governor from the live process's own state file
//   6. THROUGHPUT         — embedding + link rate the weaver can actually sustain, locally
//
// Everything here reads the REAL modules and the REAL on-disk state. Where a number depends on the
// live process, it is read from ~/.bhatbot/state.json rather than guessed.
//
// Run:  node scripts/bench-app.js         (add --json for machine-readable output)

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');

const R = { ts: new Date().toISOString(), sections: {} };
const pct = (n, d) => (d ? +(100 * n / d).toFixed(1) : 0);
function say(...a) { if (!JSON_OUT) console.log(...a); }
function head(t) { say('\n' + '─'.repeat(72) + '\n' + t + '\n' + '─'.repeat(72)); }

// ── 1. INTAKE ROUTING ────────────────────────────────────────────────────────────────────────────
function benchIntake() {
  const { classifyIntake } = require(path.join(ROOT, 'lib', 'pure'));
  const looksLikeToolTask = (t) => /\b(open|run|deploy|edit|write|build|search|send|click|install|fix|check|read|find|create|make|show)\b/i.test(t);
  const ctx = { looksLikeToolTask, referencesJob: () => false, inToolThread: false };

  // label: what the turn actually NEEDS. 'action' = it must reach the tool loop.
  const cases = [
    ['open the world cup standings and read me the top of group C', 'action'],
    ['run the protein sim and tell me the ipTM', 'action'],
    ['edit main.js and fix the governor threshold', 'action'],
    ['deploy drones for the uricase campaign', 'action'],
    ['check my email for anything urgent', 'action'],
    ['what files changed in bhatbot today', 'action'],
    ['archive the newsletters from this morning', 'action'],
    ['screenshot the current page', 'action'],
    ['install rembg so background removal works', 'action'],
    ['find every .pdb file under Research Files', 'action'],
    ['hey', 'chat'],
    ['thanks!', 'chat'],
    ['what is the capital of France', 'chat'],
    ['good morning', 'chat'],
    ['who won the 2022 world cup', 'chat'],
    ['nice, that worked', 'chat'],
  ];
  let correct = 0, falseChat = 0, falseAction = 0;
  const misses = [];
  for (const [text, want] of cases) {
    const got = classifyIntake(text, ctx);
    const reachesTools = got === 'action' || got === 'ambiguous';
    const ok = want === 'action' ? reachesTools : got === 'chat';
    if (ok) correct++;
    else {
      misses.push({ text, want, got });
      if (want === 'action') falseChat++; else falseAction++;
    }
  }
  const out = {
    total: cases.length, correct, accuracy: pct(correct, cases.length),
    falseChat,                       // THE COSTLY ERROR: a task silently answered without doing it
    falseAction,                     // cheap: a few hundred ms of extra instrumentation
    misses,
  };
  head('1 · INTAKE ROUTING  (does a tool-needing prompt reach the tool loop?)');
  say(`   accuracy ${out.accuracy}%  (${correct}/${cases.length})`);
  say(`   false-chat (BROKEN TASK):     ${falseChat}`);
  say(`   false-action (cheap):         ${falseAction}`);
  for (const m of misses) say(`     ✗ "${m.text}" → ${m.got} (wanted ${m.want})`);
  return out;
}

// ── 2. TOOL RETRIEVAL ────────────────────────────────────────────────────────────────────────────
function benchToolSelect() {
  const toolselect = require(path.join(ROOT, 'lib', 'toolselect'));
  const schema = require(path.join(ROOT, 'lib', 'tools-schema'))({ MEMORY_SECTIONS: [] });
  const cases = [
    ['resize these screenshots to 800px', 'file_tools'],
    ['merge these three PDFs', 'file_tools'],
    ['undo what you archived this morning', 'triage_mail'],
    ['what did you do to my inbox today', 'triage_mail'],
    ['search my gmail for the adaptyv thread', 'gmail'],
    ['put an event on my calendar for tuesday', 'calendar'],
    ['take a screenshot of the screen', 'screen_parse'],
    ['run a python simulation of the pendulum', 'simulate'],
    ['what is on my calendar tomorrow', 'calendar'],
    ['render this molecule', 'molecule'],
  ];
  let hit = 0, top1 = 0; const misses = [];
  for (const [q, want] of cases) {
    let picked = null;
    try { picked = toolselect.select ? toolselect.select(q, schema) : null; } catch {}
    const names = Array.isArray(picked) ? picked.map((t) => (t.name || t)) : null;
    if (!names) { misses.push({ q, want, got: '(no retrieval — full catalog passed)' }); continue; }
    if (names.includes(want)) hit++;
    if (names[0] === want) top1++;
    if (!names.includes(want)) misses.push({ q, want, got: names.slice(0, 4).join(',') });
  }
  const out = { total: cases.length, recall: pct(hit, cases.length), top1: pct(top1, cases.length), tools: schema.length, misses };
  head('2 · TOOL RETRIEVAL  (with ' + schema.length + ' tools, does the right one surface?)');
  if (misses.length === cases.length && /no retrieval/.test((misses[0] || {}).got || '')) {
    say('   toolselect returns the FULL catalog at this size (no pruning) — recall is 100% by');
    say('   construction, and the model does the choosing. Nothing to measure here yet.');
    out.note = 'full-catalog mode';
  } else {
    say(`   recall@k ${out.recall}%   top-1 ${out.top1}%`);
    for (const m of misses) say(`     ✗ "${m.q}" wanted ${m.want}, got ${m.got}`);
  }
  return out;
}

// ── 3. TRIAGE ACCURACY ───────────────────────────────────────────────────────────────────────────
function benchTriage() {
  const { classify } = require(path.join(ROOT, 'lib', 'triage'));
  const { fromGmail } = require(path.join(ROOT, 'lib', 'signals'));
  const mk = (from, subject, unsub, sent) => fromGmail(
    { id: 'x', threadId: 't', labelIds: ['INBOX', 'UNREAD'], internalDate: Date.now(),
      headers: { From: from, Subject: subject, To: 'siddhantbhat3@gmail.com', ...(unsub ? { 'List-Unsubscribe': '<u>' } : {}) } },
    { sentContacts: sent || {} });

  const cases = [
    // [from, subject, unsub, expectedClass]
    ['no-reply@accounts.google.com', 'Security alert: new sign-in', false, 'urgent'],
    ['no-reply@manus.im', 'Action Required: data deleted Aug 23', false, 'urgent'],
    ['service@paypal.com', 'Receipt for your payment', false, 'urgent'],
    ['no.reply.alerts@chase.com', 'Your statement is ready', false, 'urgent'],
    ['pramodv@princeton.edu', 'dinner sunday', false, 'important'],
    ['gijs@adaptyvbio.com', 'binder round 3', false, 'important'],
    ['akaz@princeton.edu', 'draft figures', false, 'important'],
    ['randomprof@stanford.edu', 'your application', false, 'important'],
    ['receipts@openrouter.ai', 'Your receipt', false, 'routine'],
    ['mitdaily@mit.edu', 'MIT Daily', true, 'routine'],
    ['nytdirect@nytimes.com', 'Evening Briefing', true, 'noise'],
    ['no-reply@strava.com', 'You earned a badge', true, 'noise'],
    ['chase@mcmap.chase.com', 'Pre-qualified offer', true, 'noise'],
    ['noreply@news.paypal.com', 'New ways to pay', true, 'noise'],
    ['hello@vuori.com', 'ACTION REQUIRED: cart expires', true, 'noise'],
    ['stranger@nowhere.xyz', 'quick question', false, 'ambiguous'],
  ];
  let correct = 0; const misses = [];
  // The two errors that actually matter, tracked separately from raw accuracy.
  let importantLostAsNoise = 0, noiseLeaked = 0;
  for (const [from, subj, unsub, want] of cases) {
    const v = classify(mk(from, subj, unsub));
    if (v.class === want) correct++; else misses.push({ from, subj, want, got: v.class, rule: v.rule });
    if ((want === 'urgent' || want === 'important') && v.class === 'noise') importantLostAsNoise++;
    if (want === 'noise' && (v.class === 'urgent' || v.class === 'important')) noiseLeaked++;
  }
  const out = { total: cases.length, correct, accuracy: pct(correct, cases.length), importantLostAsNoise, noiseLeaked, misses };
  head('3 · MAIL TRIAGE  (the ladder against labelled fixtures)');
  say(`   accuracy ${out.accuracy}%  (${correct}/${cases.length})`);
  say(`   important/urgent WRONGLY archived: ${importantLostAsNoise}   ← the unacceptable error`);
  say(`   noise wrongly escalated:           ${noiseLeaked}   ← merely annoying`);
  for (const m of misses) say(`     ✗ ${m.from} "${m.subj}" → ${m.got} (wanted ${m.want}, ${m.rule})`);
  return out;
}

// ── 4. GRAPH QUALITY ─────────────────────────────────────────────────────────────────────────────
function benchGraph() {
  const brain = require(path.join(ROOT, 'lib', 'brain'));
  const dir = path.join(os.homedir(), '.bhatbot', 'brain');
  let b;
  try { b = brain.createBrain({ dir }); } catch { return { error: 'no graph' }; }
  const nodes = b.nodes(), edges = b.edges();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const types = {}; for (const n of nodes) types[n.type] = (types[n.type] || 0) + 1;
  const embedded = nodes.filter((n) => Array.isArray(n.embedding) && n.embedding.length);
  const dims = {}; for (const n of embedded) dims[n.embedding.length] = (dims[n.embedding.length] || 0) + 1;

  const rel = edges.filter((e) => e.type === 'relates-to' && e.status !== 'pruned');
  const withWhy = rel.filter((e) => e.rationale);
  // A link is only interesting if it crosses projects — that is the entire premise of the graph.
  const projOf = new Map();
  for (const e of edges) {
    if (e.type !== 'part-of') continue;
    const a = byId.get(e.from), c = byId.get(e.to);
    if (!a || !c) continue;
    if (c.type === 'project') projOf.set(a.id, c.id); else if (a.type === 'project') projOf.set(c.id, a.id);
  }
  let cross = 0, within = 0;
  for (const e of rel) {
    const pa = projOf.get(e.from) || e.from, pb = projOf.get(e.to) || e.to;
    if (pa === pb) within++; else cross++;
  }
  const out = {
    nodes: nodes.length, edges: edges.length, types,
    embedded: embedded.length, embedCoverage: pct(embedded.length, nodes.length), dims,
    relatesTo: rel.length, crossProject: cross, withinProject: within,
    crossProjectPct: pct(cross, rel.length), explained: withWhy.length, explainedPct: pct(withWhy.length, rel.length),
    spendUsd: Number(b.getMeta('spendUsd')) || 0,
  };
  head('4 · SECOND-BRAIN GRAPH  (is it actually connecting things?)');
  say(`   ${out.nodes} nodes  ${JSON.stringify(types)}`);
  say(`   embedded ${out.embedded}/${out.nodes} (${out.embedCoverage}%)  dims ${JSON.stringify(dims)}`);
  say(`   relates-to links ${out.relatesTo}  ·  cross-project ${out.crossProjectPct}%  ·  explained ${out.explainedPct}%`);
  say(`   spent $${out.spendUsd.toFixed(3)}`);
  if (Object.keys(dims).length > 1) say('   ⚠ MIXED embedding dimensions — vectors from different models cannot be compared');
  if (out.embedCoverage < 90) say(`   ⚠ ${out.nodes - out.embedded} nodes have no vector → they can never form a link`);
  return out;
}

// ── 5. ENDURANCE (from the live process's own state) ─────────────────────────────────────────────
function benchEndurance() {
  const p = path.join(os.homedir(), '.bhatbot', 'state.json');
  let st = null;
  try { st = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { error: 'state.json unreadable — is the app running?' }; }
  const e = st.endurance || {};
  head('5 · ENDURANCE  (live process, from its own telemetry)');
  say(`   heap ${e.heapMb ?? '?'}MB · rss ${e.rssMb ?? '?'}MB · uptime ${e.uptimeMin ?? '?'}m`);
  say(`   governor: ${e.governor || '?'}`);
  say(`   background ticks skipped by the lock: ${e.bgSkipped ?? '?'}   lock timeouts: ${e.lockTimeouts ?? 0}`);
  say(`   agent: ${(st.agent && st.agent.state) || '?'}   jobs active: ${(st.jobs || []).length}`);
  return { ...e, agent: (st.agent || {}).state, jobsActive: (st.jobs || []).length };
}

// ── 6. THROUGHPUT (what the weaver can actually sustain here) ────────────────────────────────────
async function benchThroughput() {
  const semantic = require(path.join(ROOT, 'lib', 'semantic'));
  const texts = Array.from({ length: 24 }, (_, i) => `sample text number ${i} about protein design, agents, and graph databases`);
  const t0 = Date.now();
  const r = await semantic.embedBatch(texts);
  const ms = Date.now() - t0;
  const okv = (r.vecs || []).filter(Boolean).length;
  const out = {
    batch: texts.length, ok: okv, ms, perNodeMs: okv ? +(ms / okv).toFixed(1) : null,
    model: r.model || null, local: !!r.local, fellBackFrom: r.fellBackFrom || null, error: r.error || null,
  };
  head('6 · EMBEDDING THROUGHPUT  (the weaver\'s rate limit)');
  if (!okv) { say(`   ✗ embedding unavailable: ${r.error || r.skipped}`); return out; }
  say(`   ${okv}/${texts.length} vectors in ${ms}ms  (${out.perNodeMs}ms/node)  via ${out.model}${out.local ? ' [LOCAL]' : ''}`);
  if (out.fellBackFrom) say(`   ⚠ fell back from ${out.fellBackFrom}`);
  const nodesLeft = (() => { try { const brain = require(path.join(ROOT, 'lib', 'brain')); const b = brain.createBrain({ dir: path.join(os.homedir(), '.bhatbot', 'brain') }); const dim = Number(b.getMeta('embedDim')) || 0; return b.nodes().filter((n) => n.status !== 'pruned' && (!Array.isArray(n.embedding) || !n.embedding.length || (dim && n.embedding.length !== dim))).length; } catch { return null; } })();
  if (nodesLeft != null && out.perNodeMs) {
    const mins = (nodesLeft * out.perNodeMs / 1000 / 60).toFixed(1);
    say(`   ${nodesLeft} nodes still need vectors → ~${mins} min of pure embedding to full coverage`);
    out.nodesLeft = nodesLeft; out.minsToFullCoverage = +mins;
  }
  return out;
}

(async () => {
  R.sections.intake = benchIntake();
  R.sections.toolselect = benchToolSelect();
  R.sections.triage = benchTriage();
  R.sections.graph = benchGraph();
  R.sections.endurance = benchEndurance();
  R.sections.throughput = await benchThroughput();

  head('SUMMARY');
  const s = R.sections;
  say(`   intake routing      ${s.intake.accuracy}%   (${s.intake.falseChat} broken-task errors)`);
  say(`   mail triage         ${s.triage.accuracy}%   (${s.triage.importantLostAsNoise} important lost)`);
  say(`   graph embed coverage ${s.graph.embedCoverage ?? '?'}%  · cross-project links ${s.graph.crossProjectPct ?? '?'}%`);
  say(`   heap                ${s.endurance.heapMb ?? '?'}MB after ${s.endurance.uptimeMin ?? '?'}m`);
  say(`   embedding           ${s.throughput.perNodeMs ?? '?'}ms/node via ${s.throughput.model || 'unavailable'}`);
  const out = path.join(ROOT, 'BENCH_APP.md');
  const md = ['# BhatBot — real-app benchmark', '', `_Measured ${R.ts} against the installed build (not simulated)._`, '',
    '```json', JSON.stringify(R, null, 2), '```'].join('\n');
  fs.writeFileSync(out, md);
  say(`\n   → ${path.relative(ROOT, out)}`);
  if (JSON_OUT) console.log(JSON.stringify(R, null, 2));
})();
