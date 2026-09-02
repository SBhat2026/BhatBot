'use strict';
// Does the subagent land the plane when it runs out of steps — and can it still form a legal request
// after 40 turns of tool loops?
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sub = require('../lib/subagents');
let pass = 0; const ok=(c,m)=>{assert.ok(c,m);pass++;};

// EVERY run() below writes a persistent history. Without this, they land in
// ~/.bhatbot/subagents/*.json — the LIVE memory of the real research and coding specialists. That is
// not hypothetical: it happened, 26 of research.json's 40 messages were this file's fixtures, and the
// resulting orphaned tool_result at the send-window boundary 400'd every real delegation for days.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-subagent-test-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const toolResp = () => ({ content: [{ type:'tool_use', id:'t'+Math.random(), name:'read_file', input:{path:'/a'} }], stop_reason:'tool_use' });
const textResp = (t) => ({ content: [{ type:'text', text:t }], stop_reason:'end_turn' });

(async () => {
  // Exhausts its budget emitting only tool_use — the live failure mode.
  {
    const calls = [];
    const r = await sub.run('research', 'do a thing', {
      anthropicRequest: async (b) => { calls.push(b); return b.tools ? toolResp() : textResp('Here is what I found.'); },
      executeTool: async () => ({ success: true, out: 'data' }),
      toolDefs: [{ name:'read_file' }], apiKey:'x', models:{ sonnet:'s', haiku:'h' }, dir: DIR,
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
      executeTool: async () => ({ success:true }), toolDefs:[{name:'read_file'}], apiKey:'x', models:{sonnet:'s',haiku:'h'}, dir: DIR,
    }, { maxSteps: 1 });
    ok(r.success === false, 'a run that produces no answer at all is reported as a failure');
    ok(/tool budget/.test(r.error), 'with the reason: ' + r.error);
    ok(r.result === '', 'and no placeholder string that a caller might bank as a finding');
  }
  // Normal completion is untouched.
  {
    const r = await sub.run('research', 'x', {
      anthropicRequest: async () => textResp('done and dusted'),
      executeTool: async () => ({}), toolDefs:[], apiKey:'x', models:{sonnet:'s',haiku:'h'}, dir: DIR,
    }, { maxSteps: 5 });
    ok(r.success === true && r.result === 'done and dusted', 'a normal run is unaffected');
  }
  // ── THE SEND WINDOW MUST BE A LEGAL REQUEST ────────────────────────────────────────────────────
  // This is the bug that took `research` and `coding` down for days: slice(-32) counts MESSAGES, but
  // a tool loop spans two of them, so the window could open on a tool_result whose tool_use had been
  // cut away. The API 400s on that, in ~250ms, forever — the history is written straight back at the
  // same length, so the orphan never clears.
  //
  // Asserted STRUCTURALLY (is every request well-formed?) rather than by matching an error string,
  // so it holds regardless of how the API words the rejection.
  const wellFormed = (msgs) => {
    if (!msgs.length) return 'empty';
    if (msgs[0].role !== 'user') return 'opens on ' + msgs[0].role;
    const uses = new Set(), results = new Set();
    for (const m of msgs) for (const b of (Array.isArray(m.content) ? m.content : [])) {
      if (b.type === 'tool_use') uses.add(b.id);
      if (b.type === 'tool_result') results.add(b.tool_use_id);
    }
    for (const id of results) if (!uses.has(id)) return 'orphaned tool_result ' + id;
    for (const id of uses) if (!results.has(id)) return 'dangling tool_use ' + id;
    return null;
  };
  {
    // Drive one specialist through enough tool loops to blow well past both caps, exactly as the
    // backlog worker does night after night.
    let bad = null, requests = 0;
    for (let i = 0; i < 30 && !bad; i++) {
      await sub.run('coding', 'task ' + i, {
        anthropicRequest: async (b) => {
          requests++;
          const why = wellFormed(b.messages);
          if (why && !bad) bad = `request ${requests} (delegation ${i}) was malformed: ${why}`;
          return b.tools && requests % 2 ? toolResp() : textResp('ok ' + i);
        },
        executeTool: async () => ({ success: true, out: 'data' }),
        toolDefs: [{ name:'read_file' }], apiKey:'x', models:{ sonnet:'s', haiku:'h' }, dir: DIR,
      }, { maxSteps: 4 });
    }
    ok(!bad, 'every request stays well-formed across 30 delegations and both caps — ' + (bad || `${requests} requests checked`));
    const stored = JSON.parse(fs.readFileSync(path.join(DIR, 'coding.json'), 'utf8'));
    ok(stored.length <= sub.HIST_CAP, `the persisted history stays capped (${stored.length} <= ${sub.HIST_CAP})`);
    ok(!wellFormed(sub.windowMessages(stored, sub.SEND_CAP)), 'and what is on DISK still yields a legal send window after the run');
  }
  // The precise live corruption, reconstructed: a result whose tool_use sits one message outside.
  // Shaped like a real store — delegations separated by a plain-text task message, each followed by
  // a few tool loops — because that boundary is what makes a legal window reachable at all.
  {
    const h = [];
    for (let d = 0; d < 12; d++) {
      h.push({ role:'user', content:'delegation ' + d });
      for (let i = 0; i < 3; i++) {
        const id = `u${d}.${i}`;
        h.push({ role:'assistant', content:[{ type:'tool_use', id, name:'read_file', input:{} }] });
        h.push({ role:'user', content:[{ type:'tool_result', tool_use_id:id, content:'x' }] });
      }
    }
    const naive = h.slice(-32);
    ok(!!wellFormed(naive), 'the naive slice(-32) IS malformed — ' + wellFormed(naive) + ' (this is what shipped)');
    const win = sub.windowMessages(h, 32);
    ok(!wellFormed(win), 'windowMessages trims to a legal boundary instead');
    ok(win.length <= 32 && win.length > 0, `and keeps a useful amount of context (${win.length} messages)`);
    ok(typeof win[0].content === 'string', 'landing on a delegation boundary, so a whole task is kept intact');
  }
  // Degenerate: a history that is nothing but tool loops has NO legal boundary to snap to. The
  // window must still never be malformed — better a short request than a rejected one.
  {
    const h = [];
    for (let i = 0; i < 40; i++) {
      h.push({ role:'assistant', content:[{ type:'tool_use', id:'u'+i, name:'read_file', input:{} }] });
      h.push({ role:'user', content:[{ type:'tool_result', tool_use_id:'u'+i, content:'x' }] });
    }
    const win = sub.windowMessages(h, 32);
    ok(win.length === 0 || !wellFormed(win), 'a boundary-free history yields an empty window, never a malformed one');
  }
  // Damage from any other source heals on load rather than requiring reset().
  {
    const damaged = [
      { role:'user', content:[{ type:'tool_result', tool_use_id:'gone', content:'x' }] },   // orphan
      { role:'user', content:'a real question' },
      { role:'assistant', content:[{ type:'tool_use', id:'never-answered', name:'read_file', input:{} }] },
    ];
    const fixed = sub.repairHistory(damaged);
    ok(!wellFormed(fixed), 'repairHistory strips both an orphaned tool_result and a dangling tool_use');
    ok(fixed.length === 1 && fixed[0].content === 'a real question', 'and keeps the genuine turn');
  }
  // ...and that repair is actually WIRED INTO the load path. Testing repairHistory() directly proves
  // the unit works; it does not prove anything calls it. The damage here is deliberately placed in
  // the MIDDLE of a short history, where boundary-trimming cannot help — so only the load-time repair
  // can save the request.
  {
    fs.writeFileSync(path.join(DIR, 'lifeadmin.json'), JSON.stringify([
      { role:'user', content:'an earlier question' },
      { role:'assistant', content:[{ type:'text', text:'answered' }] },
      { role:'user', content:[{ type:'tool_result', tool_use_id:'vanished', content:'x' }] },   // mid-history orphan
      { role:'assistant', content:[{ type:'text', text:'more' }] },
    ], null, 2));
    let seen = null;
    await sub.run('lifeadmin', 'next task', {
      anthropicRequest: async (b) => { seen = seen || wellFormed(b.messages); return textResp('fine'); },
      executeTool: async () => ({}), toolDefs: [], apiKey:'x', models:{ sonnet:'s', haiku:'h' }, dir: DIR,
    }, { maxSteps: 1 });
    ok(!seen, 'a store damaged in the MIDDLE is repaired on load, not just at the boundary — ' + (seen || 'request was legal'));
  }
  // The file left on disk must itself be legal, so the next launch does not inherit the damage.
  {
    const onDisk = JSON.parse(fs.readFileSync(path.join(DIR, 'lifeadmin.json'), 'utf8'));
    ok(!wellFormed(sub.windowMessages(onDisk, sub.SEND_CAP)), 'and what gets WRITTEN BACK is legal too');
    ok(!JSON.stringify(onDisk).includes('vanished'), 'the orphan is gone from the store, not merely skipped at send time');
  }
  console.log(`✅ subagent wrap-up: ${pass} assertions passed`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
