'use strict';
// Tool registry for the cloud agent. Two classes:
//   • CLOUD-NATIVE — run right here (web fetch, durable memory). Always available.
//   • MAC-RELAY    — dispatched to the Mac executor over the WebSocket relay when it's online,
//     else they return a graceful "computer offline". Names match the desktop's executeTool
//     tool names EXACTLY, so the Mac bridge can run them with no translation.
const db = require('./db');
const { macExec, macOnline } = require('./relay');
let twilio = null; try { twilio = require('./twilio'); } catch {}

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
};

function toolDefs() { return Object.values(REGISTRY).map((t) => t.def); }
function isRelay(name) { return !!(REGISTRY[name] && REGISTRY[name].relay); }

async function dispatchTool(name, input) {
  const t = REGISTRY[name];
  if (!t) return { success: false, error: 'unknown tool: ' + name };
  try {
    if (t.relay) return await macExec(name, input || {});
    return await t.run(input || {});
  } catch (e) { return { success: false, error: String(e && e.message ? e.message : e) }; }
}

module.exports = { toolDefs, dispatchTool, isRelay, macOnline };
