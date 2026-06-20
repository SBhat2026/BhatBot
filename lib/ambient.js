'use strict';
// Ambient Awareness Layer (task #18) — narrow, OPT-IN, privacy-first proactive monitoring of
// high-signal personal sources (Calendar, Mail). It surfaces things UNPROMPTED: an imminent
// meeting, two overlapping events, a handful of unread emails that look like they need a reply.
//
// Design principles (read these before extending):
//   * OFF by default. If config.ambient.enabled !== true, EVERY exported fn is a no-op
//     returning {skipped:true}. No osascript runs, no permission prompts, nothing.
//   * Never throws. Calendar/Mail AppleScript is slow + permission-gated; each watcher is
//     independently guarded and degrades to {error} instead of crashing the host.
//   * Minimal surface area. We emit titles / subjects / senders / counts / times ONLY —
//     never email bodies, links, or codes. redact() enforces this on every signal text.
//   * Respect quiet hours. During quiet hours we still SCAN (collect + dedup) but suppress
//     surfacing, so a 3am calendar conflict is reported at wake time, not at 3am.
//   * Dedup. A seen-store (~/.bhatbot/ambient/seen.json) keeps the same item from being
//     surfaced over and over on every interval tick.
//
// Self-contained: Node built-ins + `osascript` via child_process only. No deps, no network.
// Wiring is described in lib/AMBIENT_INTEGRATION.md — NOTHING here is wired into main.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.bhatbot', 'config.json');
const STORE_DIR = path.join(HOME, '.bhatbot', 'ambient');
const SEEN_PATH = path.join(STORE_DIR, 'seen.json');

const OSA_TIMEOUT_MS = 10_000;   // Calendar/Mail can hang; hard cap so we never block a tick.
const SEEN_TTL_MS = 36 * 60 * 60 * 1000;  // forget seen items after 36h so they can resurface if still relevant
const SEEN_CAP = 500;            // bound the store

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enabled: false,
  intervalMin: 30,
  quietHours: [22, 7],   // [startHour, endHour) wrapping midnight → quiet 22:00–07:00
  lookaheadMin: 120,     // calendar window to look ahead
  mailLookbackHours: 12, // mail window to look back
  sources: { calendar: true, mail: false },
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const a = raw && typeof raw.ambient === 'object' && raw.ambient ? raw.ambient : {};
    return {
      ...DEFAULTS,
      ...a,
      sources: { ...DEFAULTS.sources, ...(a.sources || {}) },
    };
  } catch {
    return { ...DEFAULTS, sources: { ...DEFAULTS.sources } };
  }
}

function isEnabled() {
  return loadConfig().enabled === true;
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------
// quietHours [s,e]: quiet when hour in [s, e). Wraps midnight when s > e (e.g. [22,7]).
function inQuietHours(cfg = loadConfig(), now = new Date()) {
  const q = Array.isArray(cfg.quietHours) ? cfg.quietHours : DEFAULTS.quietHours;
  let s = Number(q[0]), e = Number(q[1]);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  s = ((s % 24) + 24) % 24; e = ((e % 24) + 24) % 24;
  if (s === e) return false;             // empty / disabled
  const h = now.getHours();
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
}

// ---------------------------------------------------------------------------
// Redaction — strip anything resembling a body / link / code from a summary.
// Signals carry titles, senders, times, counts only; this is a belt-and-suspenders
// pass so a watcher can't accidentally leak more than intended.
// ---------------------------------------------------------------------------
function redact(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/\r?\n/g, ' ');                                   // collapse to one line (no bodies)
  t = t.replace(/https?:\/\/\S+/gi, '[link]');                    // URLs
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, (m) => {         // emails → keep handle, drop domain
    const at = m.indexOf('@'); return at > 0 ? m.slice(0, at) + '@…' : '[email]';
  });
  t = t.replace(/\b\d[\d\s-]{4,}\d\b/g, '[number]');              // long digit runs (codes/phones/cards)
  t = t.replace(/\b[A-Z0-9]{6,}\b/g, '[code]');                   // OTP-ish all-caps/digit tokens
  t = t.replace(/\s{2,}/g, ' ').trim();
  if (t.length > 160) t = t.slice(0, 157).trimEnd() + '…';        // hard length cap
  return t;
}

