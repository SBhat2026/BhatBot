'use strict';
// lib/codescan.js — self-drive's "eyes on its own source." The self-portrait used to describe only
// TELEMETRY (latency, cost, tool usage) and doc-note debt, so reflect()'s desire engine had no
// concrete code to reason about — with no focus it found nothing actionable and the session halted
// immediately ("no_actionable_desires"). This scans the actual repo for CONCRETE, file-level
// improvement opportunities so reflect() can propose desires that name a real code surface (which is
// exactly what classifyActionability requires to mark a desire automatable).
//
// Pure + dependency-light (fs/path only). Read-only. Everything is bounded so the result stays small
// enough to ride inside the reflection prompt. scan(repoDir) → a compact opportunities object.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'OmniParser', 'vendor', '__pycache__', 'assets', '.phase4-backup']);
const SRC_DIRS = ['lib', 'tools', 'scripts'];        // plus root-level *.js
const CODE_EXT = new Set(['.js']);
const MAX_READ = 2 * 1024 * 1024;                     // per-file read cap
const TODO_RE = /(?:\/\/|#|\*)\s*(TODO|FIXME|HACK|XXX|BUG)\b[:\s-]*(.{0,140})/i;
const EMPTY_CATCH_RE = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

function readSafe(p) { try { if (fs.statSync(p).size > MAX_READ) return fs.readFileSync(p, 'utf8').slice(0, MAX_READ); return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// Collect candidate source files: root *.js + the SRC_DIRS (one level, scripts is flat), skipping junk.
function listSources(root) {
  const files = [];
  try { for (const f of fs.readdirSync(root)) { if (f.endsWith('.js') && fs.statSync(path.join(root, f)).isFile()) files.push(f); } } catch {}
  for (const d of SRC_DIRS) {
    const dir = path.join(root, d);
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; continue; }   // one level deep is enough here
      if (CODE_EXT.has(path.extname(e.name))) files.push(path.join(d, e.name));
    }
  }
  return files;
}

// Parse the issues dossier / next-push notes for still-open, code-referencing items.
function docsBacklog(root) {
  const out = [];
  for (const f of ['BHATBOT_ISSUES_DOSSIER.md', 'NEXT-PUSH.md', 'AMBITIOUS_ROADMAP.md']) {
    const txt = readSafe(path.join(root, f)); if (!txt) continue;
    for (const raw of txt.split('\n')) {
      const t = raw.trim();
      if (t.length < 16) continue;
      // Open checkbox, or a §-tagged recommendation, or an explicit "remaining/pending/not yet" note.
      if (/^[-*]?\s*⬜/.test(t) || /\b(remaining|still pending|not yet|TODO|to-do)\b/i.test(t) && /§|\.js\b|lib\/|tools\/|src\//.test(t)) {
        out.push({ file: f, note: t.replace(/^[-*>\s⬜✅⚠️]+/, '').slice(0, 180) });
      }
      if (out.length >= 15) return out;
    }
  }
  return out;
}

function scan(repoDir) {
  const root = repoDir || process.cwd();
  const files = listSources(root);
  const todos = [], oversized = [], swallowed = [], untested = [];
  let scanned = 0, empty_catch_total = 0;

  // Which base names have a test file (scripts/test-*.js mentioning them)? Cheap heuristic.
  let testBlob = '';
  try { for (const f of fs.readdirSync(path.join(root, 'scripts'))) if (/^test-/.test(f)) testBlob += f + '\n' + readSafe(path.join(root, 'scripts', f)).slice(0, 2000); } catch {}

  for (const rel of files) {
    const abs = path.join(root, rel);
    let size = 0; try { size = fs.statSync(abs).size; } catch { continue; }
    const txt = readSafe(abs); if (!txt) continue;
    scanned++;
    const lines = txt.split('\n');

    // TODO/FIXME/HACK markers (real code comments)
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(TODO_RE);
      if (m && todos.length < 25) todos.push({ file: rel, line: i + 1, kind: m[1].toUpperCase(), text: (m[2] || '').trim().slice(0, 120) });
    }
    // oversized modules → refactor/split candidates (named surface)
    if (lines.length > 1500 || size > 80 * 1024) oversized.push({ file: rel, lines: lines.length, kb: Math.round(size / 1024) });
    // swallowed errors → error-handling improvement candidates
    const ec = (txt.match(EMPTY_CATCH_RE) || []).length;
    if (ec > 0) { empty_catch_total += ec; if (ec >= 5) swallowed.push({ file: rel, empty_catches: ec }); }
    // untested sizable lib modules
    if (rel.startsWith('lib/') && size > 4 * 1024) {
      const base = path.basename(rel, '.js');
      if (!new RegExp('test-' + base.replace(/[^a-z0-9]/gi, '.?') , 'i').test(testBlob)) untested.push({ file: rel, kb: Math.round(size / 1024) });
    }
  }

  oversized.sort((a, b) => b.lines - a.lines);
  swallowed.sort((a, b) => b.empty_catches - a.empty_catches);
  untested.sort((a, b) => b.kb - a.kb);
  const backlog = docsBacklog(root);

  const summary = `scanned ${scanned} source files · ${todos.length} TODO/FIXME markers · ${oversized.length} oversized modules · ${swallowed.length} files with ≥5 swallowed errors · ${untested.length} sizable untested lib modules · ${backlog.length} open doc-backlog items`;
  return {
    summary,
    todos,
    oversized_modules: oversized.slice(0, 10),
    swallowed_errors: swallowed.slice(0, 10),
    untested_modules: untested.slice(0, 10),
    docs_backlog: backlog,
    totals: { source_files: scanned, todo_markers: todos.length, empty_catches: empty_catch_total },
    note: 'Concrete, read-only improvement opportunities in BhatBot\'s own source. Each names a real file (and often a line) — safe to ground an automatable desire on.',
  };
}

module.exports = { scan, listSources };
