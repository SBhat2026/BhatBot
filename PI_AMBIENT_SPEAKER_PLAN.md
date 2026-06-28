# BhatBot ⇄ Raspberry Pi Ambient Speaker — Design Plan

*Goal: a physical JARVIS presence in the room. A small always-listening Pi appliance that hears the
wake word, takes a spoken request, and answers in BhatBot's own voice through a good speaker — with a
glowing LED ring that mirrors the HUD orb (idle / listening / thinking / speaking). No laptop lid open,
no phone in hand: just "Jarvis, …" out loud and a spoken reply.*

---

## 1. Architecture: the Pi is a thin SATELLITE, not a second brain

BhatBot already has a satellite pattern — the brain lives on the Mac (and the always-on cloud agent),
and Twilio / Telegram / the phone PWA are dumb endpoints that stream audio/text in and play replies out.
**The Pi becomes one more satellite of the same brain.** It does NOT run the agent, hold credentials,
or make model calls. It does four things: hear the wake word, capture the utterance, play back the
reply audio, and show presence on an LED ring.

```
  ┌─────────────────────────── Tailnet (Tailscale, private) ───────────────────────────┐
  │                                                                                      │
  │   Raspberry Pi satellite                         Mac (BhatBot brain) / Cloud agent   │
  │   ┌───────────────────────┐                      ┌────────────────────────────────┐ │
  │   │ wake word (openWakeWord)│  ──wake event──▶    │ existing token-gated HTTP server │ │
  │   │ VAD capture (silero)    │  ──utterance wav──▶ │  POST /api/<token>/voice         │ │
  │   │ speaker (ALSA/aplay)     │ ◀──reply audio────  │   → transcribeAudio()            │ │
  │   │ LED ring (ReSpeaker)     │ ◀──state events──   │   → dispatchTurn()  (the agent)  │ │
  │   │ barge-in (mic during TTS)│  ──interrupt──▶     │   → synthesizeSpeech()  (1 voice)│ │
  │   └───────────────────────┘                      └────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────────────────────────────┘
```

**Why thin:** (a) keeps the single source of truth — same agent, same memory, same tools as the
desktop/phone; (b) honors the **ElevenLabs-ONLY voice** rule (`feedback_bhatbot_one_voice`) — the Pi
never synthesizes its own voice, it plays audio produced by the Mac's `synthesizeSpeech()`; (c) reuses
the existing tailnet-only, `mcpToken`-gated security boundary (`project_bhatbot_security`) instead of
opening a new attack surface; (d) a $15 Pi Zero 2 W is enough because it only moves audio.

---

## 2. Hardware (bill of materials)

| Tier | Compute | Mic | Speaker | Presence | ~Cost |
|--|--|--|--|--|--|
| **Recommended** | Pi 4 (2GB) or Pi 5 | **ReSpeaker 2-Mics Pi HAT** (dual mic + onboard APA102 LED ring + button) | 3W speaker via the HAT's JST, or a small line-out powered speaker | The HAT's RGB LED ring | ~$70 |
| Budget | Pi Zero 2 W | ReSpeaker 2-Mics HAT (fits the Zero footprint) | tiny 3W speaker | HAT LEDs | ~$45 |
| Premium presence | Pi 5 | **ReSpeaker 4-Mic Array** (far-field, beamforming, 12-LED ring) | a real bookshelf/USB speaker | 12-LED APA102 ring | ~$120 |

Notes:
- The **ReSpeaker HAT is the key part**: it gives a far-field mic (so it hears you across the room)
  AND a hardware LED ring on the same board — presence + listening in one. The 4-mic array adds
  beamforming + better wake accuracy if budget allows.
- **Echo cancellation (AEC)** matters so BhatBot's own voice doesn't re-trigger the wake word or get
  transcribed. The 4-mic array has better AEC; on the 2-mic, do it in software (`speexdsp`/WebRTC AEC)
  OR — simplest — **gate the mic while playing TTS** (mirror the Mac's existing `setWakeMute()` /
  `MUTE 1` stdin trick on `wakeProc`).

---

## 3. Software stack on the Pi

A single small Python service (`bhatpi.py`), systemd-managed, mirroring the Mac's existing Python
wake listener (which already uses `openwakeword` + `vosk` per the `resolvePython` deps comment):

| Concern | Library | Why |
|--|--|--|
| Wake word | **openWakeWord** (custom "Jarvis"/"BhatBot" model) or Porcupine free tier | same engine family as the Mac listener → consistent behavior; runs fine on a Pi |
| Voice-activity capture | **silero-vad** or `webrtcvad` | record from wake until ~800ms silence → one clean utterance wav |
| Audio out | `aplay` / ALSA (or `mpv` for streamed chunks) | play the reply bytes the Mac returns |
| LED presence | `apa102` / `gpiozero` (ReSpeaker LEDs) | map ring animation to agent state |
| Transport | `requests` (v1) → `websockets` (v2 streaming) | talk to the token-gated server over the tailnet |
| Network | **Tailscale** on the Pi | join the same tailnet; all traffic private, no port-forwarding |

