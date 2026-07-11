'use strict';
// Pure, stateless helpers extracted from main.js — SPLIT_PLAN.md step 1. These depend on nothing
// in main.js's module scope (only their arguments), so they're the safe first slice to prove the
// extraction wiring before the heavier tool-cluster modules. No Electron/fs/state imports.

// Mine a human-readable text hint from a CSS/Playwright selector (for vision-fallback clicks).
function textHintFromSelector(sel) {
  if (!sel) return '';
  const m = sel.match(/:has-text\("([^"]+)"\)/i) || sel.match(/\[aria-label="([^"]+)"\]/i)
    || sel.match(/\[placeholder="([^"]+)"\]/i) || sel.match(/\[name="([^"]+)"\]/i);
  if (m) return m[1];
  if (sel.startsWith('#')) return sel.slice(1).replace(/[-_]/g, ' ');
  return sel.replace(/[#.\[\]"'=>~]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Split text into speakable chunks (synth one while the next is prepared).
function splitForSpeech(text) {
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '').trim();
  const parts = clean.match(/[^.!?\n]+[.!?]?(\s|$)|[^.!?\n]+$/g) || [];
  const out = []; let buf = '';
  for (let p of parts) { p = p.trim(); if (!p) continue; buf = buf ? buf + ' ' + p : p; if (buf.length >= 60 || /[.!?]$/.test(p)) { out.push(buf); buf = ''; } }
  if (buf) out.push(buf);
  return out.filter((s) => s.length);
}

// Strip leaked chain-of-thought / reasoning from a model reply before it's shown OR spoken.
// Weak models (e.g. haiku) sometimes emit literal <thinking>…</thinking> / <think>… tags, or a
// dangling "<thinking The user is correcting me…" with no close, or a bare meta line narrating
// their own process. None of that should reach the chat bubble or the TTS. Conservative: only
// removes explicit reasoning markup + a leading self-narration line, never normal prose.
function stripReasoning(text) {
  let s = String(text || '');
  s = s.replace(/<thinking\b[\s\S]*?<\/thinking>/gi, ' ');   // well-formed thinking blocks
  s = s.replace(/<think\b[\s\S]*?<\/think>/gi, ' ');
  s = s.replace(/<\/?(?:thinking|think|reasoning|scratchpad)\b[^>]*>/gi, ' '); // stray open/close tags
  s = s.replace(/<thinking\b[\s\S]*$/i, ' ').replace(/<think\b[\s\S]*$/i, ' '); // dangling (never closed)
  // Leaked tool-call markup — some models emit the function-call XML as literal text instead of a
  // real tool_use block. Strip whole blocks + any stray tags so it's never shown or spoken.
  s = s.replace(/<(?:antml:)?function_calls\b[\s\S]*?<\/(?:antml:)?function_calls>/gi, ' ');
  s = s.replace(/<(?:antml:)?invoke\b[\s\S]*?<\/(?:antml:)?invoke>/gi, ' ');
  s = s.replace(/<\/?(?:antml:)?(?:function_calls|invoke|parameter|tool_call|tool_use|function_results?)\b[^>]*>/gi, ' ');
  s = s.replace(/<(?:antml:)?function_calls\b[\s\S]*$/i, ' ');   // dangling (never closed)
  // A leading line that is pure meta-narration about the user/turn ("The user is correcting me…").
  s = s.replace(/^\s*(?:the user (?:is|wants|seems|said|just)|i (?:should|need to|will|am going to|notice|see that)|let me (?:think|reason|consider))\b[^\n.!?]*[.!?]?\s*/i, '');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

// Speech planner (T2) — decide how a STREAMING reply should be spoken, from the visible text
// accumulated so far. Pure + stateless: called on each delta with the full accumulated text
// (minus <speak> markers) until it commits to a mode; makeSpeakStream freezes the first non-
// 'undecided' answer. Return values:
//   'digest'      — long or STRUCTURED (code/list/table/headers/URL-dense/multi-paragraph):
//                   speak a short summary, not the whole thing (screen still shows it all).
//   'short-plain' — short, prose-like: read verbatim (the common conversational case).
//   'undecided'   — not enough signal yet; keep buffering (finish() speaks a truly-short reply whole).
// Commit-by-220-chars guarantee: any first sentence longer than that, or 220 chars with no
// terminator, resolves to 'digest' so we never read a wall of text verbatim.
function classifySpeech(text) {
  const s = String(text || '');
  if (!s.trim()) return 'undecided';
  // STRUCTURED → digest immediately.
  if (/```/.test(s)) return 'digest';                                  // a code fence (even unclosed)
  const lines = s.split('\n');
  if (lines.filter((l) => /^\s*([-*]\s|\d+\.\s)/.test(l)).length >= 2) return 'digest';   // ≥2 bullet/numbered lines
  if (/^\s*\|.*\|/m.test(s)) return 'digest';                          // a markdown table row
  if (lines.filter((l) => /^\s*#{1,6}\s/.test(l)).length >= 2) return 'digest';           // ≥2 headers
  if (lines.some((l) => (l.match(/https?:\/\/\S+/g) || []).length >= 2)) return 'digest';  // a URL-dense line
  if (/\n[ \t]*\n[\s\S]*\S/.test(s)) return 'digest';                  // a second paragraph has started → long
  // Prose: decide at the first sentence terminator, or force digest once it runs long.
  const firstTerm = s.search(/[.!?](\s|$)/);
  if (firstTerm === -1) return s.length >= 220 ? 'digest' : 'undecided';
  return firstTerm <= 220 ? 'short-plain' : 'digest';
}

// Stateful, stream-safe text normalizer (T1/T3) — buffers streamed deltas to whitespace
// boundaries so a per-span normalizer (e.g. normalizeForSpeech) never runs across a split token
// (a URL or decimal cut between two deltas must not half-survive). `push(delta)` returns the
// normalized text that is safe to emit now (everything up to the last whitespace); `flush()`
// returns the trailing remainder. The normalize fn is injected so lib/pure.js stays dependency-free.
function createSpeechNormalizer(normalizeFn) {
  const norm = typeof normalizeFn === 'function' ? normalizeFn : (x) => x;
  let buf = '';
  return {
    push(delta) {
      buf += String(delta || '');
      const cut = buf.search(/\s\S*$/);          // last whitespace-before-trailing-token
      if (cut <= 0) return '';                    // no safe boundary yet — hold everything
      const ready = buf.slice(0, cut + 1);        // include the boundary whitespace
      buf = buf.slice(cut + 1);
      const out = norm(ready).trim();             // norm may or may not trim; normalize spacing here
      return out ? out + ' ' : '';
    },
    flush() { const rest = buf; buf = ''; return norm(rest).trim(); },
  };
}

// Action-completion guard (user-chosen: post-turn verification). isPromissory = the reply reads as
// a PROMISE/INTENT to act ("I'll open it", "let me pull that up", "going to run…") rather than a
// report of an action taken. Used as a cheap prefilter: only when a reply is promissory (or zero
// tools ran on an action task) do we spend a judge call to check whether it actually acted.
const PROMISSORY_RE = /\b(i'?ll\b|i will\b|i'?m going to|i am going to|going to\b|let me\b|i can (open|run|do|start|set|check|make|create|send|play|fix|build|deploy|pull|find|search|write|update|install|generate|render)|i'?ll go ahead|on it\b|one moment|just a moment|shall i\b|next,? i|about to\b|let'?s (open|run|start|do|check))\b/i;
function isPromissory(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  // Past-tense/report cues override — "I opened…", "Done", "Here's…" read as completed, not promised.
  if (/^\s*(done|finished|completed|here'?s|here are|i (opened|ran|created|sent|played|fixed|built|deployed|found|checked|updated|installed|generated|rendered|set)\b|that'?s done|all set)/i.test(s)) return false;
  return PROMISSORY_RE.test(s);
}

// Auto-extend budget (user-chosen: keep going while productive). Extend only if under the hard
// ceiling AND the recent iterations are still doing NEW work (unproductive = consecutive iterations
// with no novel tool signature; a stuck/looping agent stops instead of burning the whole ceiling).
function shouldExtendBudget({ maxIters, hardCeiling, unproductive, maxUnproductive = 2 } = {}) {
  return Number(maxIters) < Number(hardCeiling) && Number(unproductive || 0) <= maxUnproductive;
}

// Stable-ish signature for a tool call, for novelty/loop detection (same tool + same args = a repeat).
function toolSig(name, input) {
  let a = ''; try { a = JSON.stringify(input || {}); } catch { a = String(input); }
  return String(name || '') + ':' + a.slice(0, 200);
}

// Spoken progress heartbeat (latency/UX pass) — a brief, tool-aware "still working" line spoken
// during long turns so tier-1-paced multi-tool work never sits in dead air. Deterministic + free
// (no model call): a per-tool phrase, or a rotating generic line. Pure so it's unit-testable.
const PROGRESS_LINES = {
  browser: 'Still working through the page.',
  open_in_browser: 'Opening that up.',
  fetch_url: 'Still pulling that in.',
  web_search: 'Still searching.',
  read_file: 'Reading through it now.',
  write_file: 'Writing that out.',
  edit_file: 'Making the edit.',
  run_shell: 'Running that now.',
  claude_code: 'Still building.',
  make_figure: 'Building the figure.',
  generate_image: 'Rendering the image.',
  generate_3d: 'Rendering the model.',
  simulate: 'Running the simulation.',
  sci_compute: 'Crunching the numbers.',
  math_reason: 'Working through the math.',
  screen_parse: 'Looking at the screen.',
  vision_click: 'Working through the interface.',
  fleet: 'The team is on it.',
  agent_team: 'Looking at it from a few angles.',
  subagent: 'A specialist is on it.',
  smart_login: 'Signing in.',
  browser_workflow: 'Running the workflow.',
};
const PROGRESS_GENERIC = ['Still on it, sir.', 'Nearly there.', 'Still working.', 'One moment more.', 'Almost there, sir.'];
function progressLine(tool, rnd) {
  if (tool && PROGRESS_LINES[tool]) return PROGRESS_LINES[tool];
  const r = typeof rnd === 'number' ? rnd : Math.random();
  return PROGRESS_GENERIC[Math.floor(r * PROGRESS_GENERIC.length) % PROGRESS_GENERIC.length];
}

// Estimated USD cost of a paid generation tool call (folded into the daily cost ledger).
function estimateToolCost(name, input, result) {
  if (!result || result.success === false) return 0;    // failed calls cost ~nothing
  if (name === 'generate_image') {
    const prov = result.provider || (input && input.provider) || 'openai';
    if (prov === 'flux') return 0.04;
    if (prov === 'flux-fast') return 0.003;
    const q = (input && input.quality) || 'medium';
    return q === 'high' ? 0.08 : q === 'low' ? 0.01 : 0.04;
  }
  if (name === 'generate_3d') return 0.10;              // TRELLIS via Replicate (approx)
  return 0;
}

// looksActionable(text) — voice CLARITY GATE. Decides whether a transcribed utterance is a clear,
// actionable directive worth acting on, vs Siddhant just rambling / thinking aloud / trailing off.
// Returns { action: 'ok' | 'drop' | 'borderline', reason }. 'drop' = ignore (keep listening);
// 'ok' = dispatch; 'borderline' = let a cheap model make the call. Pure + testable.
const _VG_FILLER = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'hmmm', 'like', 'well', 'so', 'yeah', 'yknow', 'know', 'mean', 'anyway', 'anyways', 'basically', 'literally', 'actually', 'sorta', 'kinda', 'guess', 'just', 'right', 'okay', 'ok']);
const _VG_FILLER_PHRASES = /\b(you know|i mean|sort of|kind of|let me think|let'?s see|hold on|give me a (second|sec|minute)|i guess|or something|or whatever|how do i (say|put)( this)?|what was i saying)\b/g;
const _VG_KNOWN1 = new Set(['stop', 'cancel', 'yes', 'no', 'continue', 'go', 'unlock', 'lock', 'wait', 'pause', 'resume', 'repeat', 'undo', 'help', 'nevermind', 'skip', 'next', 'done']);
const _VG_RETRACT = /^(hmm+|wait|actually|never ?mind|forget it|scratch that|hold on|ignore that|no wait)\b/i;
function looksActionable(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length < 2) return { action: 'drop', reason: 'empty' };
  let t = ' ' + raw.toLowerCase().replace(/[.,!?;:]/g, ' ') + ' ';
  t = t.replace(_VG_FILLER_PHRASES, ' ');
  const words = t.match(/[a-z0-9']+/g) || [];
  const content = words.filter((w) => !_VG_FILLER.has(w) && w.length > 1);
  const fillerRatio = words.length ? 1 - content.length / words.length : 1;
  if (!content.length) return { action: 'drop', reason: 'no content (pure filler/rambling)' };
  if (content.length <= 2 && _VG_RETRACT.test(raw)) return { action: 'drop', reason: 'thinking-aloud / retraction' };
  if (content.length === 1) return { action: _VG_KNOWN1.has(content[0]) ? 'ok' : 'borderline', reason: 'single content word' };
  if (fillerRatio > 0.6 && content.length < 3) return { action: 'borderline', reason: 'mostly filler' };
  return { action: 'ok', reason: 'clear content' };
}

// classifyIntake(text, opts) — the DETERMINISTIC front-door router (T1). Decides which executor a
// turn should reach: 'action' (obvious tool work → the instrumented agentLoop), 'chat' (a tool-free
// greeting/short question → the fast path), or 'ambiguous' (anything unclear → agentLoop, NEVER the
// tool-less fast path or the local pipeline). The asymmetry is deliberate: a false 'chat' is a broken
// task; a false 'action' costs only a little latency — so we err toward execution. Pure + testable;
// opts injects main.js signals { looksLikeToolTask, referencesJob, inToolThread }.
const _INTK_TOOLSIGNAL = /```|https?:\/\/|(^|\s)[~./][\w./-]*\/[\w.-]+|\b[\w-]+\.(js|ts|py|md|json|html|css|sh|png|jpe?g|pdf|stl|glb|csv|txt|ya?ml|toml)\b/i;
const _INTK_ACTION_VERB = /\b(open|launch|play|pause|skip|run|build|fix|check|create|make|find|search|deploy|write|send|close|quit|set|update|install|delete|remove|pull up|show me|navigate|go to|download|generate|render|start|stop|turn|schedule|scrape|extract|summari[sz]e|plot|chart|organi[sz]e|refactor|analy[sz]e|configure|integrate|wire|implement|migrate|book|order|reply|draft|edit|move|rename|compile|debug|screenshot|record|translate|convert)\b/i;
const _INTK_APP = /\b(email|e-mail|gmail|calendar|spotify|browser|browse|terminal|shell|command line|repo|commit|push|pull request|3d model|\bstl\b|workflow|password|log ?in|sign ?in|automate|reminder|folder|directory|studio|nexus|bioart|molecule|world ?cup|drone|fleet)\b/i;
const _INTK_GREETING = /^(hi|hey|hello|yo|sup|thanks|thank you|ty|ok|okay|k|cool|nice|great|awesome|good (morning|afternoon|evening|night)|how are you|what'?s up|gg|lol|haha)\b/i;
const _INTK_QUESTION = /^(what|who|why|how|when|which|whose|where|is|are|do|does|did|can|could|would|should|will|was|were)\b/i;
function classifyIntake(text, opts = {}) {
  const raw = String(text || '').trim();
  if (!raw) return 'chat';
  const t = raw.toLowerCase();
  // Continuing an in-flight tool thread → always the instrumented loop.
  if (opts.inToolThread) return 'action';
  // Hard ACTION signals (any one is decisive).
  if (_INTK_TOOLSIGNAL.test(raw)) return 'action';
  if (typeof opts.looksLikeToolTask === 'function' && opts.looksLikeToolTask(raw)) return 'action';
  if (typeof opts.referencesJob === 'function' && opts.referencesJob(raw)) return 'action';
  if (_INTK_ACTION_VERB.test(t)) return 'action';
  if (_INTK_APP.test(t)) return 'action';
  // CHAT only for clearly tool-free small talk / short factual questions.
  const wc = (t.match(/[a-z0-9']+/g) || []).length;
  if (_INTK_GREETING.test(t) && wc <= 8) return 'chat';
  if ((_INTK_QUESTION.test(t) || /\?\s*$/.test(raw)) && raw.length < 90 && wc <= 16) return 'chat';
  // Everything else — statements, medium/long asks, unclear utterances → err toward execution.
  return 'ambiguous';
}

module.exports = { textHintFromSelector, splitForSpeech, estimateToolCost, stripReasoning, classifySpeech, createSpeechNormalizer, isPromissory, shouldExtendBudget, toolSig, progressLine, looksActionable, classifyIntake };
