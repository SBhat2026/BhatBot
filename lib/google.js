'use strict';
// Google integration — Gmail, Calendar, Drive over one OAuth2 client.
// Requires: googleapis (npm install googleapis)
// Config keys (~/.bhatbot/config.json → config.google):
//   clientId, clientSecret            — ONE OAuth app, shared by every account
//   accounts: [{ email, refreshToken, label?, primary?, triage? }]
// Mint a refresh token per account with `npm run google:auth`; it APPENDS rather than replaces.
// A legacy top-level `refreshToken` is still honoured and presented as a single primary account,
// so nothing that predates multi-account has to be migrated by hand.
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

// ── ACCOUNTS ─────────────────────────────────────────────────────────────────────────────────────
// One OAuth client, many refresh tokens. clientId/clientSecret identify the APP; a refresh token
// identifies a PERSON'S MAILBOX, so the only thing that varies per account is the token.
//
// The whole of multi-account lives in this section plus the `sel` parameter threaded through
// oauthClient → api → withService. Every one of the twenty-odd exported calls goes through that
// chokepoint, so none of them had to learn about accounts individually.
const isRef = (v) => typeof v === 'string' && /^CRED_REF_/.test(v);

/**
 * Normalised account list, always at least conceptually ordered with the primary first.
 * A legacy single `refreshToken` becomes one unnamed primary account.
 */
function accounts(c = cfg()) {
  const list = Array.isArray(c.accounts) ? c.accounts.slice() : [];
  // THE LEGACY ACCOUNT INHERITS TRIAGE. Before multi-account there was exactly one mailbox and
  // exactly one switch — config.triage.enabled — so the single token IS the account triage was
  // already configured against. Synthesising it with the new per-account default of `triage: false`
  // silently switched a running subsystem off, which is what happened on 2026-09-22: triage went
  // from working to "no-account-opted-in" purely because the config had not been migrated yet.
  // The per-account opt-in only starts meaning anything once there is more than one account.
  if (!list.length && c.refreshToken) list.push({ email: c.email || '', refreshToken: c.refreshToken, primary: true, triage: true });
  const out = list
    .filter((a) => a && a.refreshToken)
    .map((a, i) => ({
      email: String(a.email || '').toLowerCase(),
      label: a.label || a.email || ('account ' + (i + 1)),
      refreshToken: a.refreshToken,
      primary: !!a.primary,
      // Triage is OPT-IN per account, deliberately. A work or school inbox is often worth connecting
      // for search and calendar while nothing should ever propose archiving in it, and a default of
      // "triage everything you can reach" is the wrong way round for an action with side effects.
      triage: a.triage === true,
      // 'high' narrows what triage may ACT on for this mailbox (see lib/triage.js highCareBlock).
      // It does not narrow what it may read or propose.
      care: a.care === 'high' ? 'high' : 'standard',
      // `usable` stays "the token decrypted", because that is what decides whether we can even TRY.
      // `rejected` is the separate, harder fact: Google has refused this one.
      usable: !isRef(a.refreshToken),
      rejected: (_rejected.get(a.refreshToken) || null),
    }));
  if (out.length && !out.some((a) => a.primary)) out[0].primary = true;   // never leave writes homeless
  return out.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
}

/** Accounts that are actually usable right now (token resolved out of the vault). */
function usableAccounts(c = cfg()) { return accounts(c).filter((a) => a.usable); }

/** Accounts that have opted in to mail triage. */
function triageAccounts(c = cfg()) { return usableAccounts(c).filter((a) => a.triage); }

/**
 * Resolve an account selector to one account.
 *   undefined / null / 'primary'  → the primary (where writes go when nothing is named)
 *   'all'                         → null (callers that fan out handle this themselves)
 *   an email, a label, or a substring of either → that account
 * An unrecognised selector returns null rather than silently falling back to the primary: sending a
 * draft from the wrong mailbox is worse than not sending it.
 */
function accountFor(sel, c = cfg()) {
  const list = usableAccounts(c);
  if (!list.length) return null;
  if (!sel || sel === 'primary' || sel === true) return list.find((a) => a.primary) || list[0];
  if (sel === 'all') return null;
  if (typeof sel === 'object' && sel.refreshToken) return sel;
  const q = String(sel).toLowerCase().trim();
  return list.find((a) => a.email === q)
      || list.find((a) => String(a.label).toLowerCase() === q)
      || list.find((a) => a.email.startsWith(q) || a.email.includes(q) || String(a.label).toLowerCase().includes(q))
      || null;
}

