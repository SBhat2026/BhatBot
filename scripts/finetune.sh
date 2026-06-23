#!/usr/bin/env bash
# W5 step 2 — LoRA fine-tune BhatBot's local model from its own traces, on-device with MLX
# (Apple Silicon). Nothing leaves the machine. Mirrors scripts/sim-setup.sh conventions: a
# dedicated venv, idempotent, continues with clear messages on failure.
#
#   node scripts/export-prefs.js      # first — produces ~/.bhatbot/finetune/data/{train,valid}.jsonl
#   bash scripts/finetune.sh          # then — installs mlx-lm + runs LoRA
#
# Knobs (env):
#   MLX_BASE   HF model id to adapt (MLX/safetensors). Default a Qwen instruct build that matches
#              the Ollama local_simple role. Override to track whatever qwen3 maps to.
#   FT_ITERS   LoRA iterations (default 300). FT_LAYERS fine-tuned layers (default 8). FT_BATCH (4).
#   FT_FUSE=1  after training, fuse the adapter into a standalone model dir (for GGUF conversion).
set -u

VENV="${MLX_VENV:-$HOME/.bhatbot/mlx-venv}"
FT_DIR="${FT_DIR:-$HOME/.bhatbot/finetune}"
DATA_DIR="$FT_DIR/data"
ADAPTER_DIR="$FT_DIR/adapters"
FUSED_DIR="$FT_DIR/fused"
LOG="$FT_DIR/finetune.log"
BASE="${MLX_BASE:-mlx-community/Qwen2.5-7B-Instruct-4bit}"
ITERS="${FT_ITERS:-300}"
LAYERS="${FT_LAYERS:-8}"
BATCH="${FT_BATCH:-4}"
PYBASE="${MLX_PY:-python3.11}"
command -v "$PYBASE" >/dev/null 2>&1 || PYBASE="python3"

mkdir -p "$FT_DIR"
echo "[finetune] $(date) base=$BASE iters=$ITERS layers=$LAYERS venv=$VENV" | tee "$LOG"

# Apple-Silicon guard — MLX is arm64-only.
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "[finetune] ⚠ MLX requires Apple Silicon (arm64 macOS). Aborting." | tee -a "$LOG"; exit 1
fi

# Need training data.
if [ ! -s "$DATA_DIR/train.jsonl" ]; then
  echo "[finetune] ⚠ no training data at $DATA_DIR/train.jsonl — run: node scripts/export-prefs.js" | tee -a "$LOG"; exit 1
fi
TRAIN_N=$(wc -l < "$DATA_DIR/train.jsonl" | tr -d ' ')
echo "[finetune] training examples: $TRAIN_N" | tee -a "$LOG"
if [ "$TRAIN_N" -lt 16 ]; then
  echo "[finetune] ⚠ only $TRAIN_N examples — too few for a meaningful LoRA. Let traces accumulate (200+)." | tee -a "$LOG"
  echo "[finetune]   Continuing anyway (smoke run) — do NOT promote the result." | tee -a "$LOG"
fi

# venv + mlx-lm
if [ ! -x "$VENV/bin/python3" ]; then
  echo "[finetune] creating venv…" | tee -a "$LOG"
  "$PYBASE" -m venv "$VENV" 2>&1 | tee -a "$LOG"
fi
PY="$VENV/bin/python3"
"$PY" -m pip install --upgrade pip wheel setuptools 2>&1 | tee -a "$LOG"
"$PY" -m pip install --upgrade "mlx-lm>=0.18.0" 2>&1 | tee -a "$LOG" || { echo "[finetune] ⚠ mlx-lm install failed" | tee -a "$LOG"; exit 1; }

# LoRA train. mlx_lm.lora reads {train,valid}.jsonl (chat format) from --data.
echo "[finetune] starting LoRA…" | tee -a "$LOG"
mkdir -p "$ADAPTER_DIR"
"$PY" -m mlx_lm.lora \
  --model "$BASE" \
  --train \
  --data "$DATA_DIR" \
  --adapter-path "$ADAPTER_DIR" \
  --iters "$ITERS" \
  --num-layers "$LAYERS" \
  --batch-size "$BATCH" 2>&1 | tee -a "$LOG" || { echo "[finetune] ⚠ LoRA run failed (see $LOG)" | tee -a "$LOG"; exit 1; }

echo "[finetune] ✅ adapter written to $ADAPTER_DIR" | tee -a "$LOG"

# Optional: fuse adapter → standalone model dir (input for llama.cpp GGUF conversion → Ollama).
if [ "${FT_FUSE:-0}" = "1" ]; then
  echo "[finetune] fusing adapter → $FUSED_DIR" | tee -a "$LOG"
  "$PY" -m mlx_lm.fuse --model "$BASE" --adapter-path "$ADAPTER_DIR" --save-path "$FUSED_DIR" 2>&1 | tee -a "$LOG" || echo "[finetune] ⚠ fuse failed" | tee -a "$LOG"
fi

cat <<EOF | tee -a "$LOG"

[finetune] Next steps:
  1) A/B vs baseline (gated promote):   node scripts/ft-eval.js --adapter "$ADAPTER_DIR" --base "$BASE"
  2) To serve the adapter for eval:     $PY -m mlx_lm.server --model "$BASE" --adapter-path "$ADAPTER_DIR" --port 8081
  3) To run under Ollama instead: FT_FUSE=1 re-run, then convert $FUSED_DIR to GGUF (llama.cpp
     convert-hf-to-gguf.py) and 'ollama create bhatbot-local -f Modelfile'.
  Promotion is GATED: ft-eval only writes config.models.local_simple if the adapter wins the A/B.
EOF
