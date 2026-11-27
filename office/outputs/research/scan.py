"""Run due journal searches once, serializing overlapping wakeups."""
import fcntl
import sys
import time
import literature
from research import ROOT, db, event

def main():
    with (ROOT/"work/scanner.lock").open("a") as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: return
        literature.initialize(db)
        for topic,feeds in literature.FEEDS.items():
            for journal,issn in feeds:
                with db() as c:
                    row=c.execute("select due from feed_state where issn=?",(issn,)).fetchone()
                if row and row[0]>time.time() and "--now" not in sys.argv: continue
                event("literature",topic,"Searching "+journal)
                event("literature",topic,journal+" · "+literature.scan(db,topic,journal,issn))

if __name__=="__main__": main()
