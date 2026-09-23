#!/usr/bin/env node
'use strict';
// Why did the phone call not work? Runs the preflight against the live public URL and names the
// link that broke. Read-only — places no call. Run under electron so it can read the vaulted
// Twilio auth token:  npx electron scripts/voice-doctor.js
const path = require('path');
const ROOT = path.join(__dirname, '..');

(async () => {
  if (process.versions.electron) {
    const { app } = require('electron');
    try { app.setName('bhatbot'); } catch {}
    await app.whenReady();
  }
  const fs = require('fs'), os = require('os');
  const { execSync } = require('child_process');
  const preflight = require(path.join(ROOT, 'lib', 'voicepreflight'));

  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8')); } catch {}
  try {
    const credentials = require(path.join(ROOT, 'lib', 'credentials'));
    c = credentials.resolveRefs(c);
  } catch {}

  console.log('\n── voice doctor ' + '─'.repeat(58));
  let funnel = '(unknown)';
  try { funnel = execSync('tailscale funnel status 2>&1', { timeout: 5000 }).toString().trim(); } catch (e) { funnel = 'error: ' + e.message; }
  const published = !/no serve config/i.test(funnel) && /https:\/\//.test(funnel);
  console.log(`  funnel published : ${published ? 'yes' : 'NO  ← run `tailscale funnel 8788`'}`);
  console.log(`  public host      : ${c.publicHost || '(none)'}`);
  console.log(`  twilio auth token: ${c.twilioToken ? (String(c.twilioToken).startsWith('CRED_REF') ? 'VAULTED — could not decrypt (run under electron)' : 'resolved') : 'MISSING'}`);
  console.log(`  mcp token        : ${c.mcpToken ? (String(c.mcpToken).startsWith('CRED_REF') ? 'VAULTED — could not decrypt' : 'resolved') : 'MISSING'}`);

  // CHECK THE HOST THAT WILL ACTUALLY BE USED. twilioCall prefers the cloud when it is configured,
  // because the Tailscale funnel cannot be reached from outside this NAT — so a doctor that only
  // ever examined publicHost would keep reporting a broken path that calls no longer take.
  const cloudHost = (c.cloudUrl && c.cloudToken && !/^CRED_REF/.test(String(c.cloudToken)))
    ? String(c.cloudUrl).replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';
  const useCloud = !!cloudHost;
  console.log(`  webhook host     : ${useCloud ? cloudHost + '  (the cloud — reachable)' : c.publicHost + '  (this Mac via Tailscale funnel)'}`);
  const r = useCloud
    ? await preflight.check({ host: cloudHost, token: c.cloudToken, authToken: c.twilioToken, ownerPhone: c.myPhone, path: 'outgoing', param: 'purpose' })
    : await preflight.check({ host: c.publicHost, token: c.mcpToken, authToken: c.twilioToken, ownerPhone: c.myPhone });
  console.log(`\n  stage: ${r.stage}${r.status ? ' (HTTP ' + r.status + ')' : ''}`);
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.detail}`);
  if (r.twiml) console.log(`\n  TwiML returned:\n    ${String(r.twiml).replace(/></g, '>\n    <').slice(0, 600)}`);
  if (r.ok) console.log('\n  ✓ TWO-WAY: it speaks and listens — a real conversation will work.');
  else console.log('\n  A two-way call placed right now would play "An application error has occurred".');

  if (process.versions.electron) { try { require('electron').app.exit(r.ok ? 0 : 1); } catch {} }
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
