'use strict';
// ── WHICH MODEL IS THIS AGENT, AS A COLOUR ───────────────────────────────────────────────────────
//
// 2026-11-25: "For the agent office floor, add different colors to each of the models."
//
// The office already spends HUE on designation (what an agent is doing — lib/designation.js). The
// body now wears the MODEL instead, and the designation moves to the floor ring and the legend, so
// both stay readable: a gold figure on a green ring is Opus doing code.
//
// Like designation, the palette travels to the renderer as data (forRenderer) — presence.html is an
// iframe on file:// and must not grow its own copy.
//
// The families are deliberately coarse. Twelve shades of "a Claude model" is not something anyone
// can read across a room; five families is.

const FAMILIES = [
  { id: 'opus',   label: 'Opus',   body: '#E0A43A', match: /opus/i },
  { id: 'sonnet', label: 'Sonnet', body: '#8B6FE0', match: /sonnet/i },
  { id: 'haiku',  label: 'Haiku',  body: '#3FB58A', match: /haiku/i },
  { id: 'local',  label: 'Local',  body: '#5B8FB0', match: /qwen|gemma|llama|mistral|phi|ollama|mlx|deepseek|local|darkbloom/i },
  { id: 'openai', label: 'OpenAI', body: '#D9774A', match: /gpt|openai|\bo\d\b|terra|astra/i },
];
const UNKNOWN = { id: 'model', label: 'Model unknown', body: '#9AA7B2' };

/** A model id or tier word → its family id. Never throws; unknown is its own honest grey. */
function classify(model) {
  const m = String(model || '');
  if (!m) return UNKNOWN.id;
  for (const f of FAMILIES) if (f.match.test(m)) return f.id;
  return UNKNOWN.id;
}

function get(id) { return FAMILIES.find((f) => f.id === id) || UNKNOWN; }

function forRenderer() {
  return {
    families: FAMILIES.map(({ id, label, body }) => ({ id, label, body })),
    unknown: { ...UNKNOWN },
  };
}

module.exports = { FAMILIES, UNKNOWN, classify, get, forRenderer };
