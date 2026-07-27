#!/usr/bin/env node
'use strict';
// Integration guard for the five MISSION SEAMS in main.js. lib/mission.js is unit-tested separately
// (scripts/test-mission.js); this file asserts the seams are actually WIRED — because every one of
// them is a single line that a future refactor could silently drop, and each protects against a
// failure mode that already cost real work:
//
//   S1  open/close        — a mission exists for action tasks, and finish() is the single funnel
//   S2  goal re-anchoring — anchor re-injected after BOTH trim sites (entry + mid-loop)
//   S3  tool journaling   — every tool execution is recorded
//   S4  rate abort        — `history = []` is GONE (it threw away hours of work on a pacing blip)
//   S5  budget park       — running out of steps parks instead of dead-ending
//
// main.js can't be required outside Electron, so this reads it as source and asserts on structure.
// Structural assertions are deliberately anchored to identifiers (not line numbers) so they survive
// ordinary edits and only fail when the seam itself is removed. Wired into `npm run verify`.
//   node scripts/test-mission-seams.js
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
// Scope every assertion to agentLoop's body so a stray match elsewhere in a 9k-line file can't pass.
const loopStart = main.indexOf('async function agentLoop(');
const loopEnd = main.indexOf('\n// ==========', loopStart);
ok(loopStart > 0 && loopEnd > loopStart, 'agentLoop located in main.js');
const loop = main.slice(loopStart, loopEnd);

