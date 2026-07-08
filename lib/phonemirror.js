// lib/phonemirror.js — drive Siddhant's iPhone through macOS "iPhone Mirroring".
//
// iPhone Mirroring (macOS 15+/Sequoia) presents the phone as an ordinary Mac window, so BhatBot
// can operate it with the SAME vision loop it uses for any native app: screen_parse → vision_click.
// This module is the THIN glue that the phone_mirror tool composes: launch/focus the app, report
// whether it's live, drive the built-in keyboard shortcuts (Home / App Switcher / Spotlight), and
// read the window geometry so the caller can scope a screenshot/parse to just the phone.
//
// Self-contained: Node built-ins + `osascript` only. No deps, no network. Every function RESOLVES
// (never rejects) so a tool turn can't hang on a permission prompt or a missing app.

const { spawn } = require('child_process');

const APP = 'iPhone Mirroring';
// iPhone Mirroring's documented keyboard shortcuts (all with ⌘): 1 = Home Screen, 2 = App
// Switcher, 3 = Spotlight. We drive these via System Events so we never guess pixel coords for the
// hardware-button gestures.
const KEY = { home: '1', switcher: '2', spotlight: '3' };

// osascript runner — resolves { ok, out, err }. Hard timeout so a blocked Apple-event prompt
// can never wedge the agent loop.
function osa(script, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let p;
    try { p = spawn('osascript', ['-e', script], { env: process.env }); }
    catch (e) { return finish({ ok: false, out: '', err: String(e && e.message || e) }); }
    const t = setTimeout(() => { try { p.kill(); } catch {} finish({ ok: false, out, err: err || 'timeout' }); }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); finish({ ok: code === 0, out: out.trim(), err: err.trim() }); });
    p.on('error', (e) => { clearTimeout(t); finish({ ok: false, out, err: String(e && e.message || e) }); });
  });
}

// Is the iPhone Mirroring process currently running?
async function isRunning() {
  const r = await osa(`tell application "System Events" to (name of processes) contains "${APP}"`);
  return r.ok && /true/i.test(r.out);
}

// Launch (if needed) and bring iPhone Mirroring to the front. Returns { ok, launched }.
async function open() {
  const wasRunning = await isRunning();
  const r = await osa(`tell application "${APP}" to activate`, { timeout: 6000 });
  // Give the window a moment to draw / reconnect to the phone on a cold launch.
  await new Promise((res) => setTimeout(res, wasRunning ? 400 : 2500));
  return { ok: r.ok, launched: !wasRunning, note: r.ok ? undefined : (r.err || 'could not activate iPhone Mirroring') };
}

// Window geometry of the mirrored phone {x,y,w,h} — lets the caller crop screen_parse to the phone
// instead of the whole desktop. null if the window isn't found (app closed / phone not connected).
async function windowBounds() {
  const script = `tell application "System Events" to tell process "${APP}"\n` +
    `if (count of windows) = 0 then return "none"\n` +
    `set p to position of window 1\nset s to size of window 1\n` +
    `return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)\n` +
    `end tell`;
  const r = await osa(script);
  if (!r.ok || r.out === 'none' || !/^-?\d+,/.test(r.out)) return null;
  const [x, y, w, h] = r.out.split(',').map((n) => parseInt(n, 10));
  if ([x, y, w, h].some((n) => Number.isNaN(n))) return null;
  return { x, y, w, h };
}

// Detect whether mirroring is actually CONNECTED to a phone vs. showing the "open your iPhone"
// gate. Heuristic: a connected session gives a tall phone-shaped window (h > w, reasonable size);
// the setup/locked gate is small/absent. Best-effort — the caller confirms visually via a screenshot.
async function connected() {
  const b = await windowBounds();
  if (!b) return { connected: false, reason: 'no iPhone Mirroring window (app closed or phone not linked)' };
  const phoneShaped = b.h > b.w && b.h > 400;
  return { connected: phoneShaped, bounds: b, reason: phoneShaped ? undefined : 'window present but does not look like a live phone screen — Siddhant may need to unlock the phone/Mac' };
}

// Press one of the iPhone Mirroring gesture shortcuts (home / switcher / spotlight).
async function gesture(kind) {
  const k = KEY[kind]; if (!k) return { ok: false, error: `unknown gesture "${kind}"` };
  await osa(`tell application "${APP}" to activate`, { timeout: 4000 });
  await new Promise((res) => setTimeout(res, 250));
  const r = await osa(`tell application "System Events" to keystroke "${k}" using {command down}`);
  return { ok: r.ok, error: r.ok ? undefined : (r.err || 'keystroke failed — grant Accessibility to BhatBot') };
}

module.exports = { APP, isRunning, open, windowBounds, connected, gesture, osa };
