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
const { spawnSync } = require('child_process');

const OUT_DIR = path.join(os.homedir(), '.bhatbot', 'figures');

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

module.exports = { analyze, render, OUT_DIR };
