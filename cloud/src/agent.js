'use strict';
// The cloud agent — a Claude tool-use loop. This is the always-on brain. It:
//   • recalls relevant long-term memory (SQLite + optional shared Notion bank),
//   • knows whether the Mac executor is online (so it offers/uses computer tools accordingly),
//   • runs tools (cloud-native here, computer tools relayed to the Mac),
//   • persists the conversation to SQLite, and streams tool activity to the phone's feed.
const db = require('./db');
const { callClaude, MODEL_SONNET, MODEL_HAIKU } = require('./llm');
const { toolDefs, dispatchTool, macOnline } = require('./tools');
let notion = null; try { notion = require('../notion'); } catch {}

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 8);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 40);

const SONNET_HINTS = [/write.*prompt/i, /architect/i, /refactor/i, /debug/i, /explain.*why/i, /design/i, /strategy/i, /research/i, /paper/i, /optimiz/i, /\bplan\b/i, /review/i, /analy[sz]e/i];
function pickModel(text) { return SONNET_HINTS.some((re) => re.test(text || '')) ? MODEL_SONNET : MODEL_HAIKU; }

function buildSystem({ macUp, recalled }) {
  let s = `You are BhatBot — Siddhant's personal AI assistant, running as an always-on CLOUD service he reaches from his phone or computer. Speak like a calm, dry-witted British butler (JARVIS): brief, direct, no filler, no markdown in spoken-style replies.

You have tools. CLOUD tools (web_fetch, remember, recall) always work. COMPUTER tools (run_shell, read_file, write_file, list_directory, open_in_browser, system_control, media_control) run on Siddhant's Mac and only work when it is connected.

The Mac is currently ${macUp ? 'ONLINE — you may use computer tools.' : 'OFFLINE — do NOT promise to run computer tools now; if a request needs the Mac, say plainly it will run once the computer is back, and do whatever cloud part you can.'}

Use remember when he states a durable preference, decision, or fact. Use recall when a question may depend on something he told you before. Keep replies short and natural.`;
  if (recalled && recalled.length) s += `\n\nRELEVANT MEMORY (use silently, do not enumerate):\n` + recalled.map((f) => '- ' + f).join('\n');
  const cost = db.costToday();
  if (cost.calls) s += `\n\nAPI spend today: $${cost.usd.toFixed(3)} (${cost.calls} calls). Be efficient.`;
  return s;
}

// Run one user turn through the loop. convId scopes the persisted conversation.
async function runTurn(convId, userText, { reset = false } = {}) {
  if (reset) db.resetConversation(convId);
  const text = String(userText || '').trim();
  if (!text) return { error: 'empty' };

  db.pushActivity('task', text.slice(0, 200));

  // Recall: SQLite memory + (optional) shared Notion bank.
  let recalled = db.recallMemory(text, 6);
  if (notion && notion.configured && notion.configured()) {
    try { const n = await notion.recallSmart(text, 5); if (Array.isArray(n)) recalled = [...new Set([...recalled, ...n])]; } catch {}
  }

  db.addMessage(convId, 'user', text);
  let history = db.getHistory(convId, HISTORY_LIMIT);
  const system = buildSystem({ macUp: macOnline(), recalled });
  const model = pickModel(text);
  const tools = toolDefs();

  let steps = 0;
  while (steps < MAX_STEPS) {
    const resp = await callClaude({ system, messages: history, tools, model });
    const content = resp.content || [];
    history.push({ role: 'assistant', content });
    db.addMessage(convId, 'assistant', content);

    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length || resp.stop_reason === 'end_turn') {
      const out = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      // Persist explicit "remember…" facts to the shared bank too (cross-surface continuity).
      maybeShareFact(text, out);
      db.pushActivity('done', out.slice(0, 200));
      return { text: out, _model: model, _macOnline: macOnline() };
    }

    const results = [];
    for (const tu of toolUses) {
      db.pushActivity('tool', tu.name);
      const result = await dispatchTool(tu.name, tu.input);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 24 * 1024), is_error: result && result.success === false });
    }
    history.push({ role: 'user', content: results });
    db.addMessage(convId, 'user', results);
    history = history.slice(-HISTORY_LIMIT);
    steps++;
  }
  // Step budget hit — one final tool-less summary.
  history.push({ role: 'user', content: '[Step budget reached. Do NOT call tools. In one or two short sentences tell me what you did, what remains, and the next step.]' });
  const fin = await callClaude({ system, messages: history.slice(-HISTORY_LIMIT), model });
  const out = (fin.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || 'Reached the step budget for this turn.';
  db.addMessage(convId, 'assistant', fin.content || out);
  db.pushActivity('done', out.slice(0, 200));
  return { text: out, _model: model, _macOnline: macOnline() };
}

const REMEMBER_RE = /\b(remember(?:\s+that)?|note\s+that|don'?t\s+forget|keep\s+in\s+mind|for\s+the\s+record)\b[:,]?\s*(.+)/i;
function maybeShareFact(userText, reply) {
  try {
    const m = userText.match(REMEMBER_RE);
    let fact = m && m[2] && m[2].trim().length > 3 ? m[2].trim().replace(/[.\s]+$/, '') : null;
    if (!fact && /\bmy\s+\w+\s+(is|are|=)\s+\S/i.test(userText) && userText.length < 200) fact = userText.trim();
    if (fact) {
      db.saveMemory(fact, { source: 'user' });
      if (notion && notion.configured && notion.configured()) notion.appendMemory(fact, { tags: ['cloud'], source: 'user', confidence: 0.9 }).catch(() => {});
    }
    if (notion && notion.configured && notion.configured()) notion.logActivity((userText || '').slice(0, 200) + (reply ? ' → ' + reply.slice(0, 120) : '')).catch(() => {});
  } catch {}
}

module.exports = { runTurn };
