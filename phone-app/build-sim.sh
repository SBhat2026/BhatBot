#!/usr/bin/env bash
# Build BhatBot for the iOS SIMULATOR (Debug, no signing) → prints the .app path.
#   bash ~/bhatbot/phone-app/build-sim.sh
set -e
cd "$(dirname "$0")"
mkdir -p Web && cp ../src/mobile.html Web/mobile.html
( cd .. && node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/live/phone-secrets 2>/dev/null | grep '^SECRETS' ) || true
[ -f Sources/Secrets.swift ] || printf 'enum Secrets {\n  static let macHost = ""\n  static let macToken = ""\n  static let cloudHost = ""\n  static let cloudToken = ""\n}\n' > Sources/Secrets.swift
xcodegen generate >/dev/null
xcodebuild -project BhatBot.xcodeproj -scheme BhatBot -sdk iphonesimulator -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/bb-sim \
  CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E "error:|warning: unre|BUILD (SUCCEEDED|FAILED)" | head -20
echo "APP=/tmp/bb-sim/Build/Products/Debug-iphonesimulator/BhatBot.app"
