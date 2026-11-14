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

module.exports = { scan, apply, restore, DEFAULTS, BACKUPISH, INSTALLER, ARCHIVE };
