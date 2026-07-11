'use strict';
// T1 — intake router tests. The load-bearing invariant: NO action prompt is ever classified 'chat'
// (a false 'chat' is a broken task). Chat prompts stay chat (fast path); the rest are 'ambiguous'
// (which routes to agentLoop, never the tool-less fast path).
const { classifyIntake } = require('../lib/pure');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

// A stand-in for main.js's looksLikeToolTask: catches live-data questions the verbs miss.
const looksLikeToolTask = (t) => /\b(weather|forecast|score|standings?|world cup|stock|price|news|who'?s winning|latest)\b/i.test(t);
const opts = { looksLikeToolTask };

const ACTION = [
  'open the world cup standings and read me the top of group C',
  'run the sim',
  'edit main.js and fix the router',
  'deploy drones for the protein analysis',
  'send an email to my advisor',
  'search bioart for a t cell illustration',
  'what is the weather in Paris',                 // live-data question → tool
  'add a meeting to my calendar tomorrow at 3',
  'go to duffel.com and book a flight',
  'summarize this pdf: /Users/sid/paper.pdf',
];
const CHAT = [
  'hi', 'hey there', 'thanks!', 'what is the capital of France',
  'how are you', 'why is the sky blue',
];
const AMBIG = [
  'the mitochondria thing we discussed',
  'I was thinking about the protein folding problem again',
  'that seems off',
  'maybe something with more contrast',
];

for (const p of ACTION) ok(classifyIntake(p, opts) === 'action', `action: "${p.slice(0, 42)}"`);
// The hard invariant, stated as its own assertion:
ok(ACTION.every((p) => classifyIntake(p, opts) !== 'chat'), 'INVARIANT: no action prompt classified chat');
for (const p of CHAT) ok(classifyIntake(p, opts) === 'chat', `chat: "${p}"`);
for (const p of AMBIG) { const r = classifyIntake(p, opts); ok(r === 'ambiguous' || r === 'action', `ambiguous(→agentLoop): "${p}" = ${r}`); }
ok(AMBIG.every((p) => classifyIntake(p, opts) !== 'chat'), 'INVARIANT: no ambiguous prompt classified chat');

// in-tool-thread → always action
ok(classifyIntake('yes', { inToolThread: true }) === 'action', 'thread: continuation → action');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
