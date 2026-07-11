'use strict';
// Project memory with a constantly-updating summary (Task #24).
//
// BhatBot can "open a project" and keep a living, cumulative summary of what that project is
// — refreshed as work happens. Each project is a JSON record on disk; one project is "active"
// at a time. The agent's memory block injects the active project's summary so BhatBot always
// knows the current context.
//
// The LLM is INJECTED by the caller (main.js) via `deps.summarize(prompt) -> Promise<string>`,
// so this module stays dependency-free, testable, and never imports the model layer. With no
// summarize dep it degrades to a deterministic summary (recent highlights/log lines).
//
// Design rules: every public read is synchronous; only updateSummary/maybeAutoSummarize are
// async (they may call the model). All writes are atomic (tmp + rename). Nothing ever throws —
// every entry point is wrapped, returning a safe default on failure.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = process.env.BHATBOT_PROJECTS_DIR || path.join(os.homedir(), '.bhatbot', 'projects');   // env override for tests/relocation
const ACTIVE_FILE = path.join(DIR, 'active.json');
const LOG_CAP = 200;            // keep only the last ~200 log entries per project
const LOG_KINDS = ['note', 'turn', 'decision', 'milestone', 'lane', 'artifact'];

// ---------------------------------------------------------------------------
// low-level fs helpers — all swallow errors and return safe defaults
// ---------------------------------------------------------------------------
function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJSON(file, obj) {
  try {
    ensureDir();
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);            // atomic replace
    return true;
  } catch { return false; }
}
function slugify(s) {
  return String(s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
}
function recordPath(slug) { return path.join(DIR, slug + '.json'); }
function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Normalize/repair a record read from disk so callers always get a complete shape.
function normalize(rec, slug) {
  rec = rec && typeof rec === 'object' ? rec : {};
  const now = new Date().toISOString();
  return {
    name: rec.name || slug || 'Project',
    slug: rec.slug || slug,
    created: rec.created || now,
    updated: rec.updated || now,
    status: ['active', 'paused', 'done'].includes(rec.status) ? rec.status : 'active',
    summary: typeof rec.summary === 'string' ? rec.summary : '',
    highlights: Array.isArray(rec.highlights) ? rec.highlights.filter((x) => typeof x === 'string') : [],
    log: Array.isArray(rec.log) ? rec.log.filter((e) => e && typeof e === 'object') : [],
    specs: rec.specs && typeof rec.specs === 'object' && !Array.isArray(rec.specs) ? rec.specs : {},   // locked build specs (resumable)
    artifacts: Array.isArray(rec.artifacts) ? rec.artifacts.filter((a) => a && typeof a === 'object') : [],   // produced deliverables (paths)
    _sinceSummary: Number.isFinite(rec._sinceSummary) ? rec._sinceSummary : 0,
  };
}
function load(slug) {
  if (!slug) return null;
  const raw = readJSON(recordPath(slug));
  if (!raw) return null;
  return normalize(raw, slug);
}
function save(rec) {
  rec.updated = new Date().toISOString();
  if (rec.log.length > LOG_CAP) rec.log = rec.log.slice(-LOG_CAP);
  return writeJSON(recordPath(rec.slug), rec) ? rec : null;
}

// ---------------------------------------------------------------------------
// active-project pointer
// ---------------------------------------------------------------------------
function activeSlug() {
  try { const a = readJSON(ACTIVE_FILE); return a && a.slug ? a.slug : null; } catch { return null; }
}
function setActive(slug) { return writeJSON(ACTIVE_FILE, { slug }); }
function active() { try { return load(activeSlug()); } catch { return null; } }

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

// open(name) — create the project if it doesn't exist, mark it active, return the record.
// Idempotent: opening an existing project just re-activates it (status revives to 'active').
function open(name) {
  try {
    const slug = slugify(name);
    let rec = load(slug);
    if (!rec) {
      const now = new Date().toISOString();
      rec = {
        name: String(name || slug).trim() || slug, slug, created: now, updated: now,
        status: 'active', summary: '', highlights: [], log: [], _sinceSummary: 0,
      };
      rec.log.push({ ts: now, kind: 'milestone', text: 'Project opened.' });
      save(rec);
    } else if (rec.status === 'done') {
      rec.status = 'active';
      save(rec);
    }
    setActive(slug);
    return rec;
  } catch { return null; }
}

function get(slug) { try { return load(slug); } catch { return null; } }

function list() {
  try {
    ensureDir();
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'active.json');
    const out = [];
    for (const f of files) {
      const rec = load(f.replace(/\.json$/, ''));
      if (!rec) continue;
      out.push({
        name: rec.name, slug: rec.slug, status: rec.status, updated: rec.updated,
        summaryLine: clip(rec.summary || (rec.highlights[rec.highlights.length - 1] || ''), 140),
      });
    }
    out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    return out;
  } catch { return []; }
}

