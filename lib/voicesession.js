'use strict';
// ── THE VOICE SESSION ─────────────────────────────────────────────────────────────────────────────
// What state a spoken conversation is in, what may legally happen next, and which register the
// butler speaks in at that moment.
//
// THE TARGET, stated as a mechanism rather than a vibe: tap once to open, then continuous open mic
// with server-side turn detection — no wake word per utterance — barge-in that cuts playback the
// instant you speak, context that carries across turns, and a visible four-state affordance
// (idle / listening / thinking / speaking). The session ends when you end it, not when the model
// decides you are finished.
//
// WHAT WAS ALREADY HERE. Nearly every mechanism: continuous listening (97cf27a), barge-in with the
// TTS tail killed, adaptive+learned endpointing (lib/endpoint.js), a Web-Audio VAD gate, one-socket
// streaming TTS (lib/ttsws.js), a voice-ID cocktail-party filter, wake-word self-mute while it
// speaks, and the `tts-idle` → mic re-arm contract. What was missing is the thing that OWNS them: a
// "conversation" was an emergent property of timers, a 30-second silence note and stop-phrase
// matching. There was no object to ask "are we in a session?", so nothing could answer it.
//
// THREE THINGS FALL OUT OF HAVING THE OBJECT AT ALL:
//
//   1. THE WAKE WORD IS ONLY NEEDED TO ENTER. `closed → listening` requires it (or a tap); every
//      transition inside the session does not. This is the single biggest felt difference from what
//      is there now, and it is one line of policy rather than a new subsystem.
//
//   2. `tts-idle` BECOMES CHECKABLE. main.js carries an [[invariant]] comment: tts-idle MUST fire
//      every turn or hands-free conversation wedges. A comment cannot be tested. Here, `speaking`
//      only leaves through `ttsIdle()` or `bargeIn()`, and `wedged(now)` reports a session that has
//      been speaking with no audio and no idle for longer than it should — so the failure mode that
//      used to be silent has a name and a watchdog can act on it.
//
//   3. REGISTER BECOMES A FUNCTION OF STATE. A butler does not greet you twice in one conversation,
//      does not re-introduce himself after you interrupt him, and does not sign off mid-errand. The
//      persona in lib/static-prompt.js is written for a REPLY; this is the part that is written for
//      a CONVERSATION, and it is the half that was missing. See REGISTERS below.
//
// Pure + DI: no timers of its own (the caller owns cadence and passes `now`), no audio, no Electron.
// Every effect — killing playback, muting the wake word, speaking a line — is an injected callback,
// so the whole machine is testable without a microphone. See scripts/test-voicesession.js.

// ── states ────────────────────────────────────────────────────────────────────────────────────────
const CLOSED = 'closed';
const LISTENING = 'listening';
const THINKING = 'thinking';
const SPEAKING = 'speaking';
const STATES = [CLOSED, LISTENING, THINKING, SPEAKING];

// The legal graph. Anything not listed is a bug in the caller, and `can()` lets the caller ask
// before it acts rather than discovering it by corrupting the session.
const TRANSITIONS = {
  [CLOSED]: { open: LISTENING },
  [LISTENING]: { endpoint: THINKING, close: CLOSED, timeout: CLOSED },
  [THINKING]: { firstAudio: SPEAKING, silentTurn: LISTENING, close: CLOSED, abort: LISTENING },
  // `ttsIdle` is the normal re-arm; `bargeIn` is the user talking over the top. Both land on
  // listening — the difference is what the caller must kill on the way, and what gets said next.
  [SPEAKING]: { ttsIdle: LISTENING, bargeIn: LISTENING, close: CLOSED, abort: LISTENING },
};

