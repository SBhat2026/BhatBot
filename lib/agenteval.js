'use strict';
// ── GRADING AN AGENT AGAINST SOMETHING THAT IS NOT ITSELF ─────────────────────────────────────────
// scripts/perf-eval.js already measures routing and uses Claude-as-judge for the text metrics. That
// is useful and it has a ceiling: a model from the same family deciding whether the answer was good
// shares the blind spots of the thing it is grading, and on a hallucinated fact both can be
// confidently wrong together.
//
// So this grades against an EXTERNAL answer key, fetched live from an authoritative API at grading
// time. Not a downloaded dataset — those go stale, and a stale key marks a correct answer wrong,
// which is worse than no benchmark. The question is asked of BhatBot and the truth is fetched
// independently, in the same minute, from the source that owns the fact.
//
// WHAT IT ACTUALLY MEASURES, which is narrower than "is it smart":
//   • can it retrieve a verifiable fact with its tools;
//   • does it report the number it found, or a number that sounds right (the hallucination case);
//   • does it say it could not find something rather than inventing it.
// Reasoning quality is NOT in scope here. A benchmark that claims to measure everything measures
// nothing, and there is already a judge suite for the prose.

/** Pull the numbers out of an answer, tolerating 1,234 / 1.2k / 3.4 million / -5. */
function numbersIn(text) {
  const s = String(text || '').replace(/,(?=\d{3}\b)/g, '');
  const out = [];
  for (const m of s.matchAll(/(-?\d+(?:\.\d+)?)\s*(k|thousand|m|million|bn|billion)?/gi)) {
    let n = parseFloat(m[1]);
    const unit = (m[2] || '').toLowerCase();
    if (/^k|thousand$/.test(unit)) n *= 1e3;
    else if (/^m|million$/.test(unit)) n *= 1e6;
    else if (/^bn|billion$/.test(unit)) n *= 1e9;
    out.push(n);
  }
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * grade(answer, expect) → { ok, why, found? }
 *
 * expect:
 *   { number, tolerance }  — any number in the answer within tolerance (relative) of the truth
 *   { text }               — the truth appears in the answer
 *   { anyOf: [...] }       — any of several acceptable strings
 *
 * ABSTENTION IS NOT FAILURE. "I could not find that" is the correct answer when a source is down,
 * and scoring it the same as a fabricated number would teach exactly the wrong behaviour — the
 * whole point of the exercise is that inventing a plausible figure is the worst outcome available.
 */
const ABSTAIN = /\b(couldn'?t|could not|unable to|failed to|no result|not find|don'?t have|cannot (?:find|reach|access)|unavailable|is down)\b/i;

// An answer the HARNESS failed to capture, or a turn that produced none. This is not a fact about
// the agent's knowledge and must never be scored as one — the first run of this benchmark reported a
// 20% FABRICATION RATE for a turn that said nothing at all, which is precisely the kind of confident
// false number the whole exercise exists to catch. In its own instrument.
const NO_ANSWER = /^\(no text\)$|^\(harness error/i;

function grade(answer, expect = {}) {
  const a = String(answer || '').trim();
  if (!a) return { ok: false, why: 'empty answer', kind: 'empty' };
  if (NO_ANSWER.test(a)) return { ok: null, why: 'the turn produced no answer — an agent or harness failure, not a wrong belief', kind: 'no-answer' };
  if (ABSTAIN.test(a)) return { ok: null, why: 'abstained — said it could not find it', kind: 'abstain' };

  if (expect.number != null) {
    const tol = expect.tolerance == null ? 0.02 : expect.tolerance;
    const nums = numbersIn(a);
    if (!nums.length) return { ok: false, why: 'no number in the answer', kind: 'no-number' };
    const hit = nums.find((n) => Math.abs(n - expect.number) <= Math.abs(expect.number) * tol + (expect.absolute || 0));
    return hit != null
      ? { ok: true, why: `${hit} is within ${(tol * 100).toFixed(0)}% of ${expect.number}`, found: hit, kind: 'number' }
      // A wrong number stated confidently is the failure this benchmark exists to catch, so it is
      // named rather than folded into a generic miss.
      : { ok: false, why: `stated ${nums.slice(0, 3).join(', ')} — truth is ${expect.number}`, found: nums[0], kind: 'wrong-number' };
  }
  const wants = expect.anyOf || (expect.text != null ? [expect.text] : []);
  if (wants.length) {
    const hay = norm(a);
    const hit = wants.find((w) => hay.includes(norm(w)));
    return hit
      ? { ok: true, why: `contains "${hit}"`, found: hit, kind: 'text' }
      : { ok: false, why: `none of ${wants.map((w) => `"${w}"`).join(' / ')} appears`, kind: 'wrong-text' };
  }
  return { ok: false, why: 'nothing to check against', kind: 'no-expectation' };
}

/** Roll a set of graded rows into the numbers worth reporting. */
function summarize(rows = []) {
  // `ok === null` covers both an honest abstention and a turn that produced nothing. Neither is a
  // belief, so neither belongs in an accuracy denominator.
  const answered = rows.filter((r) => r.verdict.ok !== null);
  const correct = rows.filter((r) => r.verdict.ok === true);
  const wrong = rows.filter((r) => r.verdict.ok === false);
  const abstained = rows.filter((r) => r.verdict.ok === null);
  // Fabrication is the metric that matters most and the one a self-judge is worst at: a confident
  // number that is simply not true.
  const fabricated = wrong.filter((r) => /wrong-number|wrong-text/.test(r.verdict.kind));
  return {
    asked: rows.length,
    answered: answered.length,
    correct: correct.length,
    wrong: wrong.length,
    abstained: abstained.filter((r) => r.verdict.kind === 'abstain').length,
    noAnswer: abstained.filter((r) => r.verdict.kind === 'no-answer').length,
    fabricated: fabricated.length,
    accuracy: answered.length ? +(correct.length / answered.length).toFixed(3) : null,
    fabricationRate: answered.length ? +(fabricated.length / answered.length).toFixed(3) : null,
    medianMs: rows.length ? rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] : null,
    usd: +rows.reduce((n, r) => n + (r.usd || 0), 0).toFixed(4),
  };
}

module.exports = { grade, summarize, numbersIn, ABSTAIN, NO_ANSWER };
