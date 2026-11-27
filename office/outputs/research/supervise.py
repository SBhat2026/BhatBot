"""Keep the office and local model available while this user is logged in."""
import sys
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen
HERE=Path(__file__).resolve().parent
def available(url):
    try:
        with urlopen(url,timeout=3) as r: return r.status==200
    except OSError: return False

while True:
    if not all(available(url) for url in ("http://127.0.0.1:4612/state","http://127.0.0.1:4600/api/login","http://127.0.0.1:11436/health")):
        subprocess.run(["/bin/zsh",str(HERE/"Start research.command"),"--background"],cwd=HERE)
    subprocess.run([sys.executable,str(HERE/"scan.py")],cwd=HERE)
    time.sleep(60)
