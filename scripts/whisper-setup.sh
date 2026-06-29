#!/usr/bin/env bash
# One-time setup for OFFLINE speech-to-text (mlx-whisper, Apple Silicon). After this, BhatBot can
# transcribe voice with NO cloud key — it's the automatic fallback for transcribeAudio when there's
# no OpenAI/Groq key or the cloud call fails. Reuses the existing ~/.bhatbot/mlx-venv.
#
#   bash scripts/whisper-setup.sh            # install + pre-download the default model
#   WHISPER_MODEL=mlx-community/whisper-large-v3-turbo bash scripts/whisper-setup.sh   # bigger/better
#
# Requires ffmpeg on PATH (brew install ffmpeg) — mlx-whisper uses it to decode browser audio.
set -euo pipefail
VENV="${MLX_VENV:-$HOME/.bhatbot/mlx-venv}"
PY="${PYTHON:-python3}"
MODEL="${WHISPER_MODEL:-mlx-community/whisper-base.en-mlx}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[whisper-setup] WARNING: ffmpeg not found on PATH. Install it: brew install ffmpeg"
fi

if [ ! -d "$VENV" ]; then
  echo "[whisper-setup] creating venv at $VENV"
  "$PY" -m venv "$VENV"
fi
echo "[whisper-setup] installing mlx-whisper…"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet mlx-whisper

echo "[whisper-setup] pre-downloading model: $MODEL (first run only) …"
"$VENV/bin/python" - "$MODEL" <<'PYEOF'
import sys
try:
    import mlx_whisper  # noqa
    from huggingface_hub import snapshot_download
    snapshot_download(sys.argv[1])
    print("[whisper-setup] OK model cached:", sys.argv[1])
except Exception as e:
    # Non-fatal: the model will download lazily on the first transcription instead.
    print("[whisper-setup] model pre-download skipped:", type(e).__name__, str(e)[:160])
PYEOF

echo "[whisper-setup] done. Offline STT is now the fallback when no cloud key is set."
