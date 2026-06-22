'use strict';
// Tool registry for the cloud agent. Two classes:
//   • CLOUD-NATIVE — run right here (web fetch, durable memory). Always available.
//   • MAC-RELAY    — dispatched to the Mac executor over the WebSocket relay when it's online,
//     else they return a graceful "computer offline". Names match the desktop's executeTool
//     tool names EXACTLY, so the Mac bridge can run them with no translation.
const db = require('./db');
const { macExec, macOnline, queueExec } = require('./relay');
let twilio = null; try { twilio = require('./twilio'); } catch {}
const worldcup = require('./worldcup');   // live FIFA WC 2026 engine (cloud-native, no key)
const news = require('./news');           // NYT news skim (RSS, no key; powers the morning brief)

function _wcResolve(snap, q) {
  if (!q) return null;
  const s = String(q).trim().toLowerCase();
  for (const g of snap.groups) for (const t of g.teams) {
    if (t.abbr.toLowerCase() === s) return t.abbr;
    if (String(t.name).toLowerCase().includes(s)) return t.abbr;
  }
  return String(q).toUpperCase();
}
async function worldCup(input = {}) {
  const action = input.action || 'open';
  try {
    // DEFAULT / standings / live / update → hand back the live standings link (cheap; the phone
    // shows a tappable, auto-updating page). No Monte-Carlo, minimal tokens.
    if (['open', 'report', 'standings', 'scores', 'update'].includes(action)) {
      return { success: true, result: `Live World Cup standings & scores (auto-updating): ${worldcup.STANDINGS_URL}`, url: worldcup.STANDINGS_URL };
    }
    // Informative: live scores + a recommended match + insights + web buzz → form your own opinion.
    if (['watch', 'insights', 'recommend', 'brief', 'live', 'whatshappening'].includes(action)) {
      const b = await worldcup.watchBrief({ maxBuzz: 5 });
      return { success: true, result: worldcup.formatWatch(b), brief: b };
    }
    if (action === 'predict') {
      const snap = await worldcup.snapshot({ ttlMs: 60000, sims: 0 });
      const a = _wcResolve(snap, input.home), b = _wcResolve(snap, input.away);
      if (!a || !b) return { success: false, error: 'need home and away' };
      const p = worldcup.predict(snap.elo, a, b, { home: true });
      return { success: true, result: `${a} vs ${b}: ${a} ${(p.pHome * 100).toFixed(0)}% / draw ${(p.pDraw * 100).toFixed(0)}% / ${b} ${(p.pAway * 100).toFixed(0)}%` };
    }
    if (action === 'group') {
      const snap = await worldcup.snapshot({ ttlMs: 60000, sims: 0 });
      const g = snap.tables.find((t) => t.label.toUpperCase() === String(input.label || '').toUpperCase());
      if (!g) return { success: false, error: `group ${input.label} not found` };
      return { success: true, result: `Group ${g.label}\n` + g.table.map((r, i) => `${i + 1}. ${r.name} — ${r.Pts} pts (GD ${r.GD >= 0 ? '+' : ''}${r.GD})`).join('\n') };
    }
    if (action === 'odds') {
      const snap = await worldcup.snapshot({ ttlMs: 60000, sims: Number(input.sims) || 4000 });
      const r = Object.entries(snap.odds).sort((a, b) => b[1].W - a[1].W).slice(0, 10);
      return { success: true, result: 'Title odds:\n' + r.map(([ab, o]) => `${ab}: ${(o.W * 100).toFixed(1)}%`).join('\n') };
    }
    return { success: true, result: `Live World Cup standings: ${worldcup.STANDINGS_URL}`, url: worldcup.STANDINGS_URL };
  } catch (e) { return { success: false, error: 'world_cup: ' + (e.message || String(e)) }; }
}

// ---- cloud-native implementations ---------------------------------------------
async function webFetch({ url }) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'BhatBot/1.0' } });
    clearTimeout(t);
    const text = (await r.text()).slice(0, 50000);
    return { success: r.ok, status: r.status, text };
  } catch (e) { return { success: false, error: e.message }; }
}