// ---------------------------------------------------------------------------
// osascript runner — resolves (never rejects) with {ok,out,err}. Hard timeout.
// ---------------------------------------------------------------------------
function osa(script) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let p;
    try {
      p = spawn('osascript', ['-e', script], { env: process.env });
    } catch (e) {
      return finish({ ok: false, out: '', err: e.message });
    }
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      finish({ ok: false, out: '', err: 'timeout' });
    }, OSA_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); finish({ ok: false, out: '', err: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); finish({ ok: code === 0, out: out.trim(), err: err.trim() }); });
  });
}

// A unit-separated record format keeps us off JSON-in-AppleScript escaping hell.
const FS_FIELD = '';   // field sep
const RS_REC = '';     // record sep

// ---------------------------------------------------------------------------
// Watchers — each: async (cfg) → { signals:[{kind,text,urgency}], error? }
// urgency ∈ 'low' | 'med' | 'high'. text is ALREADY redacted by the watcher's caller.
// ---------------------------------------------------------------------------

// CALENDAR: next `lookaheadMin` of events across all calendars, plus overlap detection.
async function watchCalendar(cfg) {
  const lookahead = Math.max(5, Number(cfg.lookaheadMin) || DEFAULTS.lookaheadMin);
  // Emit one line per event: title FS isoStart FS isoEnd. Times via AppleScript date math.
  const script = `
set outText to ""
set nowD to current date
set horizon to nowD + (${lookahead} * minutes)
tell application "Calendar"
  repeat with cal in calendars
    try
      set evs to (every event of cal whose start date ≥ nowD and start date ≤ horizon)
      repeat with ev in evs
        set t to summary of ev
        set sd to start date of ev
        set ed to end date of ev
        set outText to outText & t & "${FS_FIELD}" & ((sd - (date "Thursday, January 1, 1970 12:00:00 AM")) as integer) & "${FS_FIELD}" & ((ed - (date "Thursday, January 1, 1970 12:00:00 AM")) as integer) & "${RS_REC}"
      end repeat
    end try
  end repeat
end tell
return outText`;
  const r = await osa(script);
  if (!r.ok) return { signals: [], error: calErr(r.err) };

  // Parse records. The epoch math above is in LOCAL time relative to the 1970 literal, which
  // AppleScript interprets in the machine's tz — same tz for "now", so deltas/ordering are
  // correct for our purposes (relative minutes-from-now, overlap comparisons).
  const events = [];
  for (const rec of r.out.split(RS_REC)) {
    if (!rec.trim()) continue;
    const [title, s, e] = rec.split(FS_FIELD);
    const start = Number(s), end = Number(e);
    if (!Number.isFinite(start)) continue;
    events.push({ title: (title || '(untitled)').trim(), start, end: Number.isFinite(end) ? end : start });
  }
  events.sort((a, b) => a.start - b.start);

  const signals = [];
  const nowSec = Math.floor(Date.now() / 1000);

  // Upcoming events.
  for (const ev of events) {
    const mins = Math.round((ev.start - nowSec) / 60);
    if (mins < -1) continue;   // already started (slack of 1 min)
    const when = mins <= 0 ? 'now' : mins < 60 ? `in ${mins} min` : `in ${Math.round(mins / 60 * 10) / 10}h`;
    const urgency = mins <= 10 ? 'high' : mins <= 30 ? 'med' : 'low';
    signals.push({
      kind: 'event.upcoming',
      key: `cal:up:${ev.title}:${ev.start}`,
      text: redact(`${ev.title} — ${when}`),
      urgency,
    });
  }

  // Overlap / conflict detection (pairwise on the sorted window).
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i], b = events[j];
      if (b.start >= a.end) break;   // sorted by start → no later event can overlap a
      signals.push({
        kind: 'event.conflict',
        key: `cal:conf:${[a.title, b.title].sort().join('|')}:${a.start}:${b.start}`,
        text: redact(`Calendar conflict: "${a.title}" overlaps "${b.title}"`),
        urgency: 'high',
      });
    }
  }
  return { signals };
}

