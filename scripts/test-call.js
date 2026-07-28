#!/usr/bin/env node
'use strict';
// Tests for the CALL interface — contact search + the place-call path that backs the call button.
// Twilio two-way voice had been wired for a long time but could only ever be STARTED by the agent
// deciding to; there was no way for Siddhant to initiate one.
//
// The behaviours worth pinning:
//   • search ranks sensibly (exact > prefix > word-start > substring) and matches phone digits, so
//     pasting a number finds whose it is;
//   • a garbled/short number is REFUSED before it reaches the dialer — a misdial is a real-world
//     side effect that cannot be undone;
//   • twilioCall targets an arbitrary number but still DEFAULTS to Siddhant's own, because every
//     pre-existing caller (notifyUser, patrol, phone_mirror) relies on that default;
//   • the renderer and preload are actually wired, not just the backend.
// main.js can't be required outside Electron, so the helpers are extracted by source. Wired into
// `npm run verify`.
//   node scripts/test-call.js
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

// Lift searchContacts + its two helpers out of main.js and run them against a fixture address book.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-call-'));
const CONTACTS = {
  contacts: [
    { name: 'Mrs. Shoop', phones: ['+19088724060'], emails: [] },
    { name: 'Ronald Q.', phones: ['+16092550030'], emails: [] },
    { name: 'Finn W', phones: ['+16099153145'], emails: [] },
    { name: 'Ron Swanson', phones: ['+15551234567'], emails: [] },
    { name: 'Aaron Burr', phones: ['+15559998888'], emails: [] },
    { name: 'No Number', phones: [], emails: ['x@y.z'] },       // must be filtered out — uncallable
    { name: null, phones: ['+15550000000'] },                    // malformed — must not crash
  ],
};
fs.mkdirSync(path.join(TMP, '.bhatbot'), { recursive: true });
fs.writeFileSync(path.join(TMP, '.bhatbot', 'contacts.json'), JSON.stringify(CONTACTS));

const slice = main.slice(main.indexOf('const digitsOf ='), main.indexOf("ipcMain.handle('contacts-search'"));
// eslint-disable-next-line no-new-func
const { searchContacts, loadContacts, digitsOf } = new Function('fs', 'path', 'os', 'CONTACTS_PATH',
  slice + '\nreturn { searchContacts, loadContacts, digitsOf };')(fs, path, os, path.join(TMP, '.bhatbot', 'contacts.json'));

// ---- loading ----
ok(loadContacts().length === 5, 'loadContacts: drops entries with no phone and malformed rows');
ok(!loadContacts().some((c) => !c.name), 'loadContacts: no nameless contacts survive');

// ---- digits ----
ok(digitsOf('+1 (609) 255-0030') === '16092550030', 'digitsOf: strips punctuation for comparison');
ok(digitsOf(null) === '', 'digitsOf: null → ""');

// ---- ranking ----
{
  const byName = (r) => r.map((c) => c.name);
  // "ron" prefix-matches BOTH Ronald Q. and Ron Swanson; what must hold is that either of them
  // outranks Aaron Burr, which only matches as an interior substring.
  const ron = byName(searchContacts('ron'));
  ok(['Ronald Q.', 'Ron Swanson'].includes(ron[0]), 'search: a name PREFIX takes the top slot');
  ok(ron.indexOf('Aaron Burr') > ron.indexOf('Ronald Q.') && ron.indexOf('Aaron Burr') > ron.indexOf('Ron Swanson'),
    'search: a prefix match outranks an interior substring ("ron" → Ronald/Ron above Aaron)');
  ok(ron.includes('Aaron Burr'), 'search: the substring match is still returned, just lower');
  ok(byName(searchContacts('swanson'))[0] === 'Ron Swanson', 'search: a word-start match works on surnames');
  ok(byName(searchContacts('Ron Swanson'))[0] === 'Ron Swanson', 'search: an exact name ranks first');
  ok(searchContacts('finn').length === 1 && searchContacts('finn')[0].name === 'Finn W', 'search: a specific query narrows to one');
  ok(searchContacts('zzzznope').length === 0, 'search: no match → empty, not everything');
  ok(searchContacts('').length === 5, 'search: an empty query lists everyone (the default view)');
  ok(searchContacts('', 2).length === 2, 'search: honours the limit');
  ok(searchContacts('RON').length === searchContacts('ron').length, 'search: case-insensitive');
}

