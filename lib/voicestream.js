'use strict';
const { createEndpointer } = require('./endpoint');   // T3 — shared learned endpointing (phone parity)
// Twilio Media Streams — real-time bidirectional phone audio over a single WebSocket. Gives
// sub-second turn-taking the Gather/poll HTTP path can't: WE own end-of-utterance detection (our
// VAD, ~700ms) instead of Twilio's <Gather speechTimeout>, and there are no TwiML round-trips.
//
// OPT-IN via config.voice.mediaStreams === true; the proven Gather path stays the default so the
// working phone setup is never at risk.
//
// Per call:
//   Twilio --(<Connect><Stream>)--> ws  →  {event:'start'|'media'|'mark'|'stop'}
//   inbound  μ-law 8kHz frames → energy VAD → utterance → transcribe (Whisper) → voiceBegin/voicePoll
//   outbound ElevenLabs ulaw_8000 → 160-byte (20ms) frames → {event:'media'}; a {event:'mark'}
//            after each spoken segment tells us playback finished (speaking→listening).
//   barge-in sustained inbound speech while the bot talks → {event:'clear'} (flush) + capture.
//
// Reuses the SAME two-tier engine as the Gather path (voiceBegin/voicePoll) — ElevenLabs voice only.
//
// DI: ctx = { transcribe(buf,mime)->{text}, synthUlaw(text,opts)->{ulaw:Buffer}, voiceBegin,
//             voicePoll, log }

