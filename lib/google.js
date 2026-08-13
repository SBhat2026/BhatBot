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

// CRED_REF RESOLUTION — this module read config.json RAW, which silently broke it the moment the
// secrets were vaulted. clientSecret and refreshToken are stored as `CRED_REF_*` handles (see
// lib/credentials.js); handing those literal strings to Google's OAuth client produces
// `invalid_client`, and because every call degrades gracefully, the failure looked like "Google
// isn't set up" rather than "Google is misconfigured". isConfigured() returned TRUE the whole time,
// because the handles are non-empty strings.
//
// Resolution needs Electron's safeStorage, so it cannot happen in a bare node process. The resolver
// is therefore INJECTED: main.js calls setConfigResolver(loadConfig) at boot (it already resolves
// refs), and headless callers fall back to the raw read plus a direct credentials.resolveRefs
// attempt, which works whenever safeStorage is reachable.
let _resolver = null;
/** main.js: setConfigResolver(loadConfig) — supplies a config with CRED_REFs already resolved. */
function setConfigResolver(fn) { _resolver = typeof fn === 'function' ? fn : null; }

function cfg() {
  if (_resolver) {
    try { const c = (_resolver() || {}).google; if (c) return c; } catch {}
  }
  try {
    const raw = (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).google) || {};
    // No injected resolver (headless): try to resolve handles ourselves. Works when safeStorage is
    // reachable; returns the handles unchanged when it is not, which unresolvedRefs() then reports.
    let c = raw;
    try { const credentials = require('./credentials'); c = credentials.resolveRefs(raw); } catch {}
    // ENV FALLBACK — the house pattern for headless callers (cf. BHATBOT_MCP_TOKEN). safeStorage is
    // Electron-only, so a bare `node scripts/...` run cannot decrypt the vault; env lets a worker or
    // a one-off script still reach Google without ever writing a plaintext secret to disk.
    const env = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    };
    for (const k of Object.keys(env)) {
      if (env[k] && (!c[k] || /^CRED_REF_/.test(String(c[k])))) c = { ...c, [k]: env[k] };
    }
    return c;
  } catch { return {}; }
}

/** True when a CRED_REF handle survived resolution — configured on paper, unusable in practice. */
function unresolvedRefs(c = cfg()) {
  return Object.entries(c).filter(([, v]) => typeof v === 'string' && /^CRED_REF_/.test(v)).map(([k]) => k);
}

/** True once clientId + clientSecret + a refresh token are all present AND resolved. */
function isConfigured() {
  const c = cfg();
  if (!(c.clientId && c.clientSecret && c.refreshToken)) return false;
  return unresolvedRefs(c).length === 0;   // an unresolved handle is NOT configured
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

// ---- Gmail: triage scan path (Phase A) --------------------------------------
// gmailSearch below is the REACTIVE tool path: 10 results, 3 headers, no pagination, capped at 25.
// Triage needs a different shape and must not disturb that one:
//   • the full header set the rule ladder keys on (List-Unsubscribe and Precedence decide whether
//     something is archivable at all, so fetching them is not optional);
//   • labelIds, because the ledger records prevLabelIds BEFORE mutating — that is what makes undo
//     exact rather than approximate;
//   • pagination, because the backlog is ~4,100 threads and a 25-cap cannot see it.
const TRIAGE_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Reply-To', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted'];

