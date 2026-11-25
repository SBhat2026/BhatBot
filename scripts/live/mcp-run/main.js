const { app } = require('electron');
app.setName('bhatbot');
app.requestSingleInstanceLock = () => true;
app.whenReady().then(async () => {
  try {
    const fs = require('fs');
    const credentials = require(require('path').join(__dirname, '../../../lib/credentials'));
    const c = credentials.resolveRefs(JSON.parse(fs.readFileSync(require('os').homedir() + '/.bhatbot/config.json', 'utf8')));
    const url = `http://127.0.0.1:${c.mcpPort || 8788}/mcp/${c.mcpToken}`;
    const instruction = process.env.INSTR;
    const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const call = async (body, sid) => {
      const r = await fetch(url, { method: 'POST', headers: sid ? { ...H, 'mcp-session-id': sid } : H, body: JSON.stringify(body) });
      return { sid: r.headers.get('mcp-session-id'), text: await r.text() };
    };
    const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
    await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid);
    const res = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_task', arguments: { instruction, new_conversation: true } } }, init.sid);
    const m = res.text.match(/"text":"((?:[^"\\]|\\.)*)"/);
    console.log('PROBE', m ? JSON.parse('"' + m[1] + '"') : res.text.slice(0, 2000));
  } catch (e) { console.log('ERR', e.message); }
  app.exit(0);
});
