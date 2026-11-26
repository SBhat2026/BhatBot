// Live probe: send ONE message exactly as the phone does (POST /api/<token>/chat over the Mac's Funnel)
// and report the round trip. MSG=... (default: a one-word reply). Costs one small model turn.
const { app } = require('electron');
app.setName('bhatbot');
app.whenReady().then(async () => {
  try {
    const fs = require('fs'), os = require('os'), path = require('path');
    const c = require(path.join(__dirname, '../../../lib/credentials')).resolveRefs(JSON.parse(fs.readFileSync(os.homedir() + '/.bhatbot/config.json', 'utf8')));
    const host = process.env.VIA === 'local' ? `http://127.0.0.1:${c.mcpPort || 8788}` : `https://${c.publicHost}`;
    const t = Date.now();
    const r = await fetch(`${host}/api/${c.mcpToken}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: process.env.MSG || 'Latency test: reply with just the word ok.' }) });
    const j = await r.json();
    console.log(`CHAT ${r.status} roundtrip=${Date.now() - t}ms server=${j.ms}ms reply=${JSON.stringify(String(j.text || j.error || '').slice(0, 120))}`);
  } catch (e) { console.log('ERR', e.message); }
  app.exit(0);
});