function calErr(err) {
  if (/-1743|Not authorized|not allowed/i.test(err || '')) {
    return 'Calendar access not authorized — System Settings → Privacy & Security → Automation → enable BhatBot → Calendar.';
  }
  return err || 'calendar read failed';
}

// MAIL: unread inbox messages from the last `mailLookbackHours` that LOOK like they need a
// reply (heuristic). Returns a COUNT signal + up to a few subject/sender summaries. No bodies.
async function watchMail(cfg) {
  const hours = Math.max(1, Number(cfg.mailLookbackHours) || DEFAULTS.mailLookbackHours);
  const script = `
set outText to ""
set cutoff to (current date) - (${hours} * hours)
tell application "Mail"
  set boxes to {}
  try
    set boxes to (every inbox)
  end try
  repeat with mb in boxes
    try
      set msgs to (messages of mb whose read status is false and date received ≥ cutoff)
      repeat with m in msgs
        set subj to subject of m
        set sndr to sender of m
        set outText to outText & subj & "${FS_FIELD}" & sndr & "${RS_REC}"
      end repeat
    end try
  end repeat
end tell
return outText`;
  const r = await osa(script);
  if (!r.ok) return { signals: [], error: mailErr(r.err) };

  const candidates = [];
  for (const rec of r.out.split(RS_REC)) {
    if (!rec.trim()) continue;
    const [subject, sender] = rec.split(FS_FIELD);
    candidates.push({ subject: (subject || '(no subject)').trim(), sender: (sender || '').trim() });
  }

  // Heuristic: drop machine/newsletter senders; keep what plausibly wants a human reply.
  const NOISE = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|newsletter|notifications?|mailer|automated|updates?@|news@|info@|support@|noreply|digest|unsubscribe|via )/i;
  const needsReply = candidates.filter((c) => {
    const blob = `${c.sender} ${c.subject}`;
    if (NOISE.test(blob)) return false;
    return true;
  });

  if (needsReply.length === 0) return { signals: [] };

  const signals = [];
  // One aggregate count signal (high-signal, low-noise).
  signals.push({
    kind: 'mail.needs_reply',
    key: `mail:count:${new Date().toISOString().slice(0, 13)}:${needsReply.length}`,  // bucketed per hour
    text: redact(`${needsReply.length} unread email${needsReply.length === 1 ? '' : 's'} may need a reply (last ${hours}h)`),
    urgency: needsReply.length >= 5 ? 'med' : 'low',
  });
  // A few individual summaries (subject + sender handle only), capped.
  for (const c of needsReply.slice(0, 3)) {
    const from = senderName(c.sender);
    signals.push({
      kind: 'mail.item',
      key: `mail:item:${from}:${c.subject}`,
      text: redact(`Email from ${from}: ${c.subject}`),
      urgency: 'low',
    });
  }
  return { signals };
}

