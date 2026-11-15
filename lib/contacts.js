'use strict';
// ── CONTACTS — his whole address book, from macOS Contacts ───────────────────────────────────────
//
// 2026-11-14: "let BhatBot access phone calling, including my whole contacts list". The call button
// read ~/.bhatbot/contacts.json, a one-off export from June with 150 people. This reads macOS
// Contacts itself (which is where his iCloud contacts sync to) through JXA, in bulk — one Apple
// Event per property rather than one per person, so a thousand contacts take a second, not minutes.
// The first run makes macOS ask once whether BhatBot may use Contacts.
//
// Pure apart from `run` (the osascript call), so the shaping is testable.

const SCRIPT = `
const C = Application('Contacts');
const P = C.people;
const n = P.name(), org = P.organization(), ph = P.phones.value(), pl = P.phones.label(), em = P.emails.value();
JSON.stringify(n.map((x, i) => ({ name: x || org[i] || '', phones: ph[i] || [], labels: pl[i] || [], emails: em[i] || [] })));
`;

const digits = (s) => String(s || '').replace(/\D+/g, '');
// Mobile first: a call to a contact should ring the phone in their pocket, not their office.
const rank = (label) => (/iphone|mobile|cell/i.test(label || '') ? 0 : /main|home|_\$!<home/i.test(label || '') ? 1 : /work/i.test(label || '') ? 2 : 3);

/** shape(raw) → [{ name, phones:[string], emails:[string] }] — named, with at least one number, de-duplicated. */
function shape(raw) {
  const out = new Map();
  for (const r of raw || []) {
    const name = String((r && r.name) || '').trim();
    if (!name) continue;
    const nums = (r.phones || []).map((p, i) => ({ p: String(p || '').trim(), r: rank((r.labels || [])[i]) })).filter((x) => digits(x.p).length >= 7);
    if (!nums.length) continue;
    nums.sort((a, b) => a.r - b.r);
    const key = name.toLowerCase();
    const prev = out.get(key) || { name, phones: [], emails: [] };
    for (const { p } of nums) if (!prev.phones.some((q) => digits(q).slice(-10) === digits(p).slice(-10))) prev.phones.push(p);
    for (const e of r.emails || []) if (e && !prev.emails.includes(e)) prev.emails.push(String(e));
    out.set(key, prev);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** sync({ run, write, now }) → { ok, count } | { ok:false, error, permission? } */
async function sync({ run, write, now = Date.now() } = {}) {
  let text;
  try { text = await run(SCRIPT); }
  catch (e) {
    const msg = String((e && e.message) || e);
    // -1743: the user (or nobody yet) has not allowed BhatBot to control Contacts.
    if (/-1743|not authori[sz]ed|not allowed/i.test(msg)) return { ok: false, permission: true, error: 'macOS has not given BhatBot access to Contacts. Allow it in System Settings → Privacy & Security → Automation (BhatBot → Contacts), then sync again.' };
    return { ok: false, error: 'could not read Contacts: ' + msg.slice(0, 160) };
  }
  let raw; try { raw = JSON.parse(String(text).trim()); } catch { return { ok: false, error: 'Contacts returned something unreadable' }; }
  const contacts = shape(raw);
  // An empty read is almost always a permission or sync hiccup, never "he has no contacts" —
  // never overwrite a good list with nothing.
  if (!contacts.length) return { ok: false, error: 'Contacts returned no people with phone numbers — keeping the existing list' };
  write({ updated: new Date(now).toISOString(), source: 'macOS Contacts', count: contacts.length, contacts });
  return { ok: true, count: contacts.length };
}

/**
 * resolve(to, search) → { ok, name, number } | { ok:false, candidates } | { ok:false, error }
 * `to` is a number or a name as he said it. An ambiguous name returns the candidates so the model
 * asks which one, rather than ringing the wrong person.
 */
function resolve(to, search) {
  const q = String(to || '').trim();
  if (!q) return { ok: false, error: 'who should I call?' };
  if (digits(q).length >= 7 && !/[a-z]{3,}/i.test(q)) return { ok: true, name: null, number: q };
  const hits = search(q, 6);
  if (!hits.length) return { ok: false, error: `no contact matches "${q}"` };
  const exact = hits.filter((h) => h.name.toLowerCase() === q.toLowerCase());
  if (exact.length === 1 || hits.length === 1) { const h = exact[0] || hits[0]; return { ok: true, name: h.name, number: h.phones[0], otherNumbers: h.phones.slice(1) }; }
  return { ok: false, candidates: hits.map((h) => h.name), error: `"${q}" matches ${hits.length} contacts — ask which one` };
}

module.exports = { SCRIPT, shape, sync, resolve, digits };
