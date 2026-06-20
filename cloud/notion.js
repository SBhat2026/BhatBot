'use strict';
// Cloud-side Notion memory — the SAME bank the Mac uses, so the phone keeps full memory with
// the Mac asleep. Self-contained (no ~/.bhatbot/config.json on a cloud host): reads everything
// from env. Degrades to no-ops when NOTION_TOKEN is unset, so the server runs fine without it.
//
//   NOTION_TOKEN          integration secret (ntn_… / secret_…)
//   NOTION_MEMORY_DB      Memory database id      (recall + durable facts)
//   NOTION_DAILYLOG_DB    Daily Log database id   (per-turn activity, optional)
//
// Use the ids that scripts/notion-setup.js wrote into ~/.bhatbot/config.json → notion.*.
const NOTION_VERSION = '2022-06-28';
const TOKEN = process.env.NOTION_TOKEN || '';
const MEMORY_DB = process.env.NOTION_MEMORY_DB || '';
const DAILYLOG_DB = process.env.NOTION_DAILYLOG_DB || '';

let _client = null;
function client() {
  if (!TOKEN) return null;
  if (_client) return _client;
  try {
    const { Client } = require('@notionhq/client');
    _client = new Client({ auth: TOKEN, notionVersion: NOTION_VERSION });
    return _client;
  } catch { return null; }
}
const configured = () => !!(TOKEN && MEMORY_DB);

const todayISO = () => new Date().toISOString().slice(0, 10);
const title = (s) => ({ title: [{ text: { content: String(s).slice(0, 200) } }] });
const bullet = (s) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: String(s).slice(0, 1900) } }] } });
function propText(p) {
  if (!p) return '';
  const arr = p.title || p.rich_text || [];
  if (arr.length) return arr.map((t) => t.plain_text || (t.text && t.text.content) || '').join('');
  if (p.multi_select) return p.multi_select.map((m) => m.name).join(', ');
  if (p.date) return p.date.start || '';
  return '';
}

// Recall the most relevant durable facts for a query (title-contains, newest first).
async function recall(query, limit = 5) {
  const nc = client(); if (!nc || !MEMORY_DB) return [];
  try {
    const r = await nc.databases.query({
      database_id: MEMORY_DB,
      filter: query ? { property: 'Fact', title: { contains: String(query).slice(0, 100) } } : undefined,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: Math.min(25, limit),
    });
    return (r.results || []).map((p) => propText(p.properties && (p.properties.Fact || p.properties.Name))).filter(Boolean);
  } catch { return []; }
}

// Token-overlap recall fallback: pull recent facts and rank by shared words, so we surface
// relevant memory even when no title substring matches the exact phrasing.
const STOP = new Set(['the','and','for','are','was','how','does','did','with','this','that','you','your','can','will','have','has','what','when','where','why','who','use','get','got','make','want','need','about','from','into','bhatbot','siddhant']);
function terms(s) { return ((s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((t) => !STOP.has(t)); }
async function recallSmart(query, limit = 5) {
  const direct = await recall(query, limit);
  if (direct.length >= limit) return direct.slice(0, limit);
  const nc = client(); if (!nc || !MEMORY_DB) return direct;
  try {
    const r = await nc.databases.query({ database_id: MEMORY_DB, sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 60 });
    const q = new Set(terms(query));
    const scored = (r.results || []).map((p) => {
      const fact = propText(p.properties && (p.properties.Fact || p.properties.Name));
      const overlap = terms(fact).filter((t) => q.has(t)).length;
      return { fact, overlap };
    }).filter((x) => x.fact && x.overlap > 0).sort((a, b) => b.overlap - a.overlap);
    const merged = [...direct];
    for (const s of scored) if (!merged.includes(s.fact)) merged.push(s.fact);
    return merged.slice(0, limit);
  } catch { return direct; }
}

// SoT dedup helpers (mirror lib/notion.js): Notion is authoritative, so don't write near-dups.
function normFact(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function similarFact(a, b) {
  const na = normFact(a), nb = normFact(b); if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(' ').filter((w) => w.length > 2)), tb = new Set(nb.split(' ').filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return false;
  let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.8;
}
async function appendMemory(fact, { tags = [], source = 'agent', confidence = 0.8, dedup = true } = {}) {
  const nc = client(); if (!nc || !MEMORY_DB || !fact) return { skipped: true };
  try {
    if (dedup) {
      const r = await nc.databases.query({ database_id: MEMORY_DB, sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 60 }).catch(() => ({ results: [] }));
      const exists = (r.results || []).some((p) => similarFact(propText(p.properties && (p.properties.Fact || p.properties.Name)), fact));
      if (exists) return { success: true, deduped: true };
    }
    await nc.pages.create({
      parent: { database_id: MEMORY_DB },
      properties: {
        Fact: title(fact),
        Tags: { multi_select: tags.slice(0, 10).map((t) => ({ name: String(t).slice(0, 90) })) },
        Source: { select: { name: ['agent', 'user', 'tool'].includes(source) ? source : 'agent' } },
        Confidence: { number: Math.max(0, Math.min(1, confidence)) },
        Date: { date: { start: todayISO() } },
      },
    });
    return { success: true };
  } catch (e) { return { error: e.message }; }
}

let _day = { date: null, id: null };
async function logActivity(event) {
  const nc = client(); if (!nc || !DAILYLOG_DB || !event) return { skipped: true };
  try {
    const day = todayISO();
    let pageId = _day.date === day ? _day.id : null;
    if (!pageId) {
      const q = await nc.databases.query({ database_id: DAILYLOG_DB, filter: { property: 'title', title: { equals: day } }, page_size: 1 }).catch(() => ({ results: [] }));
      pageId = (q.results && q.results[0] && q.results[0].id) || (await nc.pages.create({ parent: { database_id: DAILYLOG_DB }, properties: { Date: title(day) } })).id;
      _day = { date: day, id: pageId };
    }
    const time = new Date().toTimeString().slice(0, 5);
    await nc.blocks.children.append({ block_id: pageId, children: [bullet(`${time} · [phone] ${String(event).slice(0, 280)}`)] });
    return { success: true };
  } catch (e) { _day = { date: null, id: null }; return { error: e.message }; }
}

module.exports = { configured, recall, recallSmart, appendMemory, logActivity };
