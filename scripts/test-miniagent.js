#!/usr/bin/env node
'use strict';
// Tests for lib/miniagent.js — the read-only tool-loop that lets the headless worker actually RUN a
// scheduled task instead of merely noticing one is overdue.
//
// This thing runs unattended, with no human to catch a mistake, so the assertions that matter are the
// negative ones:
//   1. The tool set is an ALLOW-LIST. No shell, no writes, no browser, no credentials — and it must
//      not quietly grow into a second copy of the main agent.
//   2. It cannot read secrets or escape the home directory, even though it is "only" reading.
//   3. defer_to_app short-circuits the loop. A task needing Mail.app must stop and say so rather than
//      improvise from what it can reach — a brief that silently omits your email is worse than none.
// The model is stubbed, so this is deterministic and free. Wired into `npm run verify`.
//   node scripts/test-miniagent.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mini-'));
const mini = require('../lib/miniagent');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// A scripted model: each entry is one turn's content blocks.
function stubLlm(turns) {
  let i = 0;
  const seen = [];
  const fn = async (body) => { seen.push(body); return { content: turns[Math.min(i++, turns.length - 1)] }; };
  fn.seen = seen;
  return fn;
}
const say = (text) => [{ type: 'text', text }];
const use = (name, input, id = 't1') => [{ type: 'tool_use', id, name, input }];

