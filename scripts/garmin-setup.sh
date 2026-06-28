#!/usr/bin/env bash
# One-time BhatBot ↔ Garmin setup. Mirrors the sim-venv / mesh-venv pattern: an isolated Python venv
# with garminconnect (which uses garth for auth — the same stack the eddmann garmin-connect-mcp wraps),
# then an INTERACTIVE login that handles MFA once and caches OAuth tokens to ~/.bhatbot/garmin/tokens.
# After this, BhatBot pulls biometrics with no password (tokens last ~a year; it re-logs in if they
# expire, reading creds from the Keychain).
#
#   1. Store your Garmin creds in the macOS Keychain (password never touches BhatBot's config or the model):
#        security add-generic-password -s bhatbot-garmin -a "you@email.com" -w
#        (it will prompt for your Garmin password)
#      and set the email in BhatBot config.json:  "garmin": { "email": "you@email.com" }
#   2. Run:  bash scripts/garmin-setup.sh
#
set -euo pipefail
VENV="${GARMIN_VENV:-$HOME/.bhatbot/garmin-venv}"
PY="${PYTHON:-python3}"
mkdir -p "$HOME/.bhatbot/garmin/tokens"

if [ ! -d "$VENV" ]; then
  echo "[garmin-setup] creating venv at $VENV"
  "$PY" -m venv "$VENV"
fi
# shellcheck disable=SC1091
"$VENV/bin/pip" install --quiet --upgrade pip
echo "[garmin-setup] installing garminconnect…"
"$VENV/bin/pip" install --quiet "garminconnect>=0.2.20"

echo "[garmin-setup] interactive login (handles MFA, caches tokens)…"
EMAIL="${GARMIN_EMAIL:-}"
if [ -z "$EMAIL" ]; then read -r -p "Garmin email: " EMAIL; fi
# Pull the password from the Keychain (preferred) or prompt.
PW="$(security find-generic-password -s bhatbot-garmin -a "$EMAIL" -w 2>/dev/null || true)"
if [ -z "$PW" ]; then read -r -s -p "Garmin password: " PW; echo; fi

"$VENV/bin/python" - "$EMAIL" "$PW" <<'PYEOF'
import sys, os
from garminconnect import Garmin
email, pw = sys.argv[1], sys.argv[2]
TOK = os.path.expanduser("~/.bhatbot/garmin/tokens")
try:
    g = Garmin(email=email, password=pw, return_on_mfa=True)
    res = g.login()
    if isinstance(res, tuple) and res and res[0] == "needs_mfa":
        code = input("Garmin MFA code (from your email/authenticator): ").strip()
        g.resume_login(res[1], code)
except TypeError:
    g = Garmin(email, pw); g.login()
g.garth.dump(TOK)
print("[garmin-setup] ✅ logged in as", g.get_full_name(), "— tokens cached to", TOK)
PYEOF

echo "[garmin-setup] done. BhatBot can now pull your biometrics. Try: \"show my health\" / health sync."
