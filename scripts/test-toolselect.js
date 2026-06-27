#!/usr/bin/env node
'use strict';
// Tests for lib/toolselect.js — two-stage tool retrieval that runs on EVERY turn (cosine top-k +
// always-present CORE). Key invariants: (1) graceful degradation — returns null ("use full catalog")
// with no embedding key / tiny catalog, so the agent is NEVER stranded; (2) CORE escape-hatches +
// self_reflect are always kept; (3) ranking returns a strict subset, preserves catalog order, keeps
// un-vectored tools. semantic is monkey-patched (same required object) for deterministic ranking.
// Temp $HOME isolates the vec cache. Wired into `npm run verify`.
//   node scripts/test-toolselect.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-toolsel-'));
process.env.HOME = TMP;
const semantic = require('../lib/semantic');
const ts = require('../lib/toolselect');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- CORE invariants (locks the Phase-5 self_reflect-in-CORE + the escape hatches) ----
for (const n of ['save_memory', 'read_file', 'write_file', 'run_shell', 'notify_user', 'ask_ai', 'request_permissions', 'self_reflect'])
  ok(ts.CORE.includes(n), `CORE includes "${n}"`);

(async () => {
  // ---- graceful degradation (no embedding key in test env → isReady false) ----
  const bigCatalog = Array.from({ length: 20 }, (_, i) => ({ name: 'tool_' + i, description: 'does thing ' + i }));
  ok(semantic.isReady() === false, 'precondition: no embedding key in test env');
  ok((await ts.select('anything', bigCatalog)) === null, 'select: no embedding key → null (caller uses FULL catalog, never stranded)');

  // ---- tiny catalog → null (retrieval not worth it) ----
  // (force-enable embeddings via monkey-patch so this isn't just the no-key path)
  semantic.isReady = () => true;
  semantic.embedBatch = async (arr) => ({ vecs: arr.map((s) => ({ _text: s })) });
  semantic.cosine = (a, b) => {
    const wa = new Set(String(a._text || '').toLowerCase().match(/[a-z]+/g) || []);
    const wb = String(b._text || '').toLowerCase().match(/[a-z]+/g) || [];
    let s = 0; for (const w of wb) if (wa.has(w)) s++;
    return Math.min(1, s / 4);
  };
  ok((await ts.select('x', bigCatalog.slice(0, 10))) === null, 'select: catalog < MIN_CATALOG → null');

  // ---- ranking: relevant tools + CORE, strict subset, order preserved ----
  const catalog = [
    { name: 'web_search', description: 'search the web for news and pages online' },
    { name: 'browser_action', description: 'navigate click type on web pages browser' },
    { name: 'play_music', description: 'spotify music playback songs audio' },
    { name: 'send_email', description: 'compose and send email messages' },
    { name: 'ask_ai', description: 'ask another model a question' },          // CORE
    { name: 'save_memory', description: 'remember a fact for later' },          // CORE
    { name: 'self_reflect', description: 'introspect on desires and improvements' }, // CORE
    { name: 'generate_image', description: 'create an image from a text prompt' },
    { name: 'molecule', description: 'render a 3d molecule structure chemistry' },
    { name: 'maps', description: 'show a map location route geography' },
    { name: 'world_cup', description: 'soccer football world cup scores bracket' },
    { name: 'make_figure', description: 'plot a chart figure from data' },
    { name: 'simulate', description: 'run a physics chemistry simulation' },
    { name: 'manage_jobs', description: 'list and manage background jobs' },
    { name: 'read_file', description: 'read a file from disk' },               // CORE
    { name: 'notify_user', description: 'send a notification to the user' },    // CORE
    { name: 'transcribe', description: 'speech to text audio transcription' },
    { name: 'calendar', description: 'schedule events on the calendar' },
  ];
  const res = await ts.select('search the web for news online', catalog, { k: 4, minScore: 0.18 });
  ok(res && Array.isArray(res.tools), 'select: returns a result object with relevant query');
  ok(res.names.includes('web_search'), 'select: top match (web_search) is included');
  ok(res.names.length < catalog.length, 'select: returns a STRICT SUBSET (not the whole catalog)');
  for (const core of ['ask_ai', 'save_memory', 'self_reflect', 'read_file', 'notify_user'])
    ok(res.names.includes(core), `select: CORE "${core}" force-kept regardless of relevance`);
  ok(!res.names.includes('world_cup'), 'select: irrelevant tool (world_cup) excluded');
  // order preserved (catalog order, not score order)
  const idxWeb = res.names.indexOf('web_search'), idxAsk = res.names.indexOf('ask_ai');
  ok(idxWeb < idxAsk, 'select: preserves original catalog order in the subset');

  // ---- un-vectored tool is always kept (cache lag must not drop a new tool) ----
  const withNew = catalog.concat([{ name: 'brand_new_tool', description: 'just added, vector not cached yet' }]);
  // prime cache for the original catalog only, then add a tool whose vec we force-miss:
  const origEmbed = semantic.embedBatch;
  semantic.embedBatch = async (arr) => ({ vecs: arr.map((s) => (/just added/.test(s) ? null : { _text: s })) });
  const res2 = await ts.select('search the web', withNew, { k: 3 });
  ok(res2 && res2.names.includes('brand_new_tool'), 'select: un-vectored (cache-lagging) tool is always kept, never silently dropped');
  semantic.embedBatch = origEmbed;

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
