'use strict';
// Google integration — Gmail, Calendar, Drive over one OAuth2 client.
// Requires: googleapis (npm install googleapis)
// Config keys (~/.bhatbot/config.json → config.google):
//   clientId, clientSecret, refreshToken   (mint the refresh token once: `npm run google:auth`)
// GRACEFUL DEGRADATION: every exported call runs through withGmail/withCalendar/withDrive,
// which return { skipped:true, reason } when Google is not configured — nothing throws just
// because the user never set it up. Mirrors lib/notion.js.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.bhatbot', 'config.json');
const SKIPPED = { skipped: true, reason: 'Google not configured — run `npm run google:auth` (needs config.google.clientId/clientSecret).' };

// Scopes the app asks for. gmail.modify covers read + draft + label; no send scope on purpose.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
];

function cfg() {
  try { return (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).google) || {}; } catch { return {}; }
}

/** True once clientId + clientSecret + a refresh token are all present. */
function isConfigured() {
  const c = cfg();
  return !!(c.clientId && c.clientSecret && c.refreshToken);
}

let _auth = null, _authKey = null;
function oauthClient() {
  const c = cfg();
  if (!c.clientId || !c.clientSecret || !c.refreshToken) return null;
  const key = c.clientId + '|' + c.refreshToken;
  if (_auth && _authKey === key) return _auth;
  try {
    const { google } = require('googleapis');
    const o = new google.auth.OAuth2(c.clientId, c.clientSecret, c.redirectUri || 'http://localhost:4137/oauth2callback');
    o.setCredentials({ refresh_token: c.refreshToken });
    _auth = o; _authKey = key;
    return o;
  } catch { return null; }   // package missing → degrade
}

function api(name, version) {
  const auth = oauthClient();
  if (!auth) return null;
  try { const { google } = require('googleapis'); return google[name]({ version, auth }); }
  catch { return null; }
}

async function withService(name, version, fn) {
  const svc = api(name, version);
  if (!svc) return SKIPPED;
  try { return await fn(svc); }
  catch (e) {
    const msg = (e && e.errors && e.errors[0] && e.errors[0].message) || (e && e.message) || String(e);
    return { success: false, error: msg };
  }
}
const withGmail = (fn) => withService('gmail', 'v1', fn);
const withCalendar = (fn) => withService('calendar', 'v3', fn);
const withDrive = (fn) => withService('drive', 'v3', fn);

// ---- Gmail helpers ---------------------------------------------------------
const b64urlDecode = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const b64urlEncode = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function headerOf(payload, name) {
  const h = (payload && payload.headers) || [];
  const hit = h.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.value : '';
}

// Walk a MIME tree, prefer text/plain, fall back to a crude strip of text/html.
function extractBody(payload) {
  if (!payload) return '';
  const parts = [];
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body && p.body.data) parts.push({ t: 'plain', d: b64urlDecode(p.body.data) });
    else if (p.mimeType === 'text/html' && p.body && p.body.data) parts.push({ t: 'html', d: b64urlDecode(p.body.data) });
    (p.parts || []).forEach(walk);
  })(payload);
  const plain = parts.find((p) => p.t === 'plain');
  if (plain) return plain.d;
  const html = parts.find((p) => p.t === 'html');
  if (html) return html.d.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  return '';
}

// ---- Gmail -----------------------------------------------------------------
async function gmailSearch(query, { limit = 10 } = {}) {
  return withGmail(async (g) => {
    const list = await g.users.messages.list({ userId: 'me', q: query || '', maxResults: Math.min(limit, 25) });
    const ids = (list.data.messages || []).map((m) => m.id);
    const msgs = [];
    for (const id of ids) {
      const m = await g.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
      msgs.push({
        id, threadId: m.data.threadId,
        from: headerOf(m.data.payload, 'From'), subject: headerOf(m.data.payload, 'Subject'),
        date: headerOf(m.data.payload, 'Date'), snippet: m.data.snippet, unread: (m.data.labelIds || []).includes('UNREAD'),
      });
    }
    return { success: true, count: msgs.length, results: msgs };
  });
}

async function gmailRead(id) {
  return withGmail(async (g) => {
    const m = await g.users.messages.get({ userId: 'me', id, format: 'full' });
    const p = m.data.payload;
    return {
      success: true, id, threadId: m.data.threadId,
      from: headerOf(p, 'From'), to: headerOf(p, 'To'), subject: headerOf(p, 'Subject'), date: headerOf(p, 'Date'),
      labels: m.data.labelIds || [], body: extractBody(p).slice(0, 12000),
    };
  });
}

// Create a DRAFT (never auto-sends). Pass threadId to reply within a thread.
async function gmailDraft({ to, subject, body, cc, threadId } = {}) {
  return withGmail(async (g) => {
    const lines = [];
    if (to) lines.push('To: ' + to);
    if (cc) lines.push('Cc: ' + cc);
    if (subject) lines.push('Subject: ' + subject);
    lines.push('Content-Type: text/plain; charset=utf-8', '', body || '');
    const raw = b64urlEncode(lines.join('\r\n'));
    const d = await g.users.drafts.create({ userId: 'me', requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } } });
    return { success: true, draftId: d.data.id, messageId: d.data.message && d.data.message.id, note: 'Draft created (not sent).' };
  });
}

