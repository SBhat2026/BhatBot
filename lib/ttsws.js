'use strict';
// Continuous WebSocket streaming TTS transport (JARVIS sprint T1).
//
// WHY: the legacy desktop path synthesizes ONE ElevenLabs REST POST per sentence, writes an mp3
// to /tmp, and spawns a fresh `afplay` per file. Every sentence boundary therefore costs an HTTP
// round-trip + file write + process spawn — that is the "pauses too long between sentences"
// complaint. It is transport seams, not prosody.
//
// FIX: open ONE ElevenLabs `stream-input` websocket per turn and stream text into it as it is
// generated; pipe the returned PCM straight into ONE long-lived player process (ffplay or sox)
// via stdin. No tmp files, no per-sentence spawns, no inter-sentence gap — the audio plays as one
// continuous utterance.
//
// Pure + DI: every side-effecting dependency (WebSocket ctor, spawn, which-probe, config, log,
// latency-marker) is injected, so the whole lifecycle is unit-testable with mocks and nothing here
// imports Electron/fs. main.js supplies the real deps and gates it behind config.ttsTransport==='ws'.

// Probe for a raw-PCM player. ffplay (ffmpeg) is preferred; sox `play` is the fallback. Returns a
// spawn spec {bin,args} or null if neither is installed (caller then stays on the REST path).
//
// THE PROBE AND THE SPAWN MUST AGREE ON WHERE THE BINARY IS. They did not: `which` looked ffplay up
// with /opt/homebrew/bin appended to PATH and answered "yes", and then spawn('ffplay') ran with the
// app's own PATH — which, for an Electron launched from Finder, does not contain Homebrew. So the
// transport reported itself available, was chosen for every spoken reply, and died with
// `spawn ffplay ENOENT`. The reply was on screen and nothing was ever said. `which` may therefore
// return the ABSOLUTE PATH it found, and that path is what gets spawned; a bare `true` still works
// for callers (and tests) that only know the binary exists.
function detectPlayer(which, sampleRate) {
  const sr = String(sampleRate || 24000);
  const at = (name) => { const w = which(name); return w ? (typeof w === 'string' ? w : name) : null; };
  let bin;
  if ((bin = at('ffplay'))) {
    return { bin, args: ['-autoexit', '-nodisp', '-loglevel', 'quiet', '-f', 's16le', '-ar', sr, '-ch_layout', 'mono', '-i', 'pipe:0'] };
  }
  if ((bin = at('play'))) { // sox
    return { bin, args: ['-q', '-t', 'raw', '-r', sr, '-e', 'signed', '-b', '16', '-c', '1', '-', '-t', 'coreaudio'] };
  }
  if ((bin = at('sox'))) {
    return { bin, args: ['-q', '-t', 'raw', '-r', sr, '-e', 'signed', '-b', '16', '-c', '1', '-', '-d'] };
  }
  return null;
}

