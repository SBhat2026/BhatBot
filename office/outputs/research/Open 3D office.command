#!/bin/zsh
set -eu
cd "${0:A:h}"
python3 -c 'import json; print(json.load(open(".agent-office/config.json"))["password"],end="")' | pbcopy
echo 'The office password is on your clipboard. Paste it into the local sign-in form.'
open http://127.0.0.1:4600
