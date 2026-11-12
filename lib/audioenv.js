'use strict';
// ── WHAT IS THE COMPUTER ITSELF DOING WITH SOUND? ────────────────────────────────────────────────
//
// A microphone cannot tell a person from a loudspeaker. A YouTube video, a podcast, the far end of a
// Zoom call and Siddhant all arrive as the same thing: speech. Voice ID answers "whose voice", which
// helps — but the cheapest and most reliable question was never being asked at all: IS THIS MACHINE
// PLAYING AUDIO RIGHT NOW, AND CAN THE MICROPHONE HEAR IT?
//
// macOS answers both without any special permission. While anything is playing, coreaudiod holds a
// power assertion that names the output device:
//
//     pid 420(coreaudiod): … PreventUserIdleSystemSleep named:
//         "com.apple.audio.BuiltInSpeakerDevice.context.preventuseridlesleep"
//         Resources: audio-out BuiltInSpeakerDevice
//
// and holds nothing when the machine is silent. The device name is the half that matters. Audio from
// the BUILT-IN SPEAKERS is in the room, so the mic hears it and speech-shaped sound may well be the
// computer talking to itself. Audio going to headphones or AirPods is not in the room at all, so
// whatever the mic picked up cannot have been the media — and treating that case as suspicious would
// make BhatBot hard of hearing every time he has music on in his ears.
//
// This is a PRIOR, never a verdict. It cannot say the speech WAS the speakers, only that it could
// have been; lib/addressee.js weighs it against whose voice it was and what was said.
//
// Pure apart from the injected `exec`, so the parser is testable against captured pmset output.

/** Devices whose sound is in the room with the microphone. Anything else is assumed private. */
const AUDIBLE = /builtinspeaker|built-in|displayaudio|hdmi|airplay|external ?speaker|usb ?audio|studio ?display/i;
/** Devices that put sound in his ears and nowhere else. */
const PRIVATE = /headphone|airpods|beats|bluetooth|headset|earbuds|earphone/i;

/**
 * parse(pmsetOutput) → { playing, devices, audible, private }
 * `audible` is the question the caller actually has: could the microphone be hearing this machine?
 */
function parse(text) {
  const t = String(text || '');
  const devices = [];
  // The `Resources:` line is authoritative when present; the assertion NAME is the fallback, because
  // some macOS builds print the name and omit the resources line.
  for (const m of t.matchAll(/Resources:\s*([^\n]*)/g)) {
    for (const part of m[1].split(/\s{2,}|,/)) {
      const mm = /audio-out\s+(\S+)/.exec(part.trim());
      if (mm && !devices.includes(mm[1])) devices.push(mm[1]);
    }
  }
  for (const m of t.matchAll(/com\.apple\.audio\.([A-Za-z0-9_-]+?)\.context\.preventuseridlesleep/g)) {
    if (!devices.includes(m[1])) devices.push(m[1]);
  }
  const playing = devices.length > 0;
  // An output device we do not recognise is treated as AUDIBLE. Guessing "private" for an unknown
  // device is the unsafe direction — it would switch the protection off for exactly the speaker we
  // have never seen before.
  const priv = playing && devices.every((d) => PRIVATE.test(d) && !AUDIBLE.test(d));
  return { playing, devices, audible: playing && !priv, private: priv };
}

/**
 * createAudioEnv({ exec, now, ttlMs }) → { sample(), parse }
 * `exec` returns the text of `pmset -g assertions`. Cached briefly: this is asked once per utterance
 * and forking pmset more often than the answer can change is wasted work on the voice path.
 */
function createAudioEnv(deps = {}) {
  const exec = deps.exec;
  const now = deps.now || (() => Date.now());
  const ttlMs = Number(deps.ttlMs) >= 0 ? Number(deps.ttlMs) : 1500;
  let last = null, lastAt = -Infinity;
  function sample() {
    const t = now();
    if (last && t - lastAt < ttlMs) return last;
    let out = null;
    try { out = exec ? exec() : null; } catch { out = null; }
    // Unknown is not "silent". If the probe fails, say so and let the caller decline to use it —
    // reporting `playing: false` on an error would quietly assert something nobody measured.
    last = out == null ? { playing: null, devices: [], audible: null, private: null, unknown: true } : parse(out);
    lastAt = t;
    return last;
  }
  return { sample, parse };
}

module.exports = { createAudioEnv, parse, AUDIBLE, PRIVATE };
