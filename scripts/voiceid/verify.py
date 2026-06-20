#!/usr/bin/env python3
"""Verify whether an audio clip is Siddhant, against the enrolled profile.

Prints JSON: {ok, match, score, best, threshold, name}. `score` is cosine vs the centroid;
`best` is the max cosine vs any single enrolled sample (more forgiving of intonation drift on
longer speech). match = (max(score, best) >= threshold).

Usage:
  python verify.py clip.wav
  python verify.py --profile ~/.bhatbot/voiceid/owner.json --threshold 0.78 clip.wav
"""
import argparse
import json
import os
import sys

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip")
    ap.add_argument("--profile", default=os.path.expanduser("~/.bhatbot/voiceid/owner.json"))
    ap.add_argument("--threshold", type=float, default=None)
    args = ap.parse_args()

    if not os.path.exists(args.profile):
        print(json.dumps({"ok": False, "error": "no enrolled profile — run enroll.py first"}))
        sys.exit(2)
    with open(args.profile) as f:
        prof = json.load(f)
    thr = args.threshold if args.threshold is not None else float(prof.get("threshold", 0.78))

    from resemblyzer import VoiceEncoder, preprocess_wav

    try:
        wav = preprocess_wav(os.path.expanduser(args.clip))
        emb = VoiceEncoder().embed_utterance(wav)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"embed failed: {e}"}))
        sys.exit(1)
    emb = emb / (np.linalg.norm(emb) + 1e-9)

    mean = np.asarray(prof["mean"], dtype=float)
    score = float(emb @ mean)
    best = score
    if prof.get("embeds"):
        E = np.asarray(prof["embeds"], dtype=float)
        E = E / (np.linalg.norm(E, axis=1, keepdims=True) + 1e-9)
        best = float((E @ emb).max())

    decision = max(score, best)
    print(json.dumps({"ok": True, "match": bool(decision >= thr), "score": round(score, 4),
                      "best": round(best, 4), "threshold": thr, "name": prof.get("name", "owner")}))


if __name__ == "__main__":
    main()
