# Stop reinstalling BhatBot — silent SideStore auto-refresh

You should almost never rebuild/reinstall the `.ipa`. Two things were conflated:

| Cost | Needs a rebuild? | Why |
|---|---|---|
| **UI / feature changes** (`mobile.html`, voice, tabs, control) | **No** | The app loads the live UI from the cloud (`bhatbot-cloud.fly.dev/app/<token>`) and a service worker auto-reloads ≤60 s after every `fly deploy`. The bundled copy is only an offline fallback — and that fallback now **self-updates** to the latest UI it has seen (see `App.swift` → `cachedURL`). |
| **Native (Swift) changes** | Yes | Only when `Sources/*.swift` change — which is rare. Piggyback it on a cert refresh so it costs no extra trip. |
| **The 7-day cert expiry** | Re-sign, not rebuild | Free Apple-ID signing lasts 7 days. SideStore must re-sign. This is the only *recurring* hassle — and it can be made **silent/background** (below). |

So: the rebuild→download→reinstall loop is **not needed for the work you iterate on.** Make UI changes → `npm run sync-ui && (cd cloud && fly deploy --now)` → the phone updates itself.

---

## One-time: make the 7-day re-sign happen silently in the background

SideStore (unlike AltStore) can re-sign apps **on-device, with no computer**, using a built-in WireGuard tunnel + an anisette server. Set this up once and the weekly reinstall disappears.

### 1. iOS background refresh
- Settings → **General → Background App Refresh** → **On** (Wi-Fi & Cellular, or at least Wi-Fi).
- In that same list, make sure **SideStore** is toggled **On**.

### 2. SideStore settings (inside the SideStore app → Settings)
- **Background Refresh** → **On**.
- **Anisette Server** → set a reachable one. The bundled default usually works; if refresh fails with an anisette error, switch to a known-good public server (e.g. `ana.sidestore.io`) or self-host.
- Confirm a **pairing file** is present (it is, if SideStore installed apps successfully). On-device refresh needs it.
- Keep the **SideStore WireGuard VPN** profile installed + enabled (Settings → VPN shows a "SideStore" config). SideStore uses this local tunnel to talk to the on-device install daemon during a background re-sign — **do not delete it.**

### 3. Habits that make iOS actually run the background task
- Leave the phone **on Wi-Fi + charging overnight** — iOS schedules `BGAppRefreshTask` opportunistically, mostly when charging + idle.
- **Open SideStore every few days.** iOS learns app-usage patterns; an app you never open gets deprioritized for background runs.
- Free Apple-ID limits: **max 3 sideloaded apps**, 10 new app-IDs/week. Fewer installed apps → more reliable refresh.

### 4. Verify it's working
- Open SideStore → each app shows an **expiry countdown** (7 → 0 days).
- If background refresh is working, that countdown **resets on its own** (you'll see ~7 days again without tapping anything).
- Manual safety valve (no computer needed): SideStore → **Refresh All**. Takes seconds over the WireGuard tunnel. Do this if you ever see < 2 days remaining.

> Background refresh is **best-effort** — iOS doesn't guarantee it'll run. Steps 1–3 make it reliable in practice; if it ever lapses, "Refresh All" in the app (step 4) is a 5-second tap, still no rebuild/reinstall.

---

## When you DO need to rebuild the .ipa (rare)
Only after editing `Sources/*.swift`. Then:
```bash
bash ~/bhatbot/phone-app/build-ipa.sh        # → dist/BhatBot-unsigned.ipa
```
Open the `.ipa` in SideStore → it replaces in place (keeps your data). Time this with a cert refresh so it's not an extra trip.

## If you'd rather never sideload again
- **PWA:** Safari → `https://bhatbot-cloud.fly.dev/app/<token>` → Share → **Add to Home Screen.** Never expires, never reinstalled, auto-updates. Trade-off: loses native's force-loud-audio-over-the-mute-switch and auto-granted mic (matters for hands-free voice).
- **TestFlight ($99/yr Apple Developer):** true Apple-hosted OTA + 1-year signing. The fully hands-off option for the native app itself.
