'use strict';
// Import macOS Contacts → BhatBot. Pulls name/phones/emails via AppleScript, normalizes phone
// numbers to E.164-ish, writes ~/.bhatbot/contacts.json, and (if a token is provided) uploads them
// to the cloud so the always-on butler can resolve caller ID by name. Re-runnable; user "who is"
// notes added later via the `contacts` tool are preserved on re-import.
//
//   node scripts/contacts-import.js              # local file only
//   BHATBOT_TOKEN=… CLOUD_URL=https://bhatbot-cloud.fly.dev node scripts/contacts-import.js   # + upload
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(process.env.HOME, '.bhatbot', 'contacts.json');
const FS = String.fromCharCode(1);   // field separator (can't occur in contact text)
const VS = String.fromCharCode(2);   // multi-value separator (phones/emails)

const SCRIPT = `
set tid to AppleScript's text item delimiters
tell application "Contacts"
  set out to {}
  repeat with p in people
    set nm to ""
    try
      set nm to (name of p as text)
    end try
    set AppleScript's text item delimiters to (ASCII character 2)
    set ph to ""
    try
      set ph to ((value of phones of p) as text)
    end try
    set em to ""
    try
      set em to ((value of emails of p) as text)
    end try
    set AppleScript's text item delimiters to tid
    set end of out to nm & (ASCII character 1) & ph & (ASCII character 1) & em
  end repeat
  set AppleScript's text item delimiters to linefeed
  set txt to (out as text)
  set AppleScript's text item delimiters to tid
  return txt
end tell`;

function e164(raw) {
  const s = String(raw || '').trim();
  const plus = s.startsWith('+');
  const d = s.replace(/\D/g, '');
  if (!d) return '';
  if (plus) return '+' + d;
  if (d.length === 10) return '+1' + d;                // US default
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return '+' + d;
}

(function main() {
  let raw;
  try { raw = execFileSync('osascript', ['-e', SCRIPT], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { console.error('✗ Contacts read failed (grant access in System Settings → Privacy → Contacts):', e.message); process.exit(1); }

  const contacts = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [name = '', ph = '', em = ''] = line.split(FS);
    const phones = ph.split(VS).map(e164).filter(Boolean);
    const emails = em.split(VS).map((x) => x.trim()).filter(Boolean);
    if (!name.trim() && !phones.length) continue;
    contacts.push({ name: name.trim(), phones: [...new Set(phones)], emails: [...new Set(emails)] });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updated: Date.now(), count: contacts.length, contacts }, null, 2));
  console.log(`✓ ${contacts.length} contacts → ${OUT}`);

  const token = process.env.BHATBOT_TOKEN;
  const url = (process.env.CLOUD_URL || 'https://bhatbot-cloud.fly.dev').replace(/\/+$/, '');
  if (!token) { console.log('• no BHATBOT_TOKEN set → skipped cloud upload (local file written).'); return; }
  fetch(`${url}/api/${token}/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contacts }) })
    .then((r) => r.json())
    .then((j) => console.log(j.ok ? `✓ uploaded ${j.count} to cloud` : `✗ upload: ${JSON.stringify(j)}`))
    .catch((e) => console.error('✗ upload failed:', e.message));
})();
