// Electron probe: fetch BhatBot's own window as PNG (OUT=path) or evaluate JS in it (JS=...). Loopback only.
const { app } = require('electron');
app.setName('bhatbot');
app.whenReady().then(async () => {
  try {
    const fs = require('fs');
    const credentials = require(require('path').join(__dirname, '../../../lib/credentials'));
    const c = credentials.resolveRefs(JSON.parse(fs.readFileSync(require('os').homedir() + '/.bhatbot/config.json', 'utf8')));
    const base = `http://127.0.0.1:${c.mcpPort || 8788}/self/${c.mcpToken}`;
    if (process.env.JS) {
      const r = await fetch(base + '/eval', { method: 'POST', body: process.env.JS });
      console.log('EVAL', JSON.stringify(await r.json()));
    } else {
      const r = await fetch(base + '/shot.png' + (process.env.W ? '?w=' + process.env.W : ''));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fs.writeFileSync(process.env.OUT || '/tmp/bhatbot-self.png', Buffer.from(await r.arrayBuffer()));
      console.log('SHOT', process.env.OUT);
    }
  } catch (e) { console.log('ERR', e.message); }
  app.exit(0);
});
