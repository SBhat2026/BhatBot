'use strict';
// Per-turn response-DEPTH classifier (A3). The agent used a flat max_tokens=4096 for everything, so a
// "yep?" got the same budget as "plan the migration" and the model padded short answers / got clipped
// on long ones. This picks a depth tier from the user's text → a matching max_tokens CEILING + a
// brevity/expansion DIRECTIVE injected as a trailing (uncached) system block. The model still decides
// actual length; this just sizes the room and nudges. Heuristic-first: zero latency, zero cost.
//
//   const { classifyDepth } = require('./lib/depth');
//   const d = classifyDepth(userText);   // → { depth, maxTokens, directive }

const TIERS = {
  ack: {
    maxTokens: 400,
    directive: 'RESPONSE SIZE: trivial exchange — one or two sentences, spoken-style. No lists, no headers, no preamble. Just the answer.',
  },
  conversational: {
    maxTokens: 1200,
    directive: 'RESPONSE SIZE: keep it tight — a short paragraph at most. Conversational, no bullet dumps. Put extra detail on screen only if genuinely needed.',
  },
  detailed: {
    maxTokens: 4096,
    directive: 'RESPONSE SIZE: a substantive answer is warranted — be thorough but not padded. Structure on screen; keep the SPOKEN part brief.',
  },
  deep: {
    maxTokens: 8192,
    directive: 'RESPONSE SIZE: this needs real depth — plan and reason carefully, give a complete structured answer ON SCREEN. Keep the spoken summary to a couple of sentences.',
  },
};

// Pure acknowledgements / closers — never need room.
const ACK_RE = /^(ok(ay)?|k|kk|yes|yep|yeah|no|nope|nah|thanks|thank you|thx|ty|cool|nice|great|got it|sure|fine|stop|cancel|never ?mind|good|perfect|done|sounds good|will do|👍|🙏)[.! ]*$/i;

// Heavy-lift intents: planning, building, analysis, teaching — earn the big budget.
const DEEP_RE = /\b(plan|design|architect|implement|refactor|debug|build (me|a|the)|write (me )?(a|the|an|some)|essay|comprehensive|in detail|deep ?dive|walk me through|step[ -]?by[ -]?step|compare|trade[ -]?offs?|pros and cons|analy[sz]e|break ?down|research|roadmap|strategy|migrat|rewrite|full (write|breakdown)|explain (why|how)|reasoning)\b/i;

// Mid-weight: explanations, summaries, reviews, drafts, lists.
const DETAIL_RE = /\b(how (do|does|can|should|would)|why (is|do|does|are)|what(?:'s| is| are)?.*(difference|best|options?)|summar(y|ize|ise)|review|draft|outline|list|describe|overview|recommend|suggest|help me)\b/i;

function classifyDepth(text) {
  const t = String(text || '').trim();
  let depth;
  if (!t || t.length <= 14 || ACK_RE.test(t)) depth = 'ack';
  else if (DEEP_RE.test(t) || t.length > 400) depth = 'deep';
  else if (DETAIL_RE.test(t) || t.length > 160) depth = 'detailed';
  else depth = 'conversational';
  return { depth, ...TIERS[depth] };
}

module.exports = { classifyDepth, TIERS };
