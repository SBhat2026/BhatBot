'use strict';
// Workspace manager (Phase 1). Each project gets an isolated dir under
// ~/.bhatbot/workspaces/<slug>/ with its own goals/state/tasks/decisions + memory,
// artifacts, source. Loading a workspace pulls ONLY the small working set — never
// global memory.md. See ARCHITECTURE.md §1.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.bhatbot', 'workspaces');
const CONFIG = path.join(os.homedir(), '.bhatbot', 'config.json');

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workspace';
}
function readJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJSON(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function dirOf(slug) { return path.join(ROOT, slug); }
function now() { return new Date().toISOString(); }

function create(name) {
  let slug = slugify(name), i = 1;
  while (fs.existsSync(dirOf(slug))) slug = `${slugify(name)}-${++i}`;
  const dir = dirOf(slug);
  for (const sub of ['checkpoints', 'memories/chunks', 'artifacts', 'source']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  writeJSON(path.join(dir, 'workspace.json'), { id: slug, name, slug, created: now(), updated: now(), integrations: {}, model_prefs: {} });
  writeJSON(path.join(dir, 'goals.json'), { north_star: name, sub_goals: [], acceptance: [], updated: now() });
  writeJSON(path.join(dir, 'state.json'), { version: 0, updated: now(), components: {}, metrics: { tokens_today: 0, cost_month_usd: 0 } });
  writeJSON(path.join(dir, 'decisions.json'), { decisions: [] });
  writeJSON(path.join(dir, 'tasks.json'), { seq: 0, tasks: [] });
  return { slug, dir };
}

function exists(slug) { return fs.existsSync(path.join(dirOf(slug), 'workspace.json')); }

function list() {
  if (!fs.existsSync(ROOT)) return [];
  return fs.readdirSync(ROOT).filter((s) => exists(s)).map((s) => {
    const w = readJSON(path.join(dirOf(s), 'workspace.json'), {});
    return { slug: s, name: w.name || s, updated: w.updated || null };
  }).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

// Cold-load contract: return ONLY the small working set (< ~4k tokens). decisions.json
// and memories/ are opened lazily by lib/state.js / lib/memory.js, never here.
function load(slug) {
  if (!exists(slug)) throw new Error(`workspace "${slug}" not found`);
  const dir = dirOf(slug);
  const tasks = readJSON(path.join(dir, 'tasks.json'), { tasks: [] });
  return {
    slug, dir,
    workspace: readJSON(path.join(dir, 'workspace.json'), {}),
    goals: readJSON(path.join(dir, 'goals.json'), {}),
    state: readJSON(path.join(dir, 'state.json'), { version: 0, components: {} }),
    openTasks: (tasks.tasks || []).filter((t) => t.status !== 'done' && t.status !== 'cancelled'),
  };
}

function setActive(slug) {
  if (!exists(slug)) throw new Error(`workspace "${slug}" not found`);
  const cfg = readJSON(CONFIG, {});
  cfg.activeWorkspace = slug;
  writeJSON(CONFIG, cfg);
  return slug;
}
function getActive() {
  const slug = readJSON(CONFIG, {}).activeWorkspace;
  return slug && exists(slug) ? slug : null;
}
function activeDir() { const s = getActive(); return s ? dirOf(s) : null; }

module.exports = { ROOT, create, exists, list, load, setActive, getActive, activeDir, dirOf, slugify, readJSON, writeJSON };
