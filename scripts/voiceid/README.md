# BhatBot Voice ID (speaker verification)

Recognize Siddhant's voice so BhatBot can know *who* is speaking — used as a second auth factor
for command mode (alongside the spoken passphrase), and later for personalizing desktop voice.

Uses [Resemblyzer](https://github.com/resemble-ai/Resemblyzer) (a pretrained d-vector speaker
encoder). Runs fully locally; no audio leaves the machine.

## Status
✅ **Wired into the always-on wake listener for ADAPTIVE (train-as-you-use-it) recognition.**
⚠️ Still needs real-audio testing + the one-time `setup.sh` (installs resemblyzer/torch in the
venv the listener borrows). Batch enrollment below is now OPTIONAL — the listener auto-bootstraps.

## How it actually works now (adaptive, online)
`scripts/listen.py` (the wake listener) gates every wake on a speaker match and **learns your
voice from each confirmed wake** (online enrollment → `~/.bhatbot/voiceid/owner.json`):
- **No profile yet?** The first `BHATBOT_SPEAKER_BOOTSTRAP` (default 5) wakes are accepted and
  used to SEED the profile. Then gating turns on automatically.
- **Profile exists?** Only utterances matching your voice (cosine ≥ threshold) wake it —
  background noise / other people are rejected. Strong matches keep refining the profile, so it
  gets more accustomed to you over time. The same gate suppresses noise-triggered barge-in.
- Fail-open: if resemblyzer isn't installed or a clip is unclear, it never goes deaf.

Tuning knobs (config.json `wake.*` or env): `speakerGate` (auto|1|0), `speakerAdapt`,
`speakerThreshold`, `micDevice` (e.g. an iPhone Continuity Mic name), `BHATBOT_SPEAKER_BOOTSTRAP`.

You only need `setup.sh` once (for the venv). Batch enroll below just gives it a faster, cleaner
head-start than bootstrapping from live wakes.

## 1. Setup (once)
```bash
bash scripts/voiceid/setup.sh        # builds ~/.bhatbot/voiceid-venv, installs the encoder
```

## 2. Enroll your voice
Record **6–10 clips, 5–15s each**. Variety matters — your intonation drifts over longer speech,
so include: different sentences, a calm read + an animated one, fast + slow. Drop them in a folder.
```bash
~/.bhatbot/voiceid-venv/bin/python scripts/voiceid/enroll.py --dir ~/Desktop/voice_samples
```
Writes `~/.bhatbot/voiceid/owner.json` (mean embedding + every per-sample embedding + a suggested
threshold derived from how consistent your own clips are).

## 3. Verify a clip
```bash
~/.bhatbot/voiceid-venv/bin/python scripts/voiceid/verify.py some_clip.wav
# → {"ok":true,"match":true,"score":0.83,"best":0.88,"threshold":0.78,"name":"Siddhant"}
```
`score` = cosine vs your centroid; `best` = max cosine vs any single enrolled sample (more
forgiving over longer/varied speech). `match` fires when `max(score,best) >= threshold`.

## 4. From Node
```js
const voiceid = require('./lib/voiceid');
if (voiceid.isEnrolled()) {
  const r = await voiceid.verify('/path/to/caller-utterance.wav');
  if (r.match) { /* high-confidence owner */ }
}
```

## Integration plan (next check-in)
- **Phone command mode:** capture the caller's passphrase utterance (Twilio `<Record>` or the
  Gather recording), download the audio, run `voiceid.verify`. Require **voice match AND
  passphrase** for command mode → spoofing the caller-ID *and* the passphrase still fails without
  the voice. Fall back to passphrase-only if not enrolled.
- **Desktop mic:** verify the wake-word utterance so ambient command mode only unlocks for you.
- **Tuning:** raise/lower `threshold` in `owner.json` after testing against impostor clips
  (the friend doing playtesting is a convenient negative sample).
