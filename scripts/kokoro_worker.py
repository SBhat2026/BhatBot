#!/usr/bin/env python3
"""Bhatbot local TTS worker (Kokoro).

Loads the Kokoro model ONCE, then stays warm: reads one JSON request per line on
stdin, synthesizes to a temp wav, and prints one JSON line per request on stdout.
Keeping the process alive avoids the ~1.2s model-load cost on every reply.

stdin  : {"id": <n>, "text": "...", "voice": "bm_george", "speed": 1.0, "lang": "en-gb"}
stdout : {"id": <n>, "path": "/tmp/....wav"}  | {"id": <n>, "error": "..."}
Model + voices dir is given as argv[1] (defaults to ~/.bhatbot/kokoro).
"""
import sys, os, json, tempfile

KDIR = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.bhatbot/kokoro")

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

try:
    from kokoro_onnx import Kokoro
    import soundfile as sf
    kok = Kokoro(os.path.join(KDIR, "kokoro-v1.0.onnx"), os.path.join(KDIR, "voices-v1.0.bin"))
    emit({"ready": True})
except Exception as e:  # fatal — no model
    emit({"fatal": str(e)})
    sys.exit(1)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    rid = None
    try:
        req = json.loads(line)
        rid = req.get("id")
        text = (req.get("text") or "").strip()
        if not text:
            emit({"id": rid, "error": "empty text"}); continue
        voice = req.get("voice") or "bm_george"
        speed = float(req.get("speed") or 1.0)
        lang = req.get("lang") or "en-gb"
        samples, sr = kok.create(text, voice=voice, speed=speed, lang=lang)
        fd, path = tempfile.mkstemp(prefix="bhatbot-kok-", suffix=".wav")
        os.close(fd)
        sf.write(path, samples, sr)
        emit({"id": rid, "path": path})
    except Exception as e:
        emit({"id": rid, "error": str(e)})
