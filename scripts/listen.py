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

DEBUG = os.environ.get("BHATBOT_WAKE_DEBUG") == "1"
THRESH = float(os.environ.get("BHATBOT_WAKE_THRESH", "0.5"))
MODEL_DIR = os.path.expanduser(os.environ.get("BHATBOT_VOSK_MODEL", "~/.bhatbot/vosk-model"))
ENGINES = os.environ.get("BHATBOT_WAKE_ENGINES", "oww,vosk").split(",")
DEBOUNCE = 2.5  # seconds to ignore further hits after a wake

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

    def fire(why):
        nonlocal last_wake
        now = time.time()
        if now - last_wake < DEBOUNCE:
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
            if oww is not None:
                try:
                    pcm = np.frombuffer(data, dtype=np.int16)
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
