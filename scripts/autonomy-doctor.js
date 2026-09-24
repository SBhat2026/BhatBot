#!/usr/bin/env node
'use strict';
// ── IS THE HOUR-LONG LANE ACTUALLY WIRED? ─────────────────────────────────────────────────────────
//
// `long_run` is the one capability whose failures are invisible until the moment they matter most:
// Siddhant asks for something to be worked on overnight, goes to bed, and finds out in the morning
// that the escalation channel was never reachable, or the missions directory was not writable, or the
// forge could not build anything. Every other tool tells you it is broken the moment you use it. This
// one tells you eight hours later.
//
// So this exercises the whole lane END TO END, in about ten seconds, with no API spend: a real
// three-item supervised run against a scripted worker, a real forge through the real sandbox, a real
// escalation through a recording channel, and real files on disk. The only thing it fakes is the
// model — because what breaks here is the plumbing, and the plumbing is what this walks.
//
// It is DELIBERATELY unable to phone anyone. `notify` records. A doctor that rang Siddhant to prove
// the phone works would be a worse bug than the one it was checking for.
//
//   node scripts/autonomy-doctor.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const out = [];
const fails = [];
const say = (s) => { out.push(s); console.log(s); };
const stage = (ok2, label, detail) => { say(`${ok2 ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`); if (!ok2) fails.push(label); return ok2; };

