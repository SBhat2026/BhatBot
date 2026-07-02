'use strict';
// ── iOS SIMULATOR adapter (FORGE / Phase 3 native mobile lane) ────────────────────────────────────
// Native iOS testing via `xcrun simctl`: list/boot devices, install/launch apps, screenshot. Input
// (taps/typing) is handled by the EXISTING OmniParser screen_parse → vision_click loop over the
// screenshots this returns — so no extra input-injection dependency by default.
//
// DECISION — pure simctl + OmniParser vision taps (not idb / Appium / WebDriverAgent) as the default:
//   simctl is already installed with Xcode (zero extra dep), and BhatBot already has a vision tap loop.
//   `idb` (brew install idb-companion) is the documented upgrade IF vision taps prove flaky — gated
//   behind a config flag + an explicit ask, never installed silently.
//
// child_process only. Every method degrades: no Xcode → available()=false, methods return { error,
// hint }. Headless-safe: the test probes available() and only exercises read-only listing when present.
const { execFile } = require('child_process');

function sh(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile('xcrun', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code || 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
    });
  });
}

async function available(timeoutMs = 5000) {
  const r = await sh(['simctl', 'help'], { timeoutMs });
  return r.ok;
}

// listDevices — normalized: [{ udid, name, state, runtime, booted }]. Booted first.
async function listDevices() {
  const r = await sh(['simctl', 'list', 'devices', '--json']);
  if (!r.ok) return { error: 'simctl list failed: ' + r.stderr.slice(0, 200), hint: INSTALL_HINT, devices: [] };
  let json; try { json = JSON.parse(r.stdout); } catch { return { error: 'unparseable simctl output', devices: [] }; }
  const out = [];
  for (const [runtime, arr] of Object.entries(json.devices || {})) {
    for (const d of arr || []) if (d.isAvailable !== false) out.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtime.split('.').pop(), booted: d.state === 'Booted' });
  }
  out.sort((a, b) => (b.booted - a.booted) || a.name.localeCompare(b.name));
  return { devices: out };
}

// Pick a booted device, else a sensible iPhone, else the first available.
async function pickDevice(preferred) {
  const { devices = [], error } = await listDevices();
  if (error) return { error };
  if (preferred) { const d = devices.find((x) => x.udid === preferred || x.name === preferred); if (d) return { device: d }; }
  return { device: devices.find((d) => d.booted) || devices.find((d) => /iPhone/i.test(d.name)) || devices[0] || null };
}

async function boot(udid) { const r = await sh(['simctl', 'boot', udid], { timeoutMs: 60000 }); return r.ok || /current state: Booted/i.test(r.stderr) ? { booted: udid } : { error: r.stderr.slice(0, 200) }; }
async function shutdown(udid) { const r = await sh(['simctl', 'shutdown', udid]); return r.ok ? { shutdown: udid } : { error: r.stderr.slice(0, 200) }; }
async function install(udid, appPath) { const r = await sh(['simctl', 'install', udid, appPath], { timeoutMs: 120000 }); return r.ok ? { installed: appPath } : { error: r.stderr.slice(0, 200) }; }
async function launch(udid, bundleId) { const r = await sh(['simctl', 'launch', udid, bundleId], { timeoutMs: 60000 }); return r.ok ? { launched: bundleId, stdout: r.stdout.trim() } : { error: r.stderr.slice(0, 200) }; }
async function openUrl(udid, url) { const r = await sh(['simctl', 'openurl', udid, url], { timeoutMs: 30000 }); return r.ok ? { opened: url } : { error: r.stderr.slice(0, 200) }; }
async function screenshot(udid, outPath) { const r = await sh(['simctl', 'io', udid, 'screenshot', outPath], { timeoutMs: 30000 }); return r.ok ? { screenshot: outPath } : { error: r.stderr.slice(0, 200) }; }

const INSTALL_HINT = 'Native iOS testing needs Xcode + Command Line Tools (`xcode-select --install`, then open Xcode once to accept the license). If OmniParser vision-taps prove unreliable, `brew install idb-companion` enables precise tap/type — ask first.';

module.exports = { available, listDevices, pickDevice, boot, shutdown, install, launch, openUrl, screenshot, INSTALL_HINT };