STT can stay on the Mac (send the wav up to the existing `transcribeAudio()` — Whisper/Groq) so the
Pi stays dumb and cheap. (Optional later: local `whisper.cpp tiny` on a Pi 5 to cut a round-trip — STT
choice does NOT affect the voice identity, so it's a free optimization, unlike TTS.)

---

## 4. BhatBot-side changes (small, additive)

Everything below is additive to the existing token-gated server (the same one `bhatctl` hits at
`/api/<token>/chat`). No agent/loop changes.

1. **New endpoint `POST /api/<token>/voice`** (multipart: `audio` wav, optional `format`):
   ```
   transcribeAudio(buf, mime)  →  text
   dispatchTurn([{role:'user',content:text}], apiKey, ev, { stream:false, source:'pi' })  →  reply
   synthesizeSpeech(reply.spokenText)  →  { audio, mimeType }
   return { text: reply.text, audio: <base64>, mimeType }
   ```
   Reuses `transcribeAudio`, `dispatchTurn`, and `synthesizeSpeech` verbatim — so the Pi gets the
   exact same agent, tools, memory, and **voice** as the desktop. The `<speak>`-tag brevity + the new
   summary-trim/stream-cutoff fixes apply automatically.

2. **State events to the Pi** for the LED ring. The HUD already emits `tool-update` (thinking/token)
   and `tts-idle`. Add the Pi as another sink: either (a) a lightweight `GET /api/<token>/state`
   long-poll, or (b) reuse the cloud WS relay (`lib/cloud-bridge.js`) so the Pi subscribes to the same
   `idle/listening/thinking/speaking` stream the orb uses. Map: thinking→pulse, speaking→equalizer
   throb, idle→slow breath.

3. **Streaming v2 (low latency):** a `WS /api/<token>/voice-stream` that pushes `synthesizeSpeech`
   chunks as they're produced (the `ttsStream` drain already chunks sentence-by-sentence). The Pi plays
   chunk 1 (~1.5s) while the Mac generates the rest — same first-audio latency as the desktop, and
   barge-in works (Pi sends `interrupt` → `bargeInInterrupt()`).

4. **Proactive ambient (free win):** the existing ambient/patrol + morning-brief system already routes
   spoken output through `speakDesktop`. Add the Pi as a `speakDesktop` sink so urgent alerts / the
   morning brief play *in the room* automatically — the actual "ambient presence" payoff.

5. **Dedicated scoped token** for the Pi (rotate-able, separate from the desktop `mcpToken`) so a lost
   Pi can be revoked without rotating everything. Stored in the vault like other creds.

---

## 5. Security (reuses the existing hardening)

- Pi is **tailnet-only** (Tailscale). The voice endpoint is exposed via the same Tailscale Serve
  config that already gates `/health` + Twilio — **never public** (`project_bhatbot_security`).
- The Pi holds only a scoped bearer token, not API keys or the vault. The `mcpToken` boundary is the
  whole trust model — same as the phone PWA.
- The mic is gated during playback (no hot-mic recording of the room beyond an utterance window);
  optional physical mute button on the ReSpeaker HAT for a hardware kill.

---

## 6. Presence: LED ring ↔ orb states

Reuse the four states the HUD orb already drives, so the physical ring "feels" like the same entity:

| Agent state | Orb (HUD) | Pi LED ring |
|--|--|--|
| idle | slow core breath | dim slow blue breath |
| listening | radar sweep | bright cyan, rotating |
| thinking | core flicker | amber pulse |
| speaking | equalizer throb | cyan throb synced to audio amplitude |

Driven by the same event stream (§4.2). This is the cheapest, highest-impact "presence" feature.

---

## 7. Latency budget (target ≈ desktop)

`wake (local, ~0ms net)` → `VAD capture (~end-of-speech)` → `wav up over tailnet (~50-150ms)` →
`STT (~0.5-1s)` → `first agent token (~1s)` → `first TTS chunk (~0.5s)` → **first audio ≈ 2-3s**, same
as the desktop streaming path. v2 streaming keeps it there; v1 (full reply then audio) is ~1-2s slower.
Optimizations: local STT on a Pi 5, keep a warm WS, pre-roll an "Mm-hm"/ack chime on wake (mirrors the
desktop `maybeAck`).

---

## 8. Phased implementation

- **v0 — proof (an afternoon):** Pi on tailnet; a script records 5s on button-press, POSTs to a new
  `/api/<token>/voice`, plays the returned audio. Proves transport + voice consistency end to end.
- **v1 — hands-free:** add openWakeWord + silero VAD (wake → capture → send → play); add the LED ring
  with the 4 states via `/state`. The everyday "Jarvis, …" appliance.
- **v2 — streaming + barge-in:** WS chunked TTS, mic-during-playback interrupt → `bargeInInterrupt`,
  ack chime. Latency matches desktop.
- **v3 — ambient presence:** route morning brief + urgent patrol alerts to the Pi; multi-room (each Pi
  a named satellite); optional local STT.

---

## 9. Decisions for Siddhant

1. **Brain = Mac or cloud?** The Mac is always the lowest-latency host but must be awake; the cloud
   agent (`cloud/`) is always-on but adds a hop. Recommend: Pi targets whichever is reachable (Mac on
   tailnet first, cloud fallback) — same failover the phone uses.
2. **Hardware tier?** Recommend the **Pi 4 + ReSpeaker 2-Mic HAT** (~$70) for v1; jump to the 4-mic
   array only if far-field accuracy across a big room matters.
3. **STT on Mac (simplest, recommended) or local on the Pi (one less hop, needs a Pi 5)?**
4. **Wake word engine:** reuse openWakeWord (matches the Mac, free, custom "Jarvis") vs Porcupine
   (slightly better accuracy, free tier, cloud-trained keyword).

No code shipped for this yet — this is the design. Say the word and I'll start with the v0 proof:
the additive `/api/<token>/voice` endpoint on the Mac side + a ~60-line `bhatpi.py` for the Pi.
