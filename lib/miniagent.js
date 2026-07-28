'use strict';
// ── MINIAGENT — a real tool-loop for the headless worker ──────────────────────────────────────────
// Scheduled tasks were persisted to disk but only ever executed by a timer inside the Electron app,
// so a daily job simply did not happen on a day nobody opened the window. This is the execution path
// that fixes that: a small Claude tool-loop that runs in a plain node process.
//
// WHAT IT DELIBERATELY CANNOT DO. The headless process has no Electron `safeStorage`, so no vault; no
// window, so no browser/vision/screen tools; and it runs unattended, so a mistake has nobody to catch
// it. The tool set is therefore an ALLOW-LIST of read-only, side-effect-free operations. There is no
// run_shell, no write_file, no browser, no credential access. This is not a smaller copy of the main
// agent and must never grow into one — anything that acts on the world belongs in the app, where a
// human is present and the risk tiers in lib/risk.js apply.
//
// THE DEFER MECHANISM is what makes that restriction safe rather than merely limiting. When a task
// needs a capability this process lacks — reading Mail.app, sending a message, touching a file — the
// model calls `defer_to_app` instead of improvising a worse answer from what it can reach. The caller
// then leaves the schedule DUE so the full agent runs it properly on next launch. A half-done brief
// that quietly omits your email is worse than no brief; deferring says so out loud.

const fs = require('fs');
const os = require('os');
const path = require('path');
const llm = require('./llm');
const websearch = require('./websearch');

const HOME = os.homedir();
const MAX_STEPS = 12;
const MAX_TOOL_CHARS = 12000;

// Never readable, even though this loop is "read-only" — reading a secret is itself the leak.
const SECRET_RE = /(\.bhatbot\/(config|credentials)\.json|\.ssh|\.aws|\.env|id_rsa|\.netrc|keychain|\.gnupg)/i;

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web. Returns titles, snippets and URLs. Has a keyless fallback, so this always works.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'fetch_url',
    description: 'Fetch a URL and return its readable text (HTML stripped, truncated). Use after web_search to read a promising result.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'read_file',
    description: "Read a text file under the user's home directory. Secrets and credential stores are refused.",
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'list_directory',
    description: "List a directory under the user's home directory.",
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'defer_to_app',
    description: 'Call this the moment the task needs something you cannot do here — reading Mail.app or Calendar, sending a message or email, running a command, controlling an app, opening a browser, or anything touching credentials. Say which capability is missing. The task will then be run properly by the full agent when the desktop app next opens. ALWAYS prefer this over guessing, over using a weaker substitute, or over silently reporting only the part you managed — an incomplete answer that does not admit what it skipped is worse than no answer.',
    input_schema: { type: 'object', properties: { needs: { type: 'string', description: 'The capability you need, e.g. "Mail.app inbox read".' }, partial: { type: 'string', description: 'Anything useful you DID establish, so the work is not wasted (optional).' } }, required: ['needs'] },
  },
];

const SYSTEM = `You are BhatBot running as an unattended BACKGROUND worker on Siddhant's Mac. Nobody is watching a screen; your output is written to a file and may be pushed to his phone.

You have only read-only tools: web_search, fetch_url, read_file, list_directory. You have NO access to Mail, Calendar, Messages, the browser, the shell, or any credential.

Rules:
- If the task needs a capability you do not have, call defer_to_app immediately and stop. Do not substitute a weaker source, and do not answer only the part you could reach without saying so.
- Report ONLY what you actually read. Never invent a headline, an email, a sender, a number, or a source.
- Be concise and concrete — a few short paragraphs or a tight list. This is read on a phone.
- If a source fails or returns nothing, say that plainly rather than filling the gap.`;

