'use strict';
// ── THE COMMENTARY LAYER ──────────────────────────────────────────────────────────────────────────
// Two voices, and the difference between them is who the subject of the sentence is.
//
// COMMAND VOICE — first person, connected straight to the models and the tools. You give an order,
// he takes it and acts: "Right away, sir." That register lives in lib/voicesession.js and
// lib/static-prompt.js, and it is the voice of the thing DOING the work.
//
// COMMENTARY VOICE — this file. When he is explaining what is happening rather than answering you,
// he stops being the actor and becomes an observer of the household: "Second drone's back; two still
// out." "Triage archived four things just now." "The worker picked the backlog up a minute ago."
// Present tense, subject first, specific. It is what a butler does when you walk into a room and ask
// what's going on — he tells you the state of the house, not a list of his own verbs.
//
// WHY IT EXISTS. The alternative is reading logs, which is what actually happens today. The existing
// spoken heartbeat (lib/pure.progressLine) says "Working on it" every twenty seconds: first person,
// content-free, and identical whether one file is being read or nine drones are stalling. It fills a
// silence rather than reporting anything, so the only way to find out what the system is doing is to
// go and look at ~/.bhatbot/logs. This turns the events the system ALREADY emits into speech.
//
// THE HARD PART IS NOT THE WORDS, IT IS THE EDITING. A running commentary that mentions every tool
// call is worse than silence — it is noise that you learn to ignore, and then it is noise you cannot
// hear a real warning through. Three filters, in order:
//   SALIENCE    — most events are never worth saying aloud at all. A file read is not news.
//   COALESCING  — nine file reads in eight seconds are ONE event ("reading through the project"),
//                 not nine lines. The count goes in the line; the nine lines do not.
//   PACING      — a minimum gap between spoken lines, and never while he is already speaking, so
//                 commentary cannot talk over the answer it is commenting on.
//
// Deterministic templates, no model call: zero cost, zero latency, and it cannot hallucinate a
// drone that does not exist — every number in a line comes from the event that produced it.
//
// Pure + DI. See scripts/test-commentary.js.

// ── salience ──────────────────────────────────────────────────────────────────────────────────────
// What a person actually wants interrupted for. Anything not listed is `quiet` and never spoken
// unless explicitly asked for — the default is silence, which is the only default that survives.
const ALWAYS = 'always';     // say it, now, even if it breaks the pacing gap
const NOTABLE = 'notable';   // say it when the pacing allows
const QUIET = 'quiet';       // never volunteered; available if asked

// Tools whose individual calls are worth a word. Everything else coalesces into a category line or
// is simply not mentioned.
const TOOL_SALIENCE = {
  // things with consequences out in the world
  gmail: NOTABLE, triage_mail: ALWAYS, calendar: NOTABLE, drive: NOTABLE,
  smart_login: ALWAYS, run_shell: NOTABLE, container_run: NOTABLE, claude_code: NOTABLE,
  // things that cost real money
  generate_image: NOTABLE, visual_build: ALWAYS, make_asset: NOTABLE, make_model: NOTABLE,
  // things that take a long time
  simulate: NOTABLE, sci_compute: NOTABLE, predict_function: NOTABLE, deploy_drones: ALWAYS,
  fleet: ALWAYS, agent_team: ALWAYS, build_project: ALWAYS, delegate_project: ALWAYS,
  // things that change BhatBot itself
  self_fix: ALWAYS, self_heal: ALWAYS, self_drive: ALWAYS, write_file: NOTABLE, edit_file: NOTABLE,
};

// Reads and lookups. Individually beneath mention; collectively worth one line.
const COALESCE_GROUP = {
  read_file: 'reading', list_directory: 'reading', file_tools: 'reading',
  fetch_url: 'looking things up', web_search: 'looking things up', find_papers: 'looking things up',
  browser: 'looking things up', browser_observe: 'looking things up',
  save_memory: 'filing things away', notion_write: 'filing things away', notion_search: 'filing things away',
  screen_parse: 'looking at the screen', ui_inspect: 'looking at the screen', vision_click: 'looking at the screen',
};

const DEFAULTS = {
  minGapMs: 9000,          // the floor between two spoken lines
  coalesceMs: 8000,        // a burst of like tools inside this window becomes one line
  maxPerMinute: 5,         // a hard ceiling, because a runaway loop must not become a runaway voice
};

