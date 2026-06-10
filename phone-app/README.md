# BhatBot — standalone iPhone app

A real native app (not a Safari shortcut) that opens BhatBot full-screen. It's a thin
WKWebView shell around the phone UI the Mac already serves over the Tailscale Funnel — so
**every push you make auto-updates the app's content**; you never rebuild to get new UI.
Mic, wake word, the Chat/Activity/Nexus tabs, and voice replies all work inside it.

The only thing baked into the binary is the funnel URL + token (`Sources/Config.swift`).
Edit that one line if the host/token ever changes, then rebuild once.

## Build it (one time)

```bash
bash ~/bhatbot/phone-app/build.sh
```

That installs `xcodegen` (if needed), generates `BhatBot.xcodeproj`, and opens Xcode.

## Install on your iPhone — pick ONE path

### A) Xcode direct (simplest, free) — re-sign every 7 days
1. Plug the iPhone into the Mac (or use wireless debugging).
2. In Xcode: select the **BhatBot** scheme → choose your iPhone as the device.
3. **Signing & Capabilities** → Team → add your free Apple ID. Bundle id is
   `com.bhat.bhatbot` (change it if Xcode says it's taken).
4. Press **⌘R**. The app installs and launches. Trust the developer cert under
   *Settings → General → VPN & Device Management* the first time.
5. Free Apple IDs sign apps for **7 days** — just press ⌘R again when it expires.

### B) AltStore / SideStore (free) — auto-resigns, so it NEVER expires ★ recommended
This is the "standalone app that just stays installed and auto-updates" path.
1. Install **SideStore** (sidestore.io) or **AltStore** (altstore.io) on the iPhone +
   its mail/pairing helper on the Mac (one-time).
2. In Xcode: **Product → Archive**, or build, then grab the `.ipa`
   (Product → Show Build Folder → `Products/Applications/BhatBot.app`, zip → rename `.ipa`).
3. Open the `.ipa` with AltStore/SideStore → it installs.
4. AltStore/SideStore **re-signs the app automatically over Wi-Fi every few days**, so it
   stays installed indefinitely with no manual ⌘R. Content still auto-updates from the Mac.

### C) $99/yr Apple Developer account — 1-year signing, optional TestFlight
If you ever want it to "just work" for a year with zero re-signing, enroll at
developer.apple.com and use a normal distribution/dev cert. Not required.

## Notes
- The Mac must be running BhatBot with the funnel up (`bash ~/bhatbot/scripts/serve-remote.sh`
  or just the app + `tailscale funnel 8788`). Works over cellular via the Funnel.
- Wake word + mic are foreground-only (iOS won't let a web view listen with the screen off).
- This app contains no secrets beyond the same token already in your home-screen URL.
