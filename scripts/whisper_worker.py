#!/usr/bin/env python3
"""BhatBot local STT worker — offline Whisper via mlx-whisper (Apple Silicon), runs in
~/.bhatbot/mlx-venv. Stateless: node (lib/localstt.js) spawns it with a JSON request on argv[1]
{audio_path, model?, language?, prompt?} and reads one JSON object {text} | {error} on stdout.

This is the no-cloud-key / cloud-failure fallback for transcribeAudio, so voice works fully
offline. mlx_whisper decodes via ffmpeg, so any browser audio (webm/m4a/wav/ogg) is accepted.
Nothing is fabricated — a failure returns {error}, never invented text.
"""
import sys
import os
import json


def out(o):
    sys.stdout.write(json.dumps(o))
    sys.stdout.flush()
    sys.exit(0)


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    try:
        req = json.loads(raw or "{}")
    except Exception:
        out({"error": "bad request json"})

    path = req.get("audio_path")
    if not path or not os.path.exists(path):
        out({"error": "audio file missing"})

    model = req.get("model") or "mlx-community/whisper-base.en-mlx"
    try:
        import mlx_whisper
    except Exception as e:
        out({"error": "mlx_whisper not installed: " + str(e)})

    kw = {"path_or_hf_repo": model}
    if req.get("language"):
        kw["language"] = req["language"]
    if req.get("prompt"):
        kw["initial_prompt"] = req["prompt"][:600]   # vocabulary biasing (names/emails)

    try:
        r = mlx_whisper.transcribe(path, **kw)
        text = (r.get("text") or "").strip()
        segs = r.get("segments") or []

        def _mean(vals):
            nums = [v for v in vals if isinstance(v, (int, float))]
            return sum(nums) / len(nums) if nums else None

        # mlx-whisper mirrors openai-whisper's per-segment dict: no_speech_prob + avg_logprob.
        nsp = _mean([s.get("no_speech_prob") for s in segs])
        alp = _mean([s.get("avg_logprob") for s in segs])
        res = {"text": text}
        if nsp is not None:
            res["no_speech_prob"] = round(nsp, 4)
        if alp is not None:
            res["avg_logprob"] = round(alp, 4)
        # Reject at the source: whisper's own defaults treat a segment as non-speech when
        # no_speech_prob > 0.6 AND avg_logprob < -1.0 — the profile of the silence/room-noise
        # hallucination bursts. Blank the text (never fabricate) so the Node side drops it.
        if text and nsp is not None and alp is not None and nsp > 0.6 and alp < -1.0:
            res["text"] = ""
            res["dropped"] = "low_confidence"
        out(res)
    except Exception as e:
        out({"error": type(e).__name__ + ": " + str(e)[:300]})


if __name__ == "__main__":
    main()
