'use strict';
// The cloud agent — a Claude tool-use loop. This is the always-on brain. It:
//   • recalls relevant long-term memory (SQLite + optional shared Notion bank),
//   • knows whether the Mac executor is online (so it offers/uses computer tools accordingly),
//   • runs tools (cloud-native here, computer tools relayed to the Mac),
//   • persists the conversation to SQLite, and streams tool activity to the phone's feed.
const db = require('./db');
const { callClaude, MODEL_SONNET, MODEL_CHEAP } = require('./llm');
const { toolDefs, dispatchTool, macOnline } = require('./tools');
const { stripReasoning } = require('./voice');   // strip leaked <thinking>/meta before it reaches the phone
const graph = require('./graph');                // W4 cloud parity — knowledge-graph memory (multi-hop)
const toolselect = require('./toolselect');      // W1 cloud parity — per-turn tool retrieval (context-rot)
let notion = null; try { notion = require('../notion'); } catch {}

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 8);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 40);

const SONNET_HINTS = [/write.*prompt/i, /architect/i, /refactor/i, /debug/i, /explain.*why/i, /design/i, /strategy/i, /research/i, /paper/i, /optimiz/i, /\bplan\b/i, /review/i, /analy[sz]e/i,
  // live-data/sports → route up so the tool is reliably invoked instead of a stale-memory reply
  /world cup|bracket|standings?|who'?s winning|tournament|fixtures?|matchup|\bodds\b|what.*watch|worth watching|\binsights?\b/i];
// Haiku retired: MODEL_CHEAP is Sonnet in the cloud (no local tier), so this is Sonnet either way —
// the hint split is kept for when a genuinely cheaper cloud tier returns.
function pickModel(text) { return SONNET_HINTS.some((re) => re.test(text || '')) ? MODEL_SONNET : MODEL_CHEAP; }

function buildSystem({ macUp, recalled }) {
  let s = `You are BhatBot — Siddhant's personal AI assistant, running as an always-on CLOUD service he reaches from his phone or computer.

VOICE & CHARACTER — you are JARVIS (Paul Bettany), not a generic chatbot: unflappable, bone-dry, quietly amused. Dry wit and understated, affectionate sarcasm belong in nearly every reply — deadpan, never zany, the humour is in the restraint. Effortless competence (a hard task gets "Already done, sir," not enthusiasm); British understatement ("mildly concerning" for a real problem); gentle loyal teasing when he does something silly; a well-placed barb when he's wrong, always on his side. NEVER perky, bubbly, sycophantic, or emoji-laden — warmth shows as dryness and reliability. e.g. "Deployed. Try not to break it before lunch, sir." / "Your inbox is a monument to optimism; two things actually matter." Address him as "sir", sparingly. No markdown in spoken-style replies.

BREVITY (every spoken word costs ElevenLabs quota): lead with the answer, default to one sentence (two max), plain common words, no preamble/hedging/closing pleasantries — but one dry beat is welcome, never filler. Speak only what matters; detail can wait for a follow-up.

You have tools. CLOUD tools (web_fetch, remember, recall) always work. COMPUTER tools (run_shell, read_file, write_file, list_directory, open_in_browser, system_control, media_control) run on Siddhant's Mac and only work when it is connected.

The Mac is currently ${macUp ? 'ONLINE — you may use computer tools.' : 'OFFLINE — do NOT promise to run computer tools now; if a request needs the Mac, say plainly it will run once the computer is back, and do whatever cloud part you can.'}

You can also make real phone calls (call_person) and send texts (text_person) on his behalf via Twilio — you have NO access to his contacts, so ask for or use a phone number in E.164 form (e.g. +16095551234). For a call, confirm the number + purpose, then call_person and tell him you'll text a summary.

Use remember when he states a durable preference, decision, or fact. Use recall when a question may depend on something he told you before. Keep replies short and natural.

NEVER output internal reasoning: no <thinking>/<think> tags, no meta-narration ("The user is correcting me…", "Let me think…"). Your reply is your conclusion; every word is read aloud.

FAITHFULNESS: report only what a tool actually returns; NEVER invent tool results. For "any important emails / check my mail", use ambient action "read" source "mail" (pass hours:168 for "past week"); report only the senders + subjects it returns, and if it says NOTHING TO REPORT, say there's nothing notable — do not fabricate emails, deadlines, or contents.

SPOKEN IDENTIFIERS (STT mishears emails/usernames — "Siddhant Pramod"→"Citadel Promote"): treat a heard email/username as low-confidence and lowercase. If it doesn't match a known account, confirm by spelling it back (NATO: "S as in Sierra…", digits, "at", "dot com") and get a yes/no before acting. If it's close to a known one, suggest that instead. After 2 failed attempts, ask him to type it rather than re-guessing.

LIVE DATA — never answer from memory: your training is stale. For anything current (scores, standings, news, weather, prices, "today/now/latest") you MUST use a tool and answer from its result. The FIFA World Cup 2026 IS HAPPENING NOW (June–July 2026) — for ANY World Cup question (update, standings, "who's winning", title odds, a matchup prediction, the bracket) call the world_cup tool; do NOT say "the next World Cup is 2026" or "I don't have real-time data" — you do, via world_cup.

Current date & time: ${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })}. Trust this over any internal sense of the date.`;
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
  // W4 — fold multi-hop knowledge-graph relations into recall (relations flat memory can't traverse).
  try { const g = graph.query(text, { depth: 2, limit: 10 }); if (g.hits && g.hits.length) recalled = [...new Set([...recalled, ...g.hits.map((h) => 'graph: ' + h)])]; } catch {}

  db.addMessage(convId, 'user', text);
  let history = db.getHistory(convId, HISTORY_LIMIT);
  const system = buildSystem({ macUp: macOnline(), recalled });
  const model = pickModel(text);
  // W1 — inject only the tools relevant to this turn (top-k + CORE); full catalog on low confidence
  // / no key. Computed once and reused across the step loop so the set never changes mid-task.
  const fullTools = toolDefs();
  let tools = fullTools;
  // Skip subsetting for the fixed morning-brief path (it must always see news + ambient); apply it
  // to interactive turns only.
  if (convId !== 'brief') {
    try { const sel = await toolselect.select(text, fullTools, { k: 12 }); if (sel && sel.tools && sel.tools.length) { tools = sel.tools; db.pushActivity('tool', `🧰 ${sel.tools.length}/${fullTools.length} tools selected`); } } catch {}
  }

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
      graphIngestCloud(fact);   // W4 — mine entity/relation triples into the graph (async, fire-and-forget)
      if (notion && notion.configured && notion.configured()) notion.appendMemory(fact, { tags: ['cloud'], source: 'user', confidence: 0.9 }).catch(() => {});
    }
    if (notion && notion.configured && notion.configured()) notion.logActivity((userText || '').slice(0, 200) + (reply ? ' → ' + reply.slice(0, 120) : '')).catch(() => {});
  } catch {}
}

