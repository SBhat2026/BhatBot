# Installing BhatBot as a real iPhone app

Straight answer first, because there's a common misconception:

> **You cannot just AirDrop an `.ipa` to a stock iPhone and have it install.**
> iOS has no installer for raw `.ipa` files — AirDrop one and iOS says "cannot open."
> Apple only lets apps onto a non-jailbroken phone through a *signing + install* path.
> There is no way around this without jailbreaking.

So "AirDrop it over and run it" isn't a thing on iOS by itself. But there **are** ways to get
a genuine native app (its own icon, runs without Safari, content auto-updates) onto the phone.
Ranked for your setup (M4 Mac + iPhone 16, free preferred):

| Path | Cost | "AirDrop & run"? | Lifespan | Best when |
|---|---|---|---|---|
| **SideStore** (recommended) | free | ✅ closest — AirDrop the `.ipa`, it opens in SideStore, installs | permanent (auto-refreshes over Wi-Fi) | you want install-once-and-forget, no Mac needed after setup |
| **Xcode ⌘R** | free | ❌ (plug in / wireless, press Run) | 7 days, re-run to renew | the Mac is around and you just want it on the phone now |
| **Apple Developer + TestFlight** | $99/yr | ✅ tap a link, installs, auto-updates | 90 days/build | you want a true App-Store-grade experience |

All three install the **same** native shell. Once installed it loads the live UI from your
backend (Mac tunnel **or** the cloud server), so the **content auto-updates with every push** —
no rebuild, no Safari. The only thing the install path decides is *getting it on the phone and
keeping the signature alive*.

---

## Path 1 — SideStore (free, permanent, closest to "AirDrop & run")

One-time setup, then it behaves like a normal app and **re-signs itself in the background** so
it never expires.

1. **Build the app** (already done for you — re-run anytime to update the shell):
   ```bash
   bash ~/bhatbot/phone-app/build-ipa.sh
   # → phone-app/dist/BhatBot-unsigned.ipa
   ```
2. **Install SideStore once** on the iPhone: follow https://sidestore.io (pairs with a free
   Apple ID; after setup it refreshes apps over Wi-Fi with no Mac in the loop).
3. **Add BhatBot:** AirDrop `BhatBot-unsigned.ipa` to the phone → tap → "Open in SideStore"
   (or in SideStore: **+** → pick the `.ipa`). It re-signs on-device with your Apple ID and
   installs to the home screen.
4. First launch: long-press the screen → set **Host** to your backend
   (`https://…trycloudflare.com`, the Tailscale URL, or the cloud `*.fly.dev`) and **Token**,
   then Save. Done — it runs even with the Mac asleep if you point it at the cloud backend.

> Free Apple-ID signatures last 7 days; SideStore's whole point is auto-refreshing them for
> you, so in practice it stays installed. Keep it on the same Wi-Fi as its pairing now and then.

## Path 2 — Xcode ⌘R (free, fastest right now)

1. Sign Xcode into your Apple ID once: **Xcode ▸ Settings ▸ Accounts ▸ +** (free, no $99).
2. ```bash
   cd ~/bhatbot/phone-app && xcodegen generate && open BhatBot.xcodeproj
   ```
3. In Xcode: select the **BhatBot** target ▸ **Signing & Capabilities** ▸ check **Automatically
   manage signing** ▸ pick your **Personal Team**. (One time; Xcode creates a free cert.)
4. Plug in the iPhone (or use wireless devices), pick it as the run destination, press **⌘R**.
   First run: on the phone, **Settings ▸ General ▸ VPN & Device Management** → trust your
   developer cert. App installs and launches.
5. Re-press ⌘R any time within 7 days to renew. (Or use Path 1 to avoid renewing.)

Helper that does the device build/install from the command line once a team is set:
```bash
DEVELOPMENT_TEAM=XXXXXXXXXX bash ~/bhatbot/phone-app/install-device.sh
```

## Path 3 — Apple Developer Program + TestFlight ($99/yr)

True tap-a-link install with background auto-updates. Worth it only if you want the polished
experience; functionally identical app. Archive in Xcode → upload to App Store Connect →
TestFlight → install via the TestFlight app on the phone.

---

### Why this is the situation (the senior-dev version)
Apple gates third-party code on iOS behind code signing tied to a provisioning profile that
names your device. "Sideloading" tools (SideStore/AltStore) automate the *free* 7-day signing
on-device and renew it; the paid program issues 1-year profiles and TestFlight/App Store
distribution. AirDrop just transfers the file — it can't grant a signature, which is why the
raw `.ipa` won't install on its own. The good news: the **auto-update** you wanted is already
solved by the WebView shell loading the live UI, so you only do the install dance once.