// ---- phone-number search ----
{
  const r = searchContacts('9088724060');
  ok(r.length === 1 && r[0].name === 'Mrs. Shoop', 'search: a bare 10-digit number finds its owner');
  ok(searchContacts('(609) 255-0030')[0].name === 'Ronald Q.', 'search: a formatted number matches on digits');
  ok(searchContacts('12').length === 0 || !searchContacts('12').some((c) => c.name === 'Ron Swanson'),
    'search: a 2-digit query does NOT fuzzy-match every phone number');
}

// ---- twilioCall targeting ----
{
  const fn = main.slice(main.indexOf('async function twilioCall('), main.indexOf('// phone_mirror tool backend'));
  ok(/async function twilioCall\(message, \{ to, name \} = \{\}\)/.test(fn), 'twilioCall: accepts an explicit target');
  ok(/const target = to \|\| c\.myPhone/.test(fn), 'twilioCall: DEFAULTS to myPhone (every existing caller depends on this)');
  ok(!/to: c\.myPhone/.test(fn), 'twilioCall: no longer hardcodes myPhone as the dialed number');
  // Both real dial sites — the conversation webhook path and the one-shot announcement fallback.
  const dialSites = (fn.match(/calls\.create\(\{[\s\S]{0,200}?to: target/g) || []).length;
  ok(dialSites === 2, `twilioCall: BOTH dial paths use the target (found ${dialSites})`);
  ok(/machineDetection/.test(fn), 'twilioCall: voicemail detection is preserved on the two-way path');
}

// ---- the place-call handler ----
{
  const h = main.slice(main.indexOf("ipcMain.handle('place-call'"), main.indexOf("ipcMain.handle('synapse-graph'"));
  ok(/digitsOf\(target\)\.length < 7/.test(h), 'place-call: REFUSES a too-short number (a misdial cannot be undone)');
  ok(/to \|\| c\.myPhone/.test(h), 'place-call: an omitted target means "call me"');
  ok(/isSelf/.test(h) && /on behalf of Siddhant/.test(h), 'place-call: a third party hears who is calling and why');
  ok(/rstate\.event\('call'/.test(h), 'place-call: every call is recorded in the event log');
  ok(/sendToActivity/.test(h), 'place-call: surfaced in the activity feed');
  ok(/twoWay: r\.via === 'twilio-conversation'/.test(h), 'place-call: reports whether it is a real conversation or announcement-only');
  ok(/if \(!r\.sent\)/.test(h), 'place-call: a Twilio failure is returned, not swallowed');
}

// ---- preload bridge ----
{
  const p = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  ok(/contactsSearch:.*invoke\('contacts-search'/.test(p), 'preload: exposes contactsSearch');
  ok(/placeCall:.*invoke\('place-call'/.test(p), 'preload: exposes placeCall');
}

// ---- renderer ----
{
  const h = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  ok(/id="callbtn"/.test(h), 'ui: the CALL button is in the nav rail');
  ok(/id="call-card"/.test(h) && /id="call-search"/.test(h) && /id="call-list"/.test(h), 'ui: the picker markup exists');
  ok(/id="call-me"/.test(h), 'ui: there is a dedicated "call me" action');
  ok(/window\.bhatbot\.contactsSearch/.test(h) && /window\.bhatbot\.placeCall/.test(h), 'ui: wired to the preload bridge');
  ok(/ArrowDown/.test(h) && /ArrowUp/.test(h) && /'Enter'/.test(h), 'ui: keyboard navigation (arrows + enter)');
  ok(/searchSeq/.test(h), 'ui: search results are sequence-guarded so a slow response cannot overwrite a newer one');
  ok(/if \(busy\) return;/.test(h), 're-entrancy: a double-click cannot place two calls');
  ok(/announcement only/.test(h), 'ui: says when the call is one-way rather than pretending it is a conversation');

  // It must live in the MAIN renderer script, not the Three.js module block — otherwise a CDN/importmap
  // failure would silently take the call button with it.
  const mainStart = h.indexOf('<script>', 1200), mainEnd = h.indexOf('</script>', mainStart);
  const at = h.indexOf('// ---------------- CALL');
  ok(at > mainStart && at < mainEnd, 'ui: the call logic lives in the main renderer script, not the module block');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