/** True when a CRED_REF handle survived resolution — configured on paper, unusable in practice. */
function unresolvedRefs(c = cfg()) {
  const top = Object.entries(c)
    .filter(([k, v]) => k !== 'accounts' && isRef(v)).map(([k]) => k);
  const perAccount = (Array.isArray(c.accounts) ? c.accounts : [])
    .filter((a) => a && isRef(a.refreshToken))
    .map((a, i) => `accounts[${i}].refreshToken${a.email ? ' (' + a.email + ')' : ''}`);
  return [...top, ...perAccount];
}

/** True once the app credentials AND at least one account's token are present and resolved. */
function isConfigured() {
  const c = cfg();
  if (!c.clientId || !c.clientSecret || isRef(c.clientId) || isRef(c.clientSecret)) return false;
  return usableAccounts(c).length > 0;
}

// Per-account OAuth clients, keyed by the token itself — googleapis caches the access token on the
// client, so reusing one per account is what keeps a fan-out from re-minting on every call.
const _authByKey = new Map();

// WHAT "USABLE" ACTUALLY MEANS. A token that decrypts out of the vault is not the same as a token
// Google still accepts — a revoked or expired grant decrypts perfectly and then fails every call
// with `invalid_grant`. Reporting that as "ok" is the same class of lie as isConfigured() returning
// true while every CRED_REF was an undecrypted handle. So a rejection is remembered, per account,
// and surfaced: that is what lets the agent say WHICH mailbox needs re-authorising.
const _rejected = new Map();          // token → { reason, at }
function noteRejection(token, reason) { if (token) _rejected.set(token, { reason, at: Date.now() }); }
function clearRejection(token) { if (token) _rejected.delete(token); }
function oauthClient(sel) {
  const c = cfg();
  if (!c.clientId || !c.clientSecret) return null;
  const acct = accountFor(sel, c);
  if (!acct) return null;
  const key = c.clientId + '|' + acct.refreshToken;
  if (_authByKey.has(key)) return _authByKey.get(key);
  try {
    const { google } = require('googleapis');
    const o = new google.auth.OAuth2(c.clientId, c.clientSecret, c.redirectUri || 'http://localhost:4137/oauth2callback');
    o.setCredentials({ refresh_token: acct.refreshToken });
    _authByKey.set(key, o);
    return o;
  } catch { return null; }   // package missing → degrade
}

function api(name, version, sel) {
  const auth = oauthClient(sel);
  if (!auth) return null;
  try { const { google } = require('googleapis'); return google[name]({ version, auth }); }
  catch { return null; }
}

async function withService(name, version, fn, sel) {
  const svc = api(name, version, sel);
  if (!svc) return SKIPPED;
  const acct = accountFor(sel);
  try {
    const r = await fn(svc);
    clearRejection(acct && acct.refreshToken);   // it answered — whatever we thought before is stale
    return r;
  } catch (e) {
    const msg = (e && e.errors && e.errors[0] && e.errors[0].message) || (e && e.message) || String(e);
    // A dead grant is a fact about the ACCOUNT, not about this call, and it is the one error worth
    // remembering: every subsequent call will fail the same way until someone re-authorises.
    if (/invalid_grant|Token has been expired or revoked|unauthorized_client/i.test(msg)) {
      noteRejection(acct && acct.refreshToken, msg);
    }
    return { success: false, error: msg, ...(acct ? { account: acct.email || acct.label } : {}) };
  }
}
const withGmail = (fn, sel) => withService('gmail', 'v1', fn, sel);
const withCalendar = (fn, sel) => withService('calendar', 'v3', fn, sel);
const withDrive = (fn, sel) => withService('drive', 'v3', fn, sel);

// ── FAN-OUT ──────────────────────────────────────────────────────────────────────────────────────
// Reads go to every connected account; writes go to one. That asymmetry is the whole policy: a
// search that misses the inbox the thing is actually in is a wrong answer, while a draft sent from
// the wrong mailbox is a wrong ACTION, and those deserve different defaults.
//
// Each result is tagged with the account it came from, and one account failing does not fail the
// call — a dead token on a secondary inbox degrades the answer, it does not withhold it.
async function eachAccount(fn, { account, concurrent = true } = {}) {
  const list = account && account !== 'all'
    ? [accountFor(account)].filter(Boolean)
    : usableAccounts();
  if (!list.length) return [];
  const run = async (a) => {
    try { return { account: a, ok: true, result: await fn(a) }; }
    catch (e) { return { account: a, ok: false, error: (e && e.message) || String(e) }; }
  };
  return concurrent ? Promise.all(list.map(run)) : (async () => {
    const out = []; for (const a of list) out.push(await run(a)); return out;
  })();
}

/**
 * Merge a fan-out into the single-call shape every caller already expects, with each row carrying
 * the account it came from. `errors` is always present and always honest: a partial answer says so
 * rather than looking like a complete one.
 */
