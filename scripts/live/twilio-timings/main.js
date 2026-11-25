const { app } = require('electron');
app.setName('bhatbot');
app.whenReady().then(async () => {
  try {
    const credentials = require(require('path').join(__dirname, '../../../lib/credentials'));
    const fs = require('fs');
    const c = credentials.resolveRefs(JSON.parse(fs.readFileSync(require('os').homedir() + '/.bhatbot/config.json', 'utf8')));
    const auth = 'Basic ' + Buffer.from(`${c.twilioSid}:${c.twilioToken}`).toString('base64');
    const get = async (p) => (await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.twilioSid}/${p}`, { headers: { authorization: auth } })).json();
    const calls = await get('Calls.json?PageSize=2');
    for (const k of calls.calls || []) {
      console.log('CALL', k.start_time, k.status, 'dur', k.duration, 'by', k.answered_by, 'dir', k.direction, 'toOwner', String(k.to).slice(-4) === String(c.myPhone).slice(-4));
      const ev = await get(`Calls/${k.sid}/Events.json`);
      for (const e of ev.events || []) {
        const rq = e.request || {}, rs = e.response || {};
        const url = String(rq.url || '').replace(/\/voice\/[^/]+\//, '/voice/<tok>/').replace(/Accounts\/AC[0-9a-f]+/, 'Accounts/<sid>').replace(/\?.*/, '');
        console.log('  EV', rq.method, url, 'resp', rs.response_code, 'took', rs.request_duration, 'ms', 'at', rs.date_created || rq.parameters && rq.parameters.timestamp || '', 'AnsweredBy', (rq.parameters || {}).answered_by || (rq.parameters || {}).AnsweredBy || '');
      }
    }
  } catch (e) { console.log('ERR', e.message); }
  app.quit();
});