function senderName(raw) {
  // Mail's `sender` is usually "Display Name <addr@host>". Prefer the display name; never leak full addr.
  const m = /^\s*"?([^"<]+?)"?\s*<([^>]+)>/.exec(raw || '');
  if (m && m[1].trim()) return m[1].trim();
  const at = (raw || '').indexOf('@');
  return at > 0 ? raw.slice(0, at).replace(/[<"]/g, '').trim() + '@…' : (raw || 'unknown');
}

function mailErr(err) {
  if (/-1743|Not authorized|not allowed/i.test(err || '')) {
    return 'Mail access not authorized — System Settings → Privacy & Security → Automation → enable BhatBot → Mail.';
  }
  return err || 'mail read failed';
}

// Registry — adding a watcher = one line here + a source flag in config.
const WATCHERS = {
  calendar: watchCalendar,
  mail: watchMail,
};

// ---------------------------------------------------------------------------
// Seen store (dedup)
// ---------------------------------------------------------------------------
function loadSeen() {
  try {
    const o = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}
function saveSeen(map) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // prune expired + cap to newest SEEN_CAP entries
    const now = Date.now();
    let entries = Object.entries(map).filter(([, ts]) => now - ts < SEEN_TTL_MS);
    if (entries.length > SEEN_CAP) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, SEEN_CAP);
    fs.writeFileSync(SEEN_PATH, JSON.stringify(Object.fromEntries(entries), null, 2));
  } catch {}
}
function isSeen(key, seen, now = Date.now()) {
  const ts = seen[key];
  return ts != null && now - ts < SEEN_TTL_MS;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// scan() — run all ENABLED watchers, return only NEW (non-quiet, deduped) signals.
async function scan() {
  const cfg = loadConfig();
  if (cfg.enabled !== true) return { skipped: true };

  const quiet = inQuietHours(cfg);
  const seen = loadSeen();
  const now = Date.now();
  const out = [];
  const errors = {};

  for (const [name, fn] of Object.entries(WATCHERS)) {
    if (!cfg.sources || cfg.sources[name] !== true) continue;
    let res;
    try { res = await fn(cfg); }
    catch (e) { res = { signals: [], error: e && e.message ? e.message : 'watcher threw' }; }
    if (res && res.error) errors[name] = res.error;
    for (const sig of (res && res.signals) || []) {
      const key = sig.key || `${name}:${sig.kind}:${sig.text}`;
      if (isSeen(key, seen, now)) continue;     // already surfaced recently
      out.push({ source: name, kind: sig.kind, text: redact(sig.text), urgency: sig.urgency || 'low', _key: key });
    }
  }

  // During quiet hours we collect but do NOT surface (and do NOT mark seen — so they
  // surface on the first non-quiet tick). markSurfaced is the only writer to seen.json.
  const result = { signals: quiet ? [] : out, ts: new Date(now).toISOString() };
  if (quiet) result.quiet = true;
  if (Object.keys(errors).length) result.errors = errors;
  return result;
}

// digest(signals) — short plain-text briefing suitable to speak / notify. No bodies.
function digest(signals) {
  const list = Array.isArray(signals) ? signals : (signals && signals.signals) || [];
  if (!list.length) return '';
  const rank = { high: 0, med: 1, low: 2 };
  const sorted = [...list].sort((a, b) => (rank[a.urgency] ?? 3) - (rank[b.urgency] ?? 3));
  const lines = sorted.map((s) => {
    const mark = s.urgency === 'high' ? '‼️' : s.urgency === 'med' ? '•' : '·';
    return `${mark} ${redact(s.text)}`;
  });
  const head = list.length === 1 ? 'Heads up:' : `Heads up — ${list.length} things:`;
  return [head, ...lines].join('\n');
}

// markSurfaced(signals) — record them so they aren't surfaced again (within TTL).
function markSurfaced(signals) {
  const list = Array.isArray(signals) ? signals : (signals && signals.signals) || [];
  if (!list.length) return { marked: 0 };
  const seen = loadSeen();
  const now = Date.now();
  let n = 0;
  for (const s of list) {
    const key = s._key || `${s.source}:${s.kind}:${s.text}`;
    seen[key] = now; n++;
  }
  saveSeen(seen);
  return { marked: n };
}

// sources() — what watchers exist + which are enabled in config.
function sources() {
  const cfg = loadConfig();
  return {
    enabled: cfg.enabled === true,
    intervalMin: cfg.intervalMin,
    quietHours: cfg.quietHours,
    available: Object.keys(WATCHERS),
    active: Object.keys(WATCHERS).filter((n) => cfg.sources && cfg.sources[n] === true),
  };
}

module.exports = {
  isEnabled,
  scan,
  digest,
  markSurfaced,
  sources,
  // helpers exported for testing / reuse (no side effects of their own)
  redact,
  inQuietHours,
  loadConfig,
  WATCHERS,
  SEEN_PATH,
  DEFAULTS,
};
