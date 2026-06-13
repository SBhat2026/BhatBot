#!/usr/bin/env bash
# Build a SIGNED BhatBot and install it onto a connected iPhone — the Xcode ⌘R path, scripted.
# Needs (one-time): Xcode signed into your Apple ID (free) so a Personal Team / signing cert
# exists, and an iPhone plugged in (or paired wirelessly) and unlocked.
#
#   DEVELOPMENT_TEAM=XXXXXXXXXX bash install-device.sh
#   # Find your team id:  Xcode ▸ Settings ▸ Accounts ▸ (your id) ▸ team,  or:
#   #   security find-identity -v -p codesigning   (the "Apple Development: …" line)
#
# If DEVELOPMENT_TEAM is unset we still try automatic signing (Xcode picks your only team).
set -e
cd "$(dirname "$0")"

command -v xcodegen >/dev/null 2>&1 || { echo "Installing xcodegen…"; brew install xcodegen; }
mkdir -p Web && cp ../src/mobile.html Web/mobile.html
xcodegen generate >/dev/null
echo "✓ project generated"

# Find a connected physical device id via Xcode's device list.
DEV_ID=$(xcrun xctrace list devices 2>/dev/null | awk '/\(.*\) \([0-9A-Fa-f-]{20,}\)/ && !/Simulator/ {print}' | grep -iE 'iphone|ipad' | head -1 | sed -E 's/.*\(([0-9A-Fa-f-]{20,})\).*/\1/')
if [ -z "$DEV_ID" ]; then
  echo "✗ No iPhone detected. Plug it in + unlock + 'Trust This Computer', then re-run."
  echo "  (Or use the Xcode ⌘R path in INSTALL.md.)"
  exit 1
fi
echo "✓ device: $DEV_ID"

TEAM_ARG=()
[ -n "$DEVELOPMENT_TEAM" ] && TEAM_ARG=(DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM")

DD=/tmp/bb-dev-signed
rm -rf "$DD"
echo "Building + installing (signing automatically)…"
xcodebuild -project BhatBot.xcodeproj -scheme BhatBot -configuration Debug \
  -destination "id=$DEV_ID" -derivedDataPath "$DD" \
  -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic "${TEAM_ARG[@]}" \
  build install | tail -4 || {
    echo "✗ Build/sign failed. Most common cause: Xcode isn't signed into your Apple ID, or no";
    echo "  team. Open Xcode ▸ Settings ▸ Accounts ▸ + (free), then re-run. See INSTALL.md.";
    exit 1; }

# Install the freshly built .app to the device.
APP="$DD/Build/Products/Debug-iphoneos/BhatBot.app"
if [ -d "$APP" ]; then
  xcrun devicectl device install app --device "$DEV_ID" "$APP" && \
    echo "✓ Installed BhatBot on the iPhone. On first launch: Settings ▸ General ▸ VPN & Device" && \
    echo "  Management → trust your developer cert, then open the app."
else
  echo "✓ Build succeeded; if it didn't auto-install, open BhatBot.xcodeproj and press ⌘R."
fi
