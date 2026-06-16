'use strict';
// Data-accurate figure generation for papers/projects. Unlike generate_image (GPT Image →
// raster, made-up numbers), this renders REAL matplotlib/seaborn charts from real data files
// (.csv/.tsv/.json/.xlsx). Two modes:
//   analyze  → profile the data (shape, dtypes, summary stats, correlations, missingness) and
//              suggest the most informative figures. This is the "which stats matter" step.
//   render   → build a chart from a high-level spec, or run custom plotting `code` (df + plt
//              are preloaded), saving PNG/PDF/SVG. PNG is returned for visual self-critique.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const OUT_DIR = path.join(os.homedir(), '.bhatbot', 'figures');
const RECIPE_PATH = path.join(os.homedir(), '.bhatbot', 'figure-recipes.json');

function jsonLit(v) { return JSON.stringify(v == null ? null : v); }
// Python literal: null/undefined → None (JSON's "null" is not valid Python).
function pyLit(v) { return v == null ? 'None' : (typeof v === 'boolean' ? (v ? 'True' : 'False') : JSON.stringify(v)); }

// ---- shared python preamble: load df from any supported file into a DataFrame `df` ----
const LOADER = `
import sys, json, os
import pandas as pd
def _load(p):
    e = os.path.splitext(p)[1].lower()
    if e in ('.csv', '.txt'): return pd.read_csv(p)
    if e in ('.tsv',):        return pd.read_csv(p, sep='\\t')
    if e in ('.json',):       return pd.read_json(p)
    if e in ('.xlsx', '.xls'):return pd.read_excel(p)
    if e in ('.parquet',):    return pd.read_parquet(p)
    return pd.read_csv(p)     # best-effort default
`;

function runPython(pythonBin, script) {
  const r = spawnSync(pythonBin || 'python3', ['-c', script], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || 'python failed').trim().slice(0, 1500) };
  return { ok: true, stdout: r.stdout || '' };
}

// Profile the data + suggest figures. Pure inspection, no plotting.
function analyze({ data, pythonBin } = {}) {
  if (!data || !fs.existsSync(data)) return { success: false, error: `data file not found: ${data}` };
  const script = `${LOADER}
df = _load(${jsonLit(data)})
num = df.select_dtypes('number')
out = {
  'rows': int(df.shape[0]), 'cols': int(df.shape[1]),
  'columns': [{'name': c, 'dtype': str(df[c].dtype), 'nunique': int(df[c].nunique(dropna=True)),
               'missing': int(df[c].isna().sum())} for c in df.columns],
  'describe': json.loads(num.describe().to_json()) if num.shape[1] else {},
}
# Strongest pairwise correlations (numeric) — candidate scatter/relationship figures.
corr = []
if num.shape[1] >= 2:
    cm = num.corr(numeric_only=True).abs()
    seen = set()
    for a in cm.columns:
        for b in cm.columns:
            if a < b and (a,b) not in seen:
                seen.add((a,b)); v = cm.loc[a,b]
                if v == v: corr.append({'x': a, 'y': b, 'r': round(float(v), 3)})
    corr = sorted(corr, key=lambda d: -d['r'])[:8]
out['top_correlations'] = corr
# Heuristic figure suggestions from the data shape.
cats = [c for c in df.columns if df[c].dtype == 'object' or df[c].nunique(dropna=True) <= 12]
nums = list(num.columns)
sugg = []
if cats and nums: sugg.append({'kind': 'bar', 'x': cats[0], 'y': nums[0], 'why': 'group means / comparison across a category'})
if len(nums) >= 2: sugg.append({'kind': 'scatter', 'x': nums[0], 'y': nums[1], 'why': 'relationship between two metrics'})
if nums: sugg.append({'kind': 'hist', 'x': nums[0], 'why': 'distribution of the key metric'})
if len(nums) >= 3: sugg.append({'kind': 'heatmap', 'why': 'correlation matrix across all metrics'})
if cats and nums: sugg.append({'kind': 'box', 'x': cats[0], 'y': nums[0], 'why': 'spread/outliers per group'})
out['suggested_figures'] = sugg
print(json.dumps(out))
`;
  const r = runPython(pythonBin, script);
  if (!r.ok) return { success: false, error: r.error };
  try { return { success: true, ...JSON.parse(r.stdout.trim().split('\n').pop()) }; }
  catch (e) { return { success: false, error: 'could not parse analysis: ' + e.message, raw: r.stdout.slice(0, 500) }; }
}

