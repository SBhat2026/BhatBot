'use strict';
// ── THE MODEL CEILING ────────────────────────────────────────────────────────────────────────────
//
// Siddhant's rule, 2026-11-12, in his words: "Don't use Fable ever. Opus should be the absolute limit
// and it should ask before using that. Most calls should default to Haiku, or Sonnet if they need
// significant coding."
//
// A rule like that cannot live in the router. main.js chooses a model in more than a dozen places —
// the turn router, the heavy-tier upgrade, three design-synthesis calls that name the top tier
// directly, the reflection job, eval, the drone fleet — and "the router never picks Fable" is a claim
// about ONE of them. The three synthesis calls ran on the most expensive model with no question
// asked, and no amount of care in the router would have changed that.
//
// So the ceiling is enforced where every request already has to pass: anthropicRequest(). That makes
// it a property of the call graph rather than of anybody's discipline — a new call site that names a
// forbidden model gets the ceiling whether or not its author knew the rule existed.
//
// TWO DIFFERENT KINDS OF "NO", and they must not be confused:
//   FORBIDDEN (Fable, Mythos)  — never sent, under any approval. There is no flag that enables it.
//   GATED (Opus)               — sent only with a live, per-task approval from him.
// Both DOWNGRADE rather than fail. A refused model is not a reason for the task to die; it is a
// reason for it to run on the tier he did agree to, and to say so.
//
// Pure: no I/O, no clock of its own.

/** Never, under any approval. Matches the family, so a future point release is covered too. */
const FORBIDDEN = /^claude-(?:fable|mythos)\b/i;
/** Allowed only while he has said yes to THIS task. */
const GATED = /^claude-opus\b/i;

/**
 * enforce(model, ctx) → { model, changed, reason }
 *   ctx.opusApproved   true only while a per-task approval is live
 *   ctx.fallback       the model to drop to (the workhorse tier)
 *   ctx.ceiling        the model Opus-class requests resolve to when approved
 *
 * Non-Claude ids (local, OpenAI, Gemini offload) pass through untouched: this is his rule about
 * Claude tiers, not a general allowlist, and blocking a local model here would break the free lane.
 */
function enforce(model, ctx = {}) {
  const id = String(model || '');
  const fallback = ctx.fallback || 'claude-sonnet-5';
  const ceiling = ctx.ceiling || 'claude-opus-5';
  if (!/^claude-/i.test(id)) return { model: id, changed: false, reason: null };

  if (FORBIDDEN.test(id)) {
    // Approved-for-Opus is the most he has ever agreed to, so that is the most a Fable request can
    // become. Without approval it is the workhorse.
    const to = ctx.opusApproved ? ceiling : fallback;
    return { model: to, changed: true, reason: `${id} is never used — running on ${to} instead` };
  }
  if (GATED.test(id) && !ctx.opusApproved) {
    return { model: fallback, changed: true, reason: `${id} needs his go-ahead for this task — running on ${fallback} instead` };
  }
  return { model: id, changed: false, reason: null };
}

/** True when sending `model` would need a question first. Used to decide whether to ask at all. */
function needsApproval(model) { const id = String(model || ''); return GATED.test(id) || FORBIDDEN.test(id); }
/** True when no approval can ever make `model` sendable. */
function isForbidden(model) { return FORBIDDEN.test(String(model || '')); }

// ── WHICH TIER, BY DEFAULT ───────────────────────────────────────────────────────────────────────
//
// "Most calls should default to Haiku, or Sonnet if they need significant coding."
//
// The base tier used to be Sonnet for everything, because the Haiku of the day fumbled multi-step
// tool plans and was retired from routing. Haiku 5.5 is a different model at a twentieth of Sonnet's
// price, so on the 5.5 generation the default flips: Haiku unless the turn is the kind of work that
// earns the bigger model. `significant` is deliberately a list of REASONS, so a turn that went to
// Sonnet can say why — a router that cannot explain an upgrade cannot be tuned.
//
// On the older generation this returns Sonnet unconditionally: Haiku 4.5 stays retired, and nothing
// about today's behaviour changes until the 5.5 lineup has been exercised live.
const SIGNIFICANT_CODE = /\b(refactor|architect|migrat|rewrite|debug|implement|fix (?:the|this|a) (?:bug|test|build|error)|write (?:a |the |some )?(?:function|class|module|script|program|test|code)|pull request|\bpr\b|codebase|repo(?:sitory)?|stack trace|compile|type ?check|unit tests?)\b/i;
function defaultTier({ gen55 = false, text = '', complexTool = false, reasoningRoute = false, models = {} } = {}) {
  const sonnet = models.sonnet || 'claude-sonnet-5', haiku = models.haiku || 'claude-haiku-5-5';
  if (!gen55) return { model: sonnet, tier: 'sonnet', why: 'the workhorse tier (Haiku is retired on this generation)' };
  if (SIGNIFICANT_CODE.test(String(text))) return { model: sonnet, tier: 'sonnet', why: 'significant coding' };
  if (complexTool) return { model: sonnet, tier: 'sonnet', why: 'a multi-step build or analysis' };
  if (reasoningRoute) return { model: sonnet, tier: 'sonnet', why: 'the classifier asked for reasoning depth' };
  return { model: haiku, tier: 'haiku', why: 'the default — nothing about this turn needs more' };
}

module.exports = { enforce, needsApproval, isForbidden, defaultTier, FORBIDDEN, GATED, SIGNIFICANT_CODE };
