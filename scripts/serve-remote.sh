#!/usr/bin/env bash
# Bhatbot remote access — keep the Mac awake, run the app (MCP server), and publish it
# to your TAILNET ONLY via Tailscale Serve (NOT public Funnel). Only your own signed-in
# devices (your phone with the Tailscale app on, your Macs) can reach it. This removes
# the public-internet attack surface. NOTE: the Claude mobile-app connector and Twilio
# voice/SMS need PUBLIC reachability and will NOT work in serve-only mode — run with
# `funnel` as the first arg to expose publicly on demand (e.g. for the Claude connector).
# Usage:  bash ~/bhatbot/scripts/serve-remote.sh           (tailnet-only, recommended)
#         bash ~/bhatbot/scripts/serve-remote.sh funnel    (PUBLIC — only if you need it)
set -u
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
PORT="${BHATBOT_MCP_PORT:-8788}"
MODE="${1:-serve}"               # serve = tailnet-only (default) | funnel = public
cd "$(dirname "$0")/.." || exit 1

TOKEN=$(node -e "console.log(require(require('os').homedir()+'/.bhatbot/config.json').mcpToken)" 2>/dev/null)
# /health is token-gated now — probe with the Bearer header.
probe() { curl -s -o /dev/null -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health"; }

echo "▶ keeping Mac awake (caffeinate)…"
caffeinate -dimsu &
CAFF=$!
cleanup() { echo; echo "stopping caffeinate (Bhatbot app + tailscale serve/funnel left running; run '$TS serve reset' / '$TS funnel reset' to stop exposure)"; kill "$CAFF" 2>/dev/null; exit 0; }
trap cleanup INT TERM

# Start the app only if the MCP server isn't already answering.
if ! probe; then
  echo "▶ starting Bhatbot app…"
  npm start >/tmp/bhatbot-start.log 2>&1 &
  for i in $(seq 1 30); do probe && break; sleep 1; done
fi

if ! probe; then
  echo "⚠ MCP server didn't come up — check /tmp/bhatbot-start.log"; cleanup
fi

HOST=$("$TS" status --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,''))}catch{console.log('')}})" 2>/dev/null)
echo "✓ Bhatbot MCP live on :$PORT"
if [ -n "$HOST" ]; then
  echo "  📱 Phone app:    https://$HOST/app/$TOKEN   (open in Safari → Add to Home Screen)"
  [ "$MODE" = "funnel" ] && echo "  🔌 Connector:    https://$HOST/mcp/$TOKEN   (Claude app, Auth=None)"
fi

if [ "$MODE" = "funnel" ]; then
  echo "▶ ⚠ PUBLIC exposure via Tailscale Funnel (reachable from the whole internet)…"
  "$TS" serve reset 2>/dev/null
  "$TS" funnel "$PORT"
else
  echo "▶ tailnet-only via Tailscale Serve (your devices only). Reachable while this runs + the app is up."
  "$TS" funnel reset 2>/dev/null            # ensure no leftover public exposure
  "$TS" serve "$PORT"
fi
