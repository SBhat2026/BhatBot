#!/usr/bin/env python3
"""Bhatbot wake-word listener (openWakeWord, offline, free).
Prints 'WAKE <model> <score>' to stdout when the wake phrase ("hey jarvis") is heard.
Bhatbot's main process watches stdout and arms voice capture on 'WAKE'.
"""
import sys
import time

THRESH = float(__import__("os").environ.get("BHATBOT_WAKE_THRESH", "0.5"))
MODEL = __import__("os").environ.get("BHATBOT_WAKE_MODEL", "hey_jarvis")
CHUNK = 1280  # 80ms @ 16kHz

def main():
    try:
        import numpy as np
        import sounddevice as sd
        import openwakeword
        from openwakeword.model import Model
    except Exception as e:
        print("WAKE_ERR import:", e, file=sys.stderr, flush=True)
        return 1
    try:
        openwakeword.utils.download_models()
    except Exception:
        pass
    # Prefer ONNX on Apple Silicon (tflite-runtime is often unavailable there).
    try:
        model = Model(wakeword_models=[MODEL], inference_framework="onnx")
    except Exception:
        model = Model(wakeword_models=[MODEL])
    print("READY", flush=True)
    try:
        with sd.InputStream(samplerate=16000, channels=1, dtype="int16", blocksize=CHUNK) as stream:
            while True:
                data, _ = stream.read(CHUNK)
                audio = np.frombuffer(data, dtype="int16")
                preds = model.predict(audio)
                for kw, score in preds.items():
                    if score >= THRESH:
                        print(f"WAKE {kw} {score:.3f}", flush=True)
                        time.sleep(2.0)        # cooldown so one phrase = one trigger
                        try: model.reset()
                        except Exception: pass
    except Exception as e:
        print("WAKE_ERR stream:", e, file=sys.stderr, flush=True)
        return 1

if __name__ == "__main__":
    sys.exit(main())