function mergeFanout(parts, key = 'results') {
  const rows = [], errors = [];
  for (const p of parts) {
    const r = p.result;
    if (!p.ok) { errors.push(`${p.account.label}: ${p.error}`); continue; }
    if (!r || r.skipped) { errors.push(`${p.account.label}: ${(r && r.reason) || 'unavailable'}`); continue; }
    if (r.success === false) { errors.push(`${p.account.label}: ${r.error}`); continue; }
    for (const row of (r[key] || [])) rows.push({ ...row, account: p.account.email || p.account.label });
  }
  return {
    success: rows.length > 0 || errors.length === 0,
    count: rows.length, [key]: rows,
    accounts: parts.map((p) => p.account.email || p.account.label),
    ...(errors.length ? { errors } : {}),
  };
}

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

async function gmailScan(query, { limit = 100, pageToken = null, headers = TRIAGE_HEADERS, account } = {}) {
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
  }, account);
}

// Batch modify — the backlog sweep would otherwise be one HTTP round-trip per message (4,100 of
// them). batchModify takes up to 1000 ids per call and is the difference between minutes and hours,
// and between staying inside the quota and being rate-limited off it.
async function gmailBatchModify(ids, { add = [], remove = [], account } = {}) {
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
  }, account);
}

// Every address Siddhant has ever WRITTEN to. Per the triage spec this is the backbone of the person
// model and the single highest-precision signal available: "I have emailed you" beats any heuristic
// about names or domains. Built by walking in:sent (121 threads on the primary account — cheap) and
// refreshed nightly.
async function gmailSentContacts({ limit = 800, account } = {}) {
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
  }, account);
}

// "Name <a@b.com>, c@d.com" → ['a@b.com','c@d.com'], lowercased.
function parseAddressList(v) {
  const out = [];
  for (const m of String(v || '').matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) out.push(m[0].toLowerCase());
  return out;
}

// ---- Gmail -----------------------------------------------------------------
async function gmailSearchOne(query, { limit = 10, account } = {}) {
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
  }, account);
}

async function gmailRead(id, { account } = {}) {
  return withGmail(async (g) => {
    const m = await g.users.messages.get({ userId: 'me', id, format: 'full' });
    const p = m.data.payload;
    return {
      success: true, id, threadId: m.data.threadId,
      from: headerOf(p, 'From'), to: headerOf(p, 'To'), subject: headerOf(p, 'Subject'), date: headerOf(p, 'Date'),
      labels: m.data.labelIds || [], body: extractBody(p).slice(0, 12000),
    };
  }, account);
}

// Create a DRAFT (never auto-sends). Pass threadId to reply within a thread.
async function gmailDraft({ to, subject, body, cc, threadId, account } = {}) {
  return withGmail(async (g) => {
    const lines = [];
    if (to) lines.push('To: ' + to);
    if (cc) lines.push('Cc: ' + cc);
    if (subject) lines.push('Subject: ' + subject);
    lines.push('Content-Type: text/plain; charset=utf-8', '', body || '');
    const raw = b64urlEncode(lines.join('\r\n'));
    const d = await g.users.drafts.create({ userId: 'me', requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } } });
    return { success: true, draftId: d.data.id, messageId: d.data.message && d.data.message.id, note: 'Draft created (not sent).' };
  }, account);
}

// Add/remove labels. Accepts label NAMES or ids; resolves names to ids, creating missing ones.
async function gmailLabel(id, { add = [], remove = [], account } = {}) {
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
  }, account);
}

// ---- Calendar --------------------------------------------------------------

/**
 * A Google Calendar event → the shape BhatBot passes around. EXPORTED so the call gate's tests can
 * feed lib/availability.js exactly what this produces. They used to hand it raw Google events, which
 * is how the gate came to read `start.dateTime` off a value that is a string by the time it arrives.
 */
function flattenEvent(e) {
  return {
      id: e.id, summary: e.summary, location: e.location,
      start: (e.start && (e.start.dateTime || e.start.date)) || null,
      end: (e.end && (e.end.dateTime || e.end.date)) || null,
      attendees: (e.attendees || []).map((a) => a.email), htmlLink: e.htmlLink,
      // What lib/availability.js needs to tell an engagement from a reminder. Flattening these away
      // left the call gate unable to honour "show me as free", a cancelled event, or a meeting he
      // declined — it could only ever treat everything as busy, or (as it turned out) nothing.
      allDay: !!(e.start && e.start.date && !e.start.dateTime),
      status: e.status || null, transparency: e.transparency || null, eventType: e.eventType || null,
      selfResponse: ((e.attendees || []).find((a) => a && a.self) || {}).responseStatus || null,
    };
}

