#!/usr/bin/env bash
set -euo pipefail

# Bhatbot — macOS Launch Agent installer (auto-start on login)

INSTALL_DIR="$HOME/bhatbot"
PROJECT_DIR="$HOME"                       # BHATBOT_PROJECT (CLAUDE.md source)
LABEL="com.siddhant.bhatbot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

NPM_BIN="$(command -v npm || true)"
if [ -z "$NPM_BIN" ]; then
  echo "✗ npm not found on PATH. Install Node first." >&2
  exit 1
fi

API_KEY="${ANTHROPIC_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo "⚠ ANTHROPIC_API_KEY not set in this shell — embedding empty value."
  echo "  Either export it before running, or rely on ~/.bhatbot/config.json."
fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NPM_BIN</string>
    <string>--prefix</string>  <string>$INSTALL_DIR</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANTHROPIC_API_KEY</key> <string>$API_KEY</string>
    <key>BHATBOT_PROJECT</key>   <string>$PROJECT_DIR</string>
  </dict>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✓ Launch Agent installed: $PLIST"
echo "✓ Loaded. Bhatbot will start on login (and now)."
echo "  Disable: launchctl unload \"$PLIST\""