// Add/remove labels. Accepts label NAMES or ids; resolves names to ids, creating missing ones.
async function gmailLabel(id, { add = [], remove = [] } = {}) {
  return withGmail(async (g) => {
    const existing = (await g.users.labels.list({ userId: 'me' })).data.labels || [];
    const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
    const toId = async (name) => {
      if (byName.has(name.toLowerCase())) return byName.get(name.toLowerCase());
      if (/^[A-Z_]+$|^Label_/.test(name)) return name;   // already an id
      const created = await g.users.labels.create({ userId: 'me', requestBody: { name } });
      byName.set(name.toLowerCase(), created.data.id);
      return created.data.id;
    };
    const addIds = []; for (const n of add) addIds.push(await toId(n));
    const removeIds = []; for (const n of remove) removeIds.push(await toId(n));
    await g.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds: addIds, removeLabelIds: removeIds } });
    return { success: true, id, added: addIds, removed: removeIds };
  });
}

// ---- Calendar --------------------------------------------------------------
async function calendarList({ calendarId = 'primary', timeMin, timeMax, query, limit = 10 } = {}) {
  return withCalendar(async (c) => {
    const params = {
      calendarId, singleEvents: true, orderBy: 'startTime', maxResults: Math.min(limit, 50),
      timeMin: timeMin || new Date(Date.now() - 3600e3).toISOString(),
    };
    if (timeMax) params.timeMax = timeMax;
    if (query) params.q = query;
    const r = await c.events.list(params);
    const events = (r.data.items || []).map((e) => ({
      id: e.id, summary: e.summary, location: e.location,
      start: (e.start && (e.start.dateTime || e.start.date)) || null,
      end: (e.end && (e.end.dateTime || e.end.date)) || null,
      attendees: (e.attendees || []).map((a) => a.email), htmlLink: e.htmlLink,
    }));
    return { success: true, count: events.length, events };
  });
}

async function calendarCreate({ summary, description, location, start, end, attendees, calendarId = 'primary' } = {}) {
  return withCalendar(async (c) => {
    const allDay = start && !/T/.test(start);
    const requestBody = {
      summary, description, location,
      start: allDay ? { date: start } : { dateTime: start },
      end: allDay ? { date: end || start } : { dateTime: end || start },
    };
    if (attendees && attendees.length) requestBody.attendees = attendees.map((e) => ({ email: e }));
    const r = await c.events.insert({ calendarId, requestBody });
    return { success: true, id: r.data.id, htmlLink: r.data.htmlLink, summary: r.data.summary };
  });
}

async function calendarUpdate(id, { summary, description, location, start, end, calendarId = 'primary' } = {}) {
  return withCalendar(async (c) => {
    const patch = {};
    if (summary != null) patch.summary = summary;
    if (description != null) patch.description = description;
    if (location != null) patch.location = location;
    if (start) patch.start = /T/.test(start) ? { dateTime: start } : { date: start };
    if (end) patch.end = /T/.test(end) ? { dateTime: end } : { date: end };
    const r = await c.events.patch({ calendarId, eventId: id, requestBody: patch });
    return { success: true, id: r.data.id, htmlLink: r.data.htmlLink };
  });
}

async function calendarDelete(id, { calendarId = 'primary' } = {}) {
  return withCalendar(async (c) => {
    await c.events.delete({ calendarId, eventId: id });
    return { success: true, id, deleted: true };
  });
}

// ---- Drive -----------------------------------------------------------------
async function driveSearch(query, { limit = 10 } = {}) {
  return withDrive(async (d) => {
    // Treat a bare string as a full-text search; pass a raw Drive query if it looks like one.
    const q = /[:=]/.test(query || '') ? query : `fullText contains '${String(query || '').replace(/'/g, "\\'")}' and trashed = false`;
    const r = await d.files.list({ q, pageSize: Math.min(limit, 50), fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))' });
    const files = (r.data.files || []).map((f) => ({
      id: f.id, name: f.name, mimeType: f.mimeType, modified: f.modifiedTime, link: f.webViewLink,
      owner: (f.owners && f.owners[0] && f.owners[0].displayName) || null,
    }));
    return { success: true, count: files.length, files };
  });
}

async function driveRead(id) {
  return withDrive(async (d) => {
    const meta = (await d.files.get({ fileId: id, fields: 'id,name,mimeType' })).data;
    let text = '';
    if (/^application\/vnd\.google-apps\./.test(meta.mimeType)) {
      // Native Google Doc/Sheet/Slide → export as plain text (sheets → CSV).
      const exportType = meta.mimeType.includes('spreadsheet') ? 'text/csv' : 'text/plain';
      const r = await d.files.export({ fileId: id, mimeType: exportType }, { responseType: 'text' });
      text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    } else {
      const r = await d.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' });
      text = typeof r.data === 'string' ? r.data : String(r.data);
    }
    return { success: true, id, name: meta.name, mimeType: meta.mimeType, content: text.slice(0, 20000) };
  });
}

async function driveCreate({ name, content = '', mimeType = 'text/plain', folderId } = {}) {
  return withDrive(async (d) => {
    const requestBody = { name };
    if (folderId) requestBody.parents = [folderId];
    const r = await d.files.create({ requestBody, media: { mimeType, body: content }, fields: 'id,name,webViewLink' });
    return { success: true, id: r.data.id, name: r.data.name, link: r.data.webViewLink };
  });
}

module.exports = {
  SCOPES, isConfigured, oauthClient, cfg,
  gmailSearch, gmailRead, gmailDraft, gmailLabel,
  calendarList, calendarCreate, calendarUpdate, calendarDelete,
  driveSearch, driveRead, driveCreate,
};
