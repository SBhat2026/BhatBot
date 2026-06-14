'use strict';
// Domain-keyed login profiles. Maps a hostname → how to sign in: the username (not
// secret), CRED_REF handles for the password + optional TOTP secret (never plaintext),
// the page URL, optional field selectors, and the 2-factor method. Source of truth is a
// local JSON file; smart_login reads it to log in automatically and to know whether the
// second factor can be done silently (TOTP) or needs the phone (push/SMS code).
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.bhatbot', 'logins.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function save(c) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(c, null, 2)); }

// Normalize anything (bare host, full URL) to a registrable host key: "www.youtube.com" → "youtube.com".
function hostKey(input) {
  let h = String(input || '').trim().toLowerCase();
  try { if (/^https?:\/\//.test(h)) h = new URL(h).hostname; } catch {}
  h = h.replace(/^www\./, '').replace(/\/.*$/, '');
  return h;
}

function get(input) {
  const c = load();
  const key = hostKey(input);
  if (c[key]) return { host: key, ...c[key] };
  // Fall back to a parent-domain match (e.g. accounts.google.com → google.com).
  const parts = key.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.');
    if (c[cand]) return { host: cand, ...c[cand] };
  }
  return null;
}

// profile: { host|url, username, credRef, totpRef?, url?, twoFactor?, selectors?, notes? }
function set(profile) {
  if (!profile || (!profile.host && !profile.url)) throw new Error('host or url required');
  const key = hostKey(profile.host || profile.url);
  const c = load();
  const prev = c[key] || {};
  c[key] = {
    username: profile.username ?? prev.username ?? '',
    credRef: profile.credRef ?? prev.credRef ?? '',
    totpRef: profile.totpRef ?? prev.totpRef ?? '',
    url: profile.url ?? prev.url ?? `https://${key}/`,
    twoFactor: profile.twoFactor ?? prev.twoFactor ?? 'auto',   // auto | totp | phone | none
    selectors: profile.selectors ?? prev.selectors ?? null,     // {user,pass,submit,otp}
    notes: profile.notes ?? prev.notes ?? '',
    updated: new Date().toISOString(),
  };
  save(c);
  return { host: key, ...c[key] };
}

function list() {
  return Object.entries(load()).map(([host, v]) => ({
    host, username: v.username, url: v.url, twoFactor: v.twoFactor,
    hasPassword: !!v.credRef, hasTotp: !!v.totpRef, updated: v.updated,
  }));
}

function remove(input) { const c = load(); const key = hostKey(input); const had = !!c[key]; delete c[key]; save(c); return had; }

module.exports = { get, set, list, remove, hostKey, FILE };
