#!/usr/bin/env python3
"""Bhatbot always-on wake-word listener (offline, lightweight, no account).

Two detectors share one mic stream:
  1. openWakeWord  -> "hey jarvis"  (purpose-built model, reliable, low false-positive)
  2. Vosk grammar  -> "hey bhatbot" (matched via in-vocab homophones, since
     "bhatbot" is not a real word and isn't in any speech model's vocabulary)

On a wake hit it prints `WAKE` to stdout. Bhatbot's main process then arms a
Whisper capture for the actual command (Whisper transcribes arbitrary speech
far better than the small Vosk model, so the command stays accurate).

Env:
  BHATBOT_WAKE_DEBUG=1     print scores / heard text to stderr (tuning)
  BHATBOT_WAKE_THRESH=0.5  openWakeWord score threshold
  BHATBOT_VOSK_MODEL       path to vosk model (default ~/.bhatbot/vosk-model)
  BHATBOT_WAKE_ENGINES     "oww,vosk" (default both) — disable one if noisy
"""
import os
import sys
import json
import time
import queue
import threading

DEBUG = os.environ.get("BHATBOT_WAKE_DEBUG") == "1"
THRESH = float(os.environ.get("BHATBOT_WAKE_THRESH", "0.5"))
MODEL_DIR = os.path.expanduser(os.environ.get("BHATBOT_VOSK_MODEL", "~/.bhatbot/vosk-model"))
ENGINES = os.environ.get("BHATBOT_WAKE_ENGINES", "oww,vosk").split(",")
DEBOUNCE = 2.5  # seconds to ignore further hits after a wake

# --- Barge-in (interrupt TTS by speaking) ---
# Energy VAD that only fires WHILE Bhatbot is speaking (main sends "TTS 1"/"TTS 0" on
# stdin). Threshold is raised during playback so the mic echo of Bhatbot's own voice through
# the speakers doesn't self-trigger; only clearly louder/closer user speech crosses it.
BARGE = os.environ.get("BHATBOT_BARGE", "1") == "1"
# Normalized RMS (0..1) the user's speech must exceed during playback to count as barge-in.
BARGE_THRESH = float(os.environ.get("BHATBOT_BARGE_THRESH", "0.085"))
BARGE_FRAMES = int(os.environ.get("BHATBOT_BARGE_FRAMES", "3"))  # ~240ms sustained (80ms/frame)
_tts_active = False
# Wake suppression: main sends "MUTE 1" while BhatBot is SPEAKING a clip that contains its
# own name ("Jarvis"/"BhatBot"), so the mic echo of that name doesn't self-trigger the wake
# word. "MUTE 0" lifts it, plus a short trailing grace for the buffered echo tail. Energy-VAD
# barge-in is untouched — the user can still talk over playback; only the wake WORD is gated.
_wake_muted = False
_wake_mute_grace_until = 0.0
WAKE_MUTE_GRACE = 0.6  # seconds after a name clip ends to keep ignoring wake (echo tail)


def _stdin_reader():
    # Main process tells us when TTS is playing / saying its own name.
    global _tts_active, _wake_muted, _wake_mute_grace_until
    for line in sys.stdin:
        s = line.strip()
        if s == "TTS 1":
            _tts_active = True
        elif s == "TTS 0":
            _tts_active = False
        elif s == "MUTE 1":
            _wake_muted = True
        elif s == "MUTE 0":
            _wake_muted = False
            _wake_mute_grace_until = time.time() + WAKE_MUTE_GRACE

# In-vocab homophones for "hey bhatbot" (Vosk small can't say "bhatbot").
# Confirmed-working set: "hey bhatbot" reliably lands as one of these two.
BHATBOT_PHRASES = ["hey bought bot", "hey but bot", "bought bot", "but bot"]
JARVIS_PHRASES = ["hey jarvis", "jarvis"]
# Match phrases (substring); 2-word minimum so bare "bot" can't false-trigger.
MATCH_PHRASES = ["hey bought bot", "hey but bot", "bought bot", "but bot", "hey jarvis", "jarvis"]
VOSK_GRAMMAR = json.dumps(BHATBOT_PHRASES + JARVIS_PHRASES + ["[unk]"])


def derr(*a):
    if DEBUG:
        print("[wake]", *a, file=sys.stderr, flush=True)