(async () => {
  // ---- 1. the tool set is an allow-list ----
  {
    const names = mini.TOOLS.map((t) => t.name);
    ok(names.includes('web_search') && names.includes('fetch_url') && names.includes('read_file') && names.includes('list_directory'),
      'tools: the read-only four are present');
    ok(names.includes('defer_to_app'), 'tools: defer_to_app is present');
    const FORBIDDEN = ['run_shell', 'write_file', 'edit_file', 'browser', 'vision_click', 'screen_parse', 'keychain_lookup', 'applescript', 'system_control', 'claude_code', 'deploy_drones'];
    ok(!names.some((n) => FORBIDDEN.includes(n)), 'tools: NOTHING that acts on the world — this must never become a second main agent');
    ok(names.length === 5, `tools: exactly five (got ${names.length}) — a growing list here is the thing to catch in review`);
    ok(/read-only/i.test(mini.SYSTEM) && /defer_to_app/.test(mini.SYSTEM), 'system prompt: states the constraint and the escape hatch');
    ok(/[Nn]ever invent/.test(mini.SYSTEM), 'system prompt: forbids inventing sources (it runs unattended)');
  }

  // ---- 2. path safety ----
  {
    const HOME = os.homedir();
    ok(mini.safePath('~/notes.txt').ok, 'safePath: a home-relative path is allowed');
    ok(mini.safePath(path.join(HOME, 'x/y.md')).ok, 'safePath: an absolute home path is allowed');
    ok(!mini.safePath('/etc/passwd').ok, 'safePath: outside $HOME is refused');
    ok(!mini.safePath(path.join(HOME, '../../etc/passwd')).ok, 'safePath: traversal out of $HOME is refused');
    for (const p of ['~/.bhatbot/config.json', '~/.bhatbot/credentials.json', '~/.ssh/id_rsa', '~/.aws/credentials', '~/.env']) {
      ok(!mini.safePath(p).ok, `safePath: refuses ${p} (reading a secret IS the leak)`);
    }
    ok((await mini.runTool('read_file', { path: '~/.bhatbot/config.json' })).error, 'read_file: a secret path errors rather than returning content');
    ok((await mini.runTool('read_file', { path: '/etc/hosts' })).error, 'read_file: outside $HOME errors');
    ok((await mini.runTool('list_directory', { path: '/etc' })).error, 'list_directory: outside $HOME errors');
  }

  // ---- 3. defer short-circuits ----
  {
    const llmImpl = stubLlm([use('defer_to_app', { needs: 'Mail.app inbox read', partial: 'weather was clear' }), say('should never get here')]);
    const r = await mini.run('read my email', { llmImpl });
    ok(r.deferred === true, 'defer: sets deferred');
    ok(r.needs === 'Mail.app inbox read', 'defer: reports the missing capability');
    ok(r.partial === 'weather was clear', 'defer: keeps partial work so it is not wasted');
    ok(llmImpl.seen.length === 1, 'defer: STOPS the loop immediately (no further model calls)');
  }

  // ---- a normal completion ----
  {
    const llmImpl = stubLlm([say('All done — nothing notable.')]);
    const r = await mini.run('check something', { llmImpl });
    ok(r.deferred === false && r.text === 'All done — nothing notable.', 'run: returns the final text');
    ok(r.steps === 1 && r.toolsUsed.length === 0, 'run: reports steps and tools used');
  }

  // ---- a tool round-trip ----
  {
    const llmImpl = stubLlm([use('list_directory', { path: '~' }), say('I listed the home directory.')]);
    const r = await mini.run('what is in my home dir', { llmImpl });
    ok(r.text === 'I listed the home directory.', 'run: completes after a tool call');
    ok(r.toolsUsed.includes('list_directory'), 'run: records which tools ran');
    const second = llmImpl.seen[1];
    ok(second.messages.length === 3, 'run: assistant turn + tool_result are appended to the conversation');
    ok(second.messages[2].content[0].type === 'tool_result', 'run: the result is sent back as a tool_result block');
  }

  // ---- a failing tool is reported to the model, not thrown ----
  {
    const llmImpl = stubLlm([use('read_file', { path: '/etc/shadow' }), say('That file is off limits, so I stopped.')]);
    const r = await mini.run('read a forbidden file', { llmImpl });
    ok(r.text && !r.error, 'run: a refused tool does not crash the loop');
    ok(llmImpl.seen[1].messages[2].content[0].is_error === true, 'run: the refusal is flagged is_error so the model can react');
  }

  // ---- the step budget is bounded, and still produces something ----
  {
    let calls = 0;
    const llmImpl = async (body) => {
      calls++;
      // Always ask for another tool — a model that never stops.
      if (body.tools) return { content: use('list_directory', { path: '~' }, 't' + calls) };
      return { content: say('Ran out of steps; here is what I had.') };   // the final tool-less turn
    };
    const r = await mini.run('loop forever', { llmImpl, maxSteps: 3 });
    ok(r.steps === 3, 'budget: stops at maxSteps');
    ok(r.truncated === true, 'budget: flags the result as truncated');
    ok(r.text === 'Ran out of steps; here is what I had.', 'budget: still asks for a summary rather than returning nothing');
    ok(r.deferred === false, 'budget: exhaustion is not a deferral');
  }

  // ---- model failure degrades to an error, never a throw ----
  {
    const r = await mini.run('x', { llmImpl: async () => { throw new Error('model down'); } });
    ok(r.error === 'model down' && r.text === null, 'run: a model failure returns an error object, never throws');
  }

  // ---- fetch_url ----
  {
    const html = '<html><head><style>a{}</style><script>bad()</script></head><body><h1>Hi</h1><p>Body &amp; text</p></body></html>';
    const r = await mini.runTool('fetch_url', { url: 'https://example.com' }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) });
    ok(/Hi Body & text/.test(r.text), 'fetch_url: strips tags and decodes entities');
    ok(!/bad\(\)/.test(r.text) && !/a\{\}/.test(r.text), 'fetch_url: drops script and style contents');
    ok((await mini.runTool('fetch_url', { url: 'file:///etc/passwd' })).error, 'fetch_url: refuses non-http schemes');
    ok((await mini.runTool('fetch_url', { url: 'https://x.com' }, { fetchImpl: async () => ({ ok: false, status: 404 }) })).error, 'fetch_url: a 404 is an error, not empty text');
    ok((await mini.runTool('fetch_url', { url: 'https://x.com' }, { fetchImpl: async () => { throw new Error('dns'); } })).error, 'fetch_url: a network failure is caught');
  }

  ok((await mini.runTool('nope', {})).error, 'runTool: an unknown tool errors rather than throwing');
  ok(mini.htmlToText('<p>a</p>   <p>b</p>') === 'a b', 'htmlToText: collapses whitespace');

  // ---- Electron-free ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'miniagent.js'), 'utf8');
    ok(!/require\(['"]electron['"]\)/.test(src), 'lib/miniagent.js: never requires electron');
    ok(!/child_process|execSync|spawn/.test(src), 'lib/miniagent.js: no process execution anywhere in the file');
  }

  // ---- the worker leaves a deferred/failed schedule DUE ----
  {
    const w = fs.readFileSync(path.join(__dirname, 'synapse-worker.js'), 'utf8');
    const block = w.slice(w.indexOf('async function runDueSchedules'), w.indexOf('function printStatus'));
    ok(/if \(r\.deferred\)/.test(block), 'worker: handles the deferred outcome explicitly');
    const deferIdx = block.indexOf('r.deferred');
    const markIdx = block.indexOf('scheduler.markRan');
    ok(deferIdx < markIdx, 'worker: the deferral branch precedes markRan');
    ok(/continue;[\s\S]{0,400}scheduler\.markRan/.test(block), 'worker: deferred and failed runs `continue` BEFORE markRan — the schedule stays due');
    ok(/only on genuine success/.test(block), 'worker: the markRan call documents that it is success-only');
    ok(/hasKey\('anthropic'\)/.test(block), 'worker: without a key it leaves schedules for the app rather than failing them');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
