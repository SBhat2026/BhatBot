#!/usr/bin/env node
'use strict';
// lib/autonomy.js — what BhatBot may do without asking, and what it may never do.
//
// Siddhant: "Complete access to all apps and browsers … aside from financial and confidential
// information … standard deletions and sending can be made without asking unless they're important
// or nonstandard … learn 'standard' actions on the go … fully autonomous after a couple weeks."
//
// The list that matters most here is the one of things that must NOT be blocked. A blocklist that is
// too eager silently turns "complete access" into "access to what I happened not to pattern-match",
// and he would find out one refused click at a time.
//   node scripts/test-autonomy.js      (wired into npm run verify)
const { createAutonomy, forbidden, classify } = require('../lib/autonomy');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };
const blocked = (tool, input, ctx) => forbidden(tool, input, ctx || {});

// ── MUST BE ALLOWED ───────────────────────────────────────────────────────────────────────────────
const fine = [
  ['browser', { action: 'navigate', url: 'https://github.com/anthropics' }],
  ['browser', { action: 'navigate', url: 'https://www.princeton.edu/academics' }],
  ['browser', { action: 'navigate', url: 'https://www.amazon.com/s?k=monitor' }],            // browsing a shop is not buying
  ['browser', { action: 'navigate', url: 'https://docs.stripe.com/api' }],                    // developer docs
  ['browser', { action: 'navigate', url: 'https://www.investopedia.com/terms/b/bond.asp' }],  // reading about finance
  ['browser', { action: 'navigate', url: 'https://finance.yahoo.com/quote/NVDA' }],           // a markets page is not HIS finances
  ['browser', { action: 'navigate', url: 'https://www.foodbank.org/volunteer' }],
  ['browser', { action: 'navigate', url: 'https://gemini.google.com/app' }],                  // not the exchange
  ['browser', { action: 'navigate', url: 'https://mail.google.com/mail/u/0/' }],
  ['browser', { action: 'type', selector: 'input[name=q]', text: 'where to buy a 4k monitor' }],   // a search, not a purchase
  ['browser', { action: 'type', selector: '#msg', text: 'can you pay me back on friday' }],
  ['browser', { action: 'click', text: 'Subscribe' }, { pageUrl: 'https://www.youtube.com/watch?v=x' }],
  ['browser', { action: 'click', text: 'Add to cart' }, { pageUrl: 'https://www.amazon.com/dp/B0' }],   // filling a cart is not paying
  ['browser', { action: 'click', text: 'Withdraw from course' }, { pageUrl: 'https://registrar.princeton.edu/x' }],
  ['system_control', { action: 'open_app', app: 'Spotify' }],
  ['system_control', { action: 'open_app', app: 'Stocks' }],
  ['system_control', { action: 'applescript', script: 'display notification "remember to buy milk"' }],
  ['read_file', { path: '/Users/sid/courses/ECO 362 Financial Investments/notes.md' }],        // coursework
  ['read_file', { path: '/Users/sid/cos126/w2/problem.txt' }],                                 // week two
  ['read_file', { path: '/Users/sid/bhatbot/lib/pricing.js' }],
  ['run_shell', { command: 'git log --oneline -5', cwd: '/Users/sid/bhatbot' }],
  ['keychain_lookup', { service: 'github', account: 'sid' }],
  ['smart_login', { url: 'https://canvas.princeton.edu' }],
];
for (const [tool, input, ctx] of fine) {
  const r = blocked(tool, input, ctx);
  ok(!r.blocked, `allowed: ${tool} ${JSON.stringify(input).slice(0, 78)}${r.blocked ? '  ← BLOCKED: ' + r.why : ''}`);
}

