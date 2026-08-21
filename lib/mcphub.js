'use strict';
// MCP-client hub — lets BhatBot consume EXTERNAL MCP servers as plugins (the inverse of mcp-server.js,
// which exposes BhatBot's own tools). Tools are discovered and surfaced to the agent loop namespaced
// as `mcp__<plugin>__<tool>`. All best-effort: a plugin that fails to start is skipped and logged,
// never crashing the app.
//
// TWO TRANSPORTS:
//   stdio      — a local process.  { name, command, args?, env?, cwd? }
//   http       — a REMOTE connector, the same shape Claude.ai's Integrations use:
//                { name, transport:'http', url, auth:{ type:'bearer', token } }
//                Streamable HTTP with an automatic fall back to SSE for older servers.
//
// The http transport is what makes a hosted connector (Seedance, Notion, Linear…) usable here
// without running anything locally — see lib/connectors.js for the registry that configures them.
//
// ── SECURITY: the environment handed to a stdio plugin is ALLOW-LISTED ────────────────────────────
// This module used to spawn every plugin with `env: { ...process.env }`. That is the exact thing
// lib/sandboxexec.js exists to prevent, and it was worse here than it looks: main.js's
// syncResolvedSecretsToEnv() deliberately bridges resolved vault secrets INTO process.env, so a
// third-party MCP server — an `npx -y some-package` that auto-updates on every launch — was handed
// ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, BHATBOT_MCP_TOKEN and the user's whole shell
// environment, and could ship them anywhere. A plugin now receives PATH, locale, and the variables
// its own spec names. Allow-list, never deny-list: a secret added to the env later is excluded by
// construction rather than by remembering to add it to a blocklist.

let Client, StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport;
try {
  ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
  ({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'));
} catch (e) { /* SDK missing → hub stays inert */ }
try { ({ StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')); } catch {}
try { ({ SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js')); } catch {}

const NS = 'mcp__';
const clients = new Map();   // pluginName -> { client, transport, tools, kind, url? }

// Non-secret, non-optional variables. PATH is how a command is found at all; the rest only affect
// text formatting. Nothing here can authenticate to anything.
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME'];

/**
 * Build the environment for a stdio plugin: SAFE_ENV_KEYS + exactly what the spec asks for.
 *
 * `spec.env` values may be either a literal or `"$SOME_VAR"`, which forwards that one variable from
 * the parent environment. The indirection is the point — it lets a spec say "give this plugin
 * ACEDATACLOUD_API_TOKEN" without the token itself ever being written into config.json, and it keeps
 * the forwarding explicit and per-plugin instead of implicit and global.
 */
function pluginEnv(spec) {
  const env = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] != null) env[k] = process.env[k];
  for (const [k, v] of Object.entries((spec && spec.env) || {})) {
    if (typeof v === 'string' && v.startsWith('$')) {
      const from = process.env[v.slice(1)];
      if (from != null) env[k] = from;                 // forward one named variable, nothing else
    } else if (v != null) env[k] = String(v);
  }
  return env;
}

function available() { return !!(Client && StdioClientTransport); }
function httpAvailable() { return !!(Client && (StreamableHTTPClientTransport || SSEClientTransport)); }

function toolId(plugin, tool) { return `${NS}${plugin}__${tool}`; }
function parseId(id) {
  if (!id || !id.startsWith(NS)) return null;
  const rest = id.slice(NS.length);
  const i = rest.indexOf('__');
  if (i < 0) return null;
  return { plugin: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/** Auth headers for an http connector. Kept in one place so a token is never assembled ad hoc. */
function authHeaders(spec) {
  const a = spec && spec.auth;
  if (!a) return {};
  const token = typeof a.token === 'string' && a.token.startsWith('$') ? process.env[a.token.slice(1)] : a.token;
  if (!token) return {};
  if (a.type === 'header') return { [a.header || 'X-API-Key']: token };
  return { Authorization: `Bearer ${token}` };          // bearer is the default and the common case
}

/**
 * Build a transport for a remote connector. Streamable HTTP first (the current spec), SSE as the
 * fallback for servers that predate it — the same negotiation Claude.ai does.
 */
function httpTransport(spec, { sse = false } = {}) {
  const url = new URL(spec.url);
  const headers = { ...authHeaders(spec), ...(spec.headers || {}) };
  const opts = { requestInit: { headers }, headers };   // both spellings: SSE reads .headers, HTTP reads .requestInit
  if (sse) {
    if (!SSEClientTransport) return null;
    return new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { headers } });
  }
  if (!StreamableHTTPClientTransport) return null;
  return new StreamableHTTPClientTransport(url, opts);
}

/** Reject if `p` has not settled within `ms`. The SDK transports have no usable connect deadline. */
function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms); }),
  ]);
}