const DEFAULTS = {
  // How long a session stays open with nobody saying anything. Long enough that a pause to think is
  // not a dismissal, short enough that an abandoned session does not hold the mic all afternoon.
  idleCloseMs: 120000,
  // A gentle "still there?" partway through that window, once, rather than silently timing out.
  idleNudgeMs: 75000,
  // `speaking` with no audio progress for this long means the tts-idle contract was broken upstream.
  wedgeMs: 45000,
  // Barge-in needs a floor: a cough should not cut the butler off mid-sentence.
  bargeInMinMs: 220,
};

// ── the spoken register ───────────────────────────────────────────────────────────────────────────
// Deterministic lines, not model calls: zero cost, zero latency, and — the practical reason — they
// can be PRE-RENDERED to audio the way `~/.bhatbot/voice/acks` already is, so the first sound after
// you speak is instant rather than a synth round trip.
//
// The register is the point. A butler's conversational competence is mostly about what he does NOT
// say: he greets you once, he does not narrate, he does not re-introduce himself after being cut
// off, and he answers an interruption with an attentive half-beat rather than an apology. Each list
// below is a MOMENT in a conversation, and the lines are written for the ear — short, stressed on
// the last word, no clause that needs punctuation to parse.
const REGISTERS = {
  // Opening a session. Used once, then never again until it closes.
  greet: ['Sir.', 'Yes, sir?', 'At your service.', 'Listening, sir.', 'Go ahead, sir.'],
  // Opening again soon after a session closed — he knows he was just here.
  greetAgain: ['Still here, sir.', 'Back again, sir?', 'Yes, sir.', 'Go on.'],
  // Acknowledging a request before the work starts. The ack library already renders these.
  ack: ['Right away, sir.', 'On it.', 'Of course, sir.', 'Consider it done.', 'Very good, sir.'],
  // A longer job — said once, not repeatedly, and honest about the wait.
  working: ['A moment, sir.', 'Working on it.', 'This will take a moment, sir.', 'Bear with me.'],
  // The cascade escalated to the slow path. He says so plainly rather than going quiet.
  escalating: ['This one needs a little longer, sir.', 'Bringing more to bear on this — a moment.',
    'The quick answer would be wrong. Give me a moment, sir.'],
  // The user cut him off. Attentive, unbothered, NOT apologetic — an apology makes the interruption
  // an event, and the whole point is that it is not one.
  bargeIn: ['Sir?', 'Yes?', 'Go on.', 'I\'m listening.'],
  // Mid-session silence, once, before the idle timeout.
  nudge: ['Still here, sir.', 'Take your time.', 'I\'ll wait.'],
  // Closing. Dry, final, no summary.
  close: ['Very good, sir.', 'I\'ll be here.', 'As you wish, sir.', 'Until next time.'],
  // Closing after a job actually got done.
  closeDone: ['Done, sir.', 'All finished.', 'That\'s that, sir.'],
  // Something failed and he is not going to dress it up.
  trouble: ['That did not go to plan, sir.', 'Mildly concerning.', 'That went about as well as expected.'],
};

// Rotate rather than randomise: across one session the lines should not repeat, and across a test
// run they must be predictable. The index is carried on the session, so two sessions do not
// lockstep.
function pickLine(kind, n) {
  const list = REGISTERS[kind];
  if (!list || !list.length) return '';
  return list[Math.abs(n | 0) % list.length];
}

/**
 * createVoiceSession(deps) — one session machine for one surface.
 *
 * deps (all optional, all effects):
 *   now()                     → ms. Injected so tests own the clock.
 *   stopPlayback()            → kill TTS + the player. Called on barge-in and close.
 *   setWakeMute(on)           → suppress the wake word while our own voice plays (already wired in
 *                               lib/ttsws.js, which mutes on hearing itself say "Jarvis").
 *   setWakeRequired(on)       → the payoff: false for the life of a session, true when it closes.
 *   speak(text, {kind})       → say a register line. The caller decides pre-rendered vs live synth.
 *   onState(from, to, why)    → for the UI's four-state affordance.
 *   log(text)
 *   config                    → overrides for DEFAULTS.
 */
