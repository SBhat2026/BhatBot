'use strict';
// The cloud agent — a Claude tool-use loop. This is the always-on brain. It:
//   • recalls relevant long-term memory (SQLite + optional shared Notion bank),
//   • knows whether the Mac executor is online (so it offers/uses computer tools accordingly),
//   • runs tools (cloud-native here, computer tools relayed to the Mac),
//   • persists the conversation to SQLite, and streams tool activity to the phone's feed.
const db = require('./db');
const { callClaude, MODEL_SONNET, MODEL_HAIKU } = require('./llm');
const { toolDefs, dispatchTool, macOnline } = require('./tools');
const { stripReasoning } = require('./voice');   // strip leaked <thinking>/meta before it reaches the phone
let notion = null; try { notion = require('../notion'); } catch {}

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 8);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 40);

const SONNET_HINTS = [/write.*prompt/i, /architect/i, /refactor/i, /debug/i, /explain.*why/i, /design/i, /strategy/i, /research/i, /paper/i, /optimiz/i, /\bplan\b/i, /review/i, /analy[sz]e/i];
function pickModel(text) { return SONNET_HINTS.some((re) => re.test(text || '')) ? MODEL_SONNET : MODEL_HAIKU; }

function buildSystem({ macUp, recalled }) {
  let s = `You are BhatBot — Siddhant's personal AI assistant, running as an always-on CLOUD service he reaches from his phone or computer. Speak like a calm, dry-witted British butler (JARVIS): brief, direct, no filler, no markdown in spoken-style replies.

You have tools. CLOUD tools (web_fetch, remember, recall) always work. COMPUTER tools (run_shell, read_file, write_file, list_directory, open_in_browser, system_control, media_control) run on Siddhant's Mac and only work when it is connected.

The Mac is currently ${macUp ? 'ONLINE — you may use computer tools.' : 'OFFLINE — do NOT promise to run computer tools now; if a request needs the Mac, say plainly it will run once the computer is back, and do whatever cloud part you can.'}

You can also make real phone calls (call_person) and send texts (text_person) on his behalf via Twilio — you have NO access to his contacts, so ask for or use a phone number in E.164 form (e.g. +16095551234). For a call, confirm the number + purpose, then call_person and tell him you'll text a summary.

Use remember when he states a durable preference, decision, or fact. Use recall when a question may depend on something he told you before. Keep replies short and natural.

NEVER output internal reasoning: no <thinking>/<think> tags, no meta-narration ("The user is correcting me…", "Let me think…"). Your reply is your conclusion; every word is read aloud.

SPOKEN IDENTIFIERS (STT mishears emails/usernames — "Siddhant Pramod"→"Citadel Promote"): treat a heard email/username as low-confidence and lowercase. If it doesn't match a known account, confirm by spelling it back (NATO: "S as in Sierra…", digits, "at", "dot com") and get a yes/no before acting. If it's close to a known one, suggest that instead. After 2 failed attempts, ask him to type it rather than re-guessing.`;
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
  // Channel/auth tier (#17): phone-voice is passphrase-gated (stepped up); sms is not (spoofable).
  const channel = convId === 'sms' ? 'sms' : convId === 'phone-voice' ? 'phone' : 'cloud';

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
      const out = stripReasoning(content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')).trim();
      // Persist explicit "remember…" facts to the shared bank too (cross-surface continuity).
      maybeShareFact(text, out);
      db.pushActivity('done', out.slice(0, 200));
      return { text: out, _model: model, _macOnline: macOnline() };
    }

    const results = [];
    for (const tu of toolUses) {
      db.pushActivity('tool', tu.name);
      const result = await dispatchTool(tu.name, tu.input, channel);
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
  const out = stripReasoning((fin.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')).trim() || 'Reached the step budget for this turn.';
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

// First-open-of-the-day brief. Runs at most once per calendar day — triggered when the phone
// or computer first opens BhatBot (whichever is first marks the day, so it fires exactly once).
const BRIEF_PROMPT = 'Give Siddhant a concise spoken morning brief, max 5 short bullets: (1) today date + day; (2) web_fetch https://prism-assembly.prismlab.workers.dev and https://protfunc.prismlab.workers.dev and flag anything not OK; (3) if my computer is online, git status of ~/bhatbot; (4) one useful reminder from stored memory if relevant. Brief and natural; flag anything urgent. Open with a short greeting.';
async function dailyBriefIfDue() {
  const day = db.today();
  if (db.getMeta('lastBriefDay') === day) return { fresh: false };
  db.setMeta('lastBriefDay', day);                  // mark first so it can't double-fire on concurrent opens
  try {
    const r = await runTurn('brief', BRIEF_PROMPT, { reset: true });
    return { fresh: true, text: r.text };
  } catch (e) { db.setMeta('lastBriefDay', ''); return { fresh: false, error: e.message }; }
}

module.exports = { runTurn, dailyBriefIfDue };