async function calendarListOne({ calendarId = 'primary', timeMin, timeMax, query, limit = 10, account } = {}) {
  return withCalendar(async (c) => {
    const params = {
      calendarId, singleEvents: true, orderBy: 'startTime', maxResults: Math.min(limit, 50),
      timeMin: timeMin || new Date(Date.now() - 3600e3).toISOString(),
    };
    if (timeMax) params.timeMax = timeMax;
    if (query) params.q = query;
    const r = await c.events.list(params);
    const events = (r.data.items || []).map(flattenEvent);
    return { success: true, count: events.length, events };
  }, account);
}

async function calendarCreate({ summary, description, location, start, end, attendees, calendarId = 'primary', account } = {}) {
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
  }, account);
}

async function calendarUpdate(id, { summary, description, location, start, end, calendarId = 'primary', account } = {}) {
  return withCalendar(async (c) => {
    const patch = {};
    if (summary != null) patch.summary = summary;
    if (description != null) patch.description = description;
    if (location != null) patch.location = location;
    if (start) patch.start = /T/.test(start) ? { dateTime: start } : { date: start };
    if (end) patch.end = /T/.test(end) ? { dateTime: end } : { date: end };
    const r = await c.events.patch({ calendarId, eventId: id, requestBody: patch });
    return { success: true, id: r.data.id, htmlLink: r.data.htmlLink };
  }, account);
}

async function calendarDelete(id, { calendarId = 'primary', account } = {}) {
  return withCalendar(async (c) => {
    await c.events.delete({ calendarId, eventId: id });
    return { success: true, id, deleted: true };
  }, account);
}

// ---- Drive -----------------------------------------------------------------
async function driveSearchOne(query, { limit = 10, account } = {}) {
  return withDrive(async (d) => {
    // Treat a bare string as a full-text search; pass a raw Drive query if it looks like one.
    const q = /[:=]/.test(query || '') ? query : `fullText contains '${String(query || '').replace(/'/g, "\\'")}' and trashed = false`;
    const r = await d.files.list({ q, pageSize: Math.min(limit, 50), fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))' });
    const files = (r.data.files || []).map((f) => ({
      id: f.id, name: f.name, mimeType: f.mimeType, modified: f.modifiedTime, link: f.webViewLink,
      owner: (f.owners && f.owners[0] && f.owners[0].displayName) || null,
    }));
    return { success: true, count: files.length, files };
  }, account);
}

async function driveRead(id, { account } = {}) {
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
  }, account);
}

async function driveCreate({ name, content = '', mimeType = 'text/plain', folderId, account } = {}) {
  return withDrive(async (d) => {
    const requestBody = { name };
    if (folderId) requestBody.parents = [folderId];
    const r = await d.files.create({ requestBody, media: { mimeType, body: content }, fields: 'id,name,webViewLink' });
    return { success: true, id: r.data.id, name: r.data.name, link: r.data.webViewLink };
  }, account);
}

// ── THE PUBLIC READS ─────────────────────────────────────────────────────────────────────────────
// Same names and the same result shape as before multi-account, so no caller had to change: pass
// nothing and a read now covers every connected inbox, with each row tagged by the account it came
// from. Naming an account (`{ account: 'school' }`) narrows it back to one, and the *One variants
// are there for callers like triage that deliberately work a single mailbox at a time.
async function gmailSearch(query, opts = {}) {
  if (opts.account && opts.account !== 'all') return gmailSearchOne(query, opts);
  const parts = await eachAccount((a) => gmailSearchOne(query, { ...opts, account: a }), opts);
  return parts.length ? mergeFanout(parts) : gmailSearchOne(query, opts);
}
async function calendarList(opts = {}) {
  if (opts.account && opts.account !== 'all') return calendarListOne(opts);
  const parts = await eachAccount((a) => calendarListOne({ ...opts, account: a }), opts);
  if (!parts.length) return calendarListOne(opts);
  const merged = mergeFanout(parts, 'events');
  // Two calendars merged but not sorted is a list nobody can read as a day.
  merged.events.sort((x, y) => String(x.start || '').localeCompare(String(y.start || '')));
  return merged;
}
async function driveSearch(query, opts = {}) {
  if (opts.account && opts.account !== 'all') return driveSearchOne(query, opts);
  const parts = await eachAccount((a) => driveSearchOne(query, { ...opts, account: a }), opts);
  return parts.length ? mergeFanout(parts, 'files') : driveSearchOne(query, opts);
}

module.exports = { flattenEvent,
  SCOPES, isConfigured, oauthClient, cfg, setConfigResolver, unresolvedRefs,
  accounts, usableAccounts, triageAccounts, accountFor, eachAccount, mergeFanout, noteRejection,
  gmailSearch, gmailSearchOne, gmailRead, gmailDraft, gmailLabel,
  gmailScan, gmailBatchModify, gmailSentContacts, parseAddressList, TRIAGE_HEADERS,
  calendarList, calendarListOne, calendarCreate, calendarUpdate, calendarDelete,
  driveSearch, driveSearchOne, driveRead, driveCreate,
};
