'use strict';
// MCP-client hub — lets BhatBot consume EXTERNAL MCP servers as plugins (the inverse of mcp-server.js,
// which exposes BhatBot's own tools). Each configured plugin is spawned over stdio; its tools are
// discovered and surfaced to the agent loop namespaced as `mcp__<plugin>__<tool>`. All best-effort:
// a plugin that fails to start is skipped and logged, never crashing the app.
//
// config.mcpPlugins: [{ name, command, args?, env?, enabled?, cwd? }]
//   e.g. { name: 'filesystem', command: 'npx', args: ['-y','@modelcontextprotocol/server-filesystem','/Users/me/Docs'] }

let Client, StdioClientTransport;
try {
  ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
  ({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'));
} catch (e) { /* SDK missing → hub stays inert */ }

const NS = 'mcp__';
const clients = new Map();   // pluginName -> { client, transport, tools:[{name,description,inputSchema}] }

function available() { return !!(Client && StdioClientTransport); }

function toolId(plugin, tool) { return `${NS}${plugin}__${tool}`; }
function parseId(id) {
  if (!id || !id.startsWith(NS)) return null;
  const rest = id.slice(NS.length);
  const i = rest.indexOf('__');
  if (i < 0) return null;
  return { plugin: rest.slice(0, i), tool: rest.slice(i + 2) };
}

// Connect one plugin; discover its tools. Returns the count of tools, or 0 on failure.
async function connectOne(spec, { log = () => {} } = {}) {
  if (!available() || !spec || !spec.name || !spec.command) return 0;
  if (spec.enabled === false) return 0;
  if (clients.has(spec.name)) return clients.get(spec.name).tools.length;
  try {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args || [],
      env: { ...process.env, ...(spec.env || {}) },
      cwd: spec.cwd || undefined,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'bhatbot', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = (listed.tools || []).map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object' } }));
    clients.set(spec.name, { client, transport, tools });
    log(`[mcphub] connected '${spec.name}' — ${tools.length} tool(s)`);
    return tools.length;
  } catch (e) {
    log(`[mcphub] plugin '${spec.name}' failed: ${(e && e.message) || e}`);
    return 0;
  }
}

// Connect every enabled plugin from config. Returns { plugins:[{name,tools}], total }.
async function connectAll(specs = [], opts = {}) {
  const enabled = (specs || []).filter((s) => s && s.enabled !== false);
  for (const s of enabled) await connectOne(s, opts);
  return status();
}

// Tool-schema entries for the agent loop (Anthropic tool format), namespaced + prefixed descriptions.
function toolSchemas() {
  const out = [];
  for (const [plugin, entry] of clients) {
    for (const t of entry.tools) {
      out.push({
        name: toolId(plugin, t.name),
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
    // Flatten the standard content array into text for the model.
    const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { success: !res.isError, result: text || res.content, isError: !!res.isError };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
}

function status() {
  const plugins = [...clients.entries()].map(([name, e]) => ({ name, tools: e.tools.map((t) => t.name) }));
  return { plugins, total: plugins.reduce((n, p) => n + p.tools.length, 0), available: available() };
}

async function disconnectAll() {
  for (const [, e] of clients) { try { await e.client.close(); } catch {} }
  clients.clear();
}

module.exports = { available, connectOne, connectAll, toolSchemas, toolId, parseId, isHubTool, callTool, status, disconnectAll, NS };