// Connect one plugin; discover its tools. Returns the count of tools, or 0 on failure.
//
// TIMEOUT IS LOAD-BEARING. Observed live after the Mac woke from sleep: the streamable-HTTP attempt
// hung, the SSE fallback hung behind it, and the whole thing took NINE MINUTES to fail — during
// which startMcpHub was blocked and, because connectAll used to await each plugin in series, every
// other connector was blocked too. It then ended at "0 tool(s)" for the rest of the session, so the
// connector's tools silently did not exist until the app was restarted.
async function connectOne(spec, { log = () => {}, timeoutMs = 20000 } = {}) {
  if (!Client || !spec || !spec.name) return 0;
  if (spec.enabled === false) return 0;
  if (clients.has(spec.name)) return clients.get(spec.name).tools.length;
  const isHttp = spec.transport === 'http' || spec.transport === 'sse' || (!spec.command && !!spec.url);
  if (!isHttp && (!StdioClientTransport || !spec.command)) return 0;
  if (isHttp && !httpAvailable()) { log(`[mcphub] '${spec.name}' needs an HTTP transport the installed MCP SDK does not provide`); return 0; }

  // ── TRANSPORTS RACE, THEY DO NOT QUEUE ──────────────────────────────────────────────────────
  // Streamable HTTP and SSE used to be tried one after the other, so a server that accepts neither
  // cost 2× the timeout, and — worse — a server that only speaks SSE paid the FULL HTTP timeout
  // before SSE was even attempted. That is the shape of the nine-minute stall: the slow path was
  // always walked first and the working path waited behind it.
  //
  // Both are now dialled at once and the FIRST ONE TO PRODUCE A TOOL LIST WINS; the loser is closed.
  // Worst case is one timeout instead of two, and an SSE-only server connects at SSE's speed rather
  // than at HTTP-timeout + SSE's speed. Nothing is lost by trying both: an MCP server that does not
  // speak a transport simply refuses it, and connecting is idempotent from the client side.
  const modes = isHttp ? [{ sse: false }, { sse: true }] : [null];

  const dial = async (mode) => {
    let transport;
    try {
      transport = isHttp ? httpTransport(spec, mode) : new StdioClientTransport({
        command: spec.command,
        args: spec.args || [],
        env: pluginEnv(spec),                 // ALLOW-LISTED — see the header note
        cwd: spec.cwd || undefined,
        stderr: 'ignore',
      });
      if (!transport) throw new Error('transport unavailable');
      const client = new Client({ name: 'bhatbot', version: '1.0.0' }, { capabilities: {} });
      await withTimeout(client.connect(transport), timeoutMs, `connect '${spec.name}'`);
      const listed = await withTimeout(client.listTools(), timeoutMs, `listTools '${spec.name}'`);
      const tools = (listed.tools || []).map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object' } }));
      return { client, transport, tools, kind: isHttp ? (mode.sse ? 'sse' : 'http') : 'stdio' };
    } catch (e) {
      // Do NOT await the close. Closing a transport whose socket is already wedged hangs too, which
      // put the timeout straight back: bounding connect at 5s but then blocking ~100s in cleanup
      // means the deadline bought nothing. Fire it and move on; the socket is gone either way.
      try { if (transport && transport.close) Promise.resolve(transport.close()).catch(() => {}); } catch {}
      throw e;
    }
  };

  // Promise.any, NOT allSettled: we must return the moment ONE transport works, not when the last
  // one gives up. allSettled here made a healthy connector wait out the loser's full timeout — a
  // 5s connect became 15s, which is the same "slow path gates the working path" bug in a new place.
  // Losers are reaped asynchronously so cleanup never sits on the critical path either.
  let won = false;
  const attempts = modes.map((mode) => dial(mode).then((res) => {
    if (won) { try { Promise.resolve(res.client.close()).catch(() => {}); } catch {} return Promise.reject(new Error('lost the race')); }
    won = true;
    return res;
  }));
  let w;
  try {
    w = await Promise.any(attempts);
  } catch (agg) {
    const errs = (agg && agg.errors) || [];
    const err = errs.map((e) => e && e.message).filter((m) => m && m !== 'lost the race')[0] || (agg && agg.message) || 'all transports failed';
    log(`[mcphub] plugin '${spec.name}' failed: ${err}`);
    return 0;
  }
  attempts.forEach((p2) => p2.catch(() => {}));   // silence the loser's rejection
  clients.set(spec.name, { client: w.client, transport: w.transport, tools: w.tools, kind: w.kind, url: spec.url || null });
  // NEVER log the spec: it carries the bearer token. Host only.
  const where = isHttp ? ` (${w.kind} · ${(() => { try { return new URL(spec.url).host; } catch { return '?'; } })()})` : '';
  log(`[mcphub] connected '${spec.name}'${where} — ${w.tools.length} tool(s)`);
  return w.tools.length;
}

