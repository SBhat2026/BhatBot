#!/usr/bin/env python3
"""Bhatbot always-on wake-word listener (offline, lightweight, no account).

Two detectors share one mic stream:
  1. openWakeWord  -> "hey jarvis"  (purpose-built model, reliable, low false-positive)
  2. Vosk grammar  -> "hey bhatbot" (matched via in-vocab homophones, since
     "bhatbot" is not a real word and isn't in any speech model's vocabulary)

SPEAKER GATING (the false-activation fix): once an owner voice profile exists, a wake hit only
counts if the buffered utterance MATCHES Siddhant's voice (speaker embedding cosine >= threshold).
Background noise, the TV, and other people no longer wake it. The same gate applies to barge-in.
It also LEARNS as you use it: every confirmed-owner wake updates the profile (online enrollment),
so it gets more accustomed to your voice over time. Before a profile exists it BOOTSTRAPS — the
first few wakes are accepted and used to seed the profile, then gating turns on automatically.

On a wake hit it prints `WAKE` to stdout. Bhatbot's main process then arms a Whisper capture for
the actual command (Whisper transcribes arbitrary speech far better than the small Vosk model).

Env:
  BHATBOT_WAKE_DEBUG=1       print scores / heard text to stderr (tuning)
  BHATBOT_WAKE_THRESH=0.5    openWakeWord score threshold
  BHATBOT_VOSK_MODEL         path to vosk model (default ~/.bhatbot/vosk-model)
  BHATBOT_WAKE_ENGINES       "oww,vosk" (default both) — disable one if noisy
  BHATBOT_SPEAKER_GATE       auto|1|0  (default auto: gate once a profile exists / can be built)
  BHATBOT_SPEAKER_ADAPT      1|0  (default 1: keep learning the owner's voice from each wake)
  BHATBOT_SPEAKER_THRESH     override the profile's match threshold (0..1)
  BHATBOT_SPEAKER_BOOTSTRAP  N wakes accepted to seed a fresh profile (default 5)
  BHATBOT_VOICEID_PROFILE    profile path (default ~/.bhatbot/voiceid/owner.json)
  BHATBOT_VOICEID_VENV       venv holding resemblyzer/torch (default ~/.bhatbot/voiceid-venv)
  BHATBOT_MIC_DEVICE         input device index or name substring (e.g. an iPhone Continuity Mic)
"""
import os
import sys
import json
import time
import glob
import queue
import threading
import collections

DEBUG = os.environ.get("BHATBOT_WAKE_DEBUG") == "1"
THRESH = float(os.environ.get("BHATBOT_WAKE_THRESH", "0.5"))
MODEL_DIR = os.path.expanduser(os.environ.get("BHATBOT_VOSK_MODEL", "~/.bhatbot/vosk-model"))
ENGINES = os.environ.get("BHATBOT_WAKE_ENGINES", "oww,vosk").split(",")
DEBOUNCE = 2.5  # seconds to ignore further hits after a wake

# --- Speaker gating / online enrollment ---
SPEAKER_GATE = os.environ.get("BHATBOT_SPEAKER_GATE", "auto")            # auto|1|0
SPEAKER_ADAPT = os.environ.get("BHATBOT_SPEAKER_ADAPT", "1") == "1"
SPEAKER_THRESH_OVR = os.environ.get("BHATBOT_SPEAKER_THRESH")
BOOTSTRAP_MIN = int(os.environ.get("BHATBOT_SPEAKER_BOOTSTRAP", "5"))
PROFILE_PATH = os.path.expanduser(os.environ.get("BHATBOT_VOICEID_PROFILE", "~/.bhatbot/voiceid/owner.json"))
VOICEID_VENV = os.path.expanduser(os.environ.get("BHATBOT_VOICEID_VENV", "~/.bhatbot/voiceid-venv"))
MIC_DEVICE = os.environ.get("BHATBOT_MIC_DEVICE")
SR = 16000
UTT_SECONDS = 2.0                                                        # rolling window embedded per wake
ADAPT_STRONG_MARGIN = 0.04                                               # only learn when clearly the owner

# --- Barge-in (interrupt TTS by speaking) ---
BARGE = os.environ.get("BHATBOT_BARGE", "1") == "1"
BARGE_THRESH = float(os.environ.get("BHATBOT_BARGE_THRESH", "0.085"))
BARGE_FRAMES = int(os.environ.get("BHATBOT_BARGE_FRAMES", "3"))  # ~240ms sustained (80ms/frame)
_tts_active = False
_wake_muted = False
_wake_mute_grace_until = 0.0
WAKE_MUTE_GRACE = 0.6  # seconds after a name clip ends to keep ignoring wake (echo tail)


