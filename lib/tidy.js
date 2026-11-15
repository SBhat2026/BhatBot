'use strict';
// ── TIDY — find what is redundant, move it aside, never delete ───────────────────────────────────
//
// Asked for 2026-11-14: "run through all my files, put all the redundant or seemingly unnecessary
// files into a single folder for deletion … then ask for permission to delete."
//
// So this never deletes. It FINDS, by named rules, and MOVES into one review folder while keeping
// each file's original path, with a manifest that can put every file back. Deleting is a separate,
// explicit step he takes after looking.
//
// Every rule is a category he can veto as a whole, and each finding carries a one-line reason.
// The rules are deliberately the boring, provable kinds — an exact duplicate, an installer whose app
// is installed, an archive that has been unpacked, an editor's backup — because "this file seems
// useless" is a judgement about his work that a scanner has no business making. Where a category is
// a judgement (dependencies of a project untouched for months), it says so.
//
// THE GUARDS ARE THE POINT, more than the rules:
//   • lib/autonomy.js decides what is financial or confidential. Those are never collected, never
//     hashed, never listed — the same rule that stops BhatBot opening a bank site stops it filing
//     his tax return under "duplicates".
//   • nothing modified in the last few days (he may be using it right now)
//   • nothing inside a git work tree (a repo's files are its own business; duplicates there are
//     usually deliberate), except caches the repo itself ignores
//   • no iCloud file that is not on this Mac — moving one forces a download, and its bytes cannot be
//     compared without fetching them
//   • ~/Library, Photos and Music libraries, app bundles, and anything under an exclude path
//
// Pure-ish: the filesystem is passed in as `fsx` so the rules are testable against a fixture tree.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { forbidden } = require('./autonomy');

const DAY = 86400000;
const DEFAULTS = {
  minAgeDays: 3,              // anything newer may be in use right now
  dupMinBytes: 1 << 20,       // duplicates under 1 MB are noise next to the ones that matter
  installerAgeDays: 14,
  staleProjectDays: 90,
  maxFiles: 400000,           // a walk bound, so a pathological tree cannot run forever
};

// Directories the walk never enters at all.
const NEVER_ENTER = new Set(['.git', '.hg', '.svn', 'Library', '.Trash', '.Spotlight-V100', '.fseventsd',
  'site-packages', '.npm', '.cache', '.conda', 'miniforge3', 'anaconda3', 'miniconda3', '.cargo', '.rustup']);
const PACKAGE_EXT = /\.(app|photoslibrary|musiclibrary|tvlibrary|bundle|framework|plugin|xcarchive|xcodeproj|xcworkspace|lrlibrary|fcpbundle|imovielibrary|sparsebundle)$/i;
// Regenerable dependency/caches: collected whole (only from stale projects), never descended into.
// node_modules only. Python caches were collected at first and came to half a megabyte across
// sixteen folders — pure noise in a review he has to read, for space that regenerates on its own.
const REGEN_DIRS = new Set(['node_modules']);
const SKIP_DIRS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.next', '.parcel-cache', '.turbo']);
const VENV_DIRS = /^(\.?venv|env|\.env|[a-z0-9_-]*-?env)$/i;

const VENDORED = /\/(vendor|vendors|libs?|package|packages|node_modules|dist|build|third[_-]?party|external|deps)\//i;
// Finder's own copy names: "x (1)", "x 2", "x copy". One or two digits — "WRI 127130" is a record id.
const COPY_SUFFIX = /( \(\d{1,2}\)| \d{1,2}| copy( \d{1,2})?|-copy|_copy)(\.[^.\/]+)?$/i;
const INSTALLER = /\.(dmg|pkg|mpkg|iso)$/i;
const SH_INSTALLER = /^(Miniforge3|Mambaforge|Miniconda3|Anaconda3)-.*\.sh$/i;
const ARCHIVE = /\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz|tar|rar|7z)$/i;
// Editor and tool leftovers. GROMACS writes "#name.N#" before overwriting; emacs writes "name~".
const BACKUPISH = /^#.+\.\d+#$|~$|\.(orig|rej|swp|swo)$|\.(bak|backup)(-[\w.-]+)?$|\.corrupt-\d+$|^\.~lock\..*#$/i;

