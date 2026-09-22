'use strict';
// Tests for lib/custodian.js — the fifth agent shape: does this answer the question, and should we
// be asking him?
//
// The behavioural change under test is the inversion: ASK IS THE DEFAULT. So roughly half of these
// assert that it stops when it should, and the other half — the ones that matter more — assert that
// it does NOT stop when it shouldn't. A custodian that pauses often gets `autonomous: true` set
// permanently on day two, and then it is protecting nothing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cd = require('../lib/custodian');

let pass = 0;
const ok = (m) => { console.log('✅ ' + m); pass++; };

function rig({ judge, config } = {}) {
  const events = [];
  const parked = [];
  const asked = [];
  const c = cd.createCustodian({
    judge,
    ask: async (q) => { asked.push(q); return null; },
    park: (p) => parked.push(p),
    onEvent: (e) => events.push(e),
    config,
  });
  return { c, events, parked, asked };
}

const yes = async () => ({ answers: true });
const no = (missing) => async () => ({ answers: false, missing: missing || 'it answered a different question' });

async function main() {

// ── it accepts ordinary good work for free ────────────────────────────────────────────────────────
{
  let judgeCalls = 0;
  const { c } = rig({ judge: async () => { judgeCalls++; return { answers: true }; } });
  const r = await c.review({
    prompt: 'summarise the backlog worker failures from september',
    deliverable: 'The backlog worker last ran on 3 September and failed. Fourteen backlog items were attempted once each, none completed.',
  });
  assert.strictEqual(r.verdict, cd.ACCEPT);
  assert.strictEqual(judgeCalls, 0, 'an obviously on-topic answer must not cost a model call');
  assert.strictEqual(r.cost, 0);
  ok('good work is accepted for free — no judge call on the common case');
}

// ── it catches drift: the tools ran, the work is real, the question was different ─────────────────
{
  const { c } = rig({ judge: no('it documented the scheduler instead of the voice pipeline') });
  const r = await c.review({
    prompt: 'write up how the voice pipeline handles barge-in',
    deliverable: 'The scheduler now classifies failures as transient or permanent and backs off accordingly, with host-scoped parking.',
  });
  assert.strictEqual(r.verdict, cd.SENDBACK);
  assert.match(r.directive, /verbatim: "write up how the voice pipeline handles barge-in"/);
  assert.match(r.directive, /WHAT IS MISSING: it documented the scheduler/);
  ok('a real, polished answer to the WRONG question is caught and sent back with the mismatch named');
}

// ── the send-back is bounded ──────────────────────────────────────────────────────────────────────
{
  const { c } = rig({ judge: no('still the wrong thing') });
  const first = await c.review({ prompt: 'write up how the voice pipeline handles barge-in', deliverable: 'Unrelated prose about scheduling.', attempt: 0 });
  assert.strictEqual(first.verdict, cd.SENDBACK);
  const second = await c.review({ prompt: 'write up how the voice pipeline handles barge-in', deliverable: 'Unrelated prose about scheduling.', attempt: 1 });
  assert.strictEqual(second.verdict, cd.ASK, 'after one failed retry it stops guessing and asks');
  assert.match(second.question, /two goes/i);
  ok('one bounded retry, then it asks — it does not loop');
}

// ── ...unless told to run autonomously ────────────────────────────────────────────────────────────
{
  const { c } = rig({ judge: no('wrong thing') });
  const r = await c.review({ prompt: 'write up how the voice pipeline handles barge-in', deliverable: 'Unrelated prose.', attempt: 1, autonomous: true });
  assert.strictEqual(r.verdict, cd.ACCEPT, 'autonomous mode must never block on a question');
  assert.match(r.reason, /running autonomously/);
  ok('autonomous mode never stops to ask — the inversion is opt-out, per task');
}

// ── a dangling referent is caught BEFORE the work starts ──────────────────────────────────────────
{
  const { c } = rig();
  const r = c.inspectRequest('go with the second one');
  assert.strictEqual(r.ask, true);
  assert.strictEqual(r.trigger, 'ambiguous_referent');
  assert.match(r.question, /"the second one"/, 'the question quotes the actual words back');
  ok(`"go with the second one" is caught before any work: ${JSON.stringify(r.question)}`);
}

// ── ...but not when the request names the set ─────────────────────────────────────────────────────
{
  const { c } = rig();
  for (const q of [
    'here are 3 options, go with the second one',
    'of both approaches, take the latter',
    'list the files then open the first one',
  ]) {
    assert.strictEqual(c.inspectRequest(q).ask, false, `"${q}" supplies its own antecedent`);
  }
  ok('a referent with an antecedent in the same sentence is not an ambiguity');
}

// ── it takes the model at its word when it says it is guessing ────────────────────────────────────
{
  const { c } = rig({ judge: yes });
  const r = await c.review({
    prompt: 'set up the deploy for the staging environment',
    deliverable: "I'm assuming you meant the Fly staging app rather than Vercel preview. Which did you want? I've set up Fly for now.",
  });
  assert.strictEqual(r.verdict, cd.ASK);
  assert.match(r.question, /Fly staging app|which did you want/i, 'it reuses the question the model already asked');
  ok('when the model says it is assuming, that becomes a question instead of a silent decision');
}

// ── contradictions between deliberately-overlapped agents ─────────────────────────────────────────
{
  const { c } = rig({ judge: yes });
  const r = await c.review({
    prompt: 'is the cloud brain deployed and reachable',
    deliverable: 'Results differ.',
    contradictions: ['the cloud returns 401, so it is up and auth-gated', 'the cloud is unreachable, DNS does not resolve'],
  });
  assert.strictEqual(r.verdict, cd.ASK);
  assert.strictEqual(r.trigger, 'contradiction');
  assert.match(r.question, /401/);
  assert.match(r.question, /DNS/);
  ok('two agents that cannot both be right becomes a question, not a coin flip');
}

// ── a missing required fact stops it before it starts ─────────────────────────────────────────────
{
  const { c } = rig();
  const r = c.inspectRequest('send the invoice', { knownFacts: { recipient: null, amount: '400' } });
  assert.strictEqual(r.ask, true);
  assert.strictEqual(r.trigger, 'missing_fact');
  assert.match(r.question, /recipient/);
  assert.ok(!/amount/.test(r.question), 'it asks only for what is actually missing');
  ok('a missing required field is asked for before the work, not guessed at');
}

// ── THE IMPORTANT HALF: it does not stop for things it should not ─────────────────────────────────
{
  const { c } = rig({ judge: yes });
  const notWorthStopping = [
    ['what time is it', 'Twenty past four, sir.'],
    ['open spotify', 'Spotify is open.'],
    ['summarise this file', 'It defines the scheduler and its backoff behaviour.'],
    ['is the worker running', 'Yes — pid 37219, last cycle four seconds.'],
  ];
  for (const [prompt, deliverable] of notWorthStopping) {
    const r = await c.review({ prompt, deliverable });
    assert.strictEqual(r.verdict, cd.ACCEPT, `"${prompt}" must not be stopped on`);
    assert.strictEqual(c.inspectRequest(prompt).ask, false, `"${prompt}" must not be pre-empted`);
  }
  ok('ordinary requests with ordinary answers are never interrupted — the custodian stays out of the way');
}

// ── a partial answer the user can see is partial is not a pause ───────────────────────────────────
{
  const { c } = rig({ judge: yes });
  const r = await c.review({
    prompt: 'check all three inboxes for anything urgent',
    deliverable: 'Two inboxes checked, nothing urgent. The third — the Princeton account — is not configured, so I could not read it.',
  });
  assert.strictEqual(r.verdict, cd.ACCEPT, 'honest partial work states its own gap; that is not confusion');
  ok('an honest partial result is accepted — it reports its own gap, which is the opposite of guessing');
}

// ── degradation: no judge means it never blocks ───────────────────────────────────────────────────
{
  const { c } = rig({ judge: null });
  const r = await c.review({ prompt: 'write up how the voice pipeline handles barge-in', deliverable: 'Entirely unrelated prose about gardening.' });
  assert.strictEqual(r.verdict, cd.ACCEPT, 'with no judge it must accept rather than block');
  assert.match(r.reason, /no judge available/);
  assert.strictEqual(r.cost, 0);
  ok('with no judge it degrades to accepting — a reviewer that blocks when it cannot think is worse than none');
}

// ── a throwing judge is the same story ────────────────────────────────────────────────────────────
{
  const { c } = rig({ judge: async () => { throw new Error('rate limited'); } });
  const r = await c.review({ prompt: 'write up the voice pipeline barge-in behaviour', deliverable: 'Unrelated gardening prose.' });
  assert.strictEqual(r.verdict, cd.ACCEPT);
  assert.match(r.reason, /judge unavailable/);
  ok('a judge that throws never blocks the work');
}

// ── an empty deliverable goes straight back ───────────────────────────────────────────────────────
{
  const { c } = rig({ judge: yes });
  const r = await c.review({ prompt: 'build the thing please', deliverable: '' });
  assert.strictEqual(r.verdict, cd.SENDBACK);
  assert.match(r.reason, /empty/);
  assert.strictEqual(r.cost, 0, 'and costs nothing to notice');
  ok('an empty deliverable is sent back for free');
}

// ── pausing speaks, parks, and asks — in that order ───────────────────────────────────────────────
{
  const { c, events, parked, asked } = rig();
  const res = await c.pause({ question: 'Which of the two?', trigger: 'ambiguous_referent', reason: 'two readings' });

  assert.strictEqual(events.length, 1, 'the pause emits an event for the commentary layer');
  assert.strictEqual(events[0].kind, 'needs_input', 'so it is SPOKEN, not just written to a log');
  assert.match(events[0].detail, /two readings/);
  assert.strictEqual(parked.length, 1, 'and the mission is parked');
  assert.strictEqual(parked[0].question, 'Which of the two?');
  assert.strictEqual(asked.length, 1, 'and he is actually asked');
  assert.strictEqual(res.answered, false, 'an unanswered ask reports itself as unanswered');
  ok('a pause speaks it, parks the mission, and asks — a park that only logs is a mission nobody notices');
}

// ── term overlap is a negative filter, and honest about it ────────────────────────────────────────
{
  const { c } = rig();
  assert.ok(c.termOverlap('the voice pipeline barge-in behaviour', 'barge-in in the voice pipeline cuts playback') > 0.5);
  assert.ok(c.termOverlap('the voice pipeline barge-in behaviour', 'gardening tips for autumn') < 0.2);
  assert.strictEqual(c.termOverlap('', 'anything'), 1, 'no terms to match → no evidence of drift');
  assert.deepStrictEqual(c.keyTerms('please can you just get the file for me'), ['file'],
    'stop words are stripped so overlap measures substance');
  ok('overlap measures substance, not length, and an empty prompt is never evidence of drift');
}

// ── nothing throws on degenerate input ────────────────────────────────────────────────────────────
{
  const { c } = rig({ judge: yes });
  for (const [p, d] of [[null, null], [undefined, ''], ['', 'x'], ['x', ''], [{}, []], ['a'.repeat(9000), 'b'.repeat(9000)]]) {
    const r = await c.review({ prompt: p, deliverable: d });
    assert.ok([cd.ACCEPT, cd.SENDBACK, cd.ASK].includes(r.verdict), `verdict for ${JSON.stringify([p, d]).slice(0, 40)}`);
    assert.doesNotThrow(() => c.inspectRequest(p));
  }
  ok('every degenerate input yields a well-formed verdict rather than a throw');
}

// ── every trigger has a human-readable reason ─────────────────────────────────────────────────────
{
  for (const [k, v] of Object.entries(cd.TRIGGERS)) {
    assert.ok(typeof v === 'string' && v.length > 15, `${k} needs a reason a person can act on`);
    assert.ok(!/error|invalid|failed/i.test(v), `${k}: "${v}" reads as a fault; a question is not a fault`);
  }
  ok(`all ${Object.keys(cd.TRIGGERS).length} triggers explain themselves in plain words`);
}


  // ── IS IT ACTUALLY WIRED? ──────────────────────────────────────────────────────────────────────
  // It was not. The Custodian was built, tested and committed, and required by nothing — which made
  // it an idea rather than a check, and left every fleet deliverable going back to Siddhant with
  // nobody having asked whether it answered the question. These assert the SEAM, because a unit test
  // of a module nothing calls passes forever while the feature does not exist.
  {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.ok(/require\('\.\/lib\/custodian'\)/.test(main), 'main.js must actually require it');
    const fleet = main.slice(main.indexOf("case 'deploy_drones'"), main.indexOf("case 'find_papers'"));
    assert.ok(/custodian\.review\(/.test(fleet), 'the review runs on the fan-out path, where deliverables come back');
    assert.ok(/custodian: custody/.test(fleet),
      'the verdict is RETURNED to the model — a check whose result the decider never sees is not a check');
    assert.ok(/synthesis, synthesisError,/.test(fleet),
      'the deliverable still goes back alongside the verdict, never replaced by it');
    ok('the Custodian is wired onto the fleet deliverable path and its verdict reaches the model');
  }

  console.log(`\n✅ custodian: ${pass} groups passed`);
}

main().catch((e) => { console.error('❌ ' + (e && e.stack || e)); process.exit(1); });
