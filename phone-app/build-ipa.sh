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
xcodegen generate >/dev/null
echo "✓ project generated"

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