// Factory. deps: { WebSocket, spawn, which, getConfig, log, latMark, onWakeMute }.
//  - WebSocket: `ws` constructor (url, { headers }).
//  - spawn: child_process.spawn.
//  - which: (bin) => absolute path | bool  (where this binary is; a path is what gets spawned).
//  - env: optional environment for the player process (the same PATH the probe searched).
//  - getConfig: () => config object.
//  - log/latMark: optional instrumentation.
//  - onWakeMute: (on:boolean) => void  — suppress the wake word while our own "Jarvis" plays.
// Returns { available(), create(seq) }.
function createTtsWs(deps) {
  const { WebSocket, spawn, which } = deps;
  const getConfig = deps.getConfig || (() => ({}));
  const log = deps.log || (() => {});
  const latMark = deps.latMark || (() => {});
  const onWakeMute = deps.onWakeMute || (() => {});
  const WAKE_RE = /\b(jarvis|bhat[\s-]?bot)\b/i;

  // Is the transport usable at all right now? (keys + a player present)
  function available() {
    const c = getConfig();
    if (!c.elevenLabsKey) return false;
    return !!detectPlayer(which, 24000);
  }

  // One streaming session, scoped to a turn `seq`. Lazily opens the ws + player on first feed().
  function create(seq) {
    const c = getConfig();
    const sampleRate = 24000;
    const voiceId = c.ttsVoice || c.elevenLabsVoiceId || 'pNInz6obpgDQGcFmaJgB';
    const model = c.ttsModel || 'eleven_flash_v2_5';
    const playerSpec = detectPlayer(which, sampleRate);

    let ws = null, player = null, opened = false, closed = false, eosSent = false;
    let firstAudio = false, sawName = false, drained = false;
    let firstAudioCb = null, drainedCb = null;
    const pending = [];            // text queued before the ws finished opening

    // ── FAILING OUT LOUD ───────────────────────────────────────────────────────────────────────────
    //
    // Every failure here used to be a log line and nothing else: a dead player, a rejected key, a ws
    // that never produced a frame. The turn's text had already been handed to this transport, so
    // nobody else was going to speak it, and because `drained` only fires after an EOS that a dead
    // player never acknowledges, the mic was never re-armed either — one silent reply and then a
    // conversation that would not continue.
    //
    // So the session remembers everything it was fed, and if it fails BEFORE any audio reached the
    // speaker it hands that text back to the caller, who can say it some other way. After the first
    // audio there is no telling how much was heard, and repeating a half-spoken sentence is worse than
    // losing its tail, so a late failure just drains.
    const fedText = [];
    let failed = false, failedCb = null, watchdog = null;
    const env = deps.env || undefined;
    const firstAudioTimeoutMs = Number(deps.firstAudioTimeoutMs) > 0 ? Number(deps.firstAudioTimeoutMs) : 4000;
    const setTimer = deps.setTimeout || setTimeout, clearTimer = deps.clearTimeout || clearTimeout;
    function fail(why) {
      if (failed || closed || drained) return;
      if (watchdog) { try { clearTimer(watchdog); } catch {} watchdog = null; }
      log('[ttsws] ' + why + (firstAudio ? ' (mid-stream; draining)' : ' — handing the text back'));
      if (firstAudio) {                       // some of it was heard: do not repeat, just release
        closed = true;
        try { if (ws) ws.close(); } catch {}
        killPlayer();
        fireDrained();
        return;
      }
      failed = true; closed = true;
      try { if (ws) ws.close(); } catch {}
      killPlayer();
      if (sawName) onWakeMute(false);
      // NOT fireDrained(): draining tells the app "speech is over, open the mic", and the whole point
      // is that somebody is about to speak this text another way. If nobody is listening for the
      // failure, though, releasing the turn is the only safe thing left.
      const text = fedText.join('');
      if (failedCb) { try { failedCb(text, why, { eosSent }); } catch {} }
      else fireDrained();
    }

    function fireDrained() {
      if (drained) return; drained = true;
      if (sawName) onWakeMute(false);
      try { drainedCb && drainedCb(); } catch {}
    }
    function killPlayer() {
      if (player) { try { player.stdin.end(); } catch {} try { player.kill(); } catch {} player = null; }
    }

    function openWs() {
      if (opened || closed) return;
      opened = true;
      if (!playerSpec) { fail('no PCM player (ffplay/sox); cannot open'); return; }
      const qs = `model_id=${encodeURIComponent(model)}&output_format=pcm_${sampleRate}&auto_mode=true`;
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?${qs}`;
      latMark('tts-ws-open');
      try {
        ws = new WebSocket(url, { headers: { 'xi-api-key': c.elevenLabsKey } });
      } catch (e) { fail('ws ctor failed: ' + e.message); return; }

      // Start the player process now; PCM chunks stream straight into its stdin.
      try {
        player = spawn(playerSpec.bin, playerSpec.args, { stdio: ['pipe', 'ignore', 'ignore'], ...(env ? { env } : {}) });
        player.on('error', (e) => { fail('player error: ' + e.message); });
        player.on('close', () => { if (eosSent) fireDrained(); });   // player exited after final audio
        if (player.stdin) player.stdin.on('error', () => {});         // ignore EPIPE on interrupt
      } catch (e) { fail('player spawn failed: ' + e.message); return; }

      ws.on('open', () => {
        // BOS: voice settings + generation config, then flush anything buffered during connect.
        const bos = { text: ' ', voice_settings: c.jarvisVoiceSettings || deps.voiceSettings || {}, xi_api_key: c.elevenLabsKey };
        try { ws.send(JSON.stringify(bos)); } catch {}
        for (const t of pending.splice(0)) sendText(t);
        if (eosSent) try { ws.send(JSON.stringify({ text: '' })); } catch {}
      });
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.audio) {
          if (!firstAudio) {
            firstAudio = true; latMark('tts-first-audio');
            if (watchdog) { try { clearTimer(watchdog); } catch {} watchdog = null; }
            try { firstAudioCb && firstAudioCb(); } catch {}
          }
          const buf = Buffer.from(msg.audio, 'base64');
          if (player && player.stdin && player.stdin.writable) { try { player.stdin.write(buf); } catch {} }
        }
        if (msg.isFinal) { try { if (player && player.stdin) player.stdin.end(); } catch {} }   // no more audio; let player drain + exit
      });
      ws.on('error', (e) => { fail('ws error: ' + (e && e.message)); });
      ws.on('close', () => {
        // A close with text sent and not one frame of audio back is a failure, whatever the code was —
        // a rejected key and an exhausted quota both look exactly like this.
        if (!firstAudio && !closed && fedText.length) { fail('ws closed before any audio'); return; }
        if (eosSent) { try { if (player && player.stdin) player.stdin.end(); } catch {} }
      });
      // And the case with no event at all: connected, accepted the text, said nothing.
      watchdog = setTimer(() => { watchdog = null; if (!firstAudio && fedText.length) fail(`no audio after ${firstAudioTimeoutMs}ms`); }, firstAudioTimeoutMs);
      if (watchdog && watchdog.unref) watchdog.unref();
    }

    function sendText(t) {
      const s = String(t || '');
      if (!s) return;
      if (WAKE_RE.test(s) && !sawName) { sawName = true; onWakeMute(true); }   // our own "Jarvis" must not self-wake
      if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ text: s })); } catch {} }
      else pending.push(s);
    }

    return {
      // Stream text in. Opens the ws/player on first call.
      feed(text) {
        if (closed || drained) return;
        const t = String(text || '');
        if (t) fedText.push(t);
        if (!opened) openWs();
        if (failed) return;                // openWs can fail synchronously; the text is already handed back
        sendText(text);
      },
      // End of turn — send EOS so ElevenLabs flushes the tail, then the player drains and exits.
      flush() {
        if (closed) { fireDrained(); return; }
        eosSent = true;
        if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ text: '' })); } catch {} }
        else if (!opened) fireDrained();   // nothing was ever fed → release immediately
      },
      // Barge-in / new turn — tear everything down instantly.
      close() {
        if (closed) return; closed = true;
        if (watchdog) { try { clearTimer(watchdog); } catch {} watchdog = null; }
        try { if (ws) ws.close(); } catch {}
        killPlayer();
        fireDrained();
      },
      onFirstAudio(cb) { firstAudioCb = cb; if (firstAudio) try { cb(); } catch {} },
      onDrained(cb) { drainedCb = cb; if (drained) try { cb(); } catch {} },
      // cb(text, why, { eosSent }) — fires at most once, only when the transport died before any audio.
      onFailed(cb) { failedCb = cb; },
      get failed() { return failed; },
      get seq() { return seq; },
    };
  }

  return { available, create, _detectPlayer: () => detectPlayer(which, 24000) };
}

module.exports = { createTtsWs, detectPlayer };
