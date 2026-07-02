#!/usr/bin/env bash
# Scientific-compute pack setup for BhatBot. Creates a DEDICATED venv (separate from sim-venv so the
# heavy MPS-torch / quant stack never disturbs the verified physics/chem sandbox). The `sci_compute`
# tool runs in here. Installs in TIERS and CONTINUES ON FAILURE so one bad wheel never blocks the rest —
# the tool's `capabilities` action reports what actually imported. Re-runnable (idempotent).
#
#   bash scripts/scicompute-setup.sh                 # core + quant + ml(torch-MPS) + physics
#   SC_TIER=core bash scripts/scicompute-setup.sh    # numerics only (fast, no torch)
#   SC_TIER=compbio bash scripts/scicompute-setup.sh # adds biopython + torch-geometric (heavy)
set -u

VENV="${SC_VENV:-$HOME/.bhatbot/scicompute-venv}"
LOG="$HOME/.bhatbot/scicompute-setup.log"
TIER="${SC_TIER:-full}"     # core | full | compbio
PYBASE="${SC_PY:-python3.11}"
command -v "$PYBASE" >/dev/null 2>&1 || PYBASE="python3"

mkdir -p "$HOME/.bhatbot"
echo "[scicompute-setup] $(date) tier=$TIER base=$PYBASE venv=$VENV" | tee "$LOG"

if [ ! -x "$VENV/bin/python3" ]; then
  echo "[scicompute-setup] creating venv…" | tee -a "$LOG"
  "$PYBASE" -m venv "$VENV" 2>&1 | tee -a "$LOG"
fi
PY="$VENV/bin/python3"
"$PY" -m pip install --upgrade pip wheel setuptools 2>&1 | tee -a "$LOG"

grp() { echo "[scicompute-setup] installing: $*" | tee -a "$LOG"; "$PY" -m pip install "$@" 2>&1 | tee -a "$LOG" || echo "[scicompute-setup] ⚠ group failed (continuing): $*" | tee -a "$LOG"; }

# --- core: numerics + real-analysis-grade precision + stats/time-series ---
grp numpy scipy sympy pandas matplotlib
grp mpmath                       # arbitrary-precision real/complex analysis
grp statsmodels                  # econometrics / regression / ARIMA

if [ "$TIER" = "full" ] || [ "$TIER" = "compbio" ]; then
  # --- quant / finance ---
  grp yfinance                   # market data (network)
  grp arch                       # GARCH / volatility econometrics
  grp QuantLib                   # derivatives pricing (own group — big build, may fail on some macs)
  # --- ml on Apple-Silicon (torch ships MPS-enabled arm64 wheels by default) ---
  grp torch                      # tensors/autograd/NN — DEVICE=mps auto-detected at runtime
  grp scikit-learn               # classical ML
  # --- control / physics analysis ---
  grp control                    # state-space / transfer functions / Bode
fi

if [ "$TIER" = "compbio" ]; then
  grp biopython
  grp torch-geometric            # GNNs (heavy; needs torch already present)
fi

# --- report what actually imported, as JSON, for the sci_compute capabilities action ---
"$PY" - <<'PYEOF' 2>&1 | tee -a "$LOG"
import json, importlib, os
mods = {"numpy":"numpy","scipy":"scipy","sympy":"sympy","mpmath":"mpmath","pandas":"pandas",
        "matplotlib":"matplotlib","statsmodels":"statsmodels","arch":"arch","yfinance":"yfinance",
        "QuantLib":"QuantLib","torch":"torch","sklearn":"sklearn","control":"control"}
ok = {}
for key, mod in mods.items():
    try:
        m = importlib.import_module(mod); ok[key] = getattr(m, "__version__", "ok")
    except Exception:
        ok[key] = None
# note MPS availability if torch present
try:
    import torch as _t
    ok["_mps"] = bool(getattr(_t.backends, "mps", None) and _t.backends.mps.is_available())
except Exception:
    ok["_mps"] = False
with open(os.path.expanduser("~/.bhatbot/scicompute-capabilities.json"), "w") as f:
    json.dump(ok, f, indent=2)
have = [k for k,v in ok.items() if v and not k.startswith("_")]
miss = [k for k,v in ok.items() if not v and not k.startswith("_")]
print("[scicompute-setup] READY. installed:", ", ".join(have))
if miss: print("[scicompute-setup] not available:", ", ".join(miss))
print("[scicompute-setup] torch MPS (Apple-Silicon GPU):", ok.get("_mps"))
PYEOF

echo "[scicompute-setup] done — see $LOG" | tee -a "$LOG"
