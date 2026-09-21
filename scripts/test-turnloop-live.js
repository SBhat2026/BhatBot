#!/usr/bin/env node
'use strict';
// ── THE FULL TURN LOOP, AGAINST THE REAL API ──────────────────────────────────────────────────────
// Every other test in this repo stubs the model. That is correct for logic, and useless for the one
// question this file exists to answer: does a whole turn — prompt → tool_use → real tool → real
// tool_result → next model call → final answer — actually complete against Anthropic, with the
// pairing rules, the history repair and the live tool implementations all in the path at once?
//
// The three tool-loop failures this year (the 683-failure morning brief, the messages.4 orphan, the
// bioart term that was never sent) were all invisible to stubbed tests and all obvious on one real
// run. So this one is real, and it is GATED: it spends money, so it does nothing without --go.
//
//   node scripts/test-turnloop-live.js            # prints what it would do, spends $0
//   node scripts/test-turnloop-live.js --go       # runs it, prints a metered cost
const path = require('path');
const ROOT = path.join(__dirname, '..');
const llm = require(path.join(ROOT, 'lib', 'llm'));
const miniagent = require(path.join(ROOT, 'lib', 'miniagent'));
const pricing = require(path.join(ROOT, 'lib', 'pricing'));

const GO = process.argv.includes('--go');
// Chosen to FORCE at least two tool calls and one synthesis: the answer is not in the weights (it is
// this machine's own disk), and one listing is not enough to answer it.
const TASK = 'Using your tools, look at the directory ' + ROOT + '/lib and tell me: how many .js '
  + 'modules are in it, and what the three largest-sounding subsystems appear to be based on their '
  + 'filenames alone. Then read exactly one of them, failkind.js, and state in one sentence what '
  + 'rule it encodes. Be brief.';

if (!GO) {
  console.log('DRY RUN — no API call made. $0.00 spent.\n');
  console.log('Task that --go would run:\n  ' + TASK.replace(/(.{92})\s/g, '$1\n  ') + '\n');
  console.log('Tools available to the loop: ' + miniagent.TOOLS.map((t) => t.name).join(', '));
  console.log('Model: ' + llm.DEFAULT_MODEL + '   Step cap: ' + miniagent.MAX_STEPS);
  console.log('\nRe-run with --go to execute it for real.');
  process.exit(0);
}

const key = llm.resolveKey('anthropic');
if (!key) { console.error('No Anthropic key reachable from a plain node process.'); process.exit(1); }

const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
const t0 = Date.now();

// Wrap the real request so the loop is untouched but every token is counted. A test that spends
// money and cannot say how much is not a test you can run twice.
async function metered(body) {
  const r = await llm.anthropicRequest(body, { apiKey: key });
  const u = (r && r.usage) || {};
  usage.calls++;
  usage.in += u.input_tokens || 0;
  usage.out += u.output_tokens || 0;
  usage.cacheRead += u.cache_read_input_tokens || 0;
  usage.cacheWrite += u.cache_creation_input_tokens || 0;
  return r;
}

(async () => {
  console.log('[turnloop] model ' + llm.DEFAULT_MODEL + ' — spending real money\n');
  const r = await miniagent.run(TASK, {
    apiKey: key,
    llmImpl: metered,
    log: (m) => console.log('  ' + m),
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const [inRate, outRate] = pricing.tuple(llm.DEFAULT_MODEL);
  const usd = (usage.in / 1e6) * inRate + (usage.out / 1e6) * outRate
            + (usage.cacheRead / 1e6) * inRate * pricing.CACHE_READ
            + (usage.cacheWrite / 1e6) * inRate * pricing.CACHE_WRITE_5M;

  console.log('\n── answer ' + '─'.repeat(70));
  console.log((r.text || '(none)').split('\n').map((l) => '  ' + l).join('\n'));
  console.log('── metered ' + '─'.repeat(69));
  console.log(`  steps        ${r.steps}/${miniagent.MAX_STEPS}`);
  console.log(`  tools used   ${r.toolsUsed.join(' → ') || '(none)'}`);
  console.log(`  deferred     ${r.deferred}`);
  console.log(`  error        ${r.error || 'none'}`);
  console.log(`  api calls    ${usage.calls}   in ${usage.in}  out ${usage.out}  cache r/w ${usage.cacheRead}/${usage.cacheWrite}`);
  console.log(`  wall clock   ${secs}s`);
  console.log(`  COST         $${usd.toFixed(4)}`);

  // A loop that answers without touching a tool has not exercised the pairing path at all, which is
  // the whole point — so that counts as a failure even if the prose reads well.
  const okLoop = !r.error && r.toolsUsed.length >= 2 && r.steps >= 2 && !!r.text;
  console.log('\n' + (okLoop ? '✅ full turn loop: multi-step, tool-using, paired, completed'
                             : '❌ full turn loop did NOT exercise a real multi-step tool turn'));
  process.exit(okLoop ? 0 : 1);
})();
