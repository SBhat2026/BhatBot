'use strict';
// ── THE CUSTODIAN — the fifth agent shape ─────────────────────────────────────────────────────────
// The other four are escalations of CAPABILITY: a specialist, an ensemble, a fleet of drones, a
// durable mission. Each one answers "how much can be brought to bear?". The Custodian is
// orthogonal — it answers "is this actually what he asked for, and should we be asking him?"
//
// TWO JOBS, AND THE SECOND IS THE IMPORTANT ONE.
//
// 1. ACCEPTANCE. Does the deliverable answer the ORIGINAL prompt? This is a different question from
//    the one `verifyActionDone` already asks in main.js, which is "did a tool actually run, or did
//    the turn end on a promise?". That catches narration. It does not catch a fleet that spent four
//    minutes and $0.40 producing a polished artifact answering a question nobody asked — the tools
//    ran, the work is real, and it is not the work that was requested. Drift like that is the
//    characteristic failure of a long fan-out, because each agent is answering its own sub-goal
//    faithfully and nothing holds the original sentence.
//
// 2. ASKING. The default becomes ASK. Today an ambiguous instruction is resolved by guessing, and
//    the guess is invisible — you find out which reading it took by looking at what it did. Claude
//    and ChatGPT both stop and ask; BhatBot should too, unless explicitly told to run autonomously
//    for this task. That inversion is the behavioural change; everything else here is plumbing for
//    it.
//
// COST DISCIPLINE. A reviewer that costs a model call on every turn is a reviewer that gets turned
// off. So the same shape as lib/triage.js: deterministic checks first, and the judge only on the
// residue. Most accepts and every obvious reject are free.
//
// WHAT IT WILL NOT DO. It will not pause on taste ("this could be better"), on a partial result the
// user can see is partial, or on anything it can resolve itself by looking. A custodian that stops
// often is a custodian that gets `autonomous: true` set permanently on day two, and then it is not
// protecting anything. The triggers below are deliberately narrow and each one is a case where
// GUESSING IS WORSE THAN WAITING.
//
// Pure + DI: the judge, the asker and the parker are all injected. See scripts/test-custodian.js.

const ACCEPT = 'accept';
const SENDBACK = 'sendback';
const ASK = 'ask';

const DEFAULTS = {
  maxSendbacks: 1,      // one bounded retry. Two is a loop with extra steps.
  minPromptWords: 4,    // below this there is nothing to check a deliverable against
  autonomous: false,    // ASK IS THE DEFAULT. This is the inversion.
};

// ── the ask triggers ──────────────────────────────────────────────────────────────────────────────
// Four, and each is a case where proceeding on a guess produces work that has to be thrown away.
const TRIGGERS = {
  ambiguous_referent: 'the request points at something without saying which',
  missing_fact: 'something required was never supplied and cannot be worked out',
  unauthorized_step_up: 'it implies an action that needs your say-so',
  contradiction: 'two agents came back with answers that cannot both be true',
};

// A referent with no antecedent — "the second one", "that file", "the other approach" — in a request
// that never named a set. This is the single most common ambiguity in a spoken instruction, and the
// one where guessing is most expensive, because the wrong referent means the whole task is wrong.
const DANGLING_REFERENT = /\b(the (?:second|third|first|last|other|latter|former)(?: one| file| option| approach| version)?|that (?:file|one|thing|version|approach)|those|it again)\b/i;
// Words that would supply the antecedent. If the prompt names a set, the referent is resolvable.
const HAS_ANTECEDENT = /\b(\d+|both|each|every|all|list|these|following|first.*second|a and b)\b/i;

// Phrases that mean the model already knows it is guessing. If it says so, it should be asking.
const SELF_FLAGGED_GUESS = /\b(i(?:'ll)? assum|assuming (?:you|that)|i(?:'m| am) not sure (?:which|what|whether)|either .* or .*(?:\?|would work)|it(?:'s| is) unclear|ambiguous)\b/i;

// ── deterministic acceptance ──────────────────────────────────────────────────────────────────────

/** Content words of a prompt — what a deliverable ought to be about. */
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'at',
  'by', 'from', 'is', 'are', 'was', 'be', 'been', 'it', 'this', 'that', 'my', 'me', 'i', 'you', 'your',
  'can', 'could', 'would', 'should', 'please', 'do', 'does', 'did', 'have', 'has', 'get', 'got', 'make',
  'just', 'then', 'so', 'if', 'as', 'not', 'no', 'up', 'out', 'about', 'into', 'now', 'all', 'some']);

