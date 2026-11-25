// Live probe: can the call gate read the calendar? Prints per-account status, event count for the
// next 24 h, and what availability.check would decide right now. No event titles, no secrets.
const { app } = require('electron');
app.setName('bhatbot');
app.whenReady().then(async () => {
  try {
    const path = require('path'), fs = require('fs'), os = require('os');
    const L = (m) => require(path.join(__dirname, '../../../lib', m));
    const credentials = L('credentials'), google = L('google'), availability = L('availability');
    google.setConfigResolver(() => credentials.resolveRefs(JSON.parse(fs.readFileSync(os.homedir() + '/.bhatbot/config.json', 'utf8'))));
    const now = Date.now();
    const r = await google.calendarList({ timeMin: new Date(now).toISOString(), timeMax: new Date(now + 864e5).toISOString(), limit: 20 });
    console.log('calendarList success', r && r.success !== false, 'events(24h)', (r.events || r.results || []).length, 'errors', JSON.stringify((r.errors || []).map((e) => String(e).replace(/[\w.+-]+@[\w.-]+/g, '<acct>').slice(0, 120))));
    const listEvents = async (o) => {
      const x = await google.calendarList({ ...o, limit: 20 });
      if (!x || x.success === false) throw new Error(x && (x.error || x.reason || (x.errors || []).join('; ')) || 'calendar read failed');
      return x.events || x.results || [];
    };
    const a = await availability.check({ listEvents, now });
    console.log('availability', JSON.stringify({ busy: a.busy, authDead: !!a.authDead, reason: a.reason ? String(a.reason).slice(0, 80) : undefined, error: a.error ? String(a.error).slice(0, 80) : undefined }));
  } catch (e) { console.log('ERR', e.message); }
  app.quit();
});