(async () => {
  // ── 1. do the modules load, and does the tool surface exist ────────────────────────────────────
  let designation, supervisorMod, escalateMod, forgeMod, missionMod, sandbox;
  try {
    designation = require('../lib/designation');
    supervisorMod = require('../lib/supervisor');
    escalateMod = require('../lib/escalate');
    forgeMod = require('../lib/toolforge');
    missionMod = require('../lib/mission');
    sandbox = require('../lib/sandbox');
    stage(true, 'the five modules load', `${designation.DESIGNATIONS.length} designations`);
  } catch (e) {
    stage(false, 'the five modules load', e.message);
    console.log('\n✗ the autonomy lane is not loadable — nothing below could have run.');
    process.exit(1);
  }

  {
    const TOOLS = require('../lib/tools-schema')({ MEMORY_SECTIONS: [] });
    const names = TOOLS.map((t) => t.name);
    stage(names.includes('long_run') && names.includes('forge_tool'), 'both tools are advertised to the model');
    // A tool the retriever cannot find is a tool the agent does not have — this is how the phone line
    // came to be broken for weeks while `self_check` sat one category away from every phrasing.
    const toolcatalog = require('../lib/toolcatalog');
    const probes = ['work on this while I am asleep', 'keep going for an hour on your own', 'you cant do that, build a tool for it'];
    // resolve() returns [{category, score, hits}], not a list of names. The first draft of this check
    // compared against strings, found nothing, and reported the retriever broken while it was working
    // perfectly — a check that tests the wrong thing gives a wrong answer, not a smaller one.
    const missed = probes.filter((q) => !(toolcatalog.resolve(q) || []).some((c) => c.category === 'agents'));
    stage(missed.length === 0, 'the retriever finds the lane from how it is actually asked for',
      missed.length ? 'missed: ' + missed.join(' | ') : `${probes.length}/${probes.length} phrasings`);
  }

  // ── 2. can it write where it needs to ──────────────────────────────────────────────────────────
  const HOME = path.join(os.homedir(), '.bhatbot');
  for (const [label, dir] of [['missions', path.join(HOME, 'missions')], ['forged tools', path.join(HOME, 'forged')], ['escalations', path.join(HOME, 'escalations')]]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.doctor-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      stage(true, `${label} directory is writable`, dir.replace(os.homedir(), '~'));
    } catch (e) { stage(false, `${label} directory is writable`, e.message); }
  }

  // ── 3. the forge, through the real sandbox ─────────────────────────────────────────────────────
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-doctor-'));
  const forge = forgeMod.createForge({ dir: path.join(TMP, 'forged'), sandbox });
  {
    const r = await forge.forge({
      name: 'doctor_probe', purpose: 'A trivial tool, forged to prove the forge works.',
      code: 'return String(input.s || "").toUpperCase();',
      tests: [{ input: { s: 'ok' }, expected: 'OK' }],
    });
    stage(r.ok, 'the forge can build and prove a tool', r.ok ? `${r.cases.length} case(s) passed in the sandbox` : (r.errors || []).join('; '));
    if (r.ok) {
      const call = await forge.run('doctor_probe', { s: 'hello' });
      stage(call.success && call.result === 'HELLO', 'and the forged tool runs afterwards', call.success ? '' : call.error);
    }
    // The wall that matters most, checked rather than assumed: a tool whose test cannot fail must not
    // be registered. If this ever passes, the forge is a rubber stamp.
    const vac = await forge.forge({ name: 'doctor_vacuous', purpose: 'x', code: 'return { a: 1 };', tests: [{ input: {}, expect: { type: 'object' } }] });
    stage(!vac.ok && vac.stage === 'vacuous', 'a test that cannot fail is still refused', vac.ok ? 'IT WAS ACCEPTED — the forge is a rubber stamp' : '');
    // And the sandbox wall.
    const esc = await forge.forge({ name: 'doctor_escape', purpose: 'x', allow: ['child_process'], code: 'return 1;', tests: [{ input: {}, expected: 1 }] });
    stage(!esc.ok, 'child_process is refused outright', esc.ok ? 'IT WAS ALLOWED — generated code can leave the sandbox' : '');
  }

  // ── 4. escalation, on a recording channel ──────────────────────────────────────────────────────
  const sent = [];
  const escalations = escalateMod.createEscalations({
    dir: path.join(TMP, 'escalations'),
    notify: async (msg, urgency, o) => { sent.push({ msg, urgency, taskId: o && o.taskId }); return { sent: true, via: 'recorder' }; },
    opts: { maxPerHour: 99 },
  });
  {
    const t0 = Date.now();
    const e = await escalations.ask({ question: 'doctor probe: may I proceed?', assumption: 'yes' });
    stage(Date.now() - t0 < 1000, 'asking does not block', `${Date.now() - t0}ms`);
    stage(sent.length === 1 && sent[0].taskId === e.id, 'the question reaches a channel with a reply id attached');
    const quiet = escalations.isQuiet(Date.now());
    say(`  (it is ${quiet ? 'quiet hours — a real question right now would go to Telegram without ringing' : 'waking hours — a real question right now would ring'})`);
    if (!quiet) {
      const r = escalations.answer('yes, go ahead');
      stage(r.matched && r.id === e.id, 'and an inbound reply lands on it');
    } else {
      // In quiet hours a question WITH an assumption is auto-assumed, so there is nothing left open to
      // answer — which is the designed behaviour, not a failure, and the check has to know that.
      stage(escalations.isAnswered(e.id) && escalations.isAnswered(e.id).status === 'assumed',
        'and at this hour it falls back to its assumption instead of waiting for morning');
    }
  }

  // ── 5. a whole supervised run, end to end ──────────────────────────────────────────────────────
  {
    const missions = missionMod.createMissions({ dir: path.join(TMP, 'missions') });
    const seen = [];
    const events = [];
    const sup = supervisorMod.createSupervisor({
      missions, escalations, forge,
      onEvent: (e) => events.push(e.type),
      runAgent: async ({ goal, designation: d, name }) => {
        seen.push({ goal, d, name });
        if (/ask Siddhant/i.test(goal)) return { status: 'blocked', summary: 'needs him', need: { kind: 'human', question: 'doctor: which one?', assumption: 'the first' } };
        return { status: 'done', summary: 'did it', spendUsd: 0.001 };
      },
    }, { tickDelayMs: 1, idleWaitMs: 300, stallTicks: 20, width: 2 });

    const t0 = Date.now();
    const rep = await sup.run({
      goal: 'doctor probe: a three-item run',
      plan: ['research the options', 'write the code', 'ask Siddhant which to use'],
      budgetUsd: 1, wallClockMs: 30000,
    });
    const ms = Date.now() - t0;

    stage(rep && rep.missionId, 'a supervised run completes and reports', `${ms}ms, stopped: ${rep.stoppedBecause}`);
    stage(rep.done.length >= 2, 'the workable items were done', `${rep.done.length} done`);
    stage(seen.some((x) => x.d === 'research') && seen.some((x) => x.d === 'code'),
      'each item got its own designation', seen.map((x) => x.d).join(', '));
    stage(events.includes('escalated'), 'a blocked item escalated rather than stopping the run');
    stage(rep.spentUsd > 0, 'spend is metered from the workers', `$${rep.spentUsd}`);
    stage(fs.existsSync(path.join(TMP, 'missions', rep.missionId, 'plan.md')),
      'the plan survives on disk, so a crash does not lose the run');
    stage(fs.existsSync(path.join(TMP, 'missions', rep.missionId, 'journal.jsonl')), 'and so does the journal');

    // Resume, which is what "several hours" is actually made of.
    const meta = (missions.attach(rep.missionId) || {}).meta || {};
    stage(meta.kind === 'supervised', 'the mission records that the SUPERVISOR should resume it, not a plain turn');

    // Parallel has to be smarter than serial, not only faster. Without a board, three agents working
    // three items at once run blind to each other and the one that learns something cannot tell the
    // two about to hit the same wall.
    stage(rep.boardFile && fs.existsSync(rep.boardFile), 'the agents share a blackboard', rep.boardFile ? path.basename(rep.boardFile) : 'none');
    if (rep.boardFile && fs.existsSync(rep.boardFile)) {
      const posts = fs.readFileSync(rep.boardFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      stage(posts.some((p) => p.kind === 'finding') && posts.some((p) => p.kind === 'status'),
        'and both ends of an item reach it', `${posts.length} posts`);
    }
  }

  // ── 6. the office can colour what it is shown ──────────────────────────────────────────────────
  {
    const r = designation.forRenderer();
    stage(r.designations.length >= 5 && r.error && r.unknown, 'the office is handed a palette rather than keeping one');
    const html = fs.readFileSync(path.join(ROOT, 'src', 'presence.html'), 'utf8');
    const leaked = designation.DESIGNATIONS.flatMap((d) => [d.glow, d.ink]).filter((h) => html.toLowerCase().includes(h.toLowerCase()));
    stage(leaked.length === 0, 'and keeps no second copy of it', leaked.length ? 'hardcoded: ' + leaked.join(', ') : '');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log('');
  if (fails.length) {
    console.log(`✗ the autonomy lane is NOT healthy — ${fails.length} stage(s) failed:`);
    for (const f of fails) console.log('    ✗ ' + f);
    console.log('\n  Do not start a long run until these are fixed: its failures surface hours later, not immediately.');
    process.exit(1);
  }
  console.log('✓ the hour-long lane is wired: it plans, delegates by designation, forges what it lacks, asks for help without stopping, meters its spend, and survives on disk.');
})().catch((e) => { console.error('✗ autonomy doctor crashed: ' + (e && e.stack || e)); process.exit(1); });
