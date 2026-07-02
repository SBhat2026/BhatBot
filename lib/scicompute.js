'use strict';
// Scientific-compute pack — the QUANTITATIVE & MODELING sibling of lib/simulate.js. Runs in its own
// dedicated venv (~/.bhatbot/scicompute-venv, set up by scripts/scicompute-setup.sh) so its heavy
// stack (MPS torch, statsmodels, yfinance, arch, QuantLib, mpmath) never disturbs the verified sim
// stack. Where `simulate` is the physics/chem sandbox, `sci_compute` is the numerics + quant-finance +
// stats/time-series + GPU(MPS)-torch lane: real-analysis-grade precision, stock/options/risk modeling,
// Monte-Carlo, and ML on Apple-Silicon.
//
// Same proven runner design as simulate.js: a rich Python PREAMBLE exposes domain helpers (so the model
// writes only the core), emit(**kw) returns JSON, and the first matplotlib figure comes back as a vision
// block so the model SEES its plot. Nothing is imported into Node — everything runs in the isolated
// interpreter. Pure + probe-first: capabilities() and every run degrade with an install hint when the
// venv is absent, so this module loads and its pure helpers test green on any machine.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SC_VENV = path.join(os.homedir(), '.bhatbot', 'scicompute-venv');
const SC_PY = path.join(SC_VENV, 'bin', 'python3');
const CAPS_FILE = path.join(os.homedir(), '.bhatbot', 'scicompute-capabilities.json');
const OUT_DIR = path.join(os.homedir(), '.bhatbot', 'scicompute');

const REGISTRY = {
  numpy: 'numerical arrays', scipy: 'optimize / linalg / signal / stats / ODE (solve_ivp)',
  sympy: 'symbolic math / CAS', mpmath: 'arbitrary-precision real/complex analysis (set mp.mp.dps)',
  pandas: 'data frames & time series', matplotlib: 'plotting',
  statsmodels: 'econometrics / regression / ARIMA / statistical tests',
  arch: 'volatility models (GARCH) & financial econometrics',
  yfinance: 'market data pull (equities/ETFs/FX) — network',
  QuantLib: 'derivatives pricing, curves, day-count, schedules',
  torch: 'tensors + autograd + neural nets on Apple-Silicon (DEVICE=mps when available)',
  sklearn: 'classical ML (regression/clustering/PCA/CV)',
  control: 'control systems (state-space, transfer functions, Bode/step)',
};

// Curated helper surface injected into every run — keeps the model's code minimal & correct.
const HELPERS = {
  quant: ['returns(prices)', 'log_returns(prices)', 'ann_vol(rets, periods=252)', 'sharpe(rets, rf=0, periods=252)',
    'sortino(rets, rf=0, periods=252)', 'max_drawdown(equity)', 'var_cvar(rets, alpha=0.05)',
    'black_scholes(S,K,T,r,sigma,kind="call")', 'mc_gbm(S0,mu,sigma,T,steps=252,paths=10000,seed=0)'],
  numerics: ['mp (mpmath; set mp.mp.dps=50 for 50-digit precision)', 'solve_ode(f,y0,t_span,**kw) → scipy solve_ivp'],
  ml: ['DEVICE (\"mps\" on Apple-Silicon else \"cpu\")', 'to_dev(x) moves a torch tensor to DEVICE'],
};

function pythonBin() {
  try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8')); if (c.sciComputePython) return c.sciComputePython; } catch {}
  return SC_PY;
}
function isInstalled() { return fs.existsSync(pythonBin()); }

function capabilities() {
  if (!isInstalled()) return { success: false, installed: false, error: 'Scientific-compute venv not set up. Run: bash scripts/scicompute-setup.sh', registry: REGISTRY, helpers: HELPERS };
  let caps = {};
  try { caps = JSON.parse(fs.readFileSync(CAPS_FILE, 'utf8')); } catch {}
  const available = Object.entries(caps).filter(([, v]) => v).map(([k]) => k);
  const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k);
  return { success: true, installed: true, available, missing,
    capabilities: Object.fromEntries(available.map((k) => [k, REGISTRY[k] || ''])), helpers: HELPERS,
    note: 'Write Python for the `run` action; these libraries are importable and the listed helpers are preloaded. Use emit(key=value) for JSON results and matplotlib for plots (auto-returned as an image).' };
}