// ---- registry -----------------------------------------------------------------
// Each: { def: <Anthropic tool schema>, relay?: true (dispatch to Mac), run?: fn }
const REGISTRY = {
  web_fetch: {
    def: { name: 'web_fetch', description: 'HTTP GET a URL and return its text (15s, 50KB cap). Use for live web info, APIs, pages. Runs in the cloud — always available.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    run: webFetch,
  },
  world_cup: {
    def: { name: 'world_cup', description: 'FIFA World Cup 2026 live data + analysis (cloud, always available). PICK BY INTENT: "open" — for "standings / scores / who\'s winning": returns a tappable auto-updating link, do NOT read tables out. "watch" — for "what should I watch / what\'s happening with the game / give me insights / fill me in": returns live scores + a RECOMMENDED match + key insights (prediction, Elo, recent form, group stakes) + a web scan of what people are saying; use it to give Siddhant YOUR opinion on what to watch plus a couple sharp insights, conversationally. "predict"{home,away} (cheap), "group"{label A–L} (cheap), "odds" (Monte-Carlo, expensive). Default "open".',
      input_schema: { type: 'object', properties: {
        action: { type: 'string', enum: ['open', 'watch', 'predict', 'group', 'odds', 'standings'] },
        home: { type: 'string' }, away: { type: 'string' }, label: { type: 'string' }, sims: { type: 'number' }
      } } },
    run: worldCup,
  },
  news: {
    def: { name: 'news', description: 'Skim the latest NYT headlines + abstracts (cloud-native, no login needed; Siddhant has a NYT account). Use for "what\'s the news / world news / today\'s headlines", and it powers the daily morning world-news skim. Returns a compact numbered list. sections: world (default), us, politics, business, technology, science, home.',
      input_schema: { type: 'object', properties: {
        section: { type: 'string', enum: ['world', 'us', 'politics', 'business', 'technology', 'science', 'home'] },
        limit: { type: 'number' }
      } } },
    run: async (input = {}) => {
      const r = await news.skim({ section: input.section || 'world', limit: Math.min(Number(input.limit) || 6, 15), apiKey: process.env.NYT_API_KEY || '' });
      return r.error ? { success: false, error: r.error } : { success: true, result: news.format(r), items: r.items };
    },
  },
  remember: {
    def: { name: 'remember', description: 'Persist a durable fact to long-term memory (preferences, decisions, personal facts, project state). One clear sentence.',
      input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
    run: async ({ fact }) => ({ success: db.saveMemory(fact, { source: 'agent' }), saved: fact }),
  },
  recall: {
    def: { name: 'recall', description: 'Search long-term memory for facts relevant to a query. Returns matching stored facts.',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    run: async ({ query }) => ({ success: true, facts: db.recallMemory(query, 8) }),
  },
  call_person: {
    def: { name: 'call_person', description: 'Place a REAL phone call (via Twilio) to a phone number on Siddhant\'s behalf and converse to accomplish a goal, then text him a summary. Use when he asks to call/phone someone. Provide the number in E.164 (e.g. +16095551234) and a clear purpose. Returns immediately; the call runs autonomously.',
      input_schema: { type: 'object', properties: { to: { type: 'string', description: 'Phone number in E.164, e.g. +16095551234' }, purpose: { type: 'string', description: 'What to accomplish on the call, in plain language.' } }, required: ['to', 'purpose'] } },
    run: async ({ to, purpose }) => twilio ? twilio.placeCall(to, purpose) : { success: false, error: 'calling not available' },
  },
  text_person: {
    def: { name: 'text_person', description: 'Send an SMS (via Twilio) to a phone number on Siddhant\'s behalf. E.164 number + message.',
      input_schema: { type: 'object', properties: { to: { type: 'string' }, message: { type: 'string' } }, required: ['to', 'message'] } },
    run: async ({ to, message }) => { if (!twilio || !twilio.configured()) return { success: false, error: 'texting not available' }; await twilio.sendSMS(to, message); return { success: true, result: `Texted ${to}.` }; },
  },
  brief_owner: {
    def: { name: 'brief_owner', description: 'CALL Siddhant on the phone and give him a spoken status update / briefing, then stay on the line in command mode so he can give you instructions which you execute live. Use for scheduled check-ins or when you proactively need to update him by voice. Provide the spoken opening briefing.',
      input_schema: { type: 'object', properties: { message: { type: 'string', description: 'The spoken briefing to open the call with (warm, concise, a few sentences).' } }, required: ['message'] } },
    run: async ({ message }) => twilio ? twilio.briefOwner(message) : { success: false, error: 'calling not available' },
  },
  ask_owner: {
    def: { name: 'ask_owner', description: 'CALL Siddhant on the phone to get a decision or information only HE can provide, when you are genuinely blocked mid-task (e.g. a choice, an approval, a value you do not have). He answers by voice and his spoken reply is returned to you so you can continue. Use sparingly — only when you truly cannot proceed without his input.',
      input_schema: { type: 'object', properties: { question: { type: 'string', description: 'One clear spoken-style question to ask him.' } }, required: ['question'] } },
    run: async ({ question }) => twilio ? twilio.askOwner(question) : { success: false, error: 'calling not available' },
  },
  contacts: {
    def: { name: 'contacts', description: "Look up / annotate Siddhant's contacts (imported from his Mac). Use to resolve who someone is, find a number to call/text, or record context about a person. action: lookup (by name or phone number), search (fuzzy over name/note/number), list (names only), who_is (set/append a note describing who a contact is and how to deal with them — Siddhant's own context). Runs in the cloud — always available.",
      input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['lookup', 'search', 'list', 'who_is'] }, query: { type: 'string', description: 'name or phone number (lookup/search)' }, name: { type: 'string', description: 'contact name/id (who_is)' }, note: { type: 'string', description: 'the context to store about this person (who_is)' } }, required: ['action'] } },
    run: async ({ action, query, name, note }) => {
      if (action === 'list') { const all = db.getContacts(); return { success: true, count: all.length, names: all.map((c) => c.name) }; }
      if (action === 'lookup') { const c = db.findContactByPhone(query) || db.searchContacts(query, 1)[0]; return c ? { success: true, contact: c } : { success: false, error: 'no match for ' + query }; }
      if (action === 'search') { return { success: true, matches: db.searchContacts(query, 8) }; }
      if (action === 'who_is') { const c = db.setContactNote(name, note); return c ? { success: true, contact: c } : { success: false, error: 'no contact named ' + name }; }
      return { success: false, error: 'unknown contacts action: ' + action };
    },
  },
  // ---- Mac-relay tools (run on the computer when it's awake) -------------------
  run_shell: {
    def: { name: 'run_shell', description: 'Run a shell command on Siddhant’s Mac (needs the computer awake + connected). rm/rmdir/trash are blocked from remote for safety.',
      input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } },
    relay: true,
  },
  read_file: {
    def: { name: 'read_file', description: 'Read a text file on the Mac (absolute path). Needs the computer awake.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    relay: true,
  },
  write_file: {
    def: { name: 'write_file', description: 'Write a text file on the Mac (absolute path). Needs the computer awake.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    relay: true,
  },
  list_directory: {
    def: { name: 'list_directory', description: 'List a directory on the Mac. Needs the computer awake.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    relay: true,
  },
  open_in_browser: {
    def: { name: 'open_in_browser', description: 'Open a URL in the Mac’s default browser. Needs the computer awake.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    relay: true,
  },
  system_control: {
    def: { name: 'system_control', description: 'macOS GUI/system automation on the Mac (open/quit/activate apps, keystroke, menu, clipboard, AppleScript, notification). Needs the computer awake.',
      input_schema: { type: 'object', properties: { action: { type: 'string' }, app: { type: 'string' }, text: { type: 'string' }, script: { type: 'string' }, key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, menuPath: { type: 'array', items: { type: 'string' } } }, required: ['action'] } },
    relay: true,
  },
  media_control: {
    def: { name: 'media_control', description: 'Control Spotify on the Mac/Connect devices (play, pause, next, search_and_play, make_playlist, set_volume). Needs the computer awake.',
      input_schema: { type: 'object', properties: { action: { type: 'string' }, query: { type: 'string' }, volume: { type: 'number' }, device: { type: 'string' }, name: { type: 'string' }, tracks: { type: 'array', items: { type: 'string' } } }, required: ['action'] } },
    relay: true,
  },
  play_chess: {
    def: { name: 'play_chess', description: 'Open a playable chess game (full rules + Stockfish AI opponent) in a window on the Mac. Use when Siddhant wants to play chess. Optional difficulty. Needs the computer awake.',
      input_schema: { type: 'object', properties: { difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] } } } },
    relay: true,
  },
  screen_observe: {
    def: { name: 'screen_observe', description: 'Watch Siddhant\'s whole Mac screen to learn how he works — only when he TELLS you to ("watch my screen"). His command is the consent. action:"start"{minutes} begins; "review" returns notes; "save"{items} stores approved items; "stop" ends. No screenshots saved, secrets skipped. Needs the computer awake.',
      input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'stop', 'status', 'review', 'save', 'snapshot', 'clear'] }, minutes: { type: 'number' }, everySeconds: { type: 'number' }, items: { type: 'array', items: { type: 'string' } } }, required: ['action'] } },
    relay: true,
  },
  project: {
    def: { name: 'project', description: 'Open and track a project with a living, auto-updating summary on the Mac. action: open/list/status/note/summary/close. Use "open" when Siddhant starts/switches to a project so BhatBot keeps its context. Needs the computer awake (queues if asleep).',
      input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['open', 'list', 'status', 'note', 'summary', 'close'] }, name: { type: 'string' }, text: { type: 'string' }, kind: { type: 'string', enum: ['note', 'decision', 'milestone'] } }, required: ['action'] } },
    relay: true,
  },
  ambient: {
    def: { name: 'ambient', description: 'Inspect/control ambient awareness (Calendar/Mail) on the Mac. action: "read"{source:"mail"|"calendar"} pulls that source ON DEMAND right now (use for "any important emails?" or the morning brief — works even if background monitoring is off); "scan" runs enabled watchers; status/enable/disable manage background monitoring. Needs the computer awake.',
      input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['read', 'scan', 'status', 'enable', 'disable'] }, source: { type: 'string', enum: ['calendar', 'mail'] } }, required: ['action'] } },
    relay: true,
  },
  subagent: {
    def: { name: 'subagent', description: 'Delegate to a persistent specialized sub-agent on the Mac (research/coding/lifeadmin), each with its own memory + scoped tools. action: run/list/history/reset; run{agent,task,background}. Needs the computer awake.',
      input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['run', 'list', 'history', 'reset'] }, agent: { type: 'string', enum: ['research', 'coding', 'lifeadmin'] }, task: { type: 'string' }, background: { type: 'boolean' } }, required: ['action'] } },
    relay: true,
  },
  wake_mac: {
    def: { name: 'wake_mac', description: 'Check whether Siddhant\'s Mac is awake/connected and ready for computer tasks. If it\'s asleep, any computer task you then issue is QUEUED and runs automatically the moment it wakes (he gets texted the result). Use when a computer task is needed and you\'re unsure the Mac is up, or when he says "wake my computer".',
      input_schema: { type: 'object', properties: {} } },
    run: async () => (macOnline()
      ? { success: true, awake: true, result: 'Your computer is awake and connected.' }
      : { success: true, awake: false, result: 'Your computer appears asleep. It stays reachable while plugged in (it keeps itself awake on AC power). Anything you ask me to do on it now will be queued and run the instant it wakes — I\'ll text you the result.' }),
  },
};