/** Does `dir` or any parent up to `stop` contain a .git? Memoised, because the walk asks a lot. */
function commonDir(a, b) {
  const x = path.dirname(a).split(path.sep), y = path.dirname(b).split(path.sep);
  let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return x.slice(0, i).join(path.sep) || path.sep;
}

function gitRootFinder(fsx) {
  const memo = new Map();
  return function inRepo(dir) {
    const chain = [];
    let d = dir, hit = null;
    while (d && d !== path.dirname(d)) {
      if (memo.has(d)) { hit = memo.get(d); break; }
      chain.push(d);
      if (fsx.existsSync(path.join(d, '.git'))) { hit = d; break; }
      d = path.dirname(d);
    }
    for (const c of chain) memo.set(c, hit);
    return hit;
  };
}

/** Newest mtime of any ordinary file directly in a project (not its dependencies). */
function projectActivity(fsx, dir) {
  let newest = 0;
  const visit = (d, depth) => {
    let ents = [];
    try { ents = fsx.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (REGEN_DIRS.has(e.name) || NEVER_ENTER.has(e.name) || VENV_DIRS.test(e.name) && e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) visit(p, depth + 1); continue; }
      try { const st = fsx.statSync(p); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch {}
    }
  };
  visit(dir, 0);
  return newest;
}

function dirSize(fsx, dir, cap = 200000) {
  let bytes = 0, n = 0;
  const stack = [dir];
  while (stack.length && n < cap) {
    const d = stack.pop();
    let ents = [];
    try { ents = fsx.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else { try { bytes += fsx.statSync(p).size; } catch {} n++; }
    }
  }
  return { bytes, files: n };
}

/** Every file entry of the archive, by path, exists in the unpacked folder (with or without a top folder). */
function verifyUnpacked(archive, folder, listArchive) {
  const list = listArchive || ((a) => {
    const { spawnSync } = require('child_process');
    const r = /\.zip$/i.test(a) ? spawnSync('/usr/bin/unzip', ['-Z1', a], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 60000 })
      : spawnSync('/usr/bin/tar', ['-tf', a], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120000 });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
  });
  let entries;
  try { entries = list(archive); } catch { entries = null; }
  if (!entries) return { ok: false, why: 'could not list the archive' };
  const files = entries.filter((e) => !e.endsWith('/') && !/(^|\/)__MACOSX\/|(^|\/)\.DS_Store$/.test(e));
  if (!files.length) return { ok: false, why: 'empty archive' };
  const base = path.basename(folder);
  let missing = 0;
  for (const e of files) {
    const rel = e.replace(/^\.\//, '');
    const a = path.join(folder, rel), b = path.join(path.dirname(folder), rel);
    const alt = rel.startsWith(base + '/') ? path.join(folder, rel.slice(base.length + 1)) : null;
    if (!fs.existsSync(a) && !fs.existsSync(b) && !(alt && fs.existsSync(alt))) { missing++; if (missing > 0) break; }
  }
  return missing ? { ok: false, why: 'files in the archive are missing from the folder', missing } : { ok: true, entries: files.length };
}

/** sha256 of a file; a cheap head+tail fingerprint first, so most same-size pairs never get fully read. */
function fingerprint(fsx, p, size) {
  const fd = fsx.openSync(p, 'r');
  try {
    const n = Math.min(65536, size);
    const a = Buffer.alloc(n), b = Buffer.alloc(n);
    fsx.readSync(fd, a, 0, n, 0);
    fsx.readSync(fd, b, 0, n, Math.max(0, size - n));
    return crypto.createHash('sha1').update(a).update(b).update(String(size)).digest('hex');
  } finally { fsx.closeSync(fd); }
}
function fullHash(fsx, p) {
  const h = crypto.createHash('sha256');
  const fd = fsx.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let r;
    while ((r = fsx.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, r));
  } finally { fsx.closeSync(fd); }
  return h.digest('hex');
}

/**
 * scan({ roots, exclude, home, now, opts, fsx, confidential }) → { findings, skipped, stats }
 * findings: [{ category, path, bytes, reason, keep? }]
 */