function keyTerms(text) {
  return [...new Set(String(text || '').toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) || [])]
    .filter((w) => !STOP.has(w));
}

/**
 * Cheap overlap: how much of the prompt's substance appears in the deliverable. Not a semantic
 * measure and not pretending to be one — it is a CHEAP NEGATIVE FILTER. High overlap proves
 * nothing; near-zero overlap on a substantial prompt is a strong signal the answer drifted, and
 * that case is worth a judge call.
 */
function termOverlap(prompt, deliverable) {
  const want = keyTerms(prompt);
  if (!want.length) return 1;
  const got = String(deliverable || '').toLowerCase();
  const hit = want.filter((w) => got.includes(w)).length;
  return hit / want.length;
}

/**
 * createCustodian(deps)
 *
 *   judge({prompt, deliverable, trace}) → {answers:boolean, missing?:string, confidence?:number}
 *        The residue check. Injected, and OPTIONAL — with no judge the Custodian still does every
 *        deterministic check and simply accepts anything it cannot disprove, which is the correct
 *        degradation: a reviewer that blocks when it cannot think is worse than no reviewer.
 *   ask({question, options, context}) → Promise<answer|null>
 *   park({reason, question})          → park the mission
 *   onEvent(event)                    → for lib/commentary.js, so a pause is SPOKEN, not logged
 */