def derr(*a):
    if DEBUG:
        print("[wake]", *a, file=sys.stderr, flush=True)


def _stdin_reader():
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


def _add_voiceid_path():
    # Let the always-on listener borrow resemblyzer/torch from the voiceid venv without a subprocess.
    for sp in glob.glob(os.path.join(VOICEID_VENV, "lib", "python*", "site-packages")):
        if sp not in sys.path:
            sys.path.insert(0, sp)


class Speaker:
    """Owner voice profile: gate wake on a match + learn the owner's voice online."""

    def __init__(self):
        import numpy as np
        self.np = np
        self.encoder = None
        self.mean = None
        self.embeds = []
        self.thresh = float(SPEAKER_THRESH_OVR) if SPEAKER_THRESH_OVR else 0.75
        self._load()

    def _load(self):
        try:
            with open(PROFILE_PATH) as f:
                p = json.load(f)
            self.mean = self.np.asarray(p["mean"], dtype=float) if p.get("mean") else None
            self.embeds = [self.np.asarray(e, dtype=float) for e in p.get("embeds", [])]
            if not SPEAKER_THRESH_OVR and p.get("threshold"):
                self.thresh = float(p["threshold"])
            derr("speaker profile loaded: %d samples, thresh %.3f" % (len(self.embeds), self.thresh))
        except Exception:
            self.mean, self.embeds = None, []

    def _enc(self):
        if self.encoder is None:
            _add_voiceid_path()
            from resemblyzer import VoiceEncoder
            self.encoder = VoiceEncoder(verbose=False)
            derr("voice encoder loaded")
        return self.encoder

    def embed(self, pcm_i16):
        try:
            _add_voiceid_path()
            from resemblyzer import preprocess_wav
            wav = pcm_i16.astype(self.np.float32) / 32768.0
            wav = preprocess_wav(wav, source_sr=SR)
            if wav.size < SR * 0.5:                       # too short to be reliable
                return None
            e = self._enc().embed_utterance(wav)
            return e / (self.np.linalg.norm(e) + 1e-9)
        except Exception as ex:
            derr("embed err:", ex)
            return None

    @property
    def n(self):
        return len(self.embeds)

    def verify(self, pcm_i16):
        """(matched, score, emb). Fail-OPEN on error and during bootstrap so it never goes deaf."""
        emb = self.embed(pcm_i16)
        if emb is None:
            return (True, 0.0, None)                      # can't tell → don't block
        if self.mean is None or self.n < BOOTSTRAP_MIN:
            return (True, 1.0, emb)                       # bootstrapping → accept + seed
        score = float(emb @ self.mean)
        if self.embeds:
            E = self.np.stack(self.embeds)
            E = E / (self.np.linalg.norm(E, axis=1, keepdims=True) + 1e-9)
            score = max(score, float((E @ emb).max()))
        return (score >= self.thresh, score, emb)

    def adapt(self, emb, score):
        # Learn from a confirmed-owner wake. During bootstrap accept all; after, only clear matches
        # (above threshold + margin) so a borderline/false accept can't slowly poison the profile.
        if emb is None or not SPEAKER_ADAPT:
            return
        if self.mean is not None and self.n >= BOOTSTRAP_MIN and score < self.thresh + ADAPT_STRONG_MARGIN:
            return
        self.embeds.append(emb)
        self.embeds = self.embeds[-60:]
        E = self.np.stack(self.embeds)
        self.mean = E.mean(axis=0)
        self.mean = self.mean / (self.np.linalg.norm(self.mean) + 1e-9)
        self._save()
        derr("adapted profile → %d samples" % self.n)

    def _save(self):
        try:
            p = {}
            try:
                with open(PROFILE_PATH) as f:
                    p = json.load(f)
            except Exception:
                p = {}
            p["mean"] = self.mean.tolist()
            p["embeds"] = [e.tolist() for e in self.embeds]
            p["n_samples"] = self.n
            p.setdefault("threshold", self.thresh)
            p.setdefault("model", "resemblyzer-voiceencoder")
            p.setdefault("name", "Siddhant")
            p["updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            os.makedirs(os.path.dirname(PROFILE_PATH), exist_ok=True)
            tmp = PROFILE_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(p, f)
            os.replace(tmp, PROFILE_PATH)
        except Exception as ex:
            derr("profile save err:", ex)


# In-vocab homophones for "hey bhatbot" (Vosk small can't say "bhatbot").
BHATBOT_PHRASES = ["hey bought bot", "hey but bot", "bought bot", "but bot"]
JARVIS_PHRASES = ["hey jarvis", "jarvis"]
MATCH_PHRASES = ["hey bought bot", "hey but bot", "bought bot", "but bot", "hey jarvis", "jarvis"]
VOSK_GRAMMAR = json.dumps(BHATBOT_PHRASES + JARVIS_PHRASES + ["[unk]"])


def _resolve_device(np_mod):
    if not MIC_DEVICE:
        return None
    if MIC_DEVICE.isdigit():
        return int(MIC_DEVICE)
    return MIC_DEVICE  # sounddevice matches a substring of the device name


def main():
    try:
        import sounddevice as sd
    except Exception as e:
        print("WAKE_ERR import sounddevice:", e, file=sys.stderr, flush=True)
        return 1
    import numpy as np

    use_oww = "oww" in ENGINES
    use_vosk = "vosk" in ENGINES

    oww = None
    if use_oww:
        try:
            from openwakeword.model import Model as OWW
            import openwakeword
            base = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
            jarvis = glob.glob(os.path.join(base, "hey_jarvis*.onnx"))
            oww = OWW(wakeword_models=jarvis, inference_framework="onnx") if jarvis else OWW()
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

    # Speaker gate: "1" force on, "0" force off, "auto" → on (verify() fail-opens if resemblyzer
    # is missing, so "auto" is safe: it gates when it can, never goes deaf when it can't).
    speaker = None
    if SPEAKER_GATE != "0":
        try:
            speaker = Speaker()
            derr("speaker gating: ON (%s)" % SPEAKER_GATE)
        except Exception as e:
            derr("speaker init failed, gating off:", e)
            speaker = None

    q = queue.Queue()

    def cb(indata, frames, t, status):
        q.put(bytes(indata))

    last_wake = 0.0
    last_barge = 0.0
    voiced_frames = 0
    # Rolling ~2s utterance buffer for speaker embedding on a wake/barge candidate.
    utt = collections.deque(maxlen=int(SR * UTT_SECONDS))

    if BARGE:
        threading.Thread(target=_stdin_reader, daemon=True).start()
        derr("barge-in armed (thresh=%.3f frames=%d)" % (BARGE_THRESH, BARGE_FRAMES))

    def owner_speaking():
        """True if the buffered utterance is Siddhant (or gating unavailable). Learns on a match."""
        if speaker is None:
            return True
        try:
            buf = np.array(utt, dtype=np.int16)
            matched, score, emb = speaker.verify(buf)
            if matched:
                speaker.adapt(emb, score)
            else:
                derr("rejected non-owner voice (score=%.3f < %.3f)" % (score, speaker.thresh))
            return matched
        except Exception as ex:
            derr("verify err (fail-open):", ex)
            return True

    def fire(why):
        nonlocal last_wake
        now = time.time()
        if now - last_wake < DEBOUNCE:
            return
        if _wake_muted or now < _wake_mute_grace_until:
            derr("WAKE suppressed (self-name) via", why)
            return
        if not owner_speaking():                          # only Siddhant's voice wakes it
            return
        last_wake = now
        derr("WAKE via", why)
        print("WAKE", flush=True)

    dev = _resolve_device(np)
    print("READY", flush=True)
    with sd.RawInputStream(samplerate=16000, blocksize=1280, dtype="int16",
                           channels=1, device=dev, callback=cb):
        while True:
            data = q.get()
            pcm = np.frombuffer(data, dtype=np.int16)
            utt.extend(pcm.tolist())
            if BARGE and _tts_active:
                rms = float(np.sqrt(np.mean((pcm.astype(np.float32) / 32768.0) ** 2))) if pcm.size else 0.0
                if rms >= BARGE_THRESH:
                    voiced_frames += 1
                    if voiced_frames >= BARGE_FRAMES and (time.time() - last_barge) > 1.0:
                        voiced_frames = 0
                        if owner_speaking():             # only the owner's voice interrupts BhatBot
                            last_barge = time.time()
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