// ── MUST BE FORBIDDEN ─────────────────────────────────────────────────────────────────────────────
const never = [
  ['browser', { action: 'navigate', url: 'https://secure.chase.com/web/auth' }, null, 'financial'],
  ['browser', { action: 'navigate', url: 'https://www.schwab.com/' }, null, 'financial'],
  ['browser', { action: 'navigate', url: 'https://www.paypal.com/myaccount' }, null, 'financial'],
  ['browser', { action: 'navigate', url: 'https://www.firstcommunitybank.com/login' }, null, 'financial'],   // never listed, still a bank
  ['browser', { action: 'navigate', url: 'https://online.banking.example.org/' }, null, 'financial'],
  ['browser', { action: 'navigate', url: 'https://www.amazon.com/gp/buy/checkout/' }, null, 'financial'],
  ['browser', { action: 'navigate', url: 'https://console.anthropic.com/settings/billing' }, null, 'financial'],
  ['browser', { action: 'navigate', url: 'https://dashboard.stripe.com/payments' }, null, 'financial'],
  ['open_in_browser', { url: 'https://www.irs.gov/payments' }, null, 'financial'],
  ['browser', { action: 'click', selector: '#login' }, { pageUrl: 'https://www.fidelity.com/' }, 'financial'],   // the page, not the click
  ['browser', { action: 'click', text: 'Place your order' }, { pageUrl: 'https://www.amazon.com/cart' }, 'financial'],
  ['browser', { action: 'click', text: 'Buy now' }, { pageUrl: 'https://store.example.com/item' }, 'financial'],
  ['vision_click', { target: 'the Pay now button' }, { pageUrl: 'https://store.example.com/' }, 'financial'],
  ['system_control', { action: 'open_app', app: 'Keychain Access' }, null, 'confidential'],
  ['system_control', { action: 'activate_app', app: '1Password 7' }, null, 'confidential'],
  ['system_control', { action: 'applescript', script: 'tell application "Robinhood" to activate' }, null, 'financial'],
  ['read_file', { path: '/Users/sid/.ssh/id_ed25519' }, null, 'confidential'],
  ['read_file', { path: '/Users/sid/Documents/Taxes/2025/return.pdf' }, null, 'financial'],
  ['read_file', { path: '/Users/sid/Downloads/form-w2-2025.pdf' }, null, 'financial'],
  ['read_file', { path: '/Users/sid/Downloads/chase bank statement march.pdf' }, null, 'financial'],
  ['run_shell', { command: 'cat ~/.aws/credentials' }, null, 'confidential'],
  ['run_shell', { command: 'sqlite3 "/Users/sid/Library/Application Support/Google/Chrome/Default/Login Data" .dump' }, null, 'confidential'],
  ['keychain_lookup', { service: 'Chase Bank', account: 'sid' }, null, 'financial'],
  ['onepassword_lookup', { item: 'Schwab brokerage' }, null, 'financial'],
];
for (const [tool, input, ctx, kind] of never) {
  const r = blocked(tool, input, ctx);
  ok(r.blocked && r.kind === kind, `forbidden (${kind}): ${tool} ${JSON.stringify(input).slice(0, 70)}${r.blocked ? '' : '  ← ALLOWED'}`);
  if (r.blocked) ok(typeof r.why === 'string' && r.why.length > 8, `  …and says why: "${r.why}"`);
}

// His own list, which no pattern could know.
{
  const mine = { confidential: { hosts: ['adaptyvbio.com'], apps: ['Signal'], paths: ['/research/unpublished'], words: ['project nexus'] } };
  ok(blocked('browser', { action: 'navigate', url: 'https://portal.adaptyvbio.com/x' }, mine).blocked, 'a host he marked confidential is forbidden, subdomains included');
  ok(blocked('system_control', { action: 'open_app', app: 'Signal' }, mine).blocked, 'an app he marked confidential is forbidden');
  ok(blocked('read_file', { path: '/Users/sid/research/unpublished/draft.md' }, mine).blocked, 'a path he marked confidential is forbidden');
  ok(blocked('write_file', { path: '/tmp/a.md', content: 'notes on Project Nexus timeline' }, mine).blocked, 'and so is anything that mentions a word he marked');
  ok(!blocked('browser', { action: 'navigate', url: 'https://github.com' }, mine).blocked, 'his list adds to the rules; it does not block everything else');
}

