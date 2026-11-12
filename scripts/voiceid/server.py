#!/usr/bin/env python3
"""Resident speaker-verification daemon.

verify.py is correct and far too slow to sit in a conversation: it imports torch and builds the
VoiceEncoder on every call, which measured 1.7 s warm and 5.8 s cold PER UTTERANCE on the M5 — and
it ran after speech-to-text, in series, so every single thing said to BhatBot waited that long
before the words were even handed to the model. The model load is the whole cost; the embedding
itself is tens of milliseconds. So load once and stay up.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
  {"id": 7, "op": "verify", "clip": "/tmp/x.webm"}  ->  {"id": 7, "ok": true, "match": ..., "score": ..., "best": ..., "threshold": ..., "ms": ...}
  {"id": 8, "op": "ping"}                           ->  {"id": 8, "ok": true, "ready": true}
The profile is re-read when its mtime changes, so a re-enrollment takes effect without a restart.
Identical scoring to verify.py — cosine against the centroid, and the best single enrolled sample.
"""
import json
import os
import sys
import time

import numpy as np

PROFILE = os.path.expanduser(os.environ.get("BHATBOT_VOICEID_PROFILE", "~/.bhatbot/voiceid/owner.json"))


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    try:
        from resemblyzer import VoiceEncoder, preprocess_wav
        enc = VoiceEncoder(verbose=False) if "verbose" in VoiceEncoder.__init__.__code__.co_varnames else VoiceEncoder()
    except Exception as e:  # noqa: BLE001
        out({"id": None, "ok": False, "fatal": True, "error": f"encoder load failed: {e}"})
        return 1

    prof = {"mtime": -1.0, "mean": None, "embeds": None, "thr": 0.78, "name": "owner"}

    def load_profile():
        try:
            m = os.path.getmtime(PROFILE)
        except OSError:
            prof.update(mtime=-1.0, mean=None, embeds=None)
            return False
        if m == prof["mtime"]:
            return prof["mean"] is not None
        with open(PROFILE) as f:
            p = json.load(f)
        prof["mean"] = np.asarray(p["mean"], dtype=float)
        E = p.get("embeds")
        if E:
            E = np.asarray(E, dtype=float)
            E = E / (np.linalg.norm(E, axis=1, keepdims=True) + 1e-9)
        prof["embeds"] = E if E is not None and len(E) else None
        prof["thr"] = float(p.get("threshold", 0.78))
        prof["name"] = p.get("name", "owner")
        prof["mtime"] = m
        return True

    # PAY THE FIRST-CALL COST HERE. The first real verification measured 1.2 s against ~50 ms for
    # every one after it: the audio stack (librosa, the decoder) initialises lazily on first use, so
    # without this the first thing said in every session is the slow one — which is exactly the
    # utterance where a wake word has just fired and the delay is most audible.
    try:
        import tempfile
        import wave
        rng = np.random.default_rng(0)
        pcm = (rng.standard_normal(16000) * 3000).astype("<i2")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tmp = tf.name
        with wave.open(tmp, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(pcm.tobytes())
        try:
            enc.embed_utterance(preprocess_wav(tmp))
        finally:
            os.unlink(tmp)
    except Exception:  # noqa: BLE001 - warming is an optimisation; never a reason to refuse to start
        pass

    out({"id": None, "ok": True, "ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            op = req.get("op")
            if op == "ping":
                out({"id": rid, "ok": True, "ready": True})
                continue
            if op != "verify":
                out({"id": rid, "ok": False, "error": f"unknown op {op!r}"})
                continue
            if not load_profile():
                out({"id": rid, "ok": False, "error": "no enrolled profile"})
                continue
            t0 = time.time()
            wav = preprocess_wav(os.path.expanduser(req["clip"]))
            # Too little voiced audio makes a d-vector that is mostly noise. Scoring it would hand
            # back a confident-looking number that means nothing, so say "too short" instead and let
            # the caller decide — a cough must not be able to fail someone's identity.
            if len(wav) < 16000 * 0.6:
                out({"id": rid, "ok": True, "match": None, "short": True, "voicedSec": round(len(wav) / 16000.0, 2),
                     "threshold": prof["thr"], "ms": int((time.time() - t0) * 1000)})
                continue
            emb = enc.embed_utterance(wav)
            emb = emb / (np.linalg.norm(emb) + 1e-9)
            score = float(emb @ prof["mean"])
            best = score if prof["embeds"] is None else float((prof["embeds"] @ emb).max())
            thr = float(req.get("threshold") or prof["thr"])
            out({"id": rid, "ok": True, "match": bool(max(score, best) >= thr), "score": round(score, 4),
                 "best": round(best, 4), "threshold": thr, "name": prof["name"],
                 "voicedSec": round(len(wav) / 16000.0, 2), "ms": int((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001
            out({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
