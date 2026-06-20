#!/usr/bin/env python3
"""Enroll Siddhant's voice → a speaker profile BhatBot can verify against.

Why multiple samples: a single clip can't capture how intonation drifts over longer,
multi-word speech. We embed several VARIED utterances (different sentences + lengths) and
store the mean embedding plus every per-sample embedding, so verification can score against
the closest enrolled style instead of one averaged-out fingerprint.

Usage:
  python enroll.py sample1.wav sample2.wav ...      # explicit files
  python enroll.py --dir ~/Desktop/voice_samples    # every wav/mp3/m4a in a folder
  python enroll.py --out ~/.bhatbot/voiceid/owner.json sample*.wav

Record ~6-10 clips of 5-15s each: read different sentences, vary pace/emphasis, include a
calm one and an animated one. More variety = more robust over real conversations.
"""
import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np


def find_samples(args):
    files = list(args.files)
    if args.dir:
        d = os.path.expanduser(args.dir)
        for ext in ("wav", "mp3", "m4a", "flac", "ogg", "webm"):
            files += glob.glob(os.path.join(d, f"*.{ext}"))
    return sorted({os.path.expanduser(f) for f in files if os.path.exists(os.path.expanduser(f))})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", help="audio sample files")
    ap.add_argument("--dir", help="folder of audio samples")
    ap.add_argument("--out", default=os.path.expanduser("~/.bhatbot/voiceid/owner.json"))
    ap.add_argument("--name", default="Siddhant")
    args = ap.parse_args()

    samples = find_samples(args)
    if len(samples) < 3:
        print(json.dumps({"ok": False, "error": f"need >=3 samples, found {len(samples)}"}))
        sys.exit(1)

    from resemblyzer import VoiceEncoder, preprocess_wav  # heavy import, deferred

    encoder = VoiceEncoder()
    embeds, used = [], []
    for p in samples:
        try:
            wav = preprocess_wav(p)
            embeds.append(encoder.embed_utterance(wav))
            used.append(os.path.basename(p))
        except Exception as e:  # noqa: BLE001
            print(f"  ! skipped {p}: {e}", file=sys.stderr)

    if len(embeds) < 3:
        print(json.dumps({"ok": False, "error": f"only {len(embeds)} samples embedded ok"}))
        sys.exit(1)

    embeds = np.stack(embeds)
    mean = embeds.mean(axis=0)
    mean = mean / (np.linalg.norm(mean) + 1e-9)

    # Self-consistency: mean cosine of each sample to the centroid → a sane default threshold
    # sits a bit below the spread of the owner's own clips.
    sims = embeds @ mean / (np.linalg.norm(embeds, axis=1) + 1e-9)
    suggested = float(max(0.6, round(sims.mean() - 2 * sims.std(), 3)))

    profile = {
        "name": args.name,
        "created": datetime.now(timezone.utc).isoformat(),
        "model": "resemblyzer-voiceencoder",
        "dim": int(mean.shape[0]),
        "n_samples": len(embeds),
        "samples": used,
        "threshold": suggested,
        "mean": mean.tolist(),
        "embeds": embeds.tolist(),  # per-sample, for max-style matching at verify time
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(profile, f)
    print(json.dumps({"ok": True, "out": args.out, "n_samples": len(embeds),
                      "suggested_threshold": suggested, "self_sim_mean": float(sims.mean())}))


if __name__ == "__main__":
    main()