// note(slug, text, kind) — append a log entry. decision/milestone entries also promote into
// the curated `highlights` list (the human-readable spine of the project).
function note(slug, text, kind = 'note') {
  try {
    const rec = load(slug);
    if (!rec) return null;
    const t = String(text || '').trim();
    if (!t) return rec;
    const k = LOG_KINDS.includes(kind) ? kind : 'note';
    rec.log.push({ ts: new Date().toISOString(), kind: k, text: clip(t, 1000) });
    rec._sinceSummary = (rec._sinceSummary || 0) + 1;
    if (k === 'decision' || k === 'milestone') {
      rec.highlights.push(clip(t, 200));
      if (rec.highlights.length > 40) rec.highlights = rec.highlights.slice(-40);
    }
    return save(rec);
  } catch { return null; }
}

// recordSpec(slug, spec) — merge locked build specifications (dimensions, colours, features, assumed
// defaults…) into the project so a later turn resumes with the exact spec, not a vague summary.
function recordSpec(slug, spec) {
  try {
    const rec = load(slug);
    if (!rec || !spec || typeof spec !== 'object') return rec;
    rec.specs = { ...rec.specs, ...spec };
    return save(rec);
  } catch { return null; }
}

// recordArtifact(slug, {kind, title, path, meta}) — remember a produced deliverable (a rendered
// Studio scene, a simulation, an image) with its on-disk path, so the build is a durable, resumable asset.
function recordArtifact(slug, art) {
  try {
    const rec = load(slug);
    if (!rec || !art || typeof art !== 'object') return rec;
    const entry = { ts: new Date().toISOString(), kind: String(art.kind || 'artifact'), title: clip(art.title || '', 120), path: art.path || '', meta: art.meta && typeof art.meta === 'object' ? art.meta : undefined };
    rec.artifacts.push(entry);
    if (rec.artifacts.length > 60) rec.artifacts = rec.artifacts.slice(-60);
    return save(rec);
  } catch { return null; }
}

// recordTurn(slug, userText, assistantText) — compact 'turn' log entry. Truncated hard so a
// chatty session doesn't bloat the record; the summary is where meaning is preserved.
function recordTurn(slug, userText, assistantText) {
  try {
    const u = clip(String(userText || '').replace(/\s+/g, ' ').trim(), 200);
    const a = clip(String(assistantText || '').replace(/\s+/g, ' ').trim(), 280);
    if (!u && !a) return load(slug);
    const text = (u ? 'U: ' + u : '') + (u && a ? ' — ' : '') + (a ? 'A: ' + a : '');
    return note(slug, text, 'turn');
  } catch { return null; }
}

function setStatus(slug, status) {
  try {
    const rec = load(slug);
    if (!rec) return null;
    rec.status = status;
    rec.log.push({ ts: new Date().toISOString(), kind: 'milestone', text: 'Status → ' + status });
    return save(rec);
  } catch { return null; }
}
function close(slug) { return setStatus(slug, 'done'); }
function pause(slug) { return setStatus(slug, 'paused'); }

// Deterministic fallback summary: a tight blurb from the latest highlights + log lines.
// Used when no LLM is injected, or as a safety net if the model call yields nothing.
function deterministicSummary(rec) {
  try {
    const lines = [];
    const hi = rec.highlights.slice(-4);
    for (const h of hi) lines.push(h);
    if (lines.length < 4) {
      const recent = rec.log.slice(-(8)).map((e) => e.text).reverse();
      for (const r of recent) { if (lines.length >= 6) break; if (!lines.includes(r)) lines.push(r); }
    }
    const head = rec.name + (rec.status !== 'active' ? ' (' + rec.status + ')' : '');
    if (!lines.length) return head + ': project opened; no activity logged yet.';
    return clip(head + ' — ' + lines.join('; ') + '.', 700);
  } catch { return (rec && rec.name) ? rec.name + ': project in progress.' : 'Project in progress.'; }
}

