#!/usr/bin/env node
'use strict';
// Install/uninstall BhatBot as an always-on macOS LaunchAgent so it starts at login and auto-restarts
// on crash — the local half of the HYBRID always-on design (the cloud/ brain is the 24/7 half for when
// the Mac is off). This is the FOUNDATION: it keeps the process alive; a hidden/tray "background mode"
// and the headless brain are the next steps (see DAEMON.md).
//
//   node scripts/install-daemon.js            # install + load
//   node scripts/install-daemon.js --uninstall
//
// KeepAlive is crash-only (SuccessfulExit:false) so quitting BhatBot on purpose does NOT relaunch it;
// RunAtLoad starts it at login. Logs → ~/.bhatbot/logs/daemon.log.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const LABEL = 'com.bhatbot.agent';
const REPO = path.resolve(__dirname, '..');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
const LOG_DIR = path.join(os.homedir(), '.bhatbot', 'logs');
const ELECTRON = path.join(REPO, 'node_modules', '.bin', 'electron');

function uninstall() {
  try { execSync(`launchctl unload ${JSON.stringify(PLIST_PATH)}`, { stdio: 'ignore' }); } catch {}
  try { fs.unlinkSync(PLIST_PATH); console.log('✓ Removed', PLIST_PATH); } catch { console.log('(no plist to remove)'); }
  console.log('✓ BhatBot daemon uninstalled.');
}

function install() {
  if (!fs.existsSync(ELECTRON)) { console.error('✗ electron not found at', ELECTRON, '\n  Run `npm install` in', REPO, 'first.'); process.exit(1); }
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ELECTRON}</string>
    <string>${REPO}</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${path.join(LOG_DIR, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(LOG_DIR, 'daemon.log')}</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
  fs.writeFileSync(PLIST_PATH, plist);
  try { execSync(`launchctl unload ${JSON.stringify(PLIST_PATH)}`, { stdio: 'ignore' }); } catch {}
  try { execSync(`launchctl load ${JSON.stringify(PLIST_PATH)}`, { stdio: 'inherit' }); }
  catch (e) { console.error('✗ launchctl load failed:', e.message); process.exit(1); }
  console.log('✓ BhatBot daemon installed + loaded.');
  console.log('  plist:', PLIST_PATH);
  console.log('  It now starts at login and auto-restarts on crash (not on intentional quit).');
  console.log('  Logs:', path.join(LOG_DIR, 'daemon.log'));
  console.log('  Uninstall: npm run daemon:uninstall');
}

(process.argv.includes('--uninstall') ? uninstall : install)();
