#!/usr/bin/env node
'use strict';
// The model ceiling: never Fable, Opus only with a per-task yes, and — the part a unit test of the
// policy alone could never establish — applied at EVERY place a request can leave for Anthropic.
//   node scripts/test-modelpolicy.js      (wired into npm run verify)
const fs = require('fs');
const path = require('path');
const { enforce, needsApproval, isForbidden } = require('../lib/modelpolicy');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };
const S = 'claude-sonnet-5', O = 'claude-opus-5';
const ctx = (opusApproved) => ({ opusApproved, fallback: S, ceiling: O });

// ── forbidden: no approval enables it ─────────────────────────────────────────────────────────────
for (const m of ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-mythos-5-2', 'claude-fable-9']) {
  const a = enforce(m, ctx(false)), b = enforce(m, ctx(true));
  ok(a.changed && a.model === S, `${m} without approval → the workhorse (${a.model})`);
  ok(b.changed && b.model === O, `${m} WITH an Opus approval → Opus at most, never itself (${b.model})`);
  ok(isForbidden(m), `${m} is forbidden outright`);
}
ok(/never used/.test(enforce('claude-fable-5-2', ctx(false)).reason), 'and the reason says it is never used, not that it needs asking');

// ── gated: Opus needs a live yes ──────────────────────────────────────────────────────────────────
for (const m of ['claude-opus-5', 'claude-opus-5-5', 'claude-opus-4-8']) {
  const no = enforce(m, ctx(false)), yes = enforce(m, ctx(true));
  ok(no.changed && no.model === S && /go-ahead/.test(no.reason), `${m} without his yes runs on the workhorse and says why`);
  ok(!yes.changed && yes.model === m, `${m} with his yes is sent as asked`);
  ok(needsApproval(m), `${m} is a model that needs asking`);
}

// ── everything he did agree to passes untouched ───────────────────────────────────────────────────
for (const m of ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5']) {
  const r = enforce(m, ctx(false));
  ok(!r.changed && r.model === m && !needsApproval(m), `${m} needs nothing`);
}
// Not a general allowlist: the free local lane and the cross-provider offload must keep working.
for (const m of ['qwen3:latest', 'gemma3:12b', 'gpt-4o-mini', 'gemini-2.0-flash']) {
  ok(!enforce(m, ctx(false)).changed, `${m} is not a Claude tier and is left alone`);
}
ok(!enforce('', ctx(false)).changed && !enforce(undefined, ctx(false)).changed, 'an absent model is not rewritten into one');
ok(enforce('claude-fable-5', {}).model === 'claude-sonnet-5', 'with no context at all it still fails SAFE — to the workhorse, never to the forbidden model');

// ── THE EGRESS INVARIANT ──────────────────────────────────────────────────────────────────────────
//
// main.js carried a comment saying every Anthropic call in the process passes through
// anthropicRequest(). Five did not: the streaming twin, two in lib/adapters.js, lib/eval.js and
// lib/llm.js. A ceiling at one of six doors is the same mistake as a ceiling in the router — a rule
// about the path somebody remembered. So this reads the source: every file that POSTs to
// /v1/messages must apply the policy, and a new egress added without it fails here.
{
  const ROOT = path.join(__dirname, '..');
  const files = ['main.js', 'scripts/synapse-worker.js',
    ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f),
    ...fs.readdirSync(path.join(ROOT, 'lib', 'agents')).filter((f) => f.endsWith('.js')).map((f) => 'lib/agents/' + f),
    ...(fs.existsSync(path.join(ROOT, 'tools')) ? fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => f.endsWith('.js')).map((f) => 'tools/' + f) : [])];
  const egress = [];
  for (const f of files) {
    let src = ''; try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    // A real POST, not a mention in a comment: the URL (or a constant holding it) reaches fetch().
    const posts = /fetch\(\s*['"`]https:\/\/api\.anthropic\.com\/v1\/messages/.test(src)
      || (/['"`]https:\/\/api\.anthropic\.com\/v1\/messages['"`]/.test(src) && /doFetch\(|fetch\(\s*API_URL/.test(src));
    if (posts) egress.push({ f, guarded: /modelpolicy|applyModelCeiling/.test(src) });
  }
  ok(egress.length >= 4, `found the places a request can leave for Anthropic (${egress.map((e) => e.f).join(', ')})`);
  const open = egress.filter((e) => !e.guarded).map((e) => e.f);
  ok(open.length === 0, `every one of them applies the ceiling (unguarded: ${open.join(', ') || 'none'})`);

  // And in main.js specifically, BOTH request functions — the streaming twin is the one that was missed.
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const fnBody = (name) => { const i = main.indexOf('async function ' + name + '('); return i < 0 ? '' : main.slice(i, i + 600); };
  ok(/applyModelCeiling\(body\)/.test(fnBody('anthropicRequest')), 'anthropicRequest applies it');
  ok(/applyModelCeiling\(body\)/.test(fnBody('anthropicStream')), 'anthropicStream applies it too');
  // The router must not ASK for a model the ceiling would refuse, or the approval question names a
  // model that will not run.
  ok(!/return\s+MODEL_FABLE|model:\s*MODEL_FABLE/.test(main), 'nothing in main.js requests Fable any more');
  ok(/if \(!_opusGrantTurn\) _opusApproved = false;/.test(main), 'an Opus approval is cleared at the next turn — it asks each time, not once a session');
  // The one egress the ceiling cannot see: `claude -p` leaves from another process and chooses its
  // own model. Every delegation has to name it.
  const bare = (main.match(/runShell\(\s*'claude -p/g) || []).length;
  ok(bare === 0, `no claude -p delegation inherits the CLI's default model (${bare} unpinned)`);
  ok(/const CLAUDE_CLI = 'claude -p --model sonnet '/.test(main), 'they are pinned to Sonnet');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} modelpolicy: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