// Build a chart and save it. Either `spec` (declarative) or `code` (custom matplotlib using df/plt).
function render({ data, spec, code, filename, formats, pythonBin } = {}) {
  if (!data || !fs.existsSync(data)) return { success: false, error: `data file not found: ${data}` };
  if (!spec && !code) return { success: false, error: 'provide either spec or code' };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = String(filename || `fig_${Date.now()}`).replace(/[^\w.-]/g, '_').replace(/\.[^.]+$/, '');
  const fmts = (Array.isArray(formats) && formats.length ? formats : ['png']).filter((f) => ['png', 'pdf', 'svg'].includes(f));
  if (!fmts.includes('png')) fmts.push('png');   // always render a PNG for visual critique
  const outPng = path.join(OUT_DIR, `${base}.png`);

  let plotBody;
  if (code) {
    // Custom: the model's matplotlib code. df and plt are in scope; it should draw on the
    // current figure (we create+save it around the code so it needn't manage files).
    plotBody = String(code);
  } else {
    const s = spec || {};
    const kind = s.kind || 'bar';
    const x = pyLit(s.x), y = pyLit(s.y), hue = pyLit(s.hue), title = pyLit(s.title || '');
    const xlabel = pyLit(s.xlabel || s.x || ''), ylabel = pyLit(s.ylabel || s.y || '');
    plotBody = `
import seaborn as sns
kind = ${jsonLit(kind)}; x=${x}; y=${y}; hue=${hue}
if kind == 'bar':        sns.barplot(data=df, x=x, y=y, hue=hue)
elif kind == 'line':     sns.lineplot(data=df, x=x, y=y, hue=hue, marker='o')
elif kind == 'scatter':  sns.scatterplot(data=df, x=x, y=y, hue=hue)
elif kind == 'hist':     sns.histplot(data=df, x=x, hue=hue, kde=True)
elif kind == 'box':      sns.boxplot(data=df, x=x, y=y, hue=hue)
elif kind == 'violin':   sns.violinplot(data=df, x=x, y=y, hue=hue)
elif kind == 'heatmap':  sns.heatmap(df.select_dtypes('number').corr(numeric_only=True), annot=True, fmt='.2f', cmap='vlag', center=0)
else:                    sns.barplot(data=df, x=x, y=y, hue=hue)
if ${xlabel}: plt.xlabel(${xlabel})
if ${ylabel} and kind != 'heatmap': plt.ylabel(${ylabel})
if ${title}: plt.title(${title})
`;
  }

  const script = `${LOADER}
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
try:
    import seaborn as sns; sns.set_theme(style='whitegrid', context='paper')
except Exception: pass
plt.rcParams.update({'figure.dpi': 150, 'savefig.bbox': 'tight', 'font.size': 11})
df = _load(${jsonLit(data)})
plt.figure(figsize=(${Number(spec && spec.width) || 7}, ${Number(spec && spec.height) || 4.5}))
${plotBody}
saved = []
for f in ${jsonLit(fmts)}:
    p = ${jsonLit(path.join(OUT_DIR, base))} + '.' + f
    plt.savefig(p); saved.append(p)
print(json.dumps({'saved': saved}))
`;
  const r = runPython(pythonBin, script);
  if (!r.ok) return { success: false, error: r.error, hint: 'Ensure pandas+matplotlib+seaborn are installed for the resolved python (config.pythonBin).' };
  let saved = [outPng];
  try { saved = JSON.parse(r.stdout.trim().split('\n').pop()).saved || saved; } catch {}
  let b64; try { b64 = fs.readFileSync(outPng).toString('base64'); } catch {}
  return { success: true, path: outPng, saved, _image: b64, _imageMime: 'image/png' };
}

// ---- recipe cache: remember which figures worked for a given data shape + goal -------------
// Keyed by a signature of the column-name/dtype set + the (normalized) goal, so the SAME kind
// of data → instant figure specs next time, no re-deciding. Local JSON (fast, always there).
const RECIPE_MAX = 24;          // hard cap — keep the pool small so it never balloons
const RECIPE_MAX_AGE_DAYS = 30; // unused-and-old entries are pruned

function loadRecipes() { try { return JSON.parse(fs.readFileSync(RECIPE_PATH, 'utf8')); } catch { return {}; } }

// "Regular search" over the recipe pool that strips REDUNDANT and UNNECESSARY entries, run on
// every write so the cache self-maintains and can't build up:
//   1. redundant   — different signatures that produce IDENTICAL figure specs → keep the most
//                    valuable (most-used, then most-recent), drop the rest.
//   2. unnecessary — stale (older than RECIPE_MAX_AGE_DAYS) AND barely used (uses <= 1).
//   3. overflow    — if still over RECIPE_MAX, keep only the top entries by (uses, recency).
function pruneRecipes(recipes) {
  const now = Date.now();
  let entries = Object.values(recipes || {}).filter((e) => e && e.sig && Array.isArray(e.specs));
  const score = (e) => (e.uses || 0) * 1e13 + Date.parse(e.updatedAt || 0) || 0;
  // 1. de-duplicate by the actual rendered figure specs
  const byFigs = new Map();
  for (const e of entries) {
    const k = JSON.stringify(e.specs);
    const cur = byFigs.get(k);
    if (!cur || score(e) > score(cur)) byFigs.set(k, e);
  }
  entries = [...byFigs.values()];
  // 2. drop stale + barely-used
  entries = entries.filter((e) => !((now - (Date.parse(e.updatedAt || 0) || 0)) > RECIPE_MAX_AGE_DAYS * 864e5 && (e.uses || 0) <= 1));
  // 3. cap total
  entries.sort((a, b) => score(b) - score(a));
  entries = entries.slice(0, RECIPE_MAX);
  return Object.fromEntries(entries.map((e) => [e.sig, e]));
}

