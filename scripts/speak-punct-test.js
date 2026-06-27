#!/usr/bin/env node
'use strict';
// Audible reverification of speech punctuation: synthesizes 5 punctuation types through the
// RUNNING app's real /tts (synthesizeSpeech → normalizeForSpeech in main.js + the live voice)
// and plays each aloud. Run: node scripts/speak-punct-test.js
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8'));
// Phase 4 vaulted mcpToken (CRED_REF handle; safeStorage is Electron-only) → prefer BHATBOT_MCP_TOKEN.
const TOKEN = (process.env.BHATBOT_MCP_TOKEN || '').trim()
  || (c.mcpToken && !/^CRED_REF/i.test(String(c.mcpToken)) ? c.mcpToken : '');
if (!TOKEN) { console.error('✗ no usable mcpToken — set BHATBOT_MCP_TOKEN (see `[mcp] listening` in the app log).'); process.exit(2); }
const endpoint = `http://127.0.0.1:${c.mcpPort || 8788}/api/${TOKEN}/tts`;

const samples = [
  ['Periods (email / domain / filename)', 'Email me at siddhant.bhat@gmail.com about main.js on protfunc.prismlab.workers.dev.'],
  ['Currency and decimals', 'It costs $1,200.50 exactly, and the ratio is 3.5.'],
  ['Symbols: percent, degrees, slash, number', 'Battery at 95%, the room is 72°, it is running TCP/IP, and it is issue #3.'],
  ['Abbreviations', 'Use the API, e.g. version two, i.e. the latest, etc., got it w/ no trouble.'],
  ['Path, ampersand, ellipsis cadence', 'Open ~/.bhatbot/config.json then save & quit, vs. closing it.'],
];

(async () => {
  for (let i = 0; i < samples.length; i++) {
    const [label, text] = samples[i];
    console.log(`\n🔊 ${i + 1}. ${label}\n   text: ${text}`);
    let r;
    try {
      const resp = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify({ text }),
      });
      r = await resp.json();
    } catch (e) { console.log('   ⚠ request failed: ' + e.message); continue; }
    if (!r || r.error || !r.audio) { console.log('   ⚠ ' + ((r && r.error) || 'no audio')); continue; }
    const ext = (r.mimeType || '').includes('wav') ? 'wav' : 'mp3';
    const f = path.join(os.tmpdir(), `punct-${i + 1}.${ext}`);
    fs.writeFileSync(f, Buffer.from(r.audio, 'base64'));
    console.log(`   via ${r.via}, ${Math.round(fs.statSync(f).size / 1024)} KB — playing…`);
    try { execFileSync('afplay', [f]); } catch (e) { console.log('   ⚠ afplay: ' + e.message); }
  }
  console.log('\ndone — heard all 5.');
})();
