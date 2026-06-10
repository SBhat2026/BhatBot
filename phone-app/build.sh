#!/usr/bin/env bash
# Generate the Xcode project for the BhatBot phone app and open it.
# Run once; thereafter you only re-open BhatBot.xcodeproj.
set -e
cd "$(dirname "$0")"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "Installing xcodegen (one-time)…"
  if command -v brew >/dev/null 2>&1; then brew install xcodegen; else
    echo "Homebrew not found. Install it from https://brew.sh then re-run."; exit 1
  fi
fi

xcodegen generate
echo "✓ Generated BhatBot.xcodeproj"
open BhatBot.xcodeproj
echo "In Xcode: pick your iPhone as the run target, set a free Signing Team, press ⌘R."