// ── the lines ─────────────────────────────────────────────────────────────────────────────────────
// Observer register: present tense, subject first, contracted, understated. No "I am" — the whole
// point is that he is not the subject here. Numbers come from the event.
const LINES = {
  tool: {
    run_shell: (e) => `Shell's running${e.detail ? ` — ${e.detail}` : ''}.`,
    claude_code: () => `Claude Code's on it.`,
    gmail: (e) => `Mail's open${e.detail ? ` — ${e.detail}` : ''}.`,
    triage_mail: (e) => e.count ? `Triage just touched ${e.count} message${e.count === 1 ? '' : 's'}.` : `Triage is going through the inbox.`,
    calendar: () => `Calendar's up.`,
    drive: () => `Drive's open.`,
    smart_login: (e) => `Signing in${e.detail ? ` to ${e.detail}` : ''} now.`,
    generate_image: () => `An image is rendering.`,
    visual_build: (e) => `Video's rendering — that one's expensive${e.usd ? `, about ${money(e.usd)}` : ''}.`,
    make_model: () => `Blender's building it.`,
    make_asset: () => `The asset pipeline's running.`,
    simulate: () => `Simulation's running.`,
    sci_compute: () => `The numbers are going through.`,
    predict_function: () => `Structure prediction's out.`,
    self_fix: () => `It's editing its own code — verify-gated.`,
    self_heal: () => `The self-healing loop's picked something up.`,
    self_drive: () => `Self-drive session's started.`,
    write_file: (e) => `Writing ${e.detail || 'a file'}.`,
    edit_file: (e) => `Patching ${e.detail || 'a file'}.`,
  },
  // A coalesced burst. `count` is real.
  burst: (e) => {
    const n = e.count;
    if (e.group === 'reading') return `Reading through the project — ${n} file${n === 1 ? '' : 's'} so far.`;
    if (e.group === 'looking things up') return `Out on the web — ${n} source${n === 1 ? '' : 's'} so far.`;
    if (e.group === 'filing things away') return `Filing ${n} thing${n === 1 ? '' : 's'} into memory.`;
    if (e.group === 'looking at the screen') return `Watching the screen — ${n} look${n === 1 ? '' : 's'} so far.`;
    return `${n} more of those.`;
  },
  agent: {
    launched: (e) => `${cap(num(e.count))} ${e.count === 1 ? "agent's" : 'agents are'} out.`,
    returned: (e) => e.outstanding > 0
      ? `One's back; ${num(e.outstanding)} still out.`
      : `They're all back.`,
    stalled: (e) => `${cap(e.name || 'One of them')} has gone quiet — nudging it.`,
    reaped: (e) => `${cap(e.name || 'One')} never came back. Working with what the others found.`,
  },
  loop: {
    synapse: (e) => e.detail ? `The brain's been weaving — ${e.detail}.` : `The brain's just done a pass.`,
    triage: (e) => `Triage ran${e.count ? ` — ${e.count} handled` : ''}.`,
    patrol: () => `Patrol's had a look round.`,
    backlog: (e) => `The backlog worker picked up ${e.detail || 'an item'}.`,
    gardener: (e) => `The gardener's been through the brain${e.detail ? ` — ${e.detail}` : ''}.`,
  },
  schedule: {
    ran: (e) => `"${e.name}" just ran.`,
    parked: (e) => `"${e.name}" is parked — ${e.detail || 'it needs you'}.`,
    deferred: (e) => `"${e.name}" needs the app open; it's waiting.`,
  },
  cost: (e) => `That's ${money(e.usd)} today.`,
  failure: (e) => e.permanent
    ? `${cap(e.name || 'That')} has stopped for good — ${e.detail || 'it needs you'}.`
    : `${cap(e.name || 'That')} fell over; it'll try again.`,
  toolbox: (e) => `Reaching for the ${e.detail} tools.`,
  needs_input: (e) => `It's stopped and wants you — ${e.detail || 'something is ambiguous'}.`,
};

const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const money = (u) => (u >= 1 ? `$${Number(u).toFixed(2)}` : `${Math.round(Number(u) * 100)} cents`);
const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const num = (n) => (NUM[n] != null ? NUM[n] : String(n));

/**
 * createCommentary(deps)
 *
 *   speak(text, {kind, salience})  — say a line. The caller owns the audio path.
 *   now()                          — injected clock.
 *   isSpeaking()                   — true while the reply itself is being spoken. Commentary NEVER
 *                                    talks over the answer; that is the fastest way to make a live
 *                                    narration something the user switches off.
 *   config                         — overrides for DEFAULTS.
 */
