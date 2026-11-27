#!/bin/zsh
set -eu
cd "${0:A:h}"
export RESEARCH_APP="$PWD"
python3 - <<'PY'
import plistlib,os
from pathlib import Path
app=Path(os.environ['RESEARCH_APP'])
work=app.parents[1]/'work'
target=Path.home()/'Library/LaunchAgents/local.research-office.plist'
target.parent.mkdir(exist_ok=True)
target.write_bytes(plistlib.dumps(dict(Label='local.research-office',ProgramArguments=[str(work/'venv/bin/python'),str(app/'supervise.py')],WorkingDirectory=str(app),RunAtLoad=True,KeepAlive=True,ThrottleInterval=60,StandardOutPath=str(work/'service.log'),StandardErrorPath=str(work/'service.log'))))
PY
domain="gui/$(id -u)"
if ! launchctl print "$domain/local.research-office" >/dev/null 2>&1; then
 launchctl bootstrap "$domain" "$HOME/Library/LaunchAgents/local.research-office.plist"
fi
launchctl print "$domain/local.research-office" | head -16