// Connect every enabled plugin from config. Returns { plugins:[{name,tools}], total, failed:[names] }.
//
// PARALLEL, not serial. Connectors are independent remote endpoints; awaiting them one at a time
// made the slowest one set the floor for all of them (and, before connectOne had a timeout, a single
// hung endpoint blocked the rest indefinitely). Failures are collected rather than thrown so one
// unreachable connector cannot take the others down with it.
async function connectAll(specs = [], opts = {}) {
  const enabled = (specs || []).filter((s) => s && s.enabled !== false);
  const results = await Promise.all(enabled.map((s) => connectOne(s, opts).then((n) => ({ name: s.name, n })).catch(() => ({ name: s.name, n: 0 }))));
  return { ...status(), failed: results.filter((r) => !r.n).map((r) => r.name) };
}

// Tool-schema entries for the agent loop (Anthropic tool format), namespaced + prefixed descriptions.
//
// `hidden` (a Map of toolId → superseding native tool, from lib/connectors.js) drops tools a native
// wrapper already covers. They remain CALLABLE — callTool() does not consult this — so the wrapper
// can still invoke them; they are simply not advertised to the model. That distinction matters:
// visual_build drives seedance_generate_video internally while the model only ever sees visual_build.
function toolSchemas({ hidden = null } = {}) {
  const out = [];
  for (const [plugin, entry] of clients) {
    for (const t of entry.tools) {
      const id = toolId(plugin, t.name);
      if (hidden && hidden.has(id)) continue;
      out.push({
        name: id,
        description: `[MCP:${plugin}] ${t.description}`.slice(0, 1024),
        input_schema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' },
      });
    }
  }
  return out;
}

function isHubTool(id) { return typeof id === 'string' && id.startsWith(NS); }

// Invoke a namespaced tool. Returns { success, result | error }.
async function callTool(id, input = {}) {
  const parsed = parseId(id);
  if (!parsed) return { success: false, error: 'not an MCP tool id: ' + id };
  const entry = clients.get(parsed.plugin);
  if (!entry) return { success: false, error: `MCP plugin '${parsed.plugin}' is not connected` };
  try {
    const res = await entry.client.callTool({ name: parsed.tool, arguments: input || {} });
    // Flatten the standard content array into text for the model, but keep non-text parts (image
    // and resource blocks — how a video/image connector returns its artifact) so callers can use them.
    const parts = res.content || [];
    const text = parts.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const media = parts.filter((c) => c.type !== 'text');
    return { success: !res.isError, result: text || parts, isError: !!res.isError, ...(media.length ? { media } : {}) };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
}

function status() {
  const plugins = [...clients.entries()].map(([name, e]) => ({ name, kind: e.kind, tools: e.tools.map((t) => t.name) }));
  return { plugins, total: plugins.reduce((n, p) => n + p.tools.length, 0), available: available(), http: httpAvailable() };
}

async function disconnectAll() {
  for (const [, e] of clients) { try { await e.client.close(); } catch {} }
  clients.clear();
}

module.exports = {
  available, httpAvailable, connectOne, connectAll, toolSchemas, toolId, parseId, isHubTool,
  callTool, status, disconnectAll, NS, pluginEnv, authHeaders, SAFE_ENV_KEYS,
};