function safePath(p) {
  const abs = path.resolve(String(p || '').replace(/^~(?=$|\/)/, HOME));
  if (!abs.startsWith(HOME)) return { ok: false, error: 'outside the home directory — refused' };
  if (SECRET_RE.test(abs)) return { ok: false, error: 'that path holds credentials — refused' };
  return { ok: true, abs };
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function runTool(name, input, { config = {}, log = () => {}, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    if (name === 'web_search') {
      const r = await websearch.search({ query: input.query, limit: Math.min(Number(input.limit) || 6, 10), config });
      if (!r.ok) return { error: r.error || 'search failed' };
      return { provider: r.provider, results: (r.items || []).map((i) => ({ title: i.title, url: i.url, snippet: String(i.snippet || '').slice(0, 400) })) };
    }
    if (name === 'fetch_url') {
      const u = String(input.url || '');
      if (!/^https?:\/\//i.test(u)) return { error: 'only http(s) URLs' };
      const res = await doFetch(u, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'BhatBot/1.0 (background worker)' } });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const body = await res.text();
      return { url: u, text: htmlToText(body).slice(0, MAX_TOOL_CHARS) };
    }
    if (name === 'read_file') {
      const s = safePath(input.path);
      if (!s.ok) return { error: s.error };
      return { path: s.abs, text: fs.readFileSync(s.abs, 'utf8').slice(0, MAX_TOOL_CHARS) };
    }
    if (name === 'list_directory') {
      const s = safePath(input.path);
      if (!s.ok) return { error: s.error };
      return { path: s.abs, entries: fs.readdirSync(s.abs, { withFileTypes: true }).slice(0, 200).map((d) => d.name + (d.isDirectory() ? '/' : '')) };
    }
    return { error: 'unknown tool: ' + name };
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 300) }; }
}

/**
 * run(task, opts) → { text, deferred, needs, partial, steps, toolsUsed, error }
 * `deferred: true` means the caller must NOT mark the task done — the full agent has to run it.
 */
async function run(task, { apiKey, config = {}, maxSteps = MAX_STEPS, log = () => {}, fetchImpl, llmImpl } = {}) {
  const ask = llmImpl || ((body) => llm.anthropicRequest(body, { apiKey, log }));
  const messages = [{ role: 'user', content: String(task) }];
  const toolsUsed = [];

  for (let step = 0; step < maxSteps; step++) {
    let resp;
    try { resp = await ask({ model: llm.DEFAULT_MODEL, max_tokens: 2048, system: SYSTEM, tools: TOOLS, messages }); }
    catch (e) { return { text: null, error: String((e && e.message) || e).slice(0, 300), steps: step, toolsUsed, deferred: false }; }

    const content = resp.content || [];
    const uses = content.filter((b) => b.type === 'tool_use');
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

    if (!uses.length) return { text: text || null, deferred: false, steps: step + 1, toolsUsed, error: text ? null : 'model returned no text' };

    messages.push({ role: 'assistant', content });
    const results = [];
    for (const u of uses) {
      toolsUsed.push(u.name);
      if (u.name === 'defer_to_app') {
        log(`[miniagent] deferring — needs ${u.input.needs}`);
        return { text: text || null, deferred: true, needs: String(u.input.needs || 'an unavailable capability'), partial: u.input.partial || null, steps: step + 1, toolsUsed };
      }
      const out = await runTool(u.name, u.input || {}, { config, log, fetchImpl });
      log(`[miniagent] ${u.name}${out.error ? ' → ' + out.error : ''}`);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, MAX_TOOL_CHARS), is_error: !!out.error });
    }
    messages.push({ role: 'user', content: results });
  }

  // Out of steps. Ask for whatever it has rather than returning nothing.
  messages.push({ role: 'user', content: '[Step budget reached. Do NOT call more tools. Summarize what you found, and state plainly what you could not finish.]' });
  try {
    const r = await ask({ model: llm.DEFAULT_MODEL, max_tokens: 1024, system: SYSTEM, messages });
    const t = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text: t || null, deferred: false, steps: maxSteps, toolsUsed, truncated: true };
  } catch (e) { return { text: null, error: String((e && e.message) || e).slice(0, 300), steps: maxSteps, toolsUsed, deferred: false }; }
}

module.exports = { run, runTool, safePath, htmlToText, TOOLS, SYSTEM, MAX_STEPS };