const SENTINEL = '__SCI_RESULT__';
const PREAMBLE = `
import json, sys, os, io, math, base64, traceback
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
try:
    import pandas as pd
except Exception:
    pd = None
try:
    import scipy as sp
    from scipy.integrate import solve_ivp
except Exception:
    sp = None; solve_ivp = None
try:
    import mpmath as mp
except Exception:
    mp = None
try:
    import torch
    DEVICE = 'mps' if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available() else ('cuda' if torch.cuda.is_available() else 'cpu')
    def to_dev(x): return x.to(DEVICE)
except Exception:
    torch = None; DEVICE = 'cpu'
    def to_dev(x): return x
_OUT_DIR = ${JSON.stringify(OUT_DIR)}
os.makedirs(_OUT_DIR, exist_ok=True)
_RESULT = {}
def emit(**kw):
    "Return structured JSON results to BhatBot."
    _RESULT.update(kw)

# ── quant helpers ────────────────────────────────────────────────────────────
def returns(prices):
    p = np.asarray(prices, float); return p[1:] / p[:-1] - 1.0
def log_returns(prices):
    p = np.asarray(prices, float); return np.log(p[1:] / p[:-1])
def ann_vol(rets, periods=252):
    return float(np.std(np.asarray(rets, float), ddof=1) * math.sqrt(periods))
def sharpe(rets, rf=0.0, periods=252):
    r = np.asarray(rets, float); ex = r - rf / periods
    s = np.std(ex, ddof=1)
    return float(np.mean(ex) / s * math.sqrt(periods)) if s else float('nan')
def sortino(rets, rf=0.0, periods=252):
    r = np.asarray(rets, float); ex = r - rf / periods
    dn = ex[ex < 0]; d = np.std(dn, ddof=1) if dn.size > 1 else 0.0
    return float(np.mean(ex) / d * math.sqrt(periods)) if d else float('nan')
def max_drawdown(equity):
    e = np.asarray(equity, float); peak = np.maximum.accumulate(e)
    return float(np.min(e / peak - 1.0)) if e.size else 0.0
def var_cvar(rets, alpha=0.05):
    r = np.sort(np.asarray(rets, float)); i = max(0, int(alpha * r.size) - 1)
    v = float(r[i]); c = float(r[:i + 1].mean()) if i >= 0 else v
    return {'var': v, 'cvar': c, 'alpha': alpha}
def black_scholes(S, K, T, r, sigma, kind='call'):
    from math import log, sqrt, exp, erf
    if T <= 0 or sigma <= 0: return max(0.0, (S - K) if kind == 'call' else (K - S))
    d1 = (log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrt(T)); d2 = d1 - sigma * sqrt(T)
    N = lambda x: 0.5 * (1 + erf(x / sqrt(2)))
    return float(S * N(d1) - K * exp(-r * T) * N(d2)) if kind == 'call' else float(K * exp(-r * T) * N(-d2) - S * N(-d1))
def mc_gbm(S0, mu, sigma, T, steps=252, paths=10000, seed=0):
    rng = np.random.default_rng(seed); dt = T / steps
    z = rng.standard_normal((paths, steps))
    incr = (mu - 0.5 * sigma * sigma) * dt + sigma * math.sqrt(dt) * z
    logp = np.concatenate([np.zeros((paths, 1)), np.cumsum(incr, axis=1)], axis=1)
    return S0 * np.exp(logp)

# ── numerics helper ──────────────────────────────────────────────────────────
def solve_ode(f, y0, t_span, **kw):
    if solve_ivp is None: raise RuntimeError('scipy not installed in this venv')
    return solve_ivp(f, t_span, np.atleast_1d(y0), **kw)

def _safe(o):
    import numpy as _np
    if isinstance(o, (_np.integer,)): return int(o)
    if isinstance(o, (_np.floating,)): return float(o)
    if isinstance(o, (_np.ndarray,)): return o.tolist()
    return str(o)
`;
const EPILOG = `
_fig_b64 = None; _fig_path = None
try:
    nums = plt.get_fignums()
    if nums:
        import time as _t
        _fig_path = os.path.join(_OUT_DIR, 'sci_%d.png' % int(_t.time()*1000))
        plt.savefig(_fig_path, dpi=150, bbox_inches='tight')
        with open(_fig_path, 'rb') as _f: _fig_b64 = base64.b64encode(_f.read()).decode()
except Exception: pass
print(${JSON.stringify(SENTINEL)} + json.dumps({'result': _RESULT, 'fig_path': _fig_path, 'fig_b64': _fig_b64}, default=_safe))
`;

// Run python `code` in the scientific-compute venv. Returns { success, stdout, result, _image }.
function run({ code, timeoutMs } = {}) {
  if (!isInstalled()) return { success: false, error: 'Scientific-compute venv not set up. Run: bash scripts/scicompute-setup.sh (or wait for the background install to finish).' };
  if (!code || !String(code).trim()) return { success: false, error: 'provide python `code` to run' };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const script = PREAMBLE + '\ntry:\n' + String(code).split('\n').map((l) => '    ' + l).join('\n') +
    '\nexcept Exception as _e:\n    emit(error=str(_e), trace=traceback.format_exc()[-1200:])\n' + EPILOG;
  const to = Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 600000);
  return new Promise((resolve) => {
    const p = spawn(pythonBin(), ['-c', script], { timeout: to });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => err += d);
    p.on('error', (e) => resolve({ success: false, error: 'sci_compute spawn failed: ' + e.message }));
    p.on('close', (codeNum) => {
      const idx = out.lastIndexOf(SENTINEL);
      let payload = null, logs = out;
      if (idx !== -1) { logs = out.slice(0, idx); try { payload = JSON.parse(out.slice(idx + SENTINEL.length)); } catch {} }
      if (!payload) {
        return resolve({ success: false, error: (err || 'sci_compute failed (no result)').slice(0, 1500), stdout: logs.slice(-2000) });
      }
      const res = payload.result || {};
      const ok = !res.error;
      resolve({ success: ok, error: res.error, trace: res.trace, result: res,
        stdout: (logs || '').slice(-4000), exitCode: codeNum,
        path: payload.fig_path || undefined, _image: payload.fig_b64 || undefined, _imageMime: payload.fig_b64 ? 'image/png' : undefined });
    });
  });
}

// Pure helper (unit-testable, no Python needed): wrap user code into the runnable script. Exposed so
// the headless test can verify indentation/try-except framing without a venv.
function buildScript(code) {
  return PREAMBLE + '\ntry:\n' + String(code || '').split('\n').map((l) => '    ' + l).join('\n') +
    '\nexcept Exception as _e:\n    emit(error=str(_e), trace=traceback.format_exc()[-1200:])\n' + EPILOG;
}

module.exports = { capabilities, run, isInstalled, buildScript, REGISTRY, HELPERS, SC_VENV, OUT_DIR, SENTINEL };