function toolDefs() { return Object.values(REGISTRY).map((t) => t.def); }
function isRelay(name) { return !!(REGISTRY[name] && REGISTRY[name].relay); }

// Capability tiers (#17): high-blast-radius tools require a STEPPED-UP channel. Voice command
// mode is passphrase-gated (stepped up); SMS is NOT (caller-ID/number is spoofable and there's no
// passphrase), so high-risk tools are denied over SMS even from the owner number. Phone-channel
// compromise is a different threat model than physical Mac access — scope tools accordingly.
const HIGH_RISK = new Set(['run_shell', 'system_control', 'write_file', 'subagent']);
const UNTRUSTED_CHANNELS = new Set(['sms']);
function channelAllows(name, channel) { return !(HIGH_RISK.has(name) && UNTRUSTED_CHANNELS.has(channel)); }

async function dispatchTool(name, input, source) {
  const t = REGISTRY[name];
  if (!t) return { success: false, error: 'unknown tool: ' + name };
  if (!channelAllows(name, source)) {
    try { db.logTool({ source: source || 'cloud', tool: name, args: input, ok: false, ms: 0, result: 'denied: high-risk over untrusted channel' }); } catch {}
    return { success: false, error: `"${name}" is a high-risk tool and is blocked over ${source}. Call from voice command mode (passphrase-gated) instead.` };
  }
  const start = Date.now();
  let res;
  try {
    if (t.relay) {
      res = await macExec(name, input || {});
      // Mac asleep → don't just fail: queue the command so it runs when the computer wakes.
      if (res && res.offline) res = queueExec(name, input || {});
    } else {
      res = await t.run(input || {});
    }
  } catch (e) { res = { success: false, error: String(e && e.message ? e.message : e) }; }
  // Append-only audit trail of every tool call (args redacted in db.logTool).
  try {
    db.logTool({ source: source || (t.relay ? 'cloud→mac' : 'cloud'), tool: name, args: input,
      ok: res && res.success !== false, ms: Date.now() - start,
      result: res && (res.error || res.result || (res.success !== false ? 'ok' : '')) });
  } catch {}
  return res;
}

module.exports = { toolDefs, dispatchTool, isRelay, macOnline };
