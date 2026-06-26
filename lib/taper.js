'use strict';
// Conversation-position taper (Phase 3, Deliverable #2). Long conversations systematically
// over-allocate: turn 30 of a coding session is almost never a fresh 8k-token task — it's a
// clarification or status check. The learned depth model picks this up from the `position` feature,
// but we ALSO apply an explicit, transparent multiplier that decays the ceiling after turn 15.
//
//   factor({ position, text, tier }) → { factor, reset, reason }
//
// Decay: identity through turn START (15); past it, a gentle geometric decay floored at FLOOR, so a
// long thread's ceilings ease down rather than cliff. The decay is SUSPENDED (factor=1, reset=true)
// when the turn shows a genuinely-new-task signal — conservatively defined to avoid resetting on
// ordinary follow-ups.

const START = 15;        // taper does nothing at/below this user-turn index
const PER_TURN = 0.04;   // 4% decay per turn past START
const FLOOR = 0.45;      // never shrink the ceiling below 45% of its sized value

// Conservative "this is a NEW task, stop tapering" signals. Deliberately narrow: explicit restarts,
// or a genuinely large/heavy new ask. Ordinary "ok", "and then?", "fix that" do NOT reset.
const RESET_RE = /\b(new (project|task|topic|feature|file)|start over|starting over|from scratch|let'?s build|brand new|different (project|task|topic)|switch(ing)? to|forget (that|the previous)|clean slate)\b/i;
const LONG_QUERY_TOKENS = 220;   // a long, detailed fresh ask (~880 chars) resets the taper

function resetSignal({ text, tier }) {
  const t = String(text || '');
  if (RESET_RE.test(t)) return 'explicit-new-task';
  if (Math.ceil(t.length / 4) >= LONG_QUERY_TOKENS) return 'long-query';
  if (tier === 'deep' && t.length > 320) return 'deep-and-substantial';   // a real planning/build ask
  return null;
}

// position = count of user turns so far in this conversation (1-based).
function factor({ position = 1, text = '', tier = 'conversational' } = {}) {
  const reset = resetSignal({ text, tier });
  if (reset) return { factor: 1, reset: true, reason: reset };
  if (position <= START) return { factor: 1, reset: false, reason: `pos<=${START}` };
  const decayed = Math.pow(1 - PER_TURN, position - START);
  const f = Math.max(FLOOR, +decayed.toFixed(3));
  return { factor: f, reset: false, reason: `decay@pos${position}` };
}

module.exports = { factor, resetSignal, START, PER_TURN, FLOOR };
