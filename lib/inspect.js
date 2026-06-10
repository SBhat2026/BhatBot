'use strict';
// Visual inspection (Phase 6). Turn a screenshot into STRUCTURED findings via a local
// vision model (gemma3:12b / llava) — defects only, no prose — so the autonomous dev loop
// (code → launch → screenshot → inspect → fix) can decide deterministically whether to
// keep iterating. Falls back cleanly if Ollama/vision model is unavailable. See ARCHITECTURE.md §6.
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';

const PROMPT = (goal) => `You are a UI QA inspector. Look at this screenshot.
Goal/context: ${goal || '(general UI quality)'}
Return ONLY JSON (no prose):
{"pass": true|false, "findings":[{"severity":"blocker|major|minor|nit","where":"region/element","issue":"...","fix_hint":"..."}]}
pass=true means no blocker/major issues. List concrete defects: broken layout, overlap, unreadable contrast, errors, empty states, cut-off text, misalignment. Empty findings + pass:true if it looks good.`;

function extractJSON(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// inspect({ imageB64, goal, model }) -> { pass, findings:[...], raw }
async function inspect({ imageB64, goal, model } = {}) {
  if (!imageB64) return { pass: false, findings: [{ severity: 'blocker', issue: 'no screenshot provided' }] };
  const mdl = model || 'gemma3:12b';
  try {
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: mdl, stream: false, prompt: PROMPT(goal), images: [imageB64], format: 'json', options: { temperature: 0.1 } }),
    });
    if (!r.ok) return { pass: null, findings: [], error: `vision ${r.status} (is ollama running ${mdl}?)` };
    const j = await r.json();
    const parsed = extractJSON(j.response) || {};
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const pass = typeof parsed.pass === 'boolean' ? parsed.pass : !findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
    return { pass, findings, model: mdl, raw: j.response };
  } catch (e) {
    return { pass: null, findings: [], error: `vision unreachable: ${e.message}` };
  }
}

// Convert findings → state_updates + a one-line summary for the agent protocol.
function findingsToState(component, result) {
  const blockers = (result.findings || []).filter((f) => f.severity === 'blocker' || f.severity === 'major');
  return {
    summary: result.pass ? 'UI looks good — no blocking issues' : `${blockers.length} blocking UI issue(s): ${blockers.map((f) => f.issue).slice(0, 3).join('; ')}`,
    state_updates: [
      { path: `${component}.facts.ui_pass`, value: !!result.pass },
      { path: `${component}.facts.ui_findings`, value: (result.findings || []).length },
    ],
  };
}

module.exports = { inspect, findingsToState };
