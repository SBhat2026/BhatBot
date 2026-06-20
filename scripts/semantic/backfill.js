#!/usr/bin/env node
'use strict';
// Backfill the semantic store from ~/.bhatbot/memory.md (durable facts).
//
// memory.md format (see saveMemoryEntry in main.js): lines like
//   - YYYY-MM-DD: some fact text
// grouped under "## Section" headings. Each such line becomes a SEMANTIC record,
// tagged with its section in meta and dated from the line's leading date.
//
// SCOPE: memory.md only. The cloud SQLite (cloud/data/bhatbot.db / $DATA_DIR)
// is intentionally OUT OF SCOPE for this script.
//
// Usage:  node scripts/semantic/backfill.js
// Prints a JSON summary to stdout.

const fs = require('fs');
const path = require('path');
const os = require('os');

const semantic = require(path.join(__dirname, '..', '..', 'lib', 'semantic.js'));

const MEMORY_PATH = path.join(os.homedir(), '.bhatbot', 'memory.md');

function parseMemory(md) {
  const items = [];
  let section = 'General';
  for (const rawLine of md.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { section = h[1].trim(); continue; }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (!li) continue;
    let body = li[1].trim();
    if (!body) continue;
    // strip a leading "YYYY-MM-DD: " (possibly doubled, as seen in some entries)
    let ts;
    const dm = body.match(/^(\d{4}-\d{2}-\d{2})\s*:\s*/);
    if (dm) {
      ts = Date.parse(dm[1] + 'T12:00:00Z');
      body = body.slice(dm[0].length).trim();
      // handle an occasional doubled date prefix
      const dm2 = body.match(/^(\d{4}-\d{2}-\d{2})\s*:\s*/);
      if (dm2) body = body.slice(dm2[0].length).trim();
    }
    if (!body) continue;
    items.push({ text: body, kind: 'semantic', ts: Number.isFinite(ts) ? ts : undefined, meta: { section, source: 'memory.md' } });
  }
  return items;
}

(async () => {
  if (!fs.existsSync(MEMORY_PATH)) {
    console.log(JSON.stringify({ ok: false, error: 'memory.md not found', path: MEMORY_PATH }, null, 2));
    return;
  }
  if (!semantic.isReady()) {
    console.log(JSON.stringify({ ok: false, skipped: true, reason: 'no openaiKey — semantic store degrades to no-op', path: MEMORY_PATH }, null, 2));
    return;
  }
  const md = fs.readFileSync(MEMORY_PATH, 'utf8');
  const items = parseMemory(md);
  const before = semantic.stats();
  const result = await semantic.backfill(items);
  const after = semantic.stats();
  console.log(JSON.stringify({
    ok: true,
    source: MEMORY_PATH,
    parsed: items.length,
    result,
    before,
    after,
  }, null, 2));
})().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }, null, 2));
});
