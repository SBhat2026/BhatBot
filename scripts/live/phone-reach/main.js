// Live probe: can a phone reach BhatBot, and by which door? Prints status + latency per route.
// Tokens are resolved in-process and never printed.
const { app } = require('electron');
app.setName('bhatbot');
app.whenReady().then(async () => {
  try {
    const fs = require('fs'), os = require('os'), path = require('path');
    const credentials = require(path.join(__dirname, '../../../lib/credentials'));
    const c = credentials.resolveRefs(JSON.parse(fs.readFileSync(os.homedir() + '/.bhatbot/config.json', 'utf8')));
    const mac = 'https://' + String(c.publicHost || '').replace(/^https?:\/\//, '');
    const cloud = String(c.cloudUrl || '').replace(/\/+$/, '');
    const probe = async (label, url) => {
      const t = Date.now();
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
        const body = (await r.text()).slice(0, 80).replace(/\s+/g, ' ');
        console.log(`${label.padEnd(34)} ${r.status} ${String(Date.now() - t).padStart(5)}ms  ${/^\{/.test(body) ? body : ''}`);
      } catch (e) { console.log(`${label.padEnd(34)} ERR ${String(Date.now() - t).padStart(5)}ms  ${e.cause ? e.cause.code || e.cause.message : e.message}`); }
    };
    await probe('mac  /health', `${mac}/health`);
    await probe('mac  /app/<mcp>/version', `${mac}/app/${c.mcpToken}/version`);
    await probe('mac  /api/<mcp>/ops', `${mac}/api/${c.mcpToken}/ops`);
    await probe('cloud /health', `${cloud}/health`);
    await probe('cloud /app/<mcp>/version', `${cloud}/app/${c.mcpToken}/version`);
    await probe('cloud /app/<cloud>/version', `${cloud}/app/${c.cloudToken}/version`);
    await probe('cloud /api/<cloud>/config', `${cloud}/api/${c.cloudToken}/config`);
  } catch (e) { console.log('ERR', e.message); }
  app.exit(0);
});