function buildPrompt(rec) {
  const recentLog = rec.log.slice(-24).map((e) => `[${e.kind}] ${e.text}`).join('\n');
  const hi = rec.highlights.slice(-12).join('\n');
  return [
    'You maintain a CUMULATIVE living summary of an ongoing project for an AI assistant.',
    'Rewrite the summary so it captures WHAT THE PROJECT IS, its goals, current state, and open threads.',
    'Be specific and dense. Carry forward durable facts from the previous summary; fold in the new activity.',
    'Output ONE tight paragraph, ≤120 words. No preamble, no markdown, no bullet list.',
    '',
    'PROJECT NAME: ' + rec.name + '  (status: ' + rec.status + ')',
    specLine(rec),
    artifactLine(rec),
    '',
    'PREVIOUS SUMMARY:',
    rec.summary || '(none yet)',
    '',
    'KEY HIGHLIGHTS:',
    hi || '(none)',
    '',
    'RECENT ACTIVITY (oldest→newest):',
    recentLog || '(none)',
    '',
    'New cumulative summary:',
  ].join('\n');
}

// updateSummary(slug, deps) — regenerate the rolling summary. deps.summarize(prompt) is an
// async fn returning a string (inject main.js's model call). Falls back to deterministic on
// any absence/failure. Persists and returns the new summary string.
async function updateSummary(slug, deps = {}) {
  try {
    const rec = load(slug);
    if (!rec) return '';
    let summary = '';
    if (deps && typeof deps.summarize === 'function') {
      try {
        const out = await deps.summarize(buildPrompt(rec));
        summary = String(out || '').trim();
      } catch { summary = ''; }
    }
    if (!summary) summary = deterministicSummary(rec);
    summary = clip(summary, 900);
    rec.summary = summary;
    rec._sinceSummary = 0;
    save(rec);
    return summary;
  } catch {
    const rec = load(slug);
    return rec ? deterministicSummary(rec) : '';
  }
}

// maybeAutoSummarize(slug, deps, everyN) — only regenerate when the log has grown by >= everyN
// entries since the last summary, keeping it cheap. Returns {updated, summary}.
async function maybeAutoSummarize(slug, deps = {}, everyN = 6) {
  try {
    const rec = load(slug);
    if (!rec) return { updated: false, summary: '' };
    if ((rec._sinceSummary || 0) < everyN) return { updated: false, summary: rec.summary || '' };
    const summary = await updateSummary(slug, deps);
    return { updated: true, summary };
  } catch { return { updated: false, summary: '' }; }
}

// contextBlock() — sync string injected into the agent's memory block so BhatBot always knows
// the active project. Empty string when nothing is open.
function specLine(rec) {
  try {
    const keys = Object.keys(rec.specs || {});
    if (!keys.length) return '';
    const parts = keys.slice(0, 16).map((k) => `${k}: ${clip(String(rec.specs[k]), 60)}`);
    return '\nSPECS — ' + parts.join(' · ');
  } catch { return ''; }
}
function artifactLine(rec) {
  try {
    const a = (rec.artifacts || []).slice(-4);
    if (!a.length) return '';
    return '\nARTIFACTS — ' + a.map((x) => `${x.kind}${x.title ? ' "' + x.title + '"' : ''}${x.path ? ' (' + x.path + ')' : ''}`).join(' · ');
  } catch { return ''; }
}
function contextBlock() {
  try {
    const rec = active();
    if (!rec) return '';
    const summary = (rec.summary || deterministicSummary(rec)).trim();
    const recent = rec.highlights.slice(-3);
    const recentLine = recent.length ? '\n(recent: ' + recent.join(' | ') + ')' : '';
    // Fold the locked specs + produced artifacts into context so a resume turn continues the ACTUAL
    // build (exact dimensions/features/files), not just a prose gist — the "keep working on it" path.
    return '## ACTIVE PROJECT — YOUR CURRENT FOCUS: ' + rec.name + '\n' + summary + specLine(rec) + artifactLine(rec) + recentLine
      + '\n\nSTAY ON THIS PROJECT. Do NOT switch to, work on, mix in, or bring up any OTHER project '
      + 'unless Siddhant explicitly names a different one in his message. If he says "it" / "that" / '
      + '"the render" / "finish it", he means ' + rec.name + ' — never a different project. If you are '
      + 'unsure which project he means, ASK; do not assume a different one.';
  } catch { return ''; }
}

module.exports = {
  open, active, activeSlug, setActive, list, get, note, recordTurn, recordSpec, recordArtifact, close, pause,
  updateSummary, maybeAutoSummarize, contextBlock,
  // exposed for tests/integration
  slugify, _DIR: DIR,
};