function createCommentary(deps = {}) {
  const {
    speak = () => {},
    now = () => Date.now(),
    isSpeaking = () => false,
    log = () => {},
    config = {},
  } = deps;

  const cfg = { ...DEFAULTS, ...config };

  let lastSpokenAt = 0;
  let spokenTimes = [];          // for maxPerMinute
  const bursts = new Map();      // group → { count, firstAt, lastAt, spokenCount }
  const said = new Set();        // one-shot keys, so the same fact is not reported twice
  let muted = false;

  function rateOk(salience, t) {
    if (muted) return false;
    if (isSpeaking()) return false;                              // never over the top of the answer
    spokenTimes = spokenTimes.filter((x) => t - x < 60000);
    if (spokenTimes.length >= cfg.maxPerMinute) return false;    // a runaway loop is not a runaway voice
    if (salience === ALWAYS) return true;                        // urgent skips the gap, not the ceiling
    return (t - lastSpokenAt) >= cfg.minGapMs;
  }

  function emit(text, kind, salience, t) {
    if (!text) return null;
    lastSpokenAt = t;
    spokenTimes.push(t);
    try { speak(text, { kind, salience }); } catch {}
    try { log(`[commentary] ${text}`); } catch {}
    return text;
  }

  /**
   * observe(event) → the line that was spoken, or null.
   *
   * event: { kind, name?, detail?, count?, outstanding?, usd?, permanent?, group?, once? }
   *   kind ∈ tool | agent | loop | schedule | cost | failure | toolbox | needs_input
   */
  function observe(event = {}) {
    const t = now();
    const { kind, name } = event;
    if (!kind) return null;

    // `once` keys collapse repeats of the same fact across a whole turn.
    if (event.once) {
      if (said.has(event.once)) return null;
      said.add(event.once);
    }

    if (kind === 'tool') {
      const group = COALESCE_GROUP[name];
      if (group) return burst(group, t);
      const sal = TOOL_SALIENCE[name] || QUIET;
      if (sal === QUIET) return null;                            // most tools are simply not news
      const line = (LINES.tool[name] || (() => null))(event);
      if (!line || !rateOk(sal, t)) return null;
      return emit(line, 'tool', sal, t);
    }

    if (kind === 'agent') {
      const f = LINES.agent[event.name];                          // name = launched|returned|stalled|reaped
      const sal = event.name === 'launched' || event.name === 'reaped' ? ALWAYS : NOTABLE;
      if (!f || !rateOk(sal, t)) return null;
      return emit(f(event), 'agent', sal, t);
    }

    if (kind === 'loop') {
      const f = LINES.loop[name];
      if (!f || !rateOk(NOTABLE, t)) return null;
      return emit(f(event), 'loop', NOTABLE, t);
    }

    if (kind === 'schedule') {
      const f = LINES.schedule[event.name === 'ran' ? 'ran' : event.name] || LINES.schedule.ran;
      const sal = event.name === 'parked' ? ALWAYS : NOTABLE;
      if (!rateOk(sal, t)) return null;
      return emit(f(event), 'schedule', sal, t);
    }

    if (kind === 'cost') {
      if (!rateOk(NOTABLE, t)) return null;
      return emit(LINES.cost(event), 'cost', NOTABLE, t);
    }

    if (kind === 'failure') {
      // A permanent failure is the one thing worth breaking the pacing for — it is the class of
      // problem that otherwise sits silently in a log for sixteen days.
      const sal = event.permanent ? ALWAYS : NOTABLE;
      if (!rateOk(sal, t)) return null;
      return emit(LINES.failure(event), 'failure', sal, t);
    }

    if (kind === 'toolbox') {
      if (!rateOk(QUIET === QUIET ? NOTABLE : NOTABLE, t)) return null;
      return emit(LINES.toolbox(event), 'toolbox', NOTABLE, t);
    }

    if (kind === 'needs_input') {
      // The Custodian's pause. Always spoken: the entire point is that the work has stopped and
      // nobody would otherwise know.
      if (muted) return null;
      return emit(LINES.needs_input(event), 'needs_input', ALWAYS, t);
    }

    return null;
  }

  // A burst counts silently and speaks at most once per coalesce window, carrying the real count.
  function burst(group, t) {
    const b = bursts.get(group) || { count: 0, firstAt: t, lastAt: t, spoken: 0 };
    if (t - b.lastAt > cfg.coalesceMs) { b.count = 0; b.firstAt = t; b.spoken = 0; }   // new burst
    b.count++; b.lastAt = t;
    bursts.set(group, b);
    // Speak on the third of a kind — one read is not a story, three is "he's reading the project".
    if (b.count < 3 || b.spoken >= 1) return null;
    if (!rateOk(NOTABLE, t)) return null;
    b.spoken++;
    return emit(LINES.burst({ group, count: b.count }), 'burst', NOTABLE, t);
  }

  /** Silence the commentary (the user asked, or a focus mode). Events are still counted. */
  function mute(on = true) { muted = !!on; }
  function isMuted() { return muted; }

  /** A turn ended: forget the one-shots and the bursts so the next turn starts fresh. */
  function reset() { bursts.clear(); said.clear(); }

  /**
   * A text answer to "what's going on?" — the same observations, printed rather than spoken, so the
   * question never requires opening a log. Caller supplies the live facts; this only formats them.
   */
  function summarize(facts = {}) {
    const bits = [];
    if (facts.agentsOut) bits.push(`${cap(num(facts.agentsOut))} ${facts.agentsOut === 1 ? 'agent is' : 'agents are'} out`);
    if (facts.tool) bits.push(`currently ${facts.tool}`);
    if (facts.loops && facts.loops.length) bits.push(`${facts.loops.join(' and ')} running in the background`);
    if (facts.parked && facts.parked.length) bits.push(`${facts.parked.length} thing${facts.parked.length === 1 ? '' : 's'} parked and waiting on you`);
    if (facts.usdToday != null) bits.push(`${money(facts.usdToday)} spent today`);
    if (!bits.length) return 'Nothing running, sir.';
    return cap(bits.join(', ')) + '.';
  }

  return { observe, burst, mute, isMuted, reset, summarize, LINES, ALWAYS, NOTABLE, QUIET };
}

module.exports = {
  createCommentary, LINES, TOOL_SALIENCE, COALESCE_GROUP, DEFAULTS, ALWAYS, NOTABLE, QUIET,
};