function createVoiceSession(deps = {}) {
  const {
    now = () => Date.now(),
    stopPlayback = () => {},
    setWakeMute = () => {},
    setWakeRequired = () => {},
    speak = () => {},
    onState = () => {},
    log = () => {},
    config = {},
  } = deps;

  const cfg = { ...DEFAULTS, ...config };

  let state = CLOSED;
  let s = null;            // the live session, or null when closed
  let lastClosedAt = 0;
  let lineN = 0;

  function fresh(via) {
    return {
      id: 's_' + now().toString(36),
      openedAt: now(),
      via,                       // 'wake' | 'tap' | 'api'
      turns: 0,                  // completed user↔assistant exchanges
      lastVoiceAt: now(),        // last time EITHER party made a sound
      lastUserAt: now(),
      listeningSince: now(),     // when the ear last became free — the idle clock's origin
      speakingSince: 0,
      nudged: false,
      greeted: false,
      bargeIns: 0,
      didWork: false,            // did any turn actually run a tool / produce a result?
      transcript: [],            // {role, text, at} — session-scoped, NOT the chat history
    };
  }

  function go(to, why) {
    const from = state;
    if (from === to) return state;
    state = to;
    // The idle clock starts when the ear becomes free, and ONLY the user can reset it. Measuring
    // "time since any sound" instead let the nudge ("Still here, sir.") restart the countdown it was
    // warning about, so a session could never actually time out — the butler kept himself awake.
    if (to === LISTENING && s) s.listeningSince = now();
    try { onState(from, to, why); } catch {}
    try { log(`[voice] ${from} → ${to} (${why})`); } catch {}
    return state;
  }

  /** Is `event` legal from the current state? Callers should ask rather than guess. */
  function can(event) { return !!(TRANSITIONS[state] && TRANSITIONS[state][event]); }

  // ── the transitions ─────────────────────────────────────────────────────────────────────────────

  /**
   * Open a session. `via` 'wake' | 'tap' | 'api'.
   *
   * THE WAKE-WORD PAYOFF IS HERE: for the life of this session the wake word is no longer required,
   * so the second utterance and the twentieth are the same as the first. That is the difference
   * between dictating to a machine and talking to someone.
   */
  function open({ via = 'tap', silent = false } = {}) {
    if (state !== CLOSED) return { ok: false, reason: 'already open', state };
    s = fresh(via);
    go(LISTENING, `opened by ${via}`);
    try { setWakeRequired(false); } catch {}
    if (!silent) {
      // "Back again, sir?" only if he genuinely was just here — otherwise it reads as a non sequitur.
      const soon = lastClosedAt && (now() - lastClosedAt) < 60000;
      const kind = soon ? 'greetAgain' : 'greet';
      s.greeted = true;
      say(kind);
    }
    return { ok: true, state, session: s.id };
  }

  /** The user started making sound. Inside `speaking` this is a barge-in; elsewhere it is just VAD. */
  function speechStart({ ms = 0 } = {}) {
    if (!s) return { ok: false, reason: 'no session' };
    s.lastVoiceAt = now();
    s.lastUserAt = now();
    s.listeningSince = now();              // the user made a sound — restart the idle clock
    s.nudged = false;                      // they are clearly still here
    if (state === SPEAKING) {
      // A cough is not an interruption. Without this floor the butler is cut off by a chair creak,
      // which reads as flakiness rather than attentiveness.
      if (ms < cfg.bargeInMinMs) return { ok: false, reason: 'below barge-in floor', state };
      return bargeIn();
    }
    return { ok: true, state };
  }

  /** The endpointer decided the user finished. */
  function endpoint({ text = '' } = {}) {
    if (!s) return { ok: false, reason: 'no session' };
    if (!can('endpoint')) return { ok: false, reason: `cannot endpoint from ${state}`, state };
    if (text) s.transcript.push({ role: 'user', text: String(text), at: now() });
    s.lastUserAt = now();
    go(THINKING, 'user finished');
    return { ok: true, state };
  }

  /** First audio of the reply reached the speaker. */
  function firstAudio() {
    if (!s) return { ok: false, reason: 'no session' };
    if (!can('firstAudio')) return { ok: false, reason: `cannot speak from ${state}`, state };
    s.speakingSince = now();
    s.lastVoiceAt = now();
    try { setWakeMute(true); } catch {}    // never self-wake on our own "Jarvis"
    go(SPEAKING, 'first audio');
    return { ok: true, state };
  }

  /**
   * The turn produced no audio at all (a silent action, or TTS disabled). Without this the machine
   * would sit in `thinking` forever waiting for a `firstAudio` that is never coming — which is the
   * wedge, arrived at from the other side.
   */
  function silentTurn() {
    if (!s) return { ok: false, reason: 'no session' };
    if (!can('silentTurn')) return { ok: false, reason: `cannot finish from ${state}`, state };
    s.turns++;
    go(LISTENING, 'turn produced no audio');
    return { ok: true, state };
  }

  /**
   * ⚠ THE INVARIANT. `tts-idle` is what re-arms the microphone; if it does not fire, hands-free
   * conversation wedges and the only symptom is that BhatBot stops listening. main.js documents
   * this in a comment. Here it is the ONLY normal exit from `speaking`, so a test can assert it and
   * `wedged()` can detect its absence at runtime.
   */
  function ttsIdle() {
    if (!s) return { ok: false, reason: 'no session' };
    if (!can('ttsIdle')) return { ok: false, reason: `cannot idle from ${state}`, state };
    s.turns++;
    s.speakingSince = 0;
    s.lastVoiceAt = now();
    try { setWakeMute(false); } catch {}
    go(LISTENING, 'tts idle — mic re-armed');
    return { ok: true, state };
  }

  /** The user talked over the reply. Kill playback NOW; the half-beat acknowledgement comes after. */
  function bargeIn() {
    if (!s) return { ok: false, reason: 'no session' };
    if (!can('bargeIn')) return { ok: false, reason: `cannot barge in from ${state}`, state };
    s.bargeIns++;
    s.speakingSince = 0;
    try { stopPlayback(); } catch {}
    try { setWakeMute(false); } catch {}
    go(LISTENING, 'barge-in');
    say('bargeIn');
    return { ok: true, state, bargeIns: s.bargeIns };
  }

  /** Something went wrong mid-turn. Return to listening rather than stranding the session. */
  function abort(why = 'aborted') {
    if (!s) return { ok: false, reason: 'no session' };
    if (!can('abort')) return { ok: false, reason: `cannot abort from ${state}`, state };
    s.speakingSince = 0;
    try { stopPlayback(); } catch {}
    try { setWakeMute(false); } catch {}
    go(LISTENING, why);
    return { ok: true, state };
  }

  /** Close the session and hand the wake word back. */
  function close({ via = 'user', silent = false } = {}) {
    if (state === CLOSED) return { ok: false, reason: 'already closed' };
    const done = !!(s && s.didWork);
    const turns = s ? s.turns : 0;
    try { stopPlayback(); } catch {}
    try { setWakeMute(false); } catch {}
    try { setWakeRequired(true); } catch {}
    // A sign-off only if he actually said anything. Closing an empty session with "Very good, sir"
    // is the butler answering a door nobody knocked on.
    if (!silent && turns > 0) say(done ? 'closeDone' : 'close');
    lastClosedAt = now();
    go(CLOSED, `closed by ${via}`);
    s = null;
    return { ok: true, state, turns, via };
  }

  // ── time ────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The caller ticks this; the machine owns no timers. Returns what it did, if anything, so a
   * caller can log or surface it.
   */
  function tick(t = now()) {
    if (!s || state === CLOSED) return null;
    // Never time out mid-thought or mid-sentence — only an idle ear closes a session.
    if (state === LISTENING) {
      const quiet = t - (s.listeningSince || s.lastVoiceAt);
      if (quiet >= cfg.idleCloseMs) { close({ via: 'timeout' }); return { action: 'closed', quiet }; }
      if (!s.nudged && quiet >= cfg.idleNudgeMs) { s.nudged = true; say('nudge'); return { action: 'nudged', quiet }; }
    }
    if (state === SPEAKING && s.speakingSince && (t - s.speakingSince) >= cfg.wedgeMs) {
      return { action: 'wedged', for: t - s.speakingSince };
    }
    return null;
  }

  /**
   * Has the tts-idle contract been broken? A watchdog calls this; the recovery is `abort()`, which
   * returns the mic rather than leaving a session that looks alive and hears nothing.
   */
  function wedged(t = now()) {
    return !!(s && state === SPEAKING && s.speakingSince && (t - s.speakingSince) >= cfg.wedgeMs);
  }

  // ── speaking ────────────────────────────────────────────────────────────────────────────────────

  /** Say a register line for this moment. Returns the text, so a caller can pre-render or log it. */
  function say(kind) {
    const text = pickLine(kind, lineN++);
    if (!text) return '';
    if (s) { s.lastVoiceAt = now(); s.transcript.push({ role: 'assistant', text, at: now(), register: kind }); }
    try { speak(text, { kind }); } catch {}
    return text;
  }

  /** The line for a moment WITHOUT saying it — for pre-rendering the whole library at boot. */
  function line(kind) { return pickLine(kind, lineN); }

  // ── what the model should know ──────────────────────────────────────────────────────────────────

  /**
   * A directive for the system prompt, derived from session state rather than guessed at.
   *
   * The register rules here are the conversational half of the persona: lib/static-prompt.js
   * describes how he SOUNDS, and this describes how a speaker behaves across turns — which is
   * mostly a list of things not to do a second time.
   */
  function promptDirective() {
    if (!s) return '';
    const bits = ['[VOICE SESSION — you are being LISTENED to, not read.]'];
    bits.push('Keep it to what you would actually say aloud: one or two sentences unless he asked for detail.');
    if (s.turns === 0) bits.push('This is the first exchange of the session.');
    else bits.push(`Exchange ${s.turns + 1} of an open conversation — do NOT greet him again, and do not re-introduce context he just gave you.`);
    if (s.bargeIns > 0) bits.push('He has interrupted you this session; he wants the point, not the preamble.');
    if (s.turns >= 4) bits.push('This has been a long conversation — be shorter, not longer.');
    return bits.join(' ');
  }

  /** Record that a turn actually did something, so the sign-off can be "Done, sir" rather than a shrug. */
  function noteWork(didWork = true) { if (s) s.didWork = !!didWork; }

  /** Record what was said, so a caller can carry session context without reaching into internals. */
  function noteReply(text) {
    if (s && text) { s.transcript.push({ role: 'assistant', text: String(text).slice(0, 2000), at: now() }); s.lastVoiceAt = now(); }
  }

  function status(t = now()) {
    return {
      state,
      open: state !== CLOSED,
      wakeRequired: state === CLOSED,
      session: s ? {
        id: s.id, via: s.via, turns: s.turns, bargeIns: s.bargeIns, didWork: s.didWork,
        openMs: t - s.openedAt, quietMs: t - (s.listeningSince || s.lastVoiceAt), nudged: s.nudged,
      } : null,
      wedged: wedged(t),
    };
  }

  function transcript() { return s ? s.transcript.slice() : []; }

  return {
    // transitions
    open, speechStart, endpoint, firstAudio, silentTurn, ttsIdle, bargeIn, abort, close, tick,
    // queries
    state: () => state, can, status, wedged, transcript, promptDirective,
    // speech
    say, line, noteWork, noteReply,
  };
}

module.exports = {
  createVoiceSession, REGISTERS, STATES, TRANSITIONS, DEFAULTS,
  CLOSED, LISTENING, THINKING, SPEAKING,
};
