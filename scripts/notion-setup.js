#!/usr/bin/env node
'use strict';
/*
 * BhatBot Notion memory bootstrap — turnkey.
 *
 * One command builds the entire structured memory bank on YOUR Notion and wires BhatBot to it.
 * It creates 5 databases under a parent page, writes their ids into ~/.bhatbot/config.json,
 * then verifies with a real write+read round-trip. Idempotent: re-running reuses dbs whose
 * ids are already in config (it won't duplicate them).
 *
 * ONE-TIME prep (≈2 min, your Notion account):
 *   1. https://www.notion.so/my-integrations → "New integration" → Internal → copy the
 *      "Internal Integration Secret" (starts with `ntn_` or `secret_`).
 *   2. In Notion, make/pick a page to hold the memory (e.g. "BhatBot Memory"). Open the "…"
 *      menu → Connections → add your integration so it can write there.
 *   3. Copy that page's URL (the share link).
 *
 * Run:
 *   NOTION_TOKEN=ntn_xxx node ~/bhatbot/scripts/notion-setup.js "<paste the page URL>"
 *   # or: node scripts/notion-setup.js <token> <pageUrl>
 *
 * Then restart BhatBot. notion_write / notion_search / daily log / project state / task queue
 * all go live, and the cloud backend (cloud/server.js) shares the SAME bank when given the
 * same NOTION_TOKEN — so the phone keeps full memory even with the Mac asleep.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const NOTION_VERSION = '2022-06-28';

// ---- args ------------------------------------------------------------------
const args = process.argv.slice(2).filter(Boolean);
let token = process.env.NOTION_TOKEN || '';
let parentArg = '';
for (const a of args) {
  if (/^(ntn_|secret_)/.test(a)) token = a;
  else parentArg = a;
}
if (!parentArg && args.length === 1 && !token) { /* nothing */ }
if (!token || !parentArg) {
  console.error('Usage: NOTION_TOKEN=ntn_xxx node scripts/notion-setup.js "<parent page URL>"');
  console.error('   or: node scripts/notion-setup.js <token> <parent page URL>');
  process.exit(1);
}

// Extract a 32-hex id from a Notion URL (…-<32hex> or …?p=<32hex>) or accept a raw id.
function pageId(s) {
  const m = String(s).match(/([0-9a-f]{32})/i) || String(s).replace(/-/g, '').match(/([0-9a-f]{32})/i);
  if (!m) throw new Error('Could not find a 32-char page id in: ' + s);
  const h = m[1].toLowerCase();
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }
function saveConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

// ---- database specs (property names MUST match lib/notion.js) ---------------
const T = () => ({ title: {} });
const SELECT = (opts) => ({ select: { options: opts.map((name) => ({ name })) } });
const MULTI = { multi_select: { options: [] } };
const NUM = { number: { format: 'number' } };
const DATE = { date: {} };
const URL = { url: {} };
const TEXT = { rich_text: {} };

const SPECS = {
  memoryDbId: {
    title: 'BhatBot · Memory',
    properties: { Fact: T(), Tags: MULTI, Source: SELECT(['agent', 'user', 'tool']), Confidence: NUM, Date: DATE },
  },
  researchDbId: {
    title: 'BhatBot · Research Hub',
    properties: { Name: T(), 'Source URL': URL, Tags: MULTI, 'Date Added': DATE },
  },
  dailyLogDbId: {
    title: 'BhatBot · Daily Log',
    properties: { Date: T() },
  },
  projectDbId: {
    title: 'BhatBot · Project State',
    properties: { Name: T(), Status: SELECT(['planned', 'active', 'blocked', 'done']) },
  },
  taskDbId: {
    title: 'BhatBot · Task Queue',
    properties: { Name: T(), Status: SELECT(['todo', 'doing', 'done']), Priority: SELECT(['low', 'med', 'high']), Due: DATE, Project: TEXT },
  },
};

(async () => {
  const { Client } = require('@notionhq/client');
  const nc = new Client({ auth: token, notionVersion: NOTION_VERSION });
  const parent = pageId(parentArg);

  // sanity: can we see the parent page?
  try { await nc.pages.retrieve({ page_id: parent }); }
  catch (e) {
    console.error('✗ Cannot read the parent page. Did you add the integration under the page\'s "…" → Connections?');
    console.error('  Notion said:', e.message);
    process.exit(1);
  }

  const cfg = loadConfig();
  cfg.notion = cfg.notion || {};
  cfg.notion.token = token;

  for (const [key, spec] of Object.entries(SPECS)) {
    // idempotent: if an id is already stored AND still retrievable, reuse it.
    if (cfg.notion[key]) {
      try { await nc.databases.retrieve({ database_id: cfg.notion[key] }); console.log(`• reuse  ${spec.title}  (${cfg.notion[key]})`); continue; }
      catch { /* stale id → recreate */ }
    }
    const db = await nc.databases.create({
      parent: { type: 'page_id', page_id: parent },
      title: [{ type: 'text', text: { content: spec.title } }],
      properties: spec.properties,
    });
    cfg.notion[key] = db.id;
    console.log(`✓ create ${spec.title}  (${db.id})`);
  }

  saveConfig(cfg);
  console.log('✓ wrote ids → ' + CONFIG_PATH);

  // ---- verify round-trip via the real lib -----------------------------------
  delete require.cache[require.resolve('../lib/notion')];
  const notion = require('../lib/notion');
  const stamp = 'setup-verify ' + new Date().toISOString();
  const w = await notion.appendMemory({ fact: stamp, tags: ['setup', 'verify'], source: 'tool', confidence: 1 });
  if (w.error || w.skipped) { console.error('✗ verify write failed:', w); process.exit(1); }
  await new Promise((r) => setTimeout(r, 800)); // Notion search is eventually-consistent
  const s = await notion.searchMemory('setup-verify', { limit: 3 });
  const ok = Array.isArray(s) && s.some((x) => x.fact && x.fact.startsWith('setup-verify'));
  console.log(ok ? '✓ verify round-trip OK (wrote + read back a memory)' : '⚠ wrote OK but search lagged (eventual consistency); will resolve shortly');
  console.log('\nDone. Restart BhatBot. Give the cloud backend the same NOTION_TOKEN to share this bank.');
})().catch((e) => { console.error('✗ setup failed:', e.message); process.exit(1); });
