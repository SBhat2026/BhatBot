#!/usr/bin/env node
'use strict';
// End-to-end smoke test — drives the RUNNING BhatBot app through its real agent loop (same
// path the phone/desktop use) and asserts on actual behavior, not the engine in isolation.
// This is the "realistic test" that catches integration bugs (wrong routing, leaked <thinking>,
// a tool never invoked) that unit-testing lib/worldcup.js can't. Logs PASS/FAIL to
// SMOKE_LOG.md so failures seed the self_fix / self_improve loop.
//
//   npm run smoke            (app must be running — npm start)
//
// Each case: send a prompt, read the activity trace, assert. Exit non-zero on any FAIL.

const fs = require('fs');
const os = require('os');
const path = require('path');

const c = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8')); } catch { return {}; } })();
const URL = `http://127.0.0.1:${c.mcpPort || 8788}`;
const TOKEN = c.mcpToken;
const LOG = path.join(__dirname, '..', 'SMOKE_LOG.md');

const CASES = [
  { name: 'world-cup-update', prompt: 'Can you give me an update on the World Cup?',
    wantTool: 'world_cup', noStale: /next (men'?s )?world cup|don'?t have real-?time|2022/i },
  { name: 'predict-matchup', prompt: 'Predict France vs Brazil in the World Cup',
    wantTool: 'world_cup', wantText: /%|percent|favored|chance|odds/i },
  { name: 'group-standings', prompt: "who's winning group A?",
    wantTool: 'world_cup' },
  { name: 'date-grounding', prompt: "What's today's date?",
    wantText: /2026/, noStale: /2024|2025/ },
];
// Every reply must be free of leaked reasoning / meta-narration.
const LEAK = /<\/?think(ing)?>|^\s*(the user is|let me think|i should|i need to|first,? i)/im;

async function api(p, body, method = 'POST', timeoutMs = 600000) {
  const r = await fetch(`${URL}${p}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  return r.json().catch(() => ({}));
}

async function run() {
  if (!TOKEN) { console.error('✗ no mcpToken in config'); process.exit(2); }
  try { const h = await fetch(`${URL}/health`, { headers: { Authorization: 'Bearer ' + TOKEN }, signal: AbortSignal.timeout(3000) }); if (!h.ok) throw 0; }
  catch { console.error('✗ app not reachable at ' + URL + ' — run `npm start` first.'); process.exit(1); }

  const results = [];
  for (const t of CASES) {
    let res, trace = '', text = '';
    const fails = [];
    try {
      const seed = await api(`/api/${TOKEN}/activity?since=0`, null, 'GET', 8000);
      const cursor = (seed && seed.seq) || 0;
      // Fresh conversation per case: otherwise World Cup data from earlier cases lingers in
      // history and the model answers from context WITHOUT re-calling world_cup → false "not called"
      // failures (same artifact fixed in complex-eval). reset → runAgentHeadless clears mcpHistory.
      res = await api(`/api/${TOKEN}/chat`, { text: t.prompt, new_conversation: true });
      const act = await api(`/api/${TOKEN}/activity?since=${cursor}`, null, 'GET', 8000);
      trace = (act.events || []).map((e) => e.text).join(' | ');
      text = (res && res.text) || '';
    } catch (e) {
      fails.push('request failed/timeout: ' + (e.message || e));
      res = {};
    }
    if (res.error) fails.push('error: ' + res.error);
    if (t.wantTool && !new RegExp(t.wantTool).test(trace)) fails.push(`tool ${t.wantTool} not called`);
    if (t.wantText && !t.wantText.test(text)) fails.push('reply missing ' + t.wantText);
    if (t.noStale && t.noStale.test(text)) fails.push('stale/forbidden phrase: ' + t.noStale);
    if (LEAK.test(text)) fails.push('leaked reasoning/meta in reply');
    const ok = fails.length === 0;
    results.push({ name: t.name, ok, fails, text: text.slice(0, 120) });
    console.log(`${ok ? '✅' : '⚠'} ${t.name}${ok ? '' : ' — ' + fails.join('; ')}`);
    if (!ok) console.log('   reply: ' + text.slice(0, 160));
  }

  const pass = results.filter((r) => r.ok).length;
  const stamp = new Date().toISOString();
  const md = `\n## ${stamp} — ${pass}/${results.length} passed\n` +
    results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} **${r.name}**${r.ok ? '' : ' — ' + r.fails.join('; ')}\n  - reply: ${r.text}`).join('\n') + '\n';
  try { fs.appendFileSync(LOG, md); } catch {}
  console.log(`\n${pass}/${results.length} passed → logged to SMOKE_LOG.md`);
  process.exit(pass === results.length ? 0 : 1);
}
run();