function scan({ roots, exclude = [], home, now = Date.now(), opts = {}, fsx = fs, confidential = null } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const inRepo = gitRootFinder(fsx);
  const findings = [];
  const skipped = { forbidden: 0, recent: 0, inRepo: 0, dataless: 0, excluded: 0 };
  const ex = exclude.map((e) => path.resolve(e));
  const isExcluded = (p) => ex.some((e) => p === e || p.startsWith(e + path.sep));
  const ctx = { home, confidential };
  const off = (p) => {
    const f = forbidden('read_file', { path: p }, ctx);
    if (f.blocked) { skipped.forbidden++; return true; }
    return false;
  };
  const young = (st) => (now - st.mtimeMs) < o.minAgeDays * DAY;
  const bySize = new Map();
  const dirsSeen = [];
  let files = 0;

  const walk = (dir) => {
    if (files > o.maxFiles) return;
    let ents = [];
    try { ents = fsx.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(ents.map((e) => e.name));
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (isExcluded(p)) { skipped.excluded++; continue; }
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (NEVER_ENTER.has(e.name) || SKIP_DIRS.has(e.name) || PACKAGE_EXT.test(e.name)) continue;
        if (REGEN_DIRS.has(e.name)) { dirsSeen.push({ p, name: e.name, parent: dir }); continue; }
        if (VENV_DIRS.test(e.name) && fsx.existsSync(path.join(p, 'pyvenv.cfg'))) continue;   // an environment, not files
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      files++;
      let st; try { st = fsx.statSync(p); } catch { continue; }
      // Not on this Mac: an iCloud placeholder reports its size but occupies no blocks.
      if (st.size > 0 && st.blocks === 0) { skipped.dataless++; continue; }
      const name = e.name;

      if (BACKUPISH.test(name)) {
        if (young(st)) { skipped.recent++; continue; }
        if (inRepo(dir)) { skipped.inRepo++; continue; }
        if (off(p)) continue;
        const kind = /^#.+\.\d+#$/.test(name) ? 'an automatic backup GROMACS writes before overwriting a file'
          : /\.corrupt-\d+$/.test(name) ? 'a salvage copy of a file that was later repaired'
          : /~$/.test(name) ? "an editor's backup copy" : 'a backup copy';
        findings.push({ category: 'backups', path: p, bytes: st.size, reason: kind });
        continue;
      }
      if ((INSTALLER.test(name) || SH_INSTALLER.test(name)) && !inRepo(dir)) {
        if ((now - st.mtimeMs) < o.installerAgeDays * DAY) { skipped.recent++; continue; }
        if (off(p)) continue;
        findings.push({ category: 'installers', path: p, bytes: st.size,
          reason: SH_INSTALLER.test(name) ? 'an installer script for something already installed' : `an installer downloaded ${Math.round((now - st.mtimeMs) / DAY)} days ago` });
        continue;
      }
      if (ARCHIVE.test(name) && !inRepo(dir)) {
        const stem = name.replace(ARCHIVE, '');
        if (stem && names.has(stem) && (() => { try { return fsx.statSync(path.join(dir, stem)).isDirectory(); } catch { return false; } })()) {
          if (young(st)) { skipped.recent++; continue; }
          if (off(p)) continue;
          // A folder with the same name is a hint, not proof. If anything was deleted from the folder
          // after unpacking, the archive is the only copy left — so every entry in it must be present
          // in the folder before the archive counts as redundant. Listing reads only the archive's
          // index, so even a 25 GB zip is checked in about a second.
          const v = verifyUnpacked(p, path.join(dir, stem), o.listArchive);
          if (!v.ok) { skipped.unverified = (skipped.unverified || 0) + 1; continue; }
          findings.push({ category: 'archives', path: p, bytes: st.size, reason: `already unpacked — all ${v.entries} files in it are in the folder "${stem}" next to it` });
          continue;
        }
      }
      if (st.size >= o.dupMinBytes) {
        if (!bySize.has(st.size)) bySize.set(st.size, []);
        bySize.get(st.size).push({ p, st, dir });
      }
    }
  };
  // A root may be { path, shallow: true }: its own files are judged but its folders are not entered.
  // That is how home itself is scanned — the loose files at the top of it, without walking into
  // every application's hidden directory.
  const walkShallow = (dir) => {
    let ents = [];
    try { ents = fsx.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const keep = ents.filter((e) => e.isFile());
    const fake = { readdirSync: () => keep };
    const real = fsx.readdirSync;
    try { fsx.readdirSync = (d, o2) => (d === dir ? keep : real.call(fsx, d, o2)); walk(dir); }
    finally { fsx.readdirSync = real; }
    void fake;
  };
  for (const r of roots) {
    const rp = path.resolve(typeof r === 'string' ? r : r.path);
    try { if (!fsx.statSync(rp).isDirectory()) continue; } catch { continue; }
    if (typeof r === 'object' && r.shallow) walkShallow(rp); else walk(rp);
  }

  // ── exact duplicates ──
  const already = new Set(findings.map((f) => f.path));
  for (const [size, group] of bySize) {
    if (group.length < 2) continue;
    const byFp = new Map();
    for (const g of group) {
      if (already.has(g.p)) continue;
      let fp; try { fp = fingerprint(fsx, g.p, size); } catch { continue; }
      if (!byFp.has(fp)) byFp.set(fp, []);
      byFp.get(fp).push(g);
    }
    for (const cands of byFp.values()) {
      if (cands.length < 2) continue;
      const byHash = new Map();
      for (const c of cands) {
        if (off(c.p)) continue;
        let h; try { h = fullHash(fsx, c.p); } catch { continue; }
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(c);
      }
      for (const same of byHash.values()) {
        if (same.length < 2) continue;
        // KEEP the copy most likely to be the real one: inside a repo, then not in Downloads, then
        // the oldest, then the shortest path. Repo copies are never collected at all.
        const rank = (c) => [inRepo(c.dir) ? 0 : 1, /\/Downloads\//.test(c.p) ? 1 : 0, c.st.mtimeMs, c.p.length];
        same.sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
        const keep = same[0];
        for (const c of same.slice(1)) {
          if (inRepo(c.dir)) { skipped.inRepo++; continue; }
          // ONLY ACROSS PLACES. Two copies inside one project — a stage-2 and a stage-3 folder, a
          // preview kept in history/ — are that project's own structure, and moving one breaks
          // whatever refers to it. A copy in Downloads of something saved elsewhere is not.
          const common = commonDir(c.p, keep.p);
          const depth = path.relative(home || '/', common).split(path.sep).filter(Boolean).length;
          if (!/\/Downloads\//.test(c.p) && depth >= 2) { skipped.sameProject = (skipped.sameProject || 0) + 1; continue; }
          // Inside a vendored library or package, a file is part of that library: pulling one out
          // breaks it even when an identical copy lives elsewhere.
          if (VENDORED.test(c.p)) { skipped.vendored = (skipped.vendored || 0) + 1; continue; }
          // Same folder, different names, is usually deliberate — a sound pack's aliases, a portal
          // that names each download by its record id. Only an obvious copy suffix counts there.
          if (path.dirname(c.p) === path.dirname(keep.p) && !COPY_SUFFIX.test(path.basename(c.p))) { skipped.sameFolderNamed = (skipped.sameFolderNamed || 0) + 1; continue; }
          if (young(c.st)) { skipped.recent++; continue; }
          findings.push({ category: 'duplicates', path: c.p, bytes: size, keep: keep.p, reason: 'an exact copy (same bytes) of a file that stays' });
        }
      }
    }
  }

  // ── regenerable dependency folders of projects untouched for months ──
  for (const d of dirsSeen) {
    const project = d.parent;
    const act = projectActivity(fsx, project);
    if (!act || (now - act) < o.staleProjectDays * DAY) continue;
    if (off(d.p)) continue;
    const { bytes, files: n } = dirSize(fsx, d.p);
    if (bytes < (d.name === 'node_modules' ? 5 << 20 : 0) || !n) continue;
    findings.push({ category: 'dependencies', path: d.p, bytes, files: n, dir: true,
      reason: `${d.name} of a project last edited ${Math.round((now - act) / DAY)} days ago — rebuilt by one install command if it is ever needed again` });
  }

  const total = findings.reduce((n, f) => n + f.bytes, 0);
  return { findings, skipped, stats: { filesWalked: files, findings: findings.length, bytes: total } };
}

// ── moving, and moving back ──────────────────────────────────────────────────────────────────────
/**
 * apply(findings, { dest, home }) → manifest. Same-volume renames, so nothing is copied and a file
 * is never in two places or none. Each entry keeps its path relative to home inside `dest`, so the
 * review folder reads like a map of where things came from.
 */
function apply(findings, { dest, home, fsx = fs, now = Date.now() } = {}) {
  fsx.mkdirSync(dest, { recursive: true });
  const manifestPath = path.join(dest, 'manifest.json');
  let manifest = { createdAt: now, home, items: [] };
  try { manifest = JSON.parse(fsx.readFileSync(manifestPath, 'utf8')); } catch {}
  for (const f of findings) {
    const rel = path.relative(home, f.path);
    const to = path.join(dest, f.category, rel.startsWith('..') ? f.path.replace(/^\//, '') : rel);
    try {
      fsx.mkdirSync(path.dirname(to), { recursive: true });
      fsx.renameSync(f.path, to);
      manifest.items.push({ ...f, from: f.path, to, movedAt: now });
    } catch (e) { manifest.items.push({ ...f, from: f.path, to: null, error: e.code || e.message }); }
  }
  fsx.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  return manifest;
}

/** restore(dest, { only }) → { restored, failed } — put everything (or one category) back. */
function restore(dest, { only = null, fsx = fs } = {}) {
  const manifestPath = path.join(dest, 'manifest.json');
  const m = JSON.parse(fsx.readFileSync(manifestPath, 'utf8'));
  let restored = 0; const failed = [];
  for (const it of m.items) {
    if (!it.to || it.restoredAt || (only && it.category !== only)) continue;
    try {
      if (fsx.existsSync(it.from)) { failed.push({ from: it.from, why: 'something is already at the original path' }); continue; }
      fsx.mkdirSync(path.dirname(it.from), { recursive: true });
      fsx.renameSync(it.to, it.from);
      it.restoredAt = Date.now(); restored++;
    } catch (e) { failed.push({ from: it.from, why: e.code || e.message }); }
  }
  fsx.writeFileSync(manifestPath, JSON.stringify(m, null, 1));
  return { restored, failed };
}

// ── BHATBOT'S OWN JANITOR ────────────────────────────────────────────────────────────────────────
// "I want BhatBot to be making the decisions, not Claude" (2026-11-14). Everything below is what
// the app needs to run a cleanup end to end by itself: choose where to look, label installers
// honestly, draw the review page, and — only after he says yes through BhatBot's own approval
// card — delete. The approval goes through lib/autonomy.js like any other delete, so his yeses are
// learned and a routine purge stops needing one.

const SKIP_TOP = new Set(['Library', 'Pictures', 'Music', 'Movies', 'Applications', 'Public', 'vec', 'bhatbot',
  'miniforge3', 'anaconda3', 'miniconda3', 'BhatBot-Cleanup-Review']);
/** His own documents and projects; never the system's data, the media libraries, Python installs or BhatBot itself. */
function defaultRoots(home, fsx = fs) {
  const out = [{ path: home, shallow: true }];
  for (const e of fsx.readdirSync(home, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_TOP.has(e.name)) continue;
    if (fsx.existsSync(path.join(home, e.name, 'pyvenv.cfg'))) continue;          // a Python environment, not files
    out.push({ path: path.join(home, e.name) });
  }
  return out;
}

/** Installers get an honest reason: is the app installed, and where can it be downloaded again. */
function labelInstallers(findings, { apps = null, whereFrom = null } = {}) {
  const { spawnSync } = require('child_process');
  const appList = apps || (() => { try { return fs.readdirSync('/Applications').map((a) => a.toLowerCase()); } catch { return []; } })();
  const from = whereFrom || ((p) => { try { return spawnSync('/usr/bin/mdls', ['-raw', '-name', 'kMDItemWhereFroms', p], { encoding: 'utf8', timeout: 4000 }).stdout || ''; } catch { return ''; } });
  for (const f of findings.filter((x) => x.category === 'installers' && /\.dmg$/i.test(x.path))) {
    const src = from(f.path);
    const site = ((src.match(/https?:\/\/([^/"]+)/) || [])[1] || '').replace(/^www\./, '');
    const stem = path.basename(f.path).replace(/[-_ ]?v?\d[\d.]*\.dmg$|\.dmg$/i, '').toLowerCase();
    // A file named by its platform ("mac-arm64.dmg") says nothing about what it installs; the source does.
    const installed = /claude-science/.test(src) ? appList.find((a) => a === 'claude science.app')
      : stem && !/^mac-?arm/.test(stem) ? appList.find((a) => a.endsWith('.app') && a.includes(stem)) : null;
    f.reason = (installed ? `installer for ${installed.replace(/\.app$/, '')}, which is already installed` : 'installer for an app that is not installed')
      + (site ? ` — re-downloadable from ${site}` : '');
  }
  return findings;
}

/** What is in the review folder right now and not yet restored or deleted, by category. */
function pending(dest, { fsx = fs } = {}) {
  let m = null;
  try { m = JSON.parse(fsx.readFileSync(path.join(dest, 'manifest.json'), 'utf8')); } catch { return { items: [], byCat: {}, bytes: 0 }; }
  const items = (m.items || []).filter((i) => i.to && !i.restoredAt && !i.purgedAt);
  const byCat = {};
  for (const i of items) { const c = byCat[i.category] || (byCat[i.category] = { n: 0, bytes: 0 }); c.n++; c.bytes += i.bytes || 0; }
  return { items, byCat, bytes: items.reduce((n, i) => n + (i.bytes || 0), 0), manifest: m };
}

/**
 * purge(dest, { only }) → { purged, bytes, failed } — permanently delete what was collected (all, or
 * one category). Only manifest items are touched, never anything else that ends up in the folder.
 */
function purge(dest, { only = null, fsx = fs, now = Date.now() } = {}) {
  const manifestPath = path.join(dest, 'manifest.json');
  const m = JSON.parse(fsx.readFileSync(manifestPath, 'utf8'));
  let purged = 0, bytes = 0; const failed = [];
  const root = path.resolve(dest) + path.sep;
  for (const it of m.items) {
    if (!it.to || it.restoredAt || it.purgedAt || (only && it.category !== only)) continue;
    // Belt and braces: a manifest entry pointing outside the review folder is never deleted.
    if (!path.resolve(it.to).startsWith(root)) { failed.push({ to: it.to, why: 'outside the review folder' }); continue; }
    try { fsx.rmSync(it.to, { recursive: true, force: true }); it.purgedAt = now; purged++; bytes += it.bytes || 0; }
    catch (e) { failed.push({ to: it.to, why: e.code || e.message }); }
  }
  fsx.writeFileSync(manifestPath, JSON.stringify(m, null, 1));
  // Empty folders left behind go too, deepest first; the manifest and page stay as the record.
  const prune = (d) => {
    let ents = []; try { ents = fsx.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory()) prune(path.join(d, e.name));
    if (d !== path.resolve(dest)) { try { if (!fsx.readdirSync(d).length) fsx.rmdirSync(d); } catch {} }
  };
  prune(path.resolve(dest));
  return { purged, bytes, failed };
}

const CAT_TITLE = { archives: 'Already-unpacked archives', installers: 'Old installers', duplicates: 'Exact duplicates',
  backups: 'Editor and tool backups', dependencies: 'Dependencies of old projects' };
const CAT_WHY = {
  archives: 'Every file inside each archive was checked and is present in the unpacked folder next to it.',
  installers: 'Disk images and installer scripts. Each says whether the app is installed and where to get it again.',
  duplicates: 'Byte-for-byte copies of a file that stays where it is.',
  backups: 'Automatic backup copies made by an editor or a tool (GROMACS #name.N#, ~, .bak).',
  dependencies: 'Rebuilt by one install command if the project is ever picked up again. This one is a judgement call.',
};
const SKIP_LABEL = { inRepo: 'Inside a git repository', sameProject: 'Duplicates inside one project (its own structure)', vendored: 'Inside a vendored library',
  sameFolderNamed: 'Same-folder files with different names', dataless: 'iCloud files not downloaded to this Mac', unverified: 'Archive that could not be fully verified',
  recent: 'Modified in the last few days', forbidden: 'Financial or confidential (BhatBot’s blocklist)' };
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gb = (b) => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';

/** The review page BhatBot shows before it asks: what it collected, and why, in one screen. */
function reviewPage({ items, skipped = {}, filesWalked = 0, home = '', dest = '' }) {
  const total = items.reduce((n, i) => n + (i.bytes || 0), 0) || 1;
  const cats = {};
  for (const i of items) (cats[i.category] = cats[i.category] || []).push(i);
  const big = [...items].sort((a, b) => b.bytes - a.bytes)[0];
  const short = (p) => (home && String(p).startsWith(home) ? '~' + String(p).slice(home.length) : p);
  const sections = Object.entries(cats).sort((a, b) => b[1].reduce((n, i) => n + i.bytes, 0) - a[1].reduce((n, i) => n + i.bytes, 0)).map(([c, list]) => {
    const bytes = list.reduce((n, i) => n + i.bytes, 0);
    const rows = list.sort((a, b) => b.bytes - a.bytes).map((i) => `<li><span class="p">${esc(short(i.from || i.path))}</span><span class="s">${gb(i.bytes)}</span>${i.reason && c !== 'backups' ? `<span class="r">${esc(i.reason)}</span>` : ''}</li>`).join('');
    return `<section class="card"><header><h2>${esc(CAT_TITLE[c] || c)}</h2><div class="meta"><b>${gb(bytes)}</b> · ${list.length} item${list.length === 1 ? '' : 's'}</div></header>
<div class="bar"><i style="width:${Math.max(1, (100 * bytes) / total).toFixed(1)}%"></i></div><p class="why">${esc(CAT_WHY[c] || '')}</p>
<details${list.length <= 12 ? ' open' : ''}><summary>Items</summary><ul>${rows}</ul></details></section>`;
  }).join('\n');
  const safe = Object.entries(SKIP_LABEL).map(([k, l]) => `<li><span>${l}</span><b>${skipped[k] || 0}</b></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cleanup Review</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--dim:#6b6a66;--line:#e6e4df;--acc:#c2410c;--accbg:#fdf0e8;--ok:#15803d}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121211;--card:#1c1c1a;--ink:#ecebe7;--dim:#9b9a95;--line:#2c2b28;--acc:#fb923c;--accbg:#2a1d14;--ok:#4ade80}}
:root[data-theme="dark"]{--bg:#121211;--card:#1c1c1a;--ink:#ecebe7;--dim:#9b9a95;--line:#2c2b28;--acc:#fb923c;--accbg:#2a1d14;--ok:#4ade80}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 60px}h1{font-size:26px;margin:0 0 4px}.sub{color:var(--dim);margin:0 0 22px}
.hero{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px}.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;flex:1 1 160px}
.stat b{display:block;font-size:24px}.stat span{color:var(--dim);font-size:13px}.stat.big b{color:var(--acc)}
.card,.safe{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
.card header{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}h2{font-size:17px;margin:0}.meta{color:var(--dim);font-size:14px}.meta b{color:var(--ink)}
.bar{height:6px;background:var(--line);border-radius:6px;margin:10px 0 8px;overflow:hidden}.bar i{display:block;height:100%;background:var(--acc)}
.why{color:var(--dim);margin:0 0 6px;font-size:14px}details summary{cursor:pointer;color:var(--acc);font-size:13px}
ul{list-style:none;margin:6px 0 0;padding:0}li{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:7px 0;border-top:1px solid var(--line);font-size:13px}
li .p{word-break:break-all}li .s{color:var(--dim);white-space:nowrap}li .r{grid-column:1/-1;color:var(--dim);font-size:12px}.safe li b{color:var(--ok)}
.ask{background:var(--accbg);border:1px solid var(--acc);border-radius:14px;padding:16px 18px}.ask h2{color:var(--acc)}.ask p{margin:6px 0 0}
code{font:12.5px ui-monospace,Menlo,monospace;background:var(--line);padding:1px 5px;border-radius:5px}
</style></head><body><main>
<h1>Cleanup Review</h1>
<p class="sub">BhatBot ${filesWalked ? `scanned ${filesWalked.toLocaleString('en-US')} of your files and ` : ''}moved what looks redundant into <code>${esc(short(dest))}</code>. Nothing has been deleted.</p>
<div class="hero"><div class="stat big"><b>${gb(total)}</b><span>would be freed</span></div><div class="stat"><b>${items.length}</b><span>items collected</span></div>${big && big.bytes > total * 0.5 ? `<div class="stat"><b>${gb(big.bytes)}</b><span>is one file: ${esc(path.basename(big.from || big.path))}</span></div>` : ''}</div>
${sections}
<section class="safe"><h2>Left alone on purpose</h2><p class="why">Things that looked like candidates but were not touched.</p><ul>${safe}</ul></section>
<section class="ask"><h2>Delete these?</h2><p>BhatBot is asking on its approval card. Yes empties the review folder; no puts everything back exactly where it was. You can also say "put the installers back" to restore one category.</p></section>
</main></body></html>`;
}

module.exports = { scan, apply, restore, purge, pending, defaultRoots, labelInstallers, reviewPage, DEFAULTS, BACKUPISH, INSTALLER, ARCHIVE, SKIP_TOP };
