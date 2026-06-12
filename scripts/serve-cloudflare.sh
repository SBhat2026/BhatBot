#!/usr/bin/env bash
# Bhatbot remote access over CLOUDFLARE TUNNEL (Tailscale-free). Keeps the Mac awake, runs the
# app, and exposes :8788 to the internet via Cloudflare.
#
#   Quick tunnel (default) — no account/domain, random *.trycloudflare.com URL that CHANGES
#     every run. Fine now that the app's server URL is editable (long-press → paste the URL).
#       bash ~/bhatbot/scripts/serve-cloudflare.sh
#
#   Named tunnel — STABLE custom hostname; needs a domain on your Cloudflare account + a
#     one-time setup (see scripts/cloudflare-setup.md). Then:
#       BHATBOT_CF_TUNNEL=bhatbot bash ~/bhatbot/scripts/serve-cloudflare.sh
set -u
PORT="${BHATBOT_MCP_PORT:-8788}"
cd "$(dirname "$0")/.." || exit 1
command -v cloudflared >/dev/null 2>&1 || { echo "cloudflared not installed → brew install cloudflared"; exit 1; }

echo "▶ keeping Mac awake (caffeinate)…"
caffeinate -dimsu & CAFF=$!
CFPID=""
cleanup() { echo; echo "stopping tunnel + caffeinate (Bhatbot app left running)"; kill "$CAFF" "$CFPID" 2>/dev/null; exit 0; }
trap cleanup INT TERM

# Start the app only if the MCP server isn't already answering.
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/health"; then
  echo "▶ starting Bhatbot app…"
  npm start >/tmp/bhatbot-start.log 2>&1 &
  for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
fi
curl -s -o /dev/null "http://127.0.0.1:$PORT/health" || { echo "⚠ MCP server didn't come up — see /tmp/bhatbot-start.log"; cleanup; }
TOKEN=$(node -e "console.log(require(require('os').homedir()+'/.bhatbot/config.json').mcpToken)" 2>/dev/null)
echo "✓ Bhatbot MCP live on :$PORT"

if [ -n "${BHATBOT_CF_TUNNEL:-}" ]; then
  echo "▶ Cloudflare NAMED tunnel: $BHATBOT_CF_TUNNEL (stable hostname from ~/.cloudflared/config.yml)"
  echo "  📱 Point the app (long-press → Save) at  https://<your-hostname>/app/$TOKEN"
  cloudflared tunnel run "$BHATBOT_CF_TUNNEL"
else
  echo "▶ Cloudflare QUICK tunnel (random URL; for a STABLE one see scripts/cloudflare-setup.md)…"
  LOG=$(mktemp)
  cloudflared tunnel --url "http://localhost:$PORT" >"$LOG" 2>&1 & CFPID=$!
  URL=""
  for i in $(seq 1 30); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
    [ -n "$URL" ] && break; sleep 1
  done
  if [ -n "$URL" ]; then
    echo "✓ tunnel up: $URL"
    echo "  📱 Phone app:   $URL/app/$TOKEN"
    echo "  ⚙  In the app:  long-press the screen → set host to  $URL  → Save"
  else
    echo "⚠ couldn't read the tunnel URL — tail $LOG"
  fi
  wait "$CFPID"
fi
