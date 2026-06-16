'use strict';
// LLM-as-judge for grading the parent model's chat updates against the GROUND TRUTH of what the
// subagents actually did. This is the same idea as DeepEval's G-Eval metric (a rubric scored by
// an LLM) but implemented in-process with plain fetch — no Python eval stack, no external SaaS,
// runs offline except for the single judge call. Reusable by the offline perf harness AND at
// runtime as an optional self-check before a status update is spoken/sent.
//
// groundTruth = a plain-text rendering of the real execution (tool calls, errors, outcomes),
// produced from the trace. The judge never sees code strings — it reasons over meaning, which is
// exactly why a simple string match (the user's "you cannot use simple code strings") fails here.

async function claudeJSON(prompt, { apiKey, model = 'claude-haiku-4-5', system, max_tokens = 700, retries = 2 } = {}) {
  if (!apiKey) throw new Error('no apiKey');
  let attempt = 0;
  while (true) {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens, system, messages: [{ role: 'user', content: prompt }] }),
      });
    } catch (e) { if (attempt++ >= retries) throw e; await new Promise((s) => setTimeout(s, 700 * attempt)); continue; }
    if (r.status === 429 || r.status === 529 || r.status >= 500) { if (attempt++ >= retries) throw new Error('anthropic ' + r.status); await new Promise((s) => setTimeout(s, 1000 * 2 ** attempt)); continue; }
    if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('judge returned no JSON: ' + text.slice(0, 160));
    return JSON.parse(m[0]);
  }
}

const JUDGE_SYSTEM = `You are a rigorous evaluation judge for an AI assistant's status updates.
You are given GROUND TRUTH (what the assistant's background subagents actually did) and the
UPDATE the assistant showed the user. Score the update ONLY against the ground truth — never
reward fluent text that misstates what happened. Output STRICT JSON, no prose, with keys:
  "alignment": 0..1     // does the update accurately reflect the ground truth? 1=fully accurate, 0=contradicts it
  "conciseness": 0..1   // 1=clean human summary, 0=raw log/terminal-dump spam or rambling noise
  "hallucination": 0..1 // RATE of invented/unsupported claims; 0=nothing invented (best), 1=mostly invented
  "reason": "<=20 words"`;

// Judge one (groundTruth, update) pair. Returns {alignment, conciseness, hallucination, reason}.
async function judgeUpdate({ update, groundTruth, apiKey, model } = {}) {
  const prompt = `GROUND TRUTH (actual subagent execution):\n${groundTruth}\n\nUPDATE shown to the user:\n"${update}"\n\nScore the update. JSON only.`;
  return claudeJSON(prompt, { apiKey, model, system: JUDGE_SYSTEM });
}

module.exports = { claudeJSON, judgeUpdate, JUDGE_SYSTEM };