function createCustodian(deps = {}) {
  const {
    judge = null,
    ask = async () => null,
    park = () => {},
    onEvent = () => {},
    log = () => {},
    config = {},
  } = deps;

  const cfg = { ...DEFAULTS, ...config };

  /**
   * Should this stop and ask BEFORE doing the work? Deterministic, free, and run on the request
   * rather than the result — the cheapest ask is the one that happens before four minutes of fan-out.
   */
  function inspectRequest(prompt, { autonomous = cfg.autonomous, knownFacts = {} } = {}) {
    const text = String(prompt || '');
    if (autonomous) return { ask: false, reason: 'autonomous' };
    if (!text.trim()) return { ask: false, reason: 'empty' };

    if (DANGLING_REFERENT.test(text) && !HAS_ANTECEDENT.test(text)) {
      const m = DANGLING_REFERENT.exec(text);
      return {
        ask: true, trigger: 'ambiguous_referent',
        reason: TRIGGERS.ambiguous_referent,
        question: `You said "${m[0]}" — which one do you mean?`,
      };
    }

    // A named requirement the caller has already told us is missing. The caller knows its own
    // required fields; the Custodian only decides that a MISSING one is worth stopping for.
    const missing = Object.entries(knownFacts).filter(([, v]) => v == null || v === '').map(([k]) => k);
    if (missing.length) {
      return {
        ask: true, trigger: 'missing_fact', reason: TRIGGERS.missing_fact,
        question: `I need ${missing.length === 1 ? missing[0] : missing.join(' and ')} before I start.`,
      };
    }

    return { ask: false, reason: 'clear' };
  }

  /**
   * Review a finished deliverable against the ORIGINAL prompt.
   *
   * Returns { verdict, reason, directive?, question?, cost }.
   *   accept   — it answers the question
   *   sendback — it does not, and a bounded retry is worth one attempt
   *   ask      — it cannot be resolved without the user
   */
  async function review({ prompt, deliverable, trace = [], attempt = 0, autonomous = cfg.autonomous, contradictions = [] } = {}) {
    const p = String(prompt || '').trim();
    const d = String(deliverable || '').trim();
    let cost = 0;

    // Contradiction between agents that were deliberately overlapped. The orchestrator marks these
    // with `overlaps` precisely because agreement is the point; disagreement is the finding, and it
    // is not the Custodian's to resolve by picking one.
    if (contradictions.length >= 2 && !autonomous) {
      return {
        verdict: ASK, cost, trigger: 'contradiction', reason: TRIGGERS.contradiction,
        question: `Two agents disagree: ${contradictions.slice(0, 2).map((c) => `"${String(c).slice(0, 80)}"`).join(' vs ')}. Which is right?`,
      };
    }

    // Nothing at all came back.
    if (!d) return { verdict: SENDBACK, cost, reason: 'the deliverable is empty', directive: sendbackDirective(p, 'nothing was produced') };

    // Too short a prompt to have drifted from.
    if (p.split(/\s+/).length < cfg.minPromptWords) return { verdict: ACCEPT, cost, reason: 'prompt too short to check against' };

    // The model said, in so many words, that it was guessing. Take it at its word — it is the
    // cheapest and most reliable ambiguity signal available, and ignoring it is how a guess becomes
    // a silent decision.
    if (!autonomous && SELF_FLAGGED_GUESS.test(d)) {
      return {
        verdict: ASK, cost, trigger: 'ambiguous_referent', reason: 'it told you it was guessing',
        question: firstQuestionIn(d) || 'It is not sure which reading you meant — which is it?',
      };
    }

    // Cheap negative filter. Substantial overlap → accept for free, which is the common case.
    const overlap = termOverlap(p, d);
    if (overlap >= 0.34) return { verdict: ACCEPT, cost, reason: `answers the request (${Math.round(overlap * 100)}% of its terms)` };

    // The residue: low overlap. Might be drift, might be a perfectly good answer phrased in other
    // words. This is the only case worth paying a judge for.
    if (!judge) {
      // No judge → accept. A reviewer that blocks work because it cannot think is worse than none.
      return { verdict: ACCEPT, cost, reason: `low term overlap (${Math.round(overlap * 100)}%) but no judge available — not blocking` };
    }

    let v = null;
    try { v = await judge({ prompt: p, deliverable: d, trace }); cost += 1; }
    catch (e) { log('[custodian] judge failed: ' + e.message); return { verdict: ACCEPT, cost, reason: 'judge unavailable — not blocking' }; }

    if (v && v.answers) return { verdict: ACCEPT, cost, reason: 'judged to answer the request' };

    const missing = (v && v.missing) || 'it does not address what was asked';
    if (attempt < cfg.maxSendbacks) {
      return { verdict: SENDBACK, cost, reason: missing, directive: sendbackDirective(p, missing) };
    }
    // Already retried once and still wrong. Do not spend a third time — surface it.
    if (autonomous) return { verdict: ACCEPT, cost, reason: `still not right (${missing}) but running autonomously` };
    return {
      verdict: ASK, cost, trigger: 'missing_fact', reason: missing,
      question: `I have had two goes at this and it still is not what you asked for — ${missing}. How would you like it done?`,
    };
  }

  /** The directive injected on a send-back. States the mismatch rather than just saying "try again". */
  function sendbackDirective(prompt, missing) {
    return `[CUSTODIAN — this does not yet answer what was asked.\nTHE ORIGINAL REQUEST, verbatim: "${prompt}"\nWHAT IS MISSING: ${missing}\nRedo the work so it answers THAT. Do not restate the plan; produce the thing.]`;
  }

  /**
   * Stop, tell him, and wait. The pause is SPOKEN through the commentary layer — a park that is
   * only written to a log is a mission that sits still until someone happens to look, which is the
   * exact failure the scheduler had for sixteen days.
   */
  async function pause({ question, trigger, reason, options = [], context = '' }) {
    try { onEvent({ kind: 'needs_input', detail: reason || TRIGGERS[trigger] || 'it needs a decision' }); } catch {}
    try { park({ reason: reason || trigger, question }); } catch {}
    log(`[custodian] parked — ${trigger}: ${question}`);
    let answer = null;
    try { answer = await ask({ question, options, context }); } catch (e) { log('[custodian] ask failed: ' + e.message); }
    return { answered: answer != null, answer, question, trigger };
  }

  return { review, inspectRequest, pause, keyTerms, termOverlap, TRIGGERS, ACCEPT, SENDBACK, ASK };
}

/** The first question the deliverable itself asked, if it asked one. */
function firstQuestionIn(text) {
  const m = String(text || '').match(/[^.!?\n]*\?/g);
  if (!m) return null;
  const q = m.map((x) => x.trim()).find((x) => x.length > 12 && x.length < 200);
  return q || null;
}

module.exports = {
  createCustodian, TRIGGERS, DEFAULTS, ACCEPT, SENDBACK, ASK,
  keyTerms, termOverlap, firstQuestionIn, DANGLING_REFERENT, SELF_FLAGGED_GUESS,
};
