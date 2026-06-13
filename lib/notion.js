'use strict';
// Notion integration (P3) — human-readable, structured long-term memory on Notion Plus.
// Requires: @notionhq/client (npm install @notionhq/client)
// Config keys (~/.bhatbot/config.json): config.notion.token, config.notion.memoryDbId,
//   config.notion.researchDbId, config.notion.dailyLogDbId, config.notion.projectDbId,
//   config.notion.taskDbId
// GRACEFUL DEGRADATION: every exported function checks isConfigured() first and returns
// { skipped: true, reason: 'Notion not configured' } when unset — it NEVER throws, so no
// caller needs to guard against Notion being absent.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const SKIPPED = { skipped: true, reason: 'Notion not configured' };

function cfg() {
  try { return (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).notion) || {}; } catch { return {}; }
}

let _client = null, _clientToken = null;
function client() {
  const { token } = cfg();
  if (!token) return null;
  if (_client && _clientToken === token) return _client;
  try {
    const { Client } = require('@notionhq/client');
    // Pin the classic API version: keeps `databases.query`/`database_id` working even though
    // the SDK can default to the 2025-09-03 data-source model. The setup script uses the same.
    _client = new Client({ auth: token, notionVersion: '2022-06-28' });
    _clientToken = token;
    return _client;
  } catch { return null; }   // package not installed → degrade, don't throw
}

/** True if a Notion token plus at least one database id is configured. */
function isConfigured() {
  const c = cfg();
  return !!(c.token && (c.memoryDbId || c.researchDbId || c.dailyLogDbId || c.projectDbId || c.taskDbId));
}

// ---- property builders -----------------------------------------------------
const title = (s) => ({ title: [{ text: { content: String(s).slice(0, 200) } }] });
const rich = (s) => ({ rich_text: [{ text: { content: String(s).slice(0, 1900) } }] });
const para = (s) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: String(s).slice(0, 1900) } }] } });
const bullet = (s) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: String(s).slice(0, 1900) } }] } });
const todayISO = () => new Date().toISOString().slice(0, 10);

// Pull plain text out of a Notion property regardless of its type.
function propText(p) {
  if (!p) return '';
  const arr = p.title || p.rich_text || [];
  if (arr.length) return arr.map((t) => t.plain_text || (t.text && t.text.content) || '').join('');
  if (p.select) return p.select.name || '';
  if (p.multi_select) return p.multi_select.map((m) => m.name).join(', ');
  if (p.number != null) return String(p.number);
  if (p.date) return p.date.start || '';
  return '';
}
function findProp(props, names) {
  for (const n of names) if (props[n]) return props[n];
  const lower = Object.fromEntries(Object.entries(props).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) if (lower[n.toLowerCase()]) return lower[n.toLowerCase()];
  return null;
}

/**
 * Append a fact to the Memory database.
 * @param {{fact: string, tags?: string[], source?: 'agent'|'user'|'tool', confidence?: number}} input
 */
async function appendMemory({ fact, tags = [], source = 'agent', confidence = 0.8 } = {}) {
  if (!isConfigured() || !cfg().memoryDbId) return SKIPPED;
  const nc = client(); if (!nc) return SKIPPED;
  if (!fact) return { error: 'fact required' };
  try {
    const page = await nc.pages.create({
      parent: { database_id: cfg().memoryDbId },
      properties: {
        Fact: title(fact),
        Tags: { multi_select: (tags || []).slice(0, 10).map((t) => ({ name: String(t).slice(0, 90) })) },
        Source: { select: { name: ['agent', 'user', 'tool'].includes(source) ? source : 'agent' } },
        Confidence: { number: Math.max(0, Math.min(1, Number(confidence) || 0)) },
        Date: { date: { start: todayISO() } },
      },
    });
    return { success: true, pageId: page.id, url: page.url };
  } catch (e) { return { error: 'Notion appendMemory failed: ' + e.message }; }
}

/**
 * Search the Memory database by query string (title contains).
 * @param {string} query
 * @param {{limit?: number}} opts
 * @returns {Promise<Array<{fact,tags,date}>|object>}
 */
async function searchMemory(query, { limit = 5 } = {}) {
  if (!isConfigured() || !cfg().memoryDbId) return SKIPPED;
  const nc = client(); if (!nc) return SKIPPED;
  try {
    const r = await nc.databases.query({
      database_id: cfg().memoryDbId,
      filter: query ? { property: 'Fact', title: { contains: String(query).slice(0, 100) } } : undefined,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: Math.min(25, limit),
    });
    return (r.results || []).map((p) => ({
      fact: propText(findProp(p.properties, ['Fact', 'Name'])),
      tags: propText(findProp(p.properties, ['Tags'])),
      date: propText(findProp(p.properties, ['Date'])),
    }));
  } catch (e) { return { error: 'Notion searchMemory failed: ' + e.message }; }
}