async function gmailScan(query, { limit = 100, pageToken = null, headers = TRIAGE_HEADERS } = {}) {
  return withGmail(async (g) => {
    const out = [];
    let token = pageToken, fetched = 0, pages = 0;
    while (fetched < limit && pages < 60) {
      pages++;
      const list = await g.users.messages.list({
        userId: 'me', q: query || '',
        maxResults: Math.min(100, limit - fetched),
        ...(token ? { pageToken: token } : {}),
      });
      const ids = (list.data.messages || []).map((m) => m.id);
      if (!ids.length) { token = list.data.nextPageToken || null; break; }
      for (const id of ids) {
        const m = await g.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: headers });
        const p = m.data.payload;
        const h = {};
        for (const name of headers) h[name] = headerOf(p, name);
        out.push({
          id, threadId: m.data.threadId, labelIds: m.data.labelIds || [],
          internalDate: Number(m.data.internalDate) || 0, snippet: m.data.snippet || '', headers: h,
        });
        fetched++;
      }
      token = list.data.nextPageToken || null;
      if (!token) break;
    }
    return { success: true, count: out.length, results: out, nextPageToken: token };
  });
}

// Batch modify — the backlog sweep would otherwise be one HTTP round-trip per message (4,100 of
// them). batchModify takes up to 1000 ids per call and is the difference between minutes and hours,
// and between staying inside the quota and being rate-limited off it.
async function gmailBatchModify(ids, { add = [], remove = [] } = {}) {
  return withGmail(async (g) => {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) return { success: true, modified: 0 };
    // Resolve names → ids once for the whole batch (system labels like INBOX/UNREAD pass through).
    const existing = (await g.users.labels.list({ userId: 'me' })).data.labels || [];
    const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
    const toId = (n) => (/^[A-Z_]+$|^Label_/.test(n) ? n : (byName.get(String(n).toLowerCase()) || n));
    const addIds = add.map(toId), removeIds = remove.map(toId);
    let modified = 0;
    for (let i = 0; i < list.length; i += 900) {
      const chunk = list.slice(i, i + 900);
      await g.users.messages.batchModify({ userId: 'me', requestBody: { ids: chunk, addLabelIds: addIds, removeLabelIds: removeIds } });
      modified += chunk.length;
    }
    return { success: true, modified, added: addIds, removed: removeIds };
  });
}

// Every address Siddhant has ever WRITTEN to. Per the triage spec this is the backbone of the person
// model and the single highest-precision signal available: "I have emailed you" beats any heuristic
// about names or domains. Built by walking in:sent (121 threads on the primary account — cheap) and
// refreshed nightly.
async function gmailSentContacts({ limit = 800 } = {}) {
  return withGmail(async (g) => {
    const counts = new Map();
    let token = null, fetched = 0, pages = 0;
    while (fetched < limit && pages < 30) {
      pages++;
      const list = await g.users.messages.list({ userId: 'me', q: 'in:sent', maxResults: Math.min(100, limit - fetched), ...(token ? { pageToken: token } : {}) });
      const ids = (list.data.messages || []).map((m) => m.id);
      if (!ids.length) break;
      for (const id of ids) {
        const m = await g.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['To', 'Cc', 'Date'] });
        const when = Number(m.data.internalDate) || 0;
        for (const field of ['To', 'Cc']) {
          for (const addr of parseAddressList(headerOf(m.data.payload, field))) {
            const cur = counts.get(addr) || { count: 0, lastAt: 0 };
            cur.count++; cur.lastAt = Math.max(cur.lastAt, when);
            counts.set(addr, cur);
          }
        }
        fetched++;
      }
      token = list.data.nextPageToken || null;
      if (!token) break;
    }
    return { success: true, contacts: Object.fromEntries(counts), scanned: fetched };
  });
}

// "Name <a@b.com>, c@d.com" → ['a@b.com','c@d.com'], lowercased.
function parseAddressList(v) {
  const out = [];
  for (const m of String(v || '').matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) out.push(m[0].toLowerCase());
  return out;
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
  SCOPES, isConfigured, oauthClient, cfg, setConfigResolver, unresolvedRefs,
  gmailSearch, gmailRead, gmailDraft, gmailLabel,
  gmailScan, gmailBatchModify, gmailSentContacts, parseAddressList, TRIAGE_HEADERS,
  calendarList, calendarCreate, calendarUpdate, calendarDelete,
  driveSearch, driveRead, driveCreate,
};