// ---- S4: the destructive line is GONE (highest severity) ----
// A rate-budget abort used to run `history = []`, discarding the entire conversation — including an
// hours-long run — because of a transient per-minute cap. callModel already tries Ollama, a
// cross-provider offload, waitForBudget pacing, and a harder capTokens retrim before it ever throws.
ok(!/history\s*=\s*\[\]\s*;/.test(loop), 'S4: `history = []` no longer appears in agentLoop');
const rateBlock = loop.slice(loop.indexOf('e.rateBudget'), loop.indexOf('e.rateBudget') + 900);
ok(/rateBudget/.test(rateBlock), 'S4: the rateBudget branch still exists');
ok(/_mission\.park\(/.test(rateBlock), 'S4: a rate abort PARKS the mission instead of discarding it');
ok(/capTokens\(history/.test(rateBlock), 'S4: with no mission it shrinks history via capTokens, never empties it');

// ---- S1: open + close ----
ok(/missions\.open\(\{/.test(loop), 'S1: agentLoop opens a mission');
ok(/opts\.missionId.*missions\.attach\(/s.test(loop), 'S1: a resumed turn attaches the existing mission instead of opening a new one');
ok(/looksLikeToolTask\(_missionGoal\)/.test(loop), 'S1: missions are only opened for ACTION-shaped asks (a chat reply has nothing to resume)');
ok(/loadConfig\(\)\.missions\s*!==\s*false/.test(loop), 'S1: the whole layer is disableable via config.missions');
ok(/_mission\.discard\(\)/.test(loop), 'S1: a short turn discards its mission (no disk litter)');
ok(/MISSION_MIN_STEPS/.test(loop), 'S1: the discard threshold is a named constant');
ok(/goal:\s*_missionGoal/.test(loop), 'S1: the goal is stored from the user text, not a summary');

// close must live in finish(), the single funnel every exit path returns through.
const finishStart = loop.indexOf('const finish =') >= 0 ? loop.indexOf('const finish =') : loop.indexOf('finish = ');
const finishBody = loop.slice(finishStart, loop.indexOf('// PERSISTENCE profile'));
ok(/_mission\.close\(/.test(finishBody), 'S1: finish() closes the mission (the one funnel every exit uses)');
ok(/\.status;/.test(finishBody) && /===\s*'parked'/.test(finishBody), 'S1: finish() leaves an already-parked mission parked (never strands resumable work)');
ok(/_activeMission\s*=\s*null/.test(finishBody), 'S1: finish() clears the active-mission pointer');

// ---- S2: goal re-anchoring after BOTH trims ----
const anchorCalls = (loop.match(/_mission\.anchor\(/g) || []).length;
ok(anchorCalls >= 2, `S2: anchor injected at both trim sites (found ${anchorCalls})`);
const midLoop = loop.slice(loop.indexOf('estimateTokens(history) > contextTrimBudget()'));
ok(/_mission\.anchor\(/.test(midLoop.slice(0, 800)), 'S2: the MID-LOOP trim re-anchors (this is where a long run loses its goal)');
const entry = loop.slice(0, loop.indexOf('const finish ='));
ok(/trimHistory\(history, apiKey\)[\s\S]{0,400}_mission\.anchor\(/.test(entry), 'S2: the ENTRY trim re-anchors too');
ok(/role:\s*'user',\s*content:\s*_mission\.anchor/.test(loop), 'S2: the anchor is appended as a user message (lands at the tail, where attention is)');

// ---- S3: tool journaling ----
ok(/_mission\.step\(\{/.test(loop), 'S3: every tool execution is journaled');
ok(/_mission\.step\(\{[^}]*result[,}]/.test(loop), 'S3: the journal entry carries the result (digested inside lib/mission.js)');
ok(/rstate\.event\('tool',/.test(loop), 'S3: a trace span is emitted alongside the journal row');

// ---- S5: budget exhaustion parks ----
const tail = loop.slice(loop.indexOf('reached the step budget'));
ok(/_mission\.park\(/.test(tail), 'S5: exhausting the step budget PARKS the mission rather than ending the task');
ok(/step-budget/.test(tail), 'S5: the park reason distinguishes step-budget from rate-budget (they get different backoffs)');
ok(/missionAutoContinue\s*!==\s*false/.test(tail), 'S5: auto-continue is disableable via config.missionAutoContinue');
ok(/Do NOT call any more tools/.test(tail), 'S5: the human-facing progress summary is preserved');

// ---- replay memoization is gated on PARALLEL_SAFE ----
const replayBlock = loop.slice(loop.indexOf('_replay && _replay.active'), loop.indexOf('_replay && _replay.active') + 1200);
ok(/PARALLEL_SAFE\.has\(block\.name\)/.test(replayBlock), 'replay: gated on PARALLEL_SAFE — run_shell/write_file are never replayed');
ok(/_replay\.diverge\(\)/.test(replayBlock), 'replay: diverges (goes cold) once the run stops matching the journal');
ok(/replayed from step/.test(replayBlock), 'replay: a replayed result is LABELLED so the model knows it is cached, not fresh');
ok(/opts\.missionId/.test(loop.slice(0, loop.indexOf('_replay = _mission.replay()'))), 'replay: only ever built for a RESUMED mission');

// ---- continuity driver (outside agentLoop) ----
ok(/async function tickMissions\(\)/.test(main), 'continuity: tickMissions exists');
ok(/async function resumeMission\(/.test(main), 'continuity: resumeMission exists');
ok(/function reapOrphanMissions\(\)/.test(main), 'continuity: reapOrphanMissions exists');
const tick = main.slice(main.indexOf('async function tickScheduler()'), main.indexOf('async function runScheduledTask('));
ok(/tickMissions\(\)/.test(tick), 'continuity: missions ride the existing 30s scheduler tick');
ok(tick.indexOf('agentState !== \'idle\'') < tick.indexOf('tickMissions()'), 'continuity: the idle guard runs BEFORE mission resume (always yields to the user)');
ok(tick.indexOf('schedulerBusy') < tick.indexOf('tickMissions()'), 'continuity: the serial guard also precedes it');

const tickBody = main.slice(main.indexOf('async function tickMissions()'), main.indexOf('async function resumeMission('));
ok(/_missionRunning/.test(tickBody), 'continuity: a re-entrancy guard prevents two resumes at once');
ok(/verdict\.ready\[0\]/.test(tickBody), 'continuity: SERIAL — exactly one mission resumes per tick');
ok(/verdict\.expired/.test(tickBody) && /\.abandon\(/.test(tickBody), 'continuity: missions past a cap are abandoned, not retried forever');

// The circuit breakers must be read from config/disk, never hardcoded into the loop.
const caps = main.slice(main.indexOf('function missionCaps()'), main.indexOf('let _missionRunning'));
ok(/missionMaxResumes/.test(caps) && /missionBudgetUsd/.test(caps) && /missionMaxAgeHours/.test(caps),
  'continuity: all three circuit breakers (resumes / spend / age) are configurable');
ok(/\|\|\s*20/.test(caps) && /\|\|\s*5/.test(caps) && /\|\|\s*24/.test(caps), 'continuity: breakers have safe defaults (20 resumes / $5 / 24h)');

// Boot ordering: adopt orphans BEFORE the tick starts, or the first tick races the reap.
const boot = main.slice(main.indexOf('reapOrphanMissions();'), main.indexOf('reapOrphanMissions();') + 300);
ok(boot.indexOf('reapOrphanMissions();') < boot.indexOf('startScheduler();'), 'boot: orphans are adopted before the scheduler starts ticking');

// ---- the mission_plan tool ----
ok(/case 'mission_plan':/.test(main), 'mission_plan: handler wired into executeTool');
const tool = main.slice(main.indexOf("case 'mission_plan':"), main.indexOf("case 'agent_team':"));
ok(/_activeMission/.test(tool), 'mission_plan: reads the active mission');
ok(/success:\s*true[^}]*plan:\s*\[\]/.test(tool), 'mission_plan: degrades to a harmless no-op when no mission is active');
ok(/m\.plan\.set\(/.test(tool) && /m\.plan\.mark\(/.test(tool) && /m\.plan\.read\(\)/.test(tool), 'mission_plan: set / mark / read all implemented');
ok(/slice\(0,\s*40\)/.test(tool), 'mission_plan: plan length is bounded');

const schema = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools-schema.js'), 'utf8');
ok(/name:\s*'mission_plan'/.test(schema), 'mission_plan: declared in the tool schema');
ok(require('../lib/toolselect').CORE.includes('mission_plan'), 'mission_plan: in the CORE set (retrieval can never drop it)');

// ---- loop breaker ----
ok(/detectLoop\(seenSigs\)/.test(loop), 'loop breaker: wired into the turn loop against seenSigs');
ok(/_loopNudged/.test(loop), 'loop breaker: fires at most once per turn (the nudge cannot become the loop)');
ok(/LOOP DETECTED/.test(loop), 'loop breaker: injects a corrective directive');
ok(/loadConfig\(\)\.loopBreaker\s*!==\s*false/.test(loop), 'loop breaker: disableable via config.loopBreaker');

// ---- mission-aware step budget ----
const budgetBlock = loop.slice(loop.indexOf('let maxIters ='), loop.indexOf('const HARD_CEILING'));
ok(/resumeCount/.test(budgetBlock), 'budget: a resumed mission starts with more headroom than a fresh turn');
ok(/Math\.min\(_resumes \* 10, 40\)/.test(budgetBlock), 'budget: the extra headroom is capped (no infinite ratchet)');

// ---- pacing visibility ----
const wait = main.slice(main.indexOf('async function waitForBudget('), main.indexOf('async function ollamaUp('));
ok(/still pacing/.test(wait), 'pacing: a long rate wait keeps reporting (silence reads as a hang)');
ok(/lastTick/.test(wait), 'pacing: the countdown is throttled, not emitted every poll');

// ---- the model is TOLD any of this exists ----
const prompt = fs.readFileSync(path.join(__dirname, '..', 'lib', 'static-prompt.js'), 'utf8');
ok(/MISSION ANCHOR/.test(prompt), 'prompt: explains what a MISSION ANCHOR block is');
ok(/mission_plan/.test(prompt), 'prompt: tells the model to externalize a long plan');
ok(/PARKED/.test(prompt), 'prompt: explains that a long task can park and resume (so it never fakes a finish)');
ok(/replayed from step/.test(prompt), 'prompt: explains replayed results');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
