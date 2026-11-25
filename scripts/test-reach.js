#!/usr/bin/env node
'use strict';
// 2026-11-14 capabilities: calling anyone in his contacts, memory relief, Xcode, the Telegram relay.
// Pure parts tested directly; the wiring in main.js checked so none of it is a function nobody calls.
//   node scripts/test-reach.js      (wired into npm run verify)
const fs = require('fs');
const path = require('path');
const contacts = require('../lib/contacts');
const mem = require('../lib/memrelief');
const xc = require('../lib/xcode');
const { classify, createAutonomy } = require('../lib/autonomy');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };

// ── contacts ──
const book = contacts.shape([
  { name: 'Ann Lee', phones: ['(609) 555-0101', '+1 609 555 0199'], labels: ['work', '_$!<Mobile>!$_'], emails: ['a@x.org'] },
  { name: 'ann lee', phones: ['6095550199'], labels: ['iPhone'] },
  { name: 'Ann Patel', phones: ['+1 732 555 0100'], labels: ['mobile'] },
  { name: '', phones: ['+1 212 555 0100'] }, { name: 'No Number', phones: [] },
]);
ok(book.length === 2, 'nameless and numberless entries are dropped, the same person once');
ok(book[0].phones[0] === '+1 609 555 0199' && book[0].phones.length === 2, 'the mobile number comes first, duplicates by last ten digits merged');
const search = (q) => book.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
let r = contacts.resolve('Ann', search);
ok(!r.ok && r.candidates.length === 2, 'an ambiguous name returns the candidates to ask about — never a guess');
r = contacts.resolve('Ann Lee', search);
ok(r.ok && r.number === '+1 609 555 0199', 'an exact name resolves to the mobile');
ok(contacts.resolve('+1 (212) 555-0100', search).ok, 'a number is a number');
let wrote = null;
(async () => {
  const s1 = await contacts.sync({ run: async () => JSON.stringify([{ name: 'Ann Lee', phones: ['6095550199'], labels: ['mobile'], emails: [] }]), write: (o) => { wrote = o; } });
  ok(s1.ok && wrote && wrote.source === 'macOS Contacts' && wrote.count === 1, 'sync writes the address book with its source');
  wrote = null;
  const s2 = await contacts.sync({ run: async () => '[]', write: (o) => { wrote = o; } });
  ok(!s2.ok && wrote === null, 'an empty read never overwrites a good list');
  const s3 = await contacts.sync({ run: async () => { throw new Error('execution error: Not authorized to send Apple events to Contacts. (-1743)'); }, write: () => {} });
  ok(!s3.ok && s3.permission && /Automation/.test(s3.error), 'a missing permission says exactly where to grant it');

  // ── calling is a learned send, per person; dialling his own iPhone is not ──
  const c1 = classify('phone_call', { to: 'Mom', purpose: 'say I land at 6' });
  ok(c1 && c1.cls === 'send' && c1.signature === 'send:call:mom', `BhatBot phoning someone is a send (${c1 && c1.label})`);
  ok(classify('phone_call', { to: 'Mom', via: 'iphone' }) === null, 'dialling on his iPhone is not — he talks, and macOS asks him to press Call');
  ok(classify('phone_call', {}) === null, 'calling himself is not a send to anyone');
  let st = null; const A = createAutonomy({ load: () => st, save: (s) => { st = JSON.parse(JSON.stringify(s)); } });
  ok(A.decide('phone_call', { to: 'Mom', purpose: 'x' }).verdict === 'ask', 'the first call to someone asks');

  // ── memory relief ──
  const ps = [
    '  101 2500000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '  102 1500000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)',
    '  103 900000 /Applications/Slack.app/Contents/MacOS/Slack',
    '  104 3000000 /Applications/Bhatbot.app/Contents/MacOS/Bhatbot',
    '  105 2000000 /Applications/Claude.app/Contents/MacOS/Claude',
    '  106 4000000 /Library/Frameworks/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python',
    '  107 50000 /usr/sbin/cfprefsd',
  ].join('\n');
  const top = mem.topApps(ps, { minMb: 700 });
  ok(top[0] && top[0].name === 'Google Chrome' && top[0].pids.length === 2, `helpers count toward their app (${top[0] && top[0].name} ${top[0] && mem.fmt(top[0].mb)})`);
  ok(!top.some((a) => /bhatbot|claude|python/i.test(a.name)), 'BhatBot, Claude and non-app processes are never offered');
  ok(mem.topApps(ps, { minMb: 700, protect: ['Slack'] }).every((a) => a.name !== 'Slack'), 'and he can protect more by name');
  ok(!mem.shouldOffer({ freePct: 30 }) && mem.shouldOffer({ freePct: 8 }) && !mem.shouldOffer({ freePct: 8, lastAskAt: Date.now() - 60000 }), 'offers only when memory is short, at most every 20 minutes');
  ok(mem.quitScript('Google Chrome') === 'tell application "Google Chrome" to quit', 'quitting is the app\'s own Quit, never a kill');
  const q = classify('free_memory', { action: 'quit', app: 'Google Chrome' });
  ok(q && q.important, 'quitting an app always asks — it never becomes routine');
  for (let i = 0; i < 6; i++) A.learn(A.decide('free_memory', { action: 'quit', app: 'Slack' }), true);
  ok(A.decide('free_memory', { action: 'quit', app: 'Slack' }).verdict === 'ask', 'even after six yeses');

  // ── xcode ──
  ok(xc.findContainer('/p', () => ['A.xcodeproj', 'A.xcworkspace']).kind === 'workspace', 'a workspace beats a project');
  ok(xc.findContainer('/p', () => ['Package.swift']).kind === 'package', 'a Swift package builds from its folder');
  const sim = xc.pickSimulator({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17', udid: 'U1', state: 'Shutdown' }, { name: 'iPhone Air', udid: 'U2', state: 'Booted' }] } });
  ok(sim && sim.udid === 'U2', 'a booted simulator is preferred');
  const args = xc.buildArgs({ container: { kind: 'project', path: '/p/A.xcodeproj' }, scheme: 'A', destination: xc.destinationFor('simulator', sim), derived: '/d' });
  ok(args.includes('CODE_SIGNING_ALLOWED=NO') && args.includes('-derivedDataPath') && args[args.length - 1] === 'build', 'builds are unsigned and go to BhatBot\'s own DerivedData');
  const s = xc.summarize('x.swift:3:9: error: cannot find \'foo\' in scope\nx.swift:3:9: error: cannot find \'foo\' in scope\nwarning: unused\n** BUILD FAILED **');
  ok(!s.ok && s.errors.length === 1 && s.warnings === 1, 'a failed build comes back as its errors, deduplicated');

  // ── wired ──
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const tools = require('../lib/tools-schema')().map((t) => t.name);
  for (const t of ['phone_call', 'contacts', 'free_memory', 'xcode']) ok(tools.includes(t) && main.includes(`case '${t}':`), `${t} is a tool the model can call, and it is handled`);
  ok(/setInterval\(\(\) => \{ memReliefTick\(\)/.test(main), 'memory relief runs on its own clock');
  ok(/await executeTool\('free_memory', \{ action: 'quit'/.test(main), 'and its quit goes through the approval gate');
  ok(/syncContacts\(\)\.catch/.test(main) && /'-l', 'JavaScript'/.test(main), 'the address book is refreshed from macOS Contacts');
  ok(/baseApiUrl: base/.test(main) && fs.existsSync(path.join(__dirname, '..', 'relay', 'telegram', 'worker.js')), 'Telegram can go through the relay');
  const w = fs.readFileSync(path.join(__dirname, '..', 'relay', 'telegram', 'worker.js'), 'utf8');
  ok(/ALLOWED_BOT_ID/.test(w) && /status: 404/.test(w), 'the relay forwards only his bot, and 404s everything else');
  ok(/!c\.telegramChatId \|\| _tgDownSince\) \{ tgHold/.test(main), 'with no chat yet, messages are held, not dropped');

  // ── reach: confirmed delivery (lib/reach.js) ──
  const R = require('../lib/reach');
  const now = Date.now(), F = { atMac: false, telegramLinked: true, callable: true };
  let d = R.next({ urgency: 'call', createdAt: now, sent: {} }, F, now);
  ok(JSON.stringify(d.send) === '["telegram","call"]', 'an urgent message goes to Telegram AND rings at once');
  d = R.next({ urgency: 'high', createdAt: now, sent: {} }, F, now);
  ok(d.send.join() === 'telegram' && d.wait === R.DEFAULTS.ackWindowMs, 'high: written first, a call only if it goes unacknowledged');
  ok(R.next({ urgency: 'high', createdAt: now - 11 * 60000, sent: { telegram: 1 } }, F, now).send.join() === 'call', '…and after ten minutes unacknowledged, it calls');
  d = R.next({ urgency: 'call', createdAt: now, sent: { telegram: 1 } }, { ...F, quiet: true, quietEndsAt: now + 3600e3 }, now);
  ok(!d.send && d.wait >= 3500e3 && /quiet hours/.test(d.why), 'quiet hours hold the call until they end — they do not cancel it');
  d = R.next({ urgency: 'call', createdAt: now, sent: { telegram: 1 } }, { ...F, quiet: true, quietEndsAt: now + 5 * 3600e3 }, now);
  ok(d.done && /overnight/.test(d.why), 'but a call that would ring hours later at dawn is left in writing instead');
  ok(/u === 'call' \? 'high'/.test(main) && !/notifyUser\(summary, 'call'\)/.test(main), 'machine-health alerts never ring him');
  d = R.next({ urgency: 'call', createdAt: now, sent: { telegram: 1 } }, { ...F, busy: true, busyUntil: now + 20 * 60000 }, now);
  ok(!d.send && d.wait > 20 * 60000 && /meeting or class/.test(d.why), 'a meeting holds the call until just after it ends');
  ok(/retrying/.test(R.next({ urgency: 'call', createdAt: now, sent: { telegram: 1 }, calls: [{ at: now - 60000 }] }, F, now).why), 'a missed call is retried after a gap');
  ok(R.next({ urgency: 'call', createdAt: now, sent: { telegram: 1 }, calls: [{ at: now - 9e5 }, { at: now - 1e5 }] }, F, now).done, '…at most twice');
  ok(R.next({ urgency: 'call', createdAt: now, sent: {}, calls: [{ reached: true }] }, F, now).done, 'answered = done');
  ok(R.next({ urgency: 'high', createdAt: now, sent: { telegram: 1 }, ackAt: now }, F, now).done, 'acknowledged = done');
  ok(!R.channels({ smsHealthy: false }).sms, 'a dead SMS channel is never used');
  ok(R.next({ urgency: 'medium', createdAt: now, sent: {} }, { telegramLinked: false, callable: true }, now).wait > 0, 'medium with nowhere to write waits rather than pretending');
  const co = R.callOutcome;
  ok(co({ status: 'completed', answered_by: 'human', duration: '40' }).reached && !co({ status: 'completed', answered_by: 'machine_end_beep', duration: '30' }).reached
    && !co({ status: 'no-answer' }).reached && !co({ status: 'ringing' }).final, 'only a person picking up counts as reached; voicemail and no-answer do not');
  const so = R.smsOutcome({ status: 'undelivered', error_code: 30034 });
  ok(so.final && !so.ok && so.channelDead && /not registered/.test(so.why), 'carrier error 30034 marks SMS dead, with the reason');

  // ── the Mac call leg follows the live Tailscale name, and its reachability is proven from outside ──
  ok(/_publicHostAt < 600000/.test(main) && /tailscale status --json/.test(main) && /publicHostPinned/.test(main), 'the public host is re-read live, not cached forever');
  ok(/funnel is published for an old name/.test(main), 'a funnel published under a stale name is reported, not trusted');
  const vp = require('../lib/voicepreflight');
  ok(typeof vp.setProbers === 'function' && /setProbers\(\[loadConfig\(\)\.reachProber/.test(main), 'BhatBot\'s own outside prober is used first');
  ok(/\.ts\\\.net\$/.test(w) && /example\.com/.test(w) && /status: 403/.test(w) && /530/.test(w), 'the prober only fetches his tailnet (and its control), and reads a funnel-edge 530 as unreachable');
  // reach wiring
  ok(/reachCreate\(msg, urgency/.test(main) && /setInterval\(async \(\) => \{\s*if \(_reachRunning\)/.test(main), 'notify_user creates tickets and a timer advances them');
  ok(/reachAck\('telegram'\)/.test(main) && /reachAck\('desktop'\)/.test(main), 'a Telegram reply or talking to BhatBot acknowledges');
  ok(/said === '\/start ' \+ code/.test(main) && !/First message authorizes this chat/.test(main), 'Telegram links only through BhatBot\'s own code');

  // A revoked calendar must read as DISCONNECTED, not as a network blip that "assumes free".
  {
    const src = main.slice(main.indexOf('async function calendarEventsOrThrow('), main.indexOf('let _meeting ='));
    const fn = new Function('google', src + '\nreturn calendarEventsOrThrow;')({ calendarList: async () => ({ success: false, accounts: ['a', 'b'], errors: ['personal: invalid_grant', 'princeton: invalid_grant'] }) });
    let msg = ''; try { await fn({}); } catch (e) { msg = e.message; }
    const av = await require('../lib/availability').check({ listEvents: fn, now: Date.now() });
    ok(/invalid_grant/.test(msg) && av.authDead === true, 'every Google account revoked → calendar reported disconnected (calls go in writing), not "assuming free"');
    ok(/function tgMarkDown[^\n]*tgWatchRecovery\(\)/.test(main) && /await telegramBot\.getMe\(\); tgMarkUp\(\)/.test(main), 'one dropped long-poll no longer takes Telegram out of the ladder: it is re-checked every 30 s');
    ok(/explicit: true \}\);/.test(main) && /bypassGate: !!t\.explicit/.test(main), 'a test call he asked for is not held back by the calendar gate');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} reach: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