module.exports = function makeVoiceStream(ctx = {}) {
  const { transcribe, synthUlaw, voiceBegin, voicePoll, log = () => {} } = ctx;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- G.711 μ-law (8-bit) → linear PCM16, table-free standard formula ---
  const BIAS = 0x84;
  function ulawByteToPcm(u) {
    u = ~u & 0xff;
    let t = ((u & 0x0f) << 3) + BIAS;
    t <<= (u & 0x70) >> 4;
    return (u & 0x80) ? (BIAS - t) : (t - BIAS);
  }
  function frameAvgAbs(buf) { let s = 0; for (let i = 0; i < buf.length; i++) s += Math.abs(ulawByteToPcm(buf[i])); return buf.length ? s / buf.length : 0; }
  // μ-law buffer → 8kHz mono 16-bit WAV (what the Whisper STT endpoint wants).
  function ulawToWav(buf) {
    const n = buf.length, dataLen = n * 2, out = Buffer.alloc(44 + dataLen);
    out.write('RIFF', 0); out.writeUInt32LE(36 + dataLen, 4); out.write('WAVE', 8);
    out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
    out.writeUInt32LE(8000, 24); out.writeUInt32LE(16000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
    out.write('data', 36); out.writeUInt32LE(dataLen, 40);
    for (let i = 0; i < n; i++) out.writeInt16LE(ulawByteToPcm(buf[i]), 44 + i * 2);
    return out;
  }

  // Tunables (config.voice.* overrides applied by caller before constructing if desired).
  const FRAME_MS = 20;            // Twilio sends ~20ms μ-law frames
  const ENERGY_THRESH = 520;      // avg|amplitude| over a frame above which we call it speech
  // T3 parity: end-of-utterance silence is now the LEARNED per-user threshold (seeded from the shared
  // endpoint.json pauses the caller passes as ctx.pauses), clamped to a phone-appropriate range so it
  // stays snappy on a call. Falls back to 700ms when nothing's been learned.
  const phoneEndpointer = createEndpointer({ pauses: ctx.pauses, floorMs: 500, ceilMs: 2000, defaultMs: ctx.silenceEndMs || 700 });
  const silenceEnd = () => phoneEndpointer.threshold();
  const MIN_SPEECH_MS = 240;      // ignore sub-blips (coughs/clicks)
  const MAX_UTTER_MS = 15000;     // hard cap on a single utterance
  const BARGE_MS = 320;           // sustained speech during playback → barge-in

  // Handle one Twilio Media Stream WebSocket for the lifetime of a call.
  function handle(ws, opts = {}) {
    let streamSid = null, callSid = opts.callSid || null;
    // Two top-level states: 'listening' (capturing the caller) and 'busy' (bot thinking/speaking;
    // barge-in is the only way the caller takes the floor back).
    let state = 'busy';
    let utter = [], speechMs = 0, silenceMs = 0, capturing = false, bargeMs = 0;
    let markCount = 0, closed = false;
    const pendingMarks = new Set();   // marks we've sent but Twilio hasn't echoed → audio still playing

    const send = (o) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch {} };
    const resetUtter = () => { utter = []; speechMs = 0; silenceMs = 0; capturing = false; };
    const endCall = () => { send({ event: 'clear', streamSid }); closed = true; try { ws.close(); } catch {} };

    // Speak a line: synthesize μ-law, stream it as 20ms media frames, then a mark to track playback.
    async function speak(text) {
      const t = String(text || '').trim();
      if (!t || closed) return;
      const r = await synthUlaw(t).catch((e) => ({ error: e.message }));
      if (!r || !r.ulaw) { log('[stream] synth failed: ' + (r && r.error)); return; }
      for (let i = 0; i < r.ulaw.length && !closed; i += 160) {
        send({ event: 'media', streamSid, media: { payload: r.ulaw.slice(i, i + 160).toString('base64') } });
      }
      const name = 'm' + (++markCount); pendingMarks.add(name);
      send({ event: 'mark', streamSid, mark: { name } });
    }
    // Wait until Twilio has played out everything we sent (all marks echoed) or we time out / get
    // barged. Keeps us from re-opening the mic while the bot's last words are still playing.
    async function drainPlayback(timeoutMs = 12000) {
      const t0 = Date.now();
      while (pendingMarks.size && !closed && state === 'busy' && Date.now() - t0 < timeoutMs) await sleep(60);
    }

    // Drive one user turn through the existing two-tier engine, then reopen the mic.
    async function runTurn(text) {
      try {
        if (!voiceBegin) { await speak('Voice agent unavailable.'); return; }
        let b; try { b = await voiceBegin(callSid, text); } catch (e) { log('[stream] begin err ' + e.message); return; }
        if (b.mode === 'reply') { await speak(b.text); if (b.hangup) { await drainPlayback(); return endCall(); } return; }
        if (b.filler) await speak(b.filler);
        let done = false, guard = 0;
        while (!done && !closed && state === 'busy' && guard++ < 120) {
          let p; try { p = voicePoll(callSid); } catch { p = { ready: true, text: '', more: false }; }
          if (p.ready) { if (p.text) await speak(p.text); if (!p.more) done = true; }
          else { if (p.filler) await speak(p.filler); await sleep(700); }
        }
      } finally {
        await drainPlayback();
        if (state === 'busy') { state = 'listening'; resetUtter(); }   // barge-in may have already flipped us
      }
    }

    async function finalizeUtterance() {
      const raw = Buffer.concat(utter); resetUtter();
      const tr = await transcribe(ulawToWav(raw), 'audio/wav').catch(() => ({}));
      const text = (tr && tr.text || '').trim();
      if (!text) { state = 'listening'; return; }
      log('[stream] heard: ' + text);
      await runTurn(text);
    }

    ws.on('message', async (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }

      if (m.event === 'start') {
        streamSid = m.start && m.start.streamSid;
        callSid = (m.start && (m.start.callSid || (m.start.customParameters && m.start.customParameters.callSid))) || callSid;
        log('[stream] start call=' + callSid + ' stream=' + streamSid);
        state = 'busy';
        try { const g = voiceBegin ? await voiceBegin(callSid, '') : { text: 'Yes, sir?' }; await speak(g.text || g.filler || 'Yes, sir?'); } catch {}
        await drainPlayback(); state = 'listening'; resetUtter();
        return;
      }

      if (m.event === 'media' && m.media && m.media.payload) {
        const buf = Buffer.from(m.media.payload, 'base64');
        const voiced = frameAvgAbs(buf) > ENERGY_THRESH;

        if (state === 'busy') {
          // Barge-in: sustained speech while the bot holds the floor → flush its queued audio and
          // hand the floor back, seeding the new utterance with these frames.
          if (voiced) {
            bargeMs += FRAME_MS;
            if (bargeMs >= BARGE_MS) { send({ event: 'clear', streamSid }); pendingMarks.clear(); bargeMs = 0; state = 'listening'; resetUtter(); capturing = true; utter.push(buf); speechMs = FRAME_MS; }
          } else bargeMs = 0;
          return;
        }

        // listening — VAD capture
        if (voiced) {
          capturing = true; utter.push(buf); speechMs += FRAME_MS; silenceMs = 0;
          if (speechMs >= MAX_UTTER_MS) { state = 'busy'; finalizeUtterance(); }
        } else if (capturing) {
          utter.push(buf); silenceMs += FRAME_MS;
          if (silenceMs >= silenceEnd()) {
            if (speechMs >= MIN_SPEECH_MS) { state = 'busy'; finalizeUtterance(); }
            else resetUtter();
          }
        }
        return;
      }

      if (m.event === 'mark') { if (m.mark && m.mark.name) pendingMarks.delete(m.mark.name); return; }
      if (m.event === 'stop') { endCall(); return; }
    });

    ws.on('close', () => { closed = true; if (callSid && ctx.onEnd) try { ctx.onEnd(callSid); } catch {} });
    ws.on('error', () => { closed = true; });
  }

  return { handle, _ulawByteToPcm: ulawByteToPcm, _ulawToWav: ulawToWav, _silenceEnd: silenceEnd, _endpointer: phoneEndpointer };
};