// Daily Log: one page per day (title = YYYY-MM-DD), each activity appended as a bullet.
// ASSUMPTION: the spec's per-row properties (Time/Event/Tool/Result/Duration) are folded
// into the bullet text since entries are grouped as blocks under a single day page.
let _dayPageCache = { date: null, id: null };
async function logActivity({ event, tool = '', result = '', duration_ms } = {}) {
  if (!isConfigured() || !cfg().dailyLogDbId) return SKIPPED;
  const nc = client(); if (!nc) return SKIPPED;
  if (!event) return { error: 'event required' };
  try {
    const day = todayISO();
    let pageId = _dayPageCache.date === day ? _dayPageCache.id : null;
    if (!pageId) {
      const q = await nc.databases.query({
        database_id: cfg().dailyLogDbId,
        filter: { property: 'title', title: { equals: day } },
        page_size: 1,
      }).catch(() => ({ results: [] }));
      if (q.results && q.results.length) pageId = q.results[0].id;
      else {
        const created = await nc.pages.create({
          parent: { database_id: cfg().dailyLogDbId },
          properties: { title: title(day) },
        });
        pageId = created.id;
      }
      _dayPageCache = { date: day, id: pageId };
    }
    const time = new Date().toTimeString().slice(0, 8);
    const line = `${time} — ${event}${tool ? ` [${tool}]` : ''}${result ? ` → ${String(result).slice(0, 200)}` : ''}${duration_ms != null ? ` (${duration_ms}ms)` : ''}`;
    await nc.blocks.children.append({ block_id: pageId, children: [bullet(line)] });
    return { success: true, pageId };
  } catch (e) {
    _dayPageCache = { date: null, id: null };   // stale cache may be the cause; reset
    return { error: 'Notion logActivity failed: ' + e.message };
  }
}

/**
 * Create a structured research page in the Research Hub database.
 * @param {{title: string, abstract?: string, findings?: string[], tags?: string[], url?: string}} input
 */
async function createResearchPage({ title: t, abstract = '', findings = [], tags = [], url = '' } = {}) {
  if (!isConfigured() || !cfg().researchDbId) return SKIPPED;
  const nc = client(); if (!nc) return SKIPPED;
  if (!t) return { error: 'title required' };
  try {
    const children = [];
    if (abstract) children.push(para(abstract));
    for (const f of (findings || []).slice(0, 40)) children.push(bullet(f));
    const page = await nc.pages.create({
      parent: { database_id: cfg().researchDbId },
      properties: {
        Name: title(t),
        'Source URL': url ? { url } : undefined,
        Tags: { multi_select: (tags || []).slice(0, 10).map((x) => ({ name: String(x).slice(0, 90) })) },
        'Date Added': { date: { start: todayISO() } },
      },
      children,
    });
    return { success: true, pageId: page.id, url: page.url };
  } catch (e) { return { error: 'Notion createResearchPage failed: ' + e.message }; }
}

/**
 * Upsert a project's state page (matched by projectName title) in the Project State db.
 * @param {{projectName: string, status?: 'planned'|'active'|'blocked'|'done', facts?: string[], blockers?: string[]}} input
 */
async function updateProjectState({ projectName, status, facts = [], blockers = [] } = {}) {
  if (!isConfigured() || !cfg().projectDbId) return SKIPPED;
  const nc = client(); if (!nc) return SKIPPED;
  if (!projectName) return { error: 'projectName required' };
  try {
    const q = await nc.databases.query({
      database_id: cfg().projectDbId,
      filter: { property: 'title', title: { equals: String(projectName) } },
      page_size: 1,
    });
    const props = {};
    if (status && ['planned', 'active', 'blocked', 'done'].includes(status)) props.Status = { select: { name: status } };
    let pageId;
    if (q.results && q.results.length) {
      pageId = q.results[0].id;
      if (Object.keys(props).length) await nc.pages.update({ page_id: pageId, properties: props });
    } else {
      const created = await nc.pages.create({
        parent: { database_id: cfg().projectDbId },
        properties: { Name: title(projectName), ...props },
      });
      pageId = created.id;
    }
    const children = [];
    const stamp = todayISO();
    for (const f of (facts || []).slice(0, 20)) children.push(bullet(`${stamp} · ${f}`));
    for (const b of (blockers || []).slice(0, 20)) children.push(bullet(`${stamp} · ⛔ BLOCKER: ${b}`));
    if (children.length) await nc.blocks.children.append({ block_id: pageId, children });
    return { success: true, pageId };
  } catch (e) { return { error: 'Notion updateProjectState failed: ' + e.message }; }
}

/**
 * Open (not-done) tasks from the Task Queue database, highest priority first.
 * @param {{limit?: number}} opts
 * @returns {Promise<Array<{title,priority,dueDate,projectName}>|object>}
 */
async function getOpenTasks({ limit = 10 } = {}) {
  if (!isConfigured() || !cfg().taskDbId) return SKIPPED;
  const nc = client(); if (!nc) return SKIPPED;
  try {
    let r;
    try {
      r = await nc.databases.query({
        database_id: cfg().taskDbId,
        filter: { property: 'Status', select: { does_not_equal: 'done' } },
        sorts: [{ property: 'Priority', direction: 'descending' }],
        page_size: Math.min(50, limit),
      });
    } catch {
      // Schema mismatch (Status not a select / Priority missing) → unfiltered fallback.
      r = await nc.databases.query({ database_id: cfg().taskDbId, page_size: Math.min(50, limit) });
    }
    return (r.results || []).map((p) => ({
      title: propText(findProp(p.properties, ['Name', 'Task', 'Title'])),
      priority: propText(findProp(p.properties, ['Priority'])),
      dueDate: propText(findProp(p.properties, ['Due', 'Due Date', 'Date'])),
      projectName: propText(findProp(p.properties, ['Project', 'Project Name'])),
    })).filter((t) => t.title);
  } catch (e) { return { error: 'Notion getOpenTasks failed: ' + e.message }; }
}

module.exports = { isConfigured, appendMemory, searchMemory, logActivity, createResearchPage, updateProjectState, getOpenTasks };
