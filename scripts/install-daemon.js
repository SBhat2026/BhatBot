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

// ── THE HEADLESS SYNAPSE WORKER ───────────────────────────────────────────────────────────────────
// Note what `install()` above actually does: it launches the ELECTRON GUI. That is why BhatBot's
// "always-on" subsystems were never on — closing the window stopped them, and the app went 15 days
// without launching while `~/.bhatbot/brain/` stayed empty.
//
// This installs the real thing: a plain node process (scripts/synapse-worker.js) with no Electron in
// its require graph. Three details are load-bearing, all learned from the two agents that were found
// dead on this machine:
//   • ABSOLUTE node path from process.execPath — never `npm`. launchd runs with a minimal PATH that
//     has no node, which is exactly why com.siddhant.bhatbot exited 127 every single boot.
//   • EXPLICIT PATH + HOME. Without HOME, `os.homedir()` resolves somewhere unexpected and the worker
//     writes its graph into the void. Without PATH, the `security` CLI (Keychain) is unreachable.
//   • ThrottleInterval, so a crash-looping worker backs off instead of hammering the machine.
const WORKER_LABEL = 'com.bhatbot.synapse';
const WORKER_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', WORKER_LABEL + '.plist');
const WORKER_SCRIPT = path.join(REPO, 'scripts', 'synapse-worker.js');

function uninstallWorker() {
  try { execSync(`launchctl bootout gui/${process.getuid()}/${WORKER_LABEL}`, { stdio: 'ignore' }); }
  catch { try { execSync(`launchctl unload ${JSON.stringify(WORKER_PLIST)}`, { stdio: 'ignore' }); } catch {} }
  try { fs.unlinkSync(WORKER_PLIST); console.log('✓ Removed', WORKER_PLIST); } catch { console.log('(no worker plist to remove)'); }
  console.log('✓ SYNAPSE worker uninstalled — the second brain now only updates while the app is open.');
}

function installWorker() {
  if (!fs.existsSync(WORKER_SCRIPT)) { console.error('✗ worker not found at', WORKER_SCRIPT); process.exit(1); }
  const NODE = process.execPath;   // the node running THIS installer — guaranteed to exist and be absolute
  if (/electron/i.test(NODE)) {
    console.error('✗ Run this with plain node, not electron:  node scripts/install-daemon.js --worker');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(WORKER_PLIST), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'synapse-worker.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${WORKER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${WORKER_SCRIPT}</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>5</integer>
</dict>
</plist>
`;
  fs.writeFileSync(WORKER_PLIST, plist);
  try { execSync(`launchctl bootout gui/${process.getuid()}/${WORKER_LABEL}`, { stdio: 'ignore' }); } catch {}
  try { execSync(`launchctl bootstrap gui/${process.getuid()} ${JSON.stringify(WORKER_PLIST)}`, { stdio: 'inherit' }); }
  catch {
    try { execSync(`launchctl load ${JSON.stringify(WORKER_PLIST)}`, { stdio: 'inherit' }); }   // older macOS
    catch (e) { console.error('✗ launchctl failed:', e.message); process.exit(1); }
  }
  console.log('✓ SYNAPSE worker installed + started.');
  console.log('  plist:', WORKER_PLIST);
  console.log('  node: ', NODE);
  console.log('  logs: ', logFile);
  console.log('');
  console.log('  Verify it is genuinely alive (do not trust the install message):');
  console.log(`    launchctl print gui/$UID/${WORKER_LABEL} | grep -E "state|last exit"`);
  console.log('    ls -la ~/.bhatbot/brain/graph.json      # must exist, and its mtime must advance');
  console.log('    node scripts/synapse-worker.js --status');
  console.log('    node scripts/bhatctl.js doctor');
  console.log('');
  console.log('  The PAID pass (embeddings + link rationales) needs keys a headless process can read —');
  console.log('  config.json only holds vault handles that Electron can decrypt. To enable it:');
  console.log('    security add-generic-password -s bhatbot-anthropic -a bhatbot -w "sk-ant-…"');
  console.log('    security add-generic-password -s bhatbot-openai    -a bhatbot -w "sk-…"');
  console.log('  Without them the FREE pass still runs, which is most of the value.');
  console.log('  Uninstall: node scripts/install-daemon.js --uninstall-worker');
}

const argv = process.argv;
if (argv.includes('--uninstall-worker')) uninstallWorker();
else if (argv.includes('--worker')) installWorker();
else if (argv.includes('--uninstall')) uninstall();
else install();
