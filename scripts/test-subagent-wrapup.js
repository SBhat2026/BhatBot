'use strict';
// Does the subagent land the plane when it runs out of steps?
const assert = require('assert');
const sub = require('../lib/subagents');
let pass = 0; const ok=(c,m)=>{assert.ok(c,m);pass++;};

const toolResp = () => ({ content: [{ type:'tool_use', id:'t'+Math.random(), name:'read_file', input:{path:'/a'} }], stop_reason:'tool_use' });
const textResp = (t) => ({ content: [{ type:'text', text:t }], stop_reason:'end_turn' });

(async () => {
  // Exhausts its budget emitting only tool_use — the live failure mode.
  {
    const calls = [];
    const r = await sub.run('research', 'do a thing', {
      anthropicRequest: async (b) => { calls.push(b); return b.tools ? toolResp() : textResp('Here is what I found.'); },
      executeTool: async () => ({ success: true, out: 'data' }),
      toolDefs: [{ name:'read_file' }], apiKey:'x', models:{ sonnet:'s', haiku:'h' },
    }, { maxSteps: 2 });
    ok(r.success === true, 'a step-exhausted run still SUCCEEDS, because it lands the plane');
    ok(r.result === 'Here is what I found.', 'and returns a real answer instead of "(completed, no text output)"');
    const last = calls[calls.length - 1];
    ok(!last.tools, 'the wrap-up call is made with NO tools, so the model must answer rather than keep working');
    ok(/run out of tool budget/i.test(JSON.stringify(last.messages.slice(-1))), 'and is told why it is being asked to stop');
  }
  // If even the wrap-up yields nothing, that is a FAILURE, not a success with a placeholder.
  {
    const r = await sub.run('research', 'x', {
      anthropicRequest: async () => ({ content: [{ type:'tool_use', id:'t', name:'read_file', input:{} }], stop_reason:'tool_use' }),
      executeTool: async () => ({ success:true }), toolDefs:[{name:'read_file'}], apiKey:'x', models:{sonnet:'s',haiku:'h'},
    }, { maxSteps: 1 });
    ok(r.success === false, 'a run that produces no answer at all is reported as a failure');
    ok(/tool budget/.test(r.error), 'with the reason: ' + r.error);
    ok(r.result === '', 'and no placeholder string that a caller might bank as a finding');
  }
  // Normal completion is untouched.
  {
    const r = await sub.run('research', 'x', {
      anthropicRequest: async () => textResp('done and dusted'),
      executeTool: async () => ({}), toolDefs:[], apiKey:'x', models:{sonnet:'s',haiku:'h'},
    }, { maxSteps: 5 });
    ok(r.success === true && r.result === 'done and dusted', 'a normal run is unaffected');
  }
  console.log(`✅ subagent wrap-up: ${pass} assertions passed`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
