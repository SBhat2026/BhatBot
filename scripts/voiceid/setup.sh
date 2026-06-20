#!/usr/bin/env bash
# One-time setup for BhatBot voice ID. Creates an isolated venv (mirrors the sim-venv pattern)
# and installs the speaker-embedding stack. Re-run safe.
set -euo pipefail

VENV="${BHATBOT_VOICEID_VENV:-$HOME/.bhatbot/voiceid-venv}"
HERE="$(cd "$(dirname "$0")" && pwd)"

PY="$(command -v python3.11 || command -v python3 || true)"
[ -z "$PY" ] && { echo "python3 not found"; exit 1; }

if [ ! -d "$VENV" ]; then
  echo "→ creating venv at $VENV"
  "$PY" -m venv "$VENV"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install --quiet --upgrade pip
echo "→ installing deps (resemblyzer + torch; first run downloads the pretrained encoder)…"
python -m pip install --quiet -r "$HERE/requirements.txt"

echo "✅ voiceid venv ready: $VENV"
echo "   enroll:  $VENV/bin/python $HERE/enroll.py --dir ~/Desktop/voice_samples"
echo "   verify:  $VENV/bin/python $HERE/verify.py clip.wav"
