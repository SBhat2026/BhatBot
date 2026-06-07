#!/usr/bin/env bash
# Print (and copy) the Bhatbot phone-app URL. Ensures the Tailscale funnel is up.
# Usage:  bash ~/bhatbot/scripts/app-url.sh
set -u
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
PORT="${BHATBOT_MCP_PORT:-8788}"

HOST=$("$TS" status --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,''))}catch{console.log('')}})")
TOKEN=$(node -e "console.log(require(require('os').homedir()+'/.bhatbot/config.json').mcpToken)" 2>/dev/null)

if [ -z "$HOST" ] || [ -z "$TOKEN" ]; then
  echo "⚠ Could not resolve host/token. Is Tailscale running + ~/.bhatbot/config.json present?"; exit 1
fi

# Make sure the app is serving and the funnel is published.
curl -s -o /dev/null "http://127.0.0.1:$PORT/health" || echo "⚠ Bhatbot app not running on :$PORT — run scripts/serve-remote.sh first."
"$TS" funnel status >/dev/null 2>&1 || "$TS" funnel --bg "$PORT" >/dev/null 2>&1

URL="https://$HOST/app/$TOKEN"
echo "$URL"
printf "%s" "$URL" | pbcopy 2>/dev/null && echo "✓ copied to clipboard — paste into Safari"
