#!/usr/bin/env bash
# Simulation sandbox setup for BhatBot. Creates a dedicated venv with curated physics,
# chemistry, and math-modeling libraries (the "simulate" tool runs in here). Installs in
# TIERS and CONTINUES ON FAILURE so a single bad wheel never blocks the rest — the simulate
# tool's capabilities action reports what actually imported. Re-runnable (idempotent).
#
#   bash scripts/sim-setup.sh            # comprehensive stack (core + 3D + quantum/MD)
#   SIM_TIER=core bash scripts/sim-setup.sh   # lightweight core only
set -u

VENV="${SIM_VENV:-$HOME/.bhatbot/sim-venv}"
LOG="$HOME/.bhatbot/sim-setup.log"
TIER="${SIM_TIER:-full}"     # core | phys3d | full
PYBASE="${SIM_PY:-python3.11}"
command -v "$PYBASE" >/dev/null 2>&1 || PYBASE="python3"

mkdir -p "$HOME/.bhatbot"
echo "[sim-setup] $(date) tier=$TIER base=$PYBASE venv=$VENV" | tee "$LOG"

if [ ! -x "$VENV/bin/python3" ]; then
  echo "[sim-setup] creating venv…" | tee -a "$LOG"
  "$PYBASE" -m venv "$VENV" 2>&1 | tee -a "$LOG"
fi
PY="$VENV/bin/python3"
"$PY" -m pip install --upgrade pip wheel setuptools 2>&1 | tee -a "$LOG"

# pip-install a group; never abort the script on failure.
grp() { echo "[sim-setup] installing: $*" | tee -a "$LOG"; "$PY" -m pip install "$@" 2>&1 | tee -a "$LOG" || echo "[sim-setup] ⚠ group failed (continuing): $*" | tee -a "$LOG"; }

# --- core (math + physics ODE/PDE/symbolic + chem basics) ---
grp numpy scipy sympy networkx pandas matplotlib
grp pint mendeleev numba
grp pymunk                       # 2D rigid-body physics
grp rdkit                        # cheminformatics
grp ase                          # atomistic / materials

if [ "$TIER" = "phys3d" ] || [ "$TIER" = "full" ]; then
  grp mujoco                     # 3D rigid-body / contact / robotics (DeepMind; prebuilt wheels)
  # NOTE: pybullet dropped — won't build on current macOS SDK + MuJoCo is faster/higher-fidelity.
fi
if [ "$TIER" = "full" ]; then
  grp smolagents litellm         # code-first agent for complex math reasoning (uses sim libs)
fi
if [ "$TIER" = "full" ]; then
  grp openmm                     # molecular dynamics
  grp pyscf                      # ab-initio quantum chemistry
fi

# --- report what actually imported, as JSON, for the simulate tool's capabilities action ---
"$PY" - <<'PYEOF' 2>&1 | tee -a "$LOG"
import json, importlib
mods = ["numpy","scipy","sympy","networkx","pandas","matplotlib","pint","mendeleev",
        "numba","pymunk","rdkit","ase","mujoco","openmm","pyscf","smolagents"]
ok = {}
for m in mods:
    try:
        mod = importlib.import_module(m)
        ok[m] = getattr(mod, "__version__", "ok")
    except Exception as e:
        ok[m] = None
import os
with open(os.path.expanduser("~/.bhatbot/sim-capabilities.json"), "w") as f:
    json.dump(ok, f, indent=2)
have = [m for m,v in ok.items() if v]
miss = [m for m,v in ok.items() if not v]
print("[sim-setup] READY. installed:", ", ".join(have))
if miss: print("[sim-setup] not available:", ", ".join(miss))
PYEOF

echo "[sim-setup] done — see $LOG" | tee -a "$LOG"
