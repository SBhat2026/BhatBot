#!/usr/bin/env bash
# Build an UNSIGNED BhatBot.ipa headlessly (no Apple ID, no Xcode UI needed).
# This is the artifact AltStore / SideStore installs — they re-sign it on-device with
# your free Apple ID, so it never expires and content still auto-updates from the Mac.
#
#   bash ~/bhatbot/phone-app/build-ipa.sh
#   → phone-app/dist/BhatBot-unsigned.ipa
#
# Then AirDrop/open that .ipa in AltStore/SideStore on the iPhone. (For the Xcode-direct
# path instead, just open BhatBot.xcodeproj and press ⌘R — see README.)
set -e
cd "$(dirname "$0")"

command -v xcodegen >/dev/null 2>&1 || { echo "Installing xcodegen…"; brew install xcodegen; }
mkdir -p Web && cp ../src/mobile.html Web/mobile.html   # sync the bundled offline-fallback UI

# Inject the live host+token from local config into the BINARY ONLY (Config.swift stays blank in
# git — public repo). Restore the placeholder source on exit so the secret never gets committed.
CFG="$HOME/.bhatbot/config.json"
TOKEN=$(node -e "try{console.log(require('$CFG').mcpToken||'')}catch{console.log('')}")
TSBIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
HOST=$("$TSBIN" status --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log('https://'+JSON.parse(s).Self.DNSName.replace(/\.$/,''))}catch{console.log('')}})" 2>/dev/null)
if [ -n "$TOKEN" ] && [ -n "$HOST" ]; then
  cp Sources/Config.swift /tmp/bb-config-orig.swift
  trap 'cp /tmp/bb-config-orig.swift Sources/Config.swift' EXIT
  sed -i '' "s|static let defaultHost = \"\"|static let defaultHost = \"$HOST\"|" Sources/Config.swift
  sed -i '' "s|static let defaultToken = \"\"|static let defaultToken = \"$TOKEN\"|" Sources/Config.swift
  echo "✓ injected host ($HOST) + current token into the build (NOT committed)"
else
  echo "⚠ couldn't read token/host — building with blank defaults (set Host+Token in-app via long-press)"
fi

xcodegen generate >/dev/null
echo "✓ project generated (bundled UI synced)"

DD=/tmp/bb-dev
rm -rf "$DD"
xcodebuild -project BhatBot.xcodeproj -scheme BhatBot -sdk iphoneos -configuration Release \
  -derivedDataPath "$DD" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build | tail -2

APP="$DD/Build/Products/Release-iphoneos/BhatBot.app"
[ -d "$APP" ] || { echo "✗ build failed — no .app produced"; exit 1; }

STAGE=/tmp/bbipa
rm -rf "$STAGE" && mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
mkdir -p dist
( cd "$STAGE" && zip -qr "$OLDPWD/dist/BhatBot-unsigned.ipa" Payload )
echo "✓ dist/BhatBot-unsigned.ipa  ($(du -h dist/BhatBot-unsigned.ipa | cut -f1))"
echo "  Install: open this .ipa in AltStore/SideStore on the iPhone."
