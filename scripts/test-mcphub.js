'use strict';
// MCP-client hub unit test — id namespacing, routing, and inert-when-empty behavior. No external
// server is spawned; we assert the pure surface (parseId/toolId/isHubTool/toolSchemas/callTool guard).
const assert = require('assert');
const hub = require('../lib/mcphub');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// SDK present in this repo → hub is available.
ok(hub.available() === true, 'hub available (SDK loaded)');

// id round-trip
const id = hub.toolId('resolve', 'render');
ok(id === 'mcp__resolve__render', 'toolId namespaces correctly');
const p = hub.parseId(id);
ok(p && p.plugin === 'resolve' && p.tool === 'render', 'parseId splits plugin/tool');
ok(hub.parseId('read_file') === null, 'native tool id → not a hub id');
// tool names containing __ survive the split (only the first __ separates plugin from tool)
const p2 = hub.parseId('mcp__fs__list__dir');
ok(p2 && p2.plugin === 'fs' && p2.tool === 'list__dir', 'parseId keeps inner __ in tool name');

ok(hub.isHubTool('mcp__x__y') === true, 'isHubTool true for namespaced');
ok(hub.isHubTool('gmail') === false, 'isHubTool false for native');

// No plugins connected yet → no schemas, empty status.
ok(Array.isArray(hub.toolSchemas()) && hub.toolSchemas().length === 0, 'no schemas before connect');
const st = hub.status();
ok(st.total === 0 && Array.isArray(st.plugins), 'status empty before connect');

// callTool on an unconnected plugin → graceful error, never throws.
hub.callTool('mcp__nope__do', {}).then((r) => {
  ok(r && r.success === false && /not connected/i.test(r.error), 'callTool on missing plugin → graceful error');
  // Bad spec → connectOne returns 0, doesn't throw.
  return hub.connectOne({ name: 'bad', command: 'definitely-not-a-real-binary-xyz', args: [] }, { log: () => {} });
}).then((cnt) => {
  ok(cnt === 0, 'connectOne on a bad command → 0 tools, no throw');
  console.log(`✅ mcphub: ${n} assertions passed`);
}).catch((e) => { console.error('❌ mcphub:', e.message); process.exit(1); });