function saveRecipes(r) {
  try { fs.mkdirSync(path.dirname(RECIPE_PATH), { recursive: true }); fs.writeFileSync(RECIPE_PATH, JSON.stringify(pruneRecipes(r), null, 2)); } catch {}
}
function dataSignature(profile, goal) {
  const cols = (profile.columns || []).map((c) => `${c.name}:${c.dtype}`).sort().join('|');
  const g = String(goal || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');
  return crypto.createHash('sha1').update(cols + '#' + g).digest('hex').slice(0, 16);
}
const cap = (s) => String(s || '').replace(/^\w/, (c) => c.toUpperCase());

// Turn the analysis' suggested figures into concrete render specs, prioritized by the GOAL.
function pickSpecs(profile, goal, n) {
  const sugg = (profile.suggested_figures || []).map((s) => ({ kind: s.kind, x: s.x, y: s.y, title: s.why ? cap(s.why) : undefined }));
  const g = String(goal || '').toLowerCase();
  const pref = [];
  if (/distrib|spread|histogram|outlier/.test(g)) pref.push('hist', 'box', 'violin');
  if (/correl|relationship|associat|scatter/.test(g)) pref.push('scatter', 'heatmap');
  if (/compar|across|group|\bbar\b|mean|category/.test(g)) pref.push('bar', 'box');
  if (/trend|time|over time|\bline\b|series/.test(g)) pref.push('line');
  const score = (s) => { const i = pref.indexOf(s.kind); return i === -1 ? 99 : i; };
  return sugg.map((s, i) => ({ s, i })).sort((a, b) => (score(a.s) - score(b.s)) || (a.i - b.i)).map((o) => o.s).slice(0, Math.max(1, n));
}

// ONE-SHOT: analyze → pick the most informative figures (or reuse a cached recipe) → render them
// all in a single call. Collapses the analyze→decide→render→critique round-trips into one, and
// caches the working specs so recurring data shapes are instant.
function oneShot({ data, goal, n = 3, formats, pythonBin } = {}) {
  if (!data || !fs.existsSync(data)) return { success: false, error: `data file not found: ${data}` };
  const profile = analyze({ data, pythonBin });
  if (!profile.success) return profile;
  const sig = dataSignature(profile, goal);
  const recipes = loadRecipes();
  let specs, recipeHit = false;
  if (recipes[sig] && Array.isArray(recipes[sig].specs) && recipes[sig].specs.length) {
    specs = recipes[sig].specs.slice(0, n); recipeHit = true;
  } else {
    specs = pickSpecs(profile, goal, n);
  }
  if (!specs.length) return { success: false, error: 'no figure could be suggested for this data', analysis: profile };
  const figs = [];
  specs.forEach((spec, i) => {
    const r = render({ data, spec, formats, filename: `${spec.kind}_${i + 1}_${Date.now()}`, pythonBin });
    if (r.success) figs.push({ spec, path: r.path, saved: r.saved, _image: r._image });
  });
  if (!figs.length) return { success: false, error: 'figures failed to render (check python deps)', analysis: profile };
  recipes[sig] = { sig, goal: goal || '', specs: figs.map((f) => f.spec), columns: (profile.columns || []).map((c) => c.name),
                   uses: ((recipes[sig] || {}).uses || 0) + 1, updatedAt: new Date().toISOString() };
  saveRecipes(recipes);
  const primary = figs[0];
  return {
    success: true, recipeHit, count: figs.length, signature: sig,
    figures: figs.map(({ _image, ...f }) => f),                 // paths + specs, no base64 bloat
    paths: figs.flatMap((f) => f.saved),
    specs: figs.map((f) => f.spec),
    analysis: { rows: profile.rows, cols: profile.cols, top_correlations: profile.top_correlations, suggested: profile.suggested_figures },
    _image: primary._image, _imageMime: 'image/png',            // first figure shown as a vision block
  };
}

module.exports = { analyze, render, oneShot, loadRecipes, pruneRecipes, dataSignature, RECIPE_MAX, OUT_DIR };