def main():
    try:
        import sounddevice as sd
    except Exception as e:
        print("WAKE_ERR import sounddevice:", e, file=sys.stderr, flush=True)
        return 1

    use_oww = "oww" in ENGINES
    use_vosk = "vosk" in ENGINES

    oww = None
    if use_oww:
        try:
            from openwakeword.model import Model as OWW
            import openwakeword, glob
            base = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
            jarvis = glob.glob(os.path.join(base, "hey_jarvis*.onnx"))
            oww = OWW(wakeword_models=jarvis, inference_framework="onnx") if jarvis else OWW()
            import numpy as np  # noqa
            derr("openWakeWord ready:", jarvis)
        except Exception as e:
            print("WAKE_ERR openwakeword:", e, file=sys.stderr, flush=True)
            oww = None

    rec = None
    if use_vosk:
        try:
            from vosk import Model, KaldiRecognizer
            if not os.path.isdir(MODEL_DIR):
                print("WAKE_ERR vosk model missing:", MODEL_DIR, file=sys.stderr, flush=True)
            else:
                rec = KaldiRecognizer(Model(MODEL_DIR), 16000, VOSK_GRAMMAR)
                derr("vosk grammar ready")
        except Exception as e:
            print("WAKE_ERR vosk:", e, file=sys.stderr, flush=True)
            rec = None

    if oww is None and rec is None:
        print("WAKE_ERR no detector available", file=sys.stderr, flush=True)
        return 1

    import numpy as np
    q = queue.Queue()

    def cb(indata, frames, t, status):
        q.put(bytes(indata))

    last_wake = 0.0
    last_barge = 0.0
    voiced_frames = 0

    if BARGE:
        threading.Thread(target=_stdin_reader, daemon=True).start()
        derr("barge-in armed (thresh=%.3f frames=%d)" % (BARGE_THRESH, BARGE_FRAMES))

    def fire(why):
        nonlocal last_wake
        now = time.time()
        if now - last_wake < DEBOUNCE:
            return
        # Suppress while BhatBot is saying its own name (or just finished) — that's its own
        # voice echoing back, not Siddhant. Only HE should be able to wake it.
        if _wake_muted or now < _wake_mute_grace_until:
            derr("WAKE suppressed (self-name) via", why)
            return
        last_wake = now
        derr("WAKE via", why)
        print("WAKE", flush=True)

    # 1280 samples @16k = 80ms — openWakeWord's expected frame size
    print("READY", flush=True)
    with sd.RawInputStream(samplerate=16000, blocksize=1280, dtype="int16",
                           channels=1, callback=cb):
        while True:
            data = q.get()
            pcm = np.frombuffer(data, dtype=np.int16)
            # Barge-in: while Bhatbot is speaking, sustained mic energy above the (raised)
            # threshold = the user talking over it → emit VOICE so main stops the TTS.
            if BARGE and _tts_active:
                rms = float(np.sqrt(np.mean((pcm.astype(np.float32) / 32768.0) ** 2))) if pcm.size else 0.0
                if rms >= BARGE_THRESH:
                    voiced_frames += 1
                    if voiced_frames >= BARGE_FRAMES and (time.time() - last_barge) > 1.0:
                        last_barge = time.time()
                        voiced_frames = 0
                        derr("BARGE rms=%.3f" % rms)
                        print("VOICE", flush=True)
                else:
                    voiced_frames = 0
            else:
                voiced_frames = 0
            if oww is not None:
                try:
                    scores = oww.predict(pcm)
                    top = max(scores.values()) if scores else 0.0
                    if DEBUG and top > 0.2:
                        derr("oww", {k: round(v, 2) for k, v in scores.items()})
                    if top >= THRESH:
                        fire("oww:hey_jarvis")
                except Exception as e:
                    derr("oww err", e)
            if rec is not None:
                try:
                    if rec.AcceptWaveform(data):
                        text = json.loads(rec.Result()).get("text", "").strip()
                        if text and text != "[unk]":
                            derr("vosk heard:", repr(text))
                            if any(p in text for p in MATCH_PHRASES):
                                fire("vosk:" + text)
                except Exception as e:
                    derr("vosk err", e)


if __name__ == "__main__":
    sys.exit(main())
