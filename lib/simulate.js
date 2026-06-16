'use strict';
// Simulation runner — executes physics / chemistry / math-modeling code in a dedicated sandbox
// venv (~/.bhatbot/sim-venv, set up by scripts/sim-setup.sh) where the heavy scientific stacks
// live (scipy, sympy, networkx, pint, numba, pymunk, rdkit, ase, pybullet, openmm, pyscf).
// Design mirrors lib/figures.js: a rich Python PREAMBLE so the model writes only the core of a
// simulation; results come back via emit(...) (JSON) and any matplotlib figure is auto-saved and
// returned as a vision block so the model SEES the plot. Keeps the main process light — nothing
// is imported into Node; everything runs in the isolated interpreter.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SIM_VENV = path.join(os.homedir(), '.bhatbot', 'sim-venv');
const SIM_PY = path.join(SIM_VENV, 'bin', 'python3');
const CAPS_FILE = path.join(os.homedir(), '.bhatbot', 'sim-capabilities.json');
const OUT_DIR = path.join(os.homedir(), '.bhatbot', 'simulations');

const REGISTRY = {
  numpy: 'numerical arrays', scipy: 'ODE/PDE (integrate.solve_ivp), optimize, linalg, signal, stats',
  sympy: 'symbolic math / CAS, sympy.physics.mechanics', networkx: 'graphs & network models',
  pandas: 'data frames', matplotlib: 'plotting', pint: 'physical units', mendeleev: 'periodic-table data',
  numba: 'JIT speedups (@njit)', pymunk: '2D rigid-body physics (Chipmunk)', rdkit: 'cheminformatics: molecules, reactions, descriptors',
  ase: 'atomistic simulation environment / materials', mujoco: '3D rigid-body / contact / robotics physics (DeepMind)',
  pybullet: '3D rigid-body & robotics physics (if available)',
  openmm: 'molecular dynamics', pyscf: 'ab-initio quantum chemistry (HF/DFT/MP2)',
};

function pythonBin() {
  try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8')); if (c.simPython) return c.simPython; } catch {}
  return SIM_PY;
}
function isInstalled() { return fs.existsSync(pythonBin()); }

function capabilities() {
  if (!isInstalled()) return { success: false, installed: false, error: 'Simulation venv not set up. Run: bash scripts/sim-setup.sh', registry: REGISTRY };
  let caps = {};
  try { caps = JSON.parse(fs.readFileSync(CAPS_FILE, 'utf8')); } catch {}
  const available = Object.entries(caps).filter(([, v]) => v).map(([k]) => k);
  const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k);
  return { success: true, installed: true, available, missing,
    capabilities: Object.fromEntries(available.map((k) => [k, REGISTRY[k] || ''])),
    note: 'Write Python for the `run` action; these libraries are importable. Use emit(key=value) for JSON results and matplotlib for plots (auto-returned).' };
}

const SENTINEL = '__SIM_RESULT__';
const PREAMBLE = `
import json, sys, os, io, math, base64, traceback
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
_OUT_DIR = ${JSON.stringify(OUT_DIR)}
os.makedirs(_OUT_DIR, exist_ok=True)
_RESULT = {}
def emit(**kw):
    "Return structured JSON results to BhatBot."
    _RESULT.update(kw)
# numpy/other types -> JSON-safe
def _safe(o):
    import numpy as _np
    if isinstance(o, (_np.integer,)): return int(o)
    if isinstance(o, (_np.floating,)): return float(o)
    if isinstance(o, (_np.ndarray,)): return o.tolist()
    return str(o)
`;
const EPILOG = `
# Auto-save the first open matplotlib figure as a vision block.
_fig_b64 = None; _fig_path = None
try:
    nums = plt.get_fignums()
    if nums:
        import time as _t
        _fig_path = os.path.join(_OUT_DIR, 'sim_%d.png' % int(_t.time()*1000))
        plt.savefig(_fig_path, dpi=150, bbox_inches='tight')
        with open(_fig_path, 'rb') as _f: _fig_b64 = base64.b64encode(_f.read()).decode()
except Exception: pass
print(${JSON.stringify(SENTINEL)} + json.dumps({'result': _RESULT, 'fig_path': _fig_path, 'fig_b64': _fig_b64}, default=_safe))
`;

// Run python `code` in the sandbox. Returns { success, stdout, result, _image }.
function run({ code, timeoutMs } = {}) {
  if (!isInstalled()) return { success: false, error: 'Simulation venv not set up. Run: bash scripts/sim-setup.sh (or wait for the background install to finish).' };
  if (!code || !String(code).trim()) return { success: false, error: 'provide python `code` to run' };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const script = PREAMBLE + '\ntry:\n' + String(code).split('\n').map((l) => '    ' + l).join('\n') +
    '\nexcept Exception as _e:\n    emit(error=str(_e), trace=traceback.format_exc()[-1200:])\n' + EPILOG;
  const to = Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 600000);
  return new Promise((resolve) => {
    const p = spawn(pythonBin(), ['-c', script], { timeout: to });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => err += d);
    p.on('error', (e) => resolve({ success: false, error: 'sim spawn failed: ' + e.message }));
    p.on('close', (codeNum) => {
      const idx = out.lastIndexOf(SENTINEL);
      let payload = null, logs = out;
      if (idx !== -1) { logs = out.slice(0, idx); try { payload = JSON.parse(out.slice(idx + SENTINEL.length)); } catch {} }
      if (!payload) {
        return resolve({ success: false, error: (err || 'simulation failed (no result)').slice(0, 1500), stdout: logs.slice(-2000) });
      }
      const res = payload.result || {};
      const ok = !res.error;
      resolve({ success: ok, error: res.error, trace: res.trace, result: res,
        stdout: (logs || '').slice(-4000), exitCode: codeNum,
        path: payload.fig_path || undefined, _image: payload.fig_b64 || undefined, _imageMime: payload.fig_b64 ? 'image/png' : undefined });
    });
  });
}

module.exports = { capabilities, run, isInstalled, REGISTRY, SIM_VENV, OUT_DIR };