// W4 — extract knowledge-graph triples from a saved fact with a cheap Haiku pass. Async +
// fire-and-forget so it never blocks the turn; gated by env KNOWLEDGE_GRAPH !== '0'.
async function graphIngestCloud(content) {
  try {
    if (process.env.KNOWLEDGE_GRAPH === '0') return;
    const text = String(content || '').trim();
    if (text.length < 8) return;
    const sys = 'Extract knowledge-graph triples from this fact about Siddhant. Return ONLY JSON: {"triples":[{"subject","predicate","object","subjectType","objectType"}]}. Types ∈ person|project|tool|org|place|concept|event|thing. Canonical short names ("Siddhant" not "I"). Skip non-factual text. Max 6 triples; empty array if none.';
    const r = await callClaude({ system: sys, messages: [{ role: 'user', content: text.slice(0, 1000) }], model: MODEL_CHEAP });
    const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = txt.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (j && Array.isArray(j.triples) && j.triples.length) { const res = graph.ingest(j.triples); if (res.added) db.pushActivity('memory', `🕸 graph +${res.added} relation${res.added > 1 ? 's' : ''}`); }
  } catch {}
}

// First-open-of-the-day brief. Runs at most once per calendar day — triggered when the phone
// or computer first opens BhatBot (whichever is first marks the day, so it fires exactly once).
const BRIEF_PROMPT = 'Morning brief — ONLY the most pressing things, nothing else. Short greeting, then exactly these three, each 1–2 short spoken bullets, terse: (1) NEWS: call the news tool (section "world") and give the 2–3 headlines that genuinely matter today — the gist, not every story. (2) IMPORTANT EMAILS: if my computer is online, call ambient action "read" source "mail" and tell me which unread emails look genuinely worth my attention — report ONLY the sender + subject the tool returns (no body is available — do NOT invent contents, deadlines, or amounts); skip newsletters/promos/automated. If the computer is offline or mail can\'t be read, say so in a few words and move on. (3) ONE INTERESTING THING you came across overnight — a genuine discovery worth my time (a notable article/development/insight), not filler. No website checks, no git status, no task lists. Flag anything truly urgent.';
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