// ── WHAT COUNTS AS AN OUTWARD ACT ─────────────────────────────────────────────────────────────────
{
  const none = [
    ['browser', { action: 'navigate', url: 'https://x.com' }],
    ['browser', { action: 'type', selector: '#box', text: 'please send me the file' }],   // typing is content
    ['calendar', { action: 'create', summary: 'gym', start: 'x' }],                         // a private event is a note
    ['calendar', { action: 'list' }],
    ['run_shell', { command: 'rm -rf node_modules' }],                                      // scratch
    ['run_shell', { command: 'rm /private/tmp/x.log' }],
    ['run_shell', { command: 'ls -la' }],
    ['gmail', { action: 'draft', to: 'a@b.com' }],                                          // a draft has not gone anywhere
  ];
  for (const [t, i] of none) ok(classify(t, i) === null, `not an outward act: ${t} ${JSON.stringify(i).slice(0, 60)}`);

  const send = classify('system_control', { action: 'applescript', script: 'tell application "Mail" to send (make new outgoing message with properties {subject:"hi"}) -- to prof@princeton.edu' });
  ok(send && send.cls === 'send' && /mail:princeton\.edu/.test(send.signature), `a Mail send is a send, keyed by where it goes (${send && send.signature})`);
  const other = classify('system_control', { action: 'applescript', script: 'tell application "Mail" to send x -- to someone@gmail.com' });
  ok(send.signature !== other.signature, 'mail to a different domain is a DIFFERENT signature — approving one does not approve the other');
  const cal = classify('calendar', { action: 'create', account: 'personal', attendees: ['a@b.com'] });
  ok(cal && cal.cls === 'send', 'an event with a guest is a send — it mails an invitation');
  const del = classify('calendar', { action: 'delete', account: 'personal', id: 'x' });
  ok(del && del.cls === 'delete' && !del.important, 'deleting his own event is a routine delete');
  const click = classify('browser', { action: 'click', text: 'Send' }, { pageUrl: 'https://mail.google.com/mail' });
  ok(click && click.signature === 'send:web:google.com:send', `a Send click is keyed by site and verb (${click && click.signature})`);
  const d1 = classify('run_shell', { command: 'rm ~/Downloads/installer.dmg' }, { home: '/Users/sid' });
  const d2 = classify('run_shell', { command: 'rm /Users/sid/Documents/thesis/ch1.tex' }, { home: '/Users/sid' });
  ok(d1 && d2 && d1.signature !== d2.signature, `deleting in Downloads and in Documents/thesis are different habits (${d1.signature} vs ${d2.signature})`);
}

// ── IMPORTANT never becomes routine ───────────────────────────────────────────────────────────────
{
  const many = classify('calendar', { action: 'create', account: 'personal', attendees: ['a@x', 'b@x', 'c@x', 'd@x', 'e@x', 'f@x'] });
  ok(many.important && /6 other people/.test(many.reasons[0]), `an invitation to six people is important (${many.reasons[0]})`);
  const care = classify('calendar', { action: 'delete', account: 'sb9699@princeton.edu' }, { highCare: ['sb9699@princeton.edu'] });
  ok(care.important && /high-care/.test(care.reasons.join()), 'anything on a high-care account is important');
  const tree = classify('run_shell', { command: 'rm -rf ~/Documents/thesis' }, { home: '/Users/sid' });
  ok(tree.important && /directory tree/.test(tree.reasons.join()), 'deleting a directory tree is important');
  const trash = classify('system_control', { action: 'applescript', script: 'tell application "Finder" to empty trash' });
  ok(trash && trash.important, 'emptying the trash is important — it cannot be undone');
}

