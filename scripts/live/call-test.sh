#!/bin/zsh
# Electron probes: each resolves vaulted credentials IN-PROCESS (app name bhatbot) and prints no secret.
# mcp-run: runs one instruction through the running app (INSTR=...). twilio-timings: last calls + webhook timings.
# NEXT PASS ONLY — places one real test call to Siddhant. Not run on 2026-11-25 (he asked for prep only).
#  1. lift calls.hold   2. rehearse (no dial)   3. real test call   4. Twilio webhook timings at +2 and +6 min
set -e
cd ~/bhatbot
E=node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
node -e "const fs=require('fs');const p=process.env.HOME+'/.bhatbot/config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));if(c.calls)delete c.calls.hold;fs.writeFileSync(p,JSON.stringify(c,null,2));console.log('hold lifted')"
sleep 2
echo "=== $(date) rehearse"
INSTR='Use the reach tool with action "rehearse". Return the raw JSON result verbatim, nothing else.' $E scripts/live/mcp-run 2>&1 | grep -A20 '^PROBE\|^ERR'
echo "=== $(date) real test call"
INSTR='Use the reach tool with action "test" and channel "call". Return the raw JSON result verbatim, nothing else.' $E scripts/live/mcp-run 2>&1 | grep -A20 '^PROBE\|^ERR'
sleep 120; echo "=== $(date) timings"; $E scripts/live/twilio-timings 2>&1 | grep -E '^(CALL|  EV|ERR)' | head -14
sleep 240; echo "=== $(date) final"; $E scripts/live/twilio-timings 2>&1 | grep -E '^(CALL|  EV|ERR)' | head -14
python3 -c "import json;t=json.load(open('/Users/siddhantbhat/.bhatbot/reach.json'))[-1];print('TICKET',json.dumps({k:t.get(k) for k in ['msg','calls','closed','log']}))"
