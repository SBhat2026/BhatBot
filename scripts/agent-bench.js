#!/usr/bin/env node
'use strict';
// ── CAN IT RETRIEVE A FACT, OR DOES IT INVENT ONE? ────────────────────────────────────────────────
// Asks the RUNNING BhatBot questions whose answers are fetched independently, in the same minute,
// from the API that owns the fact. No LLM judge — a model from the same family grading itself shares
// its blind spots, and on a hallucinated number both are confidently wrong together. No downloaded
// dataset either: a stale key marks a correct answer wrong, which is worse than no benchmark.
//
// Every source below is keyless and authoritative. If one is down its question is SKIPPED rather
// than failed, because "the benchmark's own source was unreachable" is not a fact about BhatBot.
//
//   npm run agent:bench            # print the questions and fetch the truth. Spends nothing.
//   npm run agent:bench -- --go    # actually ask BhatBot. Costs money.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { grade, summarize } = require(ROOT + '/lib/agenteval');

const UA = { 'user-agent': 'BhatBot-bench/1.0 (self-evaluation)' };
const get = async (url, ms = 20000) => {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// Each case: a question BhatBot must answer with its tools, and a truth() that fetches the answer
// from the source of record. Chosen so the answer CHANGES — a fact you could memorise proves nothing
// about retrieval.
const CASES = [
  {
    id: 'weather-now',
    ask: 'What is the current temperature in Princeton, New Jersey, in Fahrenheit? Answer with just the number and unit.',
    truth: async () => {
      const j = await get('https://api.open-meteo.com/v1/forecast?latitude=40.3573&longitude=-74.6672&current=temperature_2m&temperature_unit=fahrenheit');
      return { number: j.current.temperature_2m, tolerance: 0.06, absolute: 2, note: `${j.current.temperature_2m}°F via open-meteo` };
    },
  },
  {
    id: 'quake-latest',
    ask: 'Using the USGS earthquake feed, what was the magnitude of the single most recent earthquake worldwide? Just the number.',
    truth: async () => {
      const j = await get('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson');
      const f = (j.features || []).sort((a, b) => b.properties.time - a.properties.time)[0];
      if (!f) throw new Error('no quakes in the last hour');
      return { number: f.properties.mag, tolerance: 0.05, absolute: 0.2, note: `M${f.properties.mag} via USGS` };
    },
  },
  {
    id: 'iss-now',
    ask: 'How many people are currently in space, according to the open-notify astronaut feed? Just the number.',
    truth: async () => {
      const j = await get('http://api.open-notify.org/astros.json');
      return { number: j.number, tolerance: 0, absolute: 0, note: `${j.number} people via open-notify` };
    },
  },
  {
    id: 'hn-top',
    ask: 'What is the title of the current number-one story on Hacker News? Give the title only.',
    truth: async () => {
      const ids = await get('https://hacker-news.firebaseio.com/v0/topstories.json');
      const s = await get(`https://hacker-news.firebaseio.com/v0/item/${ids[0]}.json`);
      // Substring on a distinctive fragment: a title is often paraphrased, and demanding the exact
      // string would fail correct answers.
      const words = String(s.title).split(/\s+/).filter((w) => w.length > 4).slice(0, 3);
      return { anyOf: [s.title, ...words], note: `"${s.title}" via HN` };
    },
  },
  {
    id: 'arxiv-count',
    ask: 'Search arXiv for papers with "protein binder design" in the title and tell me the title of the most recent one.',
    truth: async () => {
      const r = await fetch('http://export.arxiv.org/api/query?search_query=ti:%22protein+binder%22&sortBy=submittedDate&sortOrder=descending&max_results=1', { headers: UA, signal: AbortSignal.timeout(20000) });
      const xml = await r.text();
      const t = (xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/) || [])[1];
      if (!t) throw new Error('no arXiv entry parsed');
      const title = t.replace(/\s+/g, ' ').trim();
      const words = title.split(/\s+/).filter((w) => w.length > 5).slice(0, 3);
      return { anyOf: [title, ...words], note: `"${title.slice(0, 60)}…" via arXiv` };
    },
  },
];

(async () => {
  const go = process.argv.includes('--go');
  console.log(`\n── agent bench ── ${CASES.length} questions, answer keys fetched live\n`);

  const live = [];
  for (const c of CASES) {
    try { const t = await c.truth(); live.push({ ...c, expect: t }); console.log(`  ✓ ${c.id.padEnd(14)} truth: ${t.note}`); }
    catch (e) { console.log(`  – ${c.id.padEnd(14)} SKIPPED — the benchmark's own source failed: ${e.message}`); }
  }
  if (!live.length) { console.log('\n  No sources reachable. Nothing to measure.\n'); process.exit(2); }

  if (!go) {
    console.log(`\n  ${live.length} question(s) ready. Re-run with --go to ask BhatBot (this spends money).\n`);
    for (const c of live) console.log(`    · ${c.ask}`);
    console.log('');
    process.exit(0);
  }

  // Ask through the app's own agent loop, so what is measured is BhatBot, not a bare model call.
  const { execFileSync } = require('child_process');
  const token = process.env.BHATBOT_MCP_TOKEN;
  if (!token) { console.error('\n✗ set BHATBOT_MCP_TOKEN (see the app log: [mcp] listening …/mcp/<token>)\n'); process.exit(2); }

  const rows = [];
  for (const c of live) {
    const t0 = Date.now();
    let answer = '';
    try {
      answer = execFileSync('node', [path.join(ROOT, 'scripts', 'bhatctl.js'), '-q', '-r', c.ask],
        { env: { ...process.env, BHATBOT_MCP_TOKEN: token }, timeout: 180000, encoding: 'utf8' })
        .replace(/\x1b\[[0-9;]*m/g, '').replace(/^.*?BHATBOT\s*/s, '').trim();
    } catch (e) { answer = `(harness error: ${e.message.slice(0, 80)})`; }
    const ms = Date.now() - t0;
    const verdict = grade(answer, c.expect);
    rows.push({ id: c.id, ms, verdict, answer });
    const mark = verdict.ok === true ? '✓' : verdict.ok === null ? '–' : '✗';
    console.log(`\n  ${mark} ${c.id}  (${(ms / 1000).toFixed(1)}s)`);
    console.log(`      truth  : ${c.expect.note}`);
    console.log(`      said   : ${answer.replace(/\n/g, ' ').slice(0, 110)}`);
    console.log(`      verdict: ${verdict.why}`);
  }

  const s = summarize(rows);
  console.log('\n── summary ' + '─'.repeat(58));
  console.log(`  asked ${s.asked} · answered ${s.answered} · correct ${s.correct} · wrong ${s.wrong} · abstained ${s.abstained} · no-answer ${s.noAnswer}`);
  console.log(`  accuracy         ${s.accuracy == null ? '—' : (s.accuracy * 100).toFixed(0) + '%'}   (of the ones it attempted)`);
  console.log(`  FABRICATION      ${s.fabricationRate == null ? '—' : (s.fabricationRate * 100).toFixed(0) + '%'}   (confident and wrong — the number that matters)`);
  console.log(`  median latency   ${s.medianMs != null ? (s.medianMs / 1000).toFixed(1) + 's' : '—'}`);
  if (s.noAnswer) console.log(`\n  ⚠ ${s.noAnswer} turn(s) produced NO answer — an agent or harness failure, excluded from accuracy rather than counted as wrong.`);
  console.log('');
  process.exit(s.fabricated > 0 ? 1 : 0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
