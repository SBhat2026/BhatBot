#!/usr/bin/env node
'use strict';
// Complex-task evaluation — drives the RUNNING BhatBot through HARDER, multi-step requests than
// smoke.js (which checks single tool calls). These exercise: multi-tool single-turn plans, tool
// output → judgment/opinion, comparison/reasoning, and conditional logic. It asserts on the tool
// TRACE (which + how many tools), the final reply, staleness, and leaked reasoning, and records
// per-case latency + tool count. Results append to EVAL_LOG.md (seeds self_fix / self_improve).
//
//   npm run eval            (app must be running — npm start)
//
// Exit non-zero on any FAIL.

const fs = require('fs');
const os = require('os');
const path = require('path');

const c = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8')); } catch { return {}; } })();
const URL = `http://127.0.0.1:${c.mcpPort || 8788}`;
const TOKEN = c.mcpToken;
const LOG = path.join(__dirname, '..', 'EVAL_LOG.md');

// wantTools: every tool name must appear in the trace. minTools: at least N tool calls.
// wantAll: every regex must match the reply. wantAny: at least one must match. opinion: must read
// like a recommendation/judgment, not a data dump.
// Recommendation/justification language — covers how a model naturally expresses a pick + reason
// ("here's why", "flip it on", "the real story", "worth a watch"), not just literal "I'd"/"because".
const OPINION = /\bi'?d\b|i would|i'?d say|my (take|pick|call|money|bet)|go with|i'?d back|worth (a )?(watch|watching|your)|recommend|honestly|if i were|i'?d watch|because|since|the edge|lean|here'?s why|why watch|the (real )?story|flip it on|tune in|don'?t miss|must.?watch|should watch|verdict|the one to (watch|catch)|reason to|tonight|drama/i;
const CASES = [
  { name: 'watch-recommendation',
    prompt: "What World Cup match should I watch and why? Give me your honest take.",
    wantTools: ['world_cup'], wantAll: [OPINION], minTools: 1,
    noStale: /next (men'?s )?world cup|don'?t have real-?time|2022|i can'?t (watch|access)/i },
  { name: 'multi-tool-brief',
    prompt: "Give me a quick two-line brief: the top world news headline, and one World Cup match worth watching. Keep it tight.",
    wantTools: ['news', 'world_cup'], minTools: 2 },
  { name: 'news-judgment',
    prompt: "Skim today's world news and tell me the single most important story right now and why it matters.",
    wantTools: ['news'], wantAll: [/matters|important|because|significant|key|biggest/i], minTools: 1,
    noStale: /i can'?t (browse|access)|as an ai|don'?t have access/i },
  { name: 'predict-with-reasoning',
    prompt: "Predict Argentina vs Spain in the World Cup, then tell me which side you'd back and why.",
    wantTools: ['world_cup'], wantAll: [/%|percent|favored|chance|edge/i, OPINION], minTools: 1 },
  { name: 'compare-groups',
    prompt: "Compare Group A and Group B in the World Cup — which group looks tougher, and who's in control of each?",
    wantTools: ['world_cup'], wantAll: [/group a/i, /group b/i], minTools: 1 },
  { name: 'conditional-live',
    prompt: "If any World Cup match is live right now, give me the score; otherwise tell me the next big one to look out for.",
    wantTools: ['world_cup'], minTools: 1,
    noStale: /i can'?t check|don'?t have real-?time|2022/i },
  // W1 regression guards — confirm two-stage tool retrieval still surfaces NON-live-data tools
  // (filesystem, web) for the right intent, not just the World-Cup/news cluster.
  { name: 'list-files',
    prompt: "List the files and folders directly inside my home directory. Just the listing.",
    wantTools: ['list_directory|run_shell'] },
  { name: 'fetch-page',
    prompt: "Fetch https://example.com and tell me the page's title or main heading.",
    wantTools: ['fetch_url|browser'], wantAny: [/example/i, /illustrative|domain/i] },
];
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
    let res = {}, trace = '', text = '', toolCalls = [], ms = 0;
    const fails = [];
    try {
      const seed = await api(`/api/${TOKEN}/activity?since=0`, null, 'GET', 8000);
      const cursor = (seed && seed.seq) || 0;
      const t0 = Date.now();
      // Each case is independent — reset the conversation so a prior case's tool results don't sit
      // in context and let the model answer THIS prompt without re-calling the tool (false negative).
      res = await api(`/api/${TOKEN}/chat`, { text: t.prompt, new_conversation: true });
      ms = Date.now() - t0;
      const act = await api(`/api/${TOKEN}/activity?since=${cursor}`, null, 'GET', 8000);
      const events = act.events || [];
      trace = events.map((e) => e.text).join(' | ');
      // tool events are surfaced as type 'tool' (cloud) or "🔧"/tool-name tokens in the trace.
      toolCalls = events.filter((e) => e.type === 'tool' || /tool/i.test(e.type || '')).map((e) => e.text);
      text = (res && res.text) || '';
    } catch (e) { fails.push('request failed/timeout: ' + (e.message || e)); }

    if (res.error) fails.push('error: ' + res.error);
    for (const tool of (t.wantTools || [])) if (!new RegExp(tool).test(trace)) fails.push(`tool ${tool} not called`);
    if (t.minTools) { const n = (trace.match(/world_cup|news|web_fetch|fetch_url|web_search/g) || []).length; if (n < t.minTools) fails.push(`only ${n} tool call(s), wanted ≥${t.minTools}`); }
    for (const re of (t.wantAll || [])) if (!re.test(text)) fails.push('reply missing ' + re);
    if (t.wantAny && !t.wantAny.some((re) => re.test(text))) fails.push('reply matched none of wantAny');
    if (t.noStale && t.noStale.test(text)) fails.push('stale/forbidden phrase: ' + t.noStale);
    if (LEAK.test(text)) fails.push('leaked reasoning/meta in reply');

    const ok = fails.length === 0;
    results.push({ name: t.name, ok, fails, ms, text: text.slice(0, 160) });
    console.log(`${ok ? '✅' : '⚠'} ${t.name}  (${(ms / 1000).toFixed(1)}s)${ok ? '' : ' — ' + fails.join('; ')}`);
    if (!ok) console.log('   reply: ' + text.slice(0, 220));
  }

  const pass = results.filter((r) => r.ok).length;
  const stamp = new Date().toISOString();
  const md = `\n## ${stamp} — ${pass}/${results.length} passed (complex-eval)\n` +
    results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} **${r.name}** (${(r.ms / 1000).toFixed(1)}s)${r.ok ? '' : ' — ' + r.fails.join('; ')}\n  - reply: ${r.text}`).join('\n') + '\n';
  try { fs.appendFileSync(LOG, md); } catch {}
  console.log(`\n${pass}/${results.length} passed → logged to EVAL_LOG.md`);
  process.exit(pass === results.length ? 0 : 1);
}
run();
