#!/usr/bin/env bash
# Bhatbot remote access — keep the Mac awake, run the app (MCP server), and
# publish it to the internet via Tailscale Funnel so the Claude app can reach it.
# Usage:  bash ~/bhatbot/scripts/serve-remote.sh     (Ctrl-C to stop)
set -u
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
PORT="${BHATBOT_MCP_PORT:-8788}"
cd "$(dirname "$0")/.." || exit 1

echo "▶ keeping Mac awake (caffeinate)…"
caffeinate -dimsu &
CAFF=$!
cleanup() { echo; echo "stopping funnel + caffeinate (Bhatbot app left running)"; kill "$CAFF" 2>/dev/null; exit 0; }
trap cleanup INT TERM

# Start the app only if the MCP server isn't already answering.
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/health"; then
  echo "▶ starting Bhatbot app…"
  npm start >/tmp/bhatbot-start.log 2>&1 &
  for i in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break
    sleep 1
  done
fi

if curl -s -o /dev/null "http://127.0.0.1:$PORT/health"; then
  TOKEN=$(node -e "console.log(require(require('os').homedir()+'/.bhatbot/config.json').mcpToken)" 2>/dev/null)
  HOST=$("$TS" status --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,''))}catch{console.log('')}})" 2>/dev/null)
  echo "✓ Bhatbot MCP live on :$PORT"
  if [ -n "$HOST" ]; then
    echo "  📱 Phone app:    https://$HOST/app/$TOKEN   (open in Safari → Add to Home Screen)"
    echo "  🔌 Connector:    https://$HOST/mcp/$TOKEN   (Claude app, Auth=None)"
  fi
else
  echo "⚠ MCP server didn't come up — check /tmp/bhatbot-start.log"; cleanup
fi

echo "▶ publishing via Tailscale Funnel (Ctrl-C to stop)…"
"$TS" funnel "$PORT"