// ── LEARNING ──────────────────────────────────────────────────────────────────────────────────────
{
  let t = Date.parse('2026-11-12T12:00:00Z'), saved = null;
  const DAY = 86400000;
  const A = createAutonomy({ now: () => t, load: () => saved, save: (s) => { saved = JSON.parse(JSON.stringify(s)); } });
  const mail = (dom) => ['system_control', { action: 'applescript', script: `tell application "Mail" to send m -- to x@${dom}` }];

  let d = A.decide(...mail('princeton.edu'));
  ok(d.verdict === 'ask' && /not done this before/.test(d.reasons[0]), `the first time is non-standard and it asks (${d.reasons[0]})`);
  A.learn(d, true);
  d = A.decide(...mail('princeton.edu'));
  ok(d.verdict === 'ask' && /1 of 2/.test(d.reasons[0]), `after one yes it is still learning, and says how far along (${d.reasons[0]})`);
  A.learn(d, true);
  d = A.decide(...mail('princeton.edu'));
  ok(d.verdict === 'allow' && /standard/.test(d.reasons[0]), `after two it is standard and stops asking (${d.reasons[0]})`);
  ok(A.decide(...mail('stranger.io')).verdict === 'ask', 'but a different destination is still a first time');
  ok(saved && saved.sigs['send:mail:princeton.edu'].yes === 2, 'and the lesson is written to the brain, not held in memory');

  // A refusal is remembered harder than an approval.
  A.learn(A.decide(...mail('princeton.edu')), false);
  d = A.decide(...mail('princeton.edu'));
  ok(d.verdict === 'ask' && /said no/.test(d.reasons[0]), 'one no puts a standard action back to asking');
  A.learn(d, true); A.learn(A.decide(...mail('princeton.edu')), true);
  ok(A.decide(...mail('princeton.edu')).verdict === 'ask', 'and two more yeses do not buy it back while the refusal is fresh');
  t += 31 * DAY;
  ok(A.decide(...mail('princeton.edu')).verdict === 'allow', 'after the hold expires the re-earned approvals count');

  // Important is recorded and never promoted.
  const big = ['calendar', { action: 'create', account: 'personal', attendees: ['a@x', 'b@x', 'c@x', 'd@x', 'e@x'] }];
  for (let i = 0; i < 5; i++) A.learn(A.decide(...big), true);
  ok(A.decide(...big).verdict === 'ask', 'an important action still asks after five approvals — routine and important are different axes');

  // Forbidden is not learnable.
  const bank = ['browser', { action: 'navigate', url: 'https://www.chase.com' }];
  for (let i = 0; i < 5; i++) A.learn(A.decide(...bank), true);
  ok(A.decide(...bank).verdict === 'forbid', 'approving a forbidden target changes nothing — there is no path from yes to allowed');
}

// ── THE "COUPLE OF WEEKS" RAMP: class trust is earned, not dated ──────────────────────────────────
{
  let t = Date.parse('2026-11-12T12:00:00Z'), saved = null;
  const DAY = 86400000;
  const A = createAutonomy({ now: () => t, load: () => saved, save: (s) => { saved = s; } });
  const mail = (dom) => ['system_control', { action: 'applescript', script: `tell application "Mail" to send m -- to x@${dom}` }];
  const teach = (dom) => { A.learn(A.decide(...mail(dom)), true); A.learn(A.decide(...mail(dom)), true); };
  for (const d of ['a.edu', 'b.edu', 'c.edu', 'd.edu', 'e.edu']) teach(d);
  ok(A.decide(...mail('new.org')).verdict === 'ask', 'five standard signatures on day one do not yet trust the class — it has not stood the test of time');
  t += 15 * DAY;
  const d = A.decide(...mail('new.org'));
  ok(d.verdict === 'allow' && /track record/.test(d.reasons[0]), `after a couple of weeks a NEW destination is trusted on the class's record (${d.reasons[0]})`);
  ok(A.summary().trustedClasses.includes('send'), 'and the summary names the trusted class');
  ok(A.decide('calendar', { action: 'delete', account: 'personal' }).verdict === 'ask', 'trust in sending is not trust in deleting');
  // One recent refusal anywhere in the class withdraws it.
  A.learn(A.decide(...mail('a.edu')), false);
  ok(A.decide(...mail('another.org')).verdict === 'ask', 'a fresh refusal in the class withdraws the class-level trust');
  // And a date alone grants nothing.
  let t2 = Date.parse('2026-11-12T12:00:00Z');
  const B = createAutonomy({ now: () => t2, load: () => null, save: () => {} });
  B.learn(B.decide(...mail('a.edu')), true);
  t2 += 60 * DAY;
  ok(B.decide(...mail('zzz.org')).verdict === 'ask', 'two months with one approval is not a track record — time alone earns nothing');
}

// ── the brain can say what it has learned ─────────────────────────────────────────────────────────
{
  let saved = null;
  const A = createAutonomy({ load: () => saved, save: (s) => { saved = s; } });
  const m = ['calendar', { action: 'delete', account: 'personal' }];
  A.learn(A.decide(...m), true);
  const s = A.summary();
  ok(s.learning.length === 1 && s.learning[0].approved === 1 && s.learning[0].of === 2, 'the summary lists what is still being learned and how far along');
  ok(Array.isArray(s.standard) && Array.isArray(s.refused) && typeof s.days === 'number', 'and what is standard, what was refused, and for how long it has been learning');
  // A corrupt store must not become "everything is standard".
  const C = createAutonomy({ load: () => { throw new Error('unreadable'); }, save: () => {} });
  ok(C.decide(...m).verdict === 'ask', 'an unreadable brain starts from asking, never from allowing');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} autonomy: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
