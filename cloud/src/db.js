'use strict';
// SQLite persistence (better-sqlite3) — the cloud's system of record. Lives on the Fly
// volume mounted at $DATA_DIR (/data) so conversations, memory, costs, schedules, and the
// activity feed survive restarts/redeploys. Single-user private server → SQLite is ideal:
// zero external deps, synchronous, fast, trivially backed up.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'bhatbot.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT, text TEXT, source TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS costs (
  day TEXT PRIMARY KEY, usd REAL, calls INTEGER, by_model TEXT
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, title TEXT, prompt TEXT, kind TEXT, at TEXT,
  every_ms INTEGER, run_at INTEGER, next_run INTEGER, enabled INTEGER,
  last_run INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, text TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT
);
`);

const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);

// ---- conversations + messages -------------------------------------------------
const _insConv = db.prepare('INSERT OR IGNORE INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)');
const _touchConv = db.prepare('UPDATE conversations SET updated_at=? WHERE id=?');
const _insMsg = db.prepare('INSERT INTO messages (conversation_id,role,content,created_at) VALUES (?,?,?,?)');
const _getMsgs = db.prepare('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY id ASC');
const _delMsgs = db.prepare('DELETE FROM messages WHERE conversation_id=?');

function ensureConversation(id, title = 'Conversation') { _insConv.run(id, title, now(), now()); }
function addMessage(convId, role, content) {
  ensureConversation(convId);
  _insMsg.run(convId, role, typeof content === 'string' ? content : JSON.stringify(content), now());
  _touchConv.run(now(), convId);
}
function getHistory(convId, limit = 40) {
  const rows = _getMsgs.all(convId);
  const msgs = rows.map((r) => {
    let c = r.content;
    if (typeof c === 'string' && (c.startsWith('[') || c.startsWith('{'))) { try { c = JSON.parse(c); } catch {} }
    return { role: r.role, content: c };
  });
  return msgs.slice(-limit);
}
function resetConversation(convId) { _delMsgs.run(convId); }

// ---- memory (lexical, idf-ish recall) -----------------------------------------
const _insMem = db.prepare('INSERT INTO memory (kind,text,source,created_at) VALUES (?,?,?,?)');
const _allMem = db.prepare('SELECT id,kind,text FROM memory ORDER BY id DESC LIMIT 800');
const STOP = new Set(['the','and','for','are','was','how','does','did','with','this','that','you','your','can','will','have','has','what','when','where','why','who','use','using','get','got','make','want','need','should','would','into','from','about','also','than','then','them','they','its']);
function saveMemory(text, { kind = 'fact', source = 'user' } = {}) {
  const t = String(text || '').trim(); if (!t) return false;
  _insMem.run(kind, t, source, now()); return true;
}
function recallMemory(query, k = 6) {
  const terms = (String(query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((t) => !STOP.has(t));
  if (!terms.length) return [];
  const docs = _allMem.all();
  if (!docs.length) return [];
  const df = {}; for (const t of terms) df[t] = docs.reduce((n, d) => n + (d.text.toLowerCase().includes(t) ? 1 : 0), 0) || 1;
  return docs.map((d) => { const hay = d.text.toLowerCase(); let s = 0; for (const t of terms) if (hay.includes(t)) s += 1 / df[t]; return { d, s }; })
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.d.text);
}

// ---- cost ledger --------------------------------------------------------------
const _getCost = db.prepare('SELECT * FROM costs WHERE day=?');
const _upCost = db.prepare('INSERT INTO costs (day,usd,calls,by_model) VALUES (?,?,?,?) ON CONFLICT(day) DO UPDATE SET usd=?,calls=?,by_model=?');
function recordCost(model, usd) {
  if (!usd) return;
  const d = today(); const row = _getCost.get(d) || { usd: 0, calls: 0, by_model: '{}' };
  const by = JSON.parse(row.by_model || '{}'); const mk = (model || 'unknown').replace(/^claude-/, '');
  by[mk] = (by[mk] || 0) + usd;
  const usdN = row.usd + usd, calls = row.calls + 1, byS = JSON.stringify(by);
  _upCost.run(d, usdN, calls, byS, usdN, calls, byS);
}
function costToday() {
  const row = _getCost.get(today());
  return row ? { usd: row.usd, calls: row.calls, byModel: JSON.parse(row.by_model || '{}') } : { usd: 0, calls: 0, byModel: {} };
}

// ---- activity feed (phone Activity tab polls /activity?since=) -----------------
const _insAct = db.prepare('INSERT INTO activity (kind,text,created_at) VALUES (?,?,?)');
const _actSince = db.prepare('SELECT id,kind,text FROM activity WHERE id>? ORDER BY id ASC LIMIT 200');
const _actMax = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM activity');
function pushActivity(kind, text) { _insAct.run(kind, String(text || '').slice(0, 400), now()); }
function getActivity(since) {
  const ev = _actSince.all(Number(since) || 0);
  return { seq: _actMax.get().m, events: ev.map((e) => ({ id: e.id, kind: e.kind, text: e.text })) };
}

// ---- meta kv (small settings: last brief day, etc.) ---------------------------
const _getMeta = db.prepare('SELECT value FROM meta WHERE key=?');
const _setMeta = db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?');
function getMeta(k) { const r = _getMeta.get(k); return r ? r.value : null; }
function setMeta(k, v) { _setMeta.run(k, String(v), String(v)); }

module.exports = {
  db, DATA_DIR, today, getMeta, setMeta,
  ensureConversation, addMessage, getHistory, resetConversation,
  saveMemory, recallMemory,
  recordCost, costToday,
  pushActivity, getActivity,
};
