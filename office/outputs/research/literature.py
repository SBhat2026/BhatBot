"""Periodic journal searches and durable, duplicate-free briefing jobs."""
import datetime as dt
import html
import json
import re
import subprocess
import time
import uuid
from urllib.parse import urlencode


FEEDS = {
    "Politics": [("American Political Science Review", "0003-0554"), ("International Organization", "0020-8183")],
    "Global health": [("BMJ Global Health", "2059-7908"), ("The Lancet Global Health", "2214-109X")],
}
ROSTER = {
    "Politics": "Searches political science and international relations journals for new articles.",
    "Global health": "Searches global health journals for new articles on populations, policy and health systems.",
    "Planner": "Turns each question into research steps with Claude, or the local model in local-only mode.",
    "Researcher": "Reads evidence and drafts a brief with source IDs.",
    "Reviewer": "Checks the draft against the supplied evidence with Claude and writes the final report.",
}

def initialize(db):
    with db() as c:
        c.execute("create table if not exists feed_state (issn text primary key, checked real, due real, status text)")
        c.execute("create table if not exists papers (topic text, doi text, primary key(topic,doi))")
        c.execute("create table if not exists literature_jobs (job text primary key, evidence text)")

def fetch(issn):
    today=dt.date.today()
    params=urlencode(dict(filter=f"type:journal-article,from-pub-date:{today-dt.timedelta(days=90)},until-pub-date:{today}",rows=20,sort="indexed",order="desc"))
    url=f"https://api.crossref.org/journals/{issn}/works?{params}"
    data=subprocess.check_output(["/usr/bin/curl","--fail","--silent","--show-error","--max-time","30",url], timeout=35)
    return json.loads(data)["message"]["items"]

def scan(db,topic,journal,issn):
    now=time.time()
    try:
        items=fetch(issn)
        with db() as c:
            evidence=[]
            for item in items:
                doi=item.get("DOI","").lower()
                if not doi or not item.get("title"): continue
                if not c.execute("insert or ignore into papers values(?,?)",(topic,doi)).rowcount: continue
                abstract=html.unescape(re.sub("<[^>]+>"," ",item.get("abstract",""))).strip()
                date="-".join(map(str,item.get("published",{}).get("date-parts",[[]])[0]))
                evidence.append(f"{item['title'][0]} — {journal}, {date}\nhttps://doi.org/{doi}\n{abstract[:900] or 'Bibliographic record only. Findings unavailable.'}")
            for start in range(0,len(evidence),5):
                batch=evidence[start:start+5]
                job=uuid.uuid4().hex[:12]
                q=f"{topic} literature watch — {journal}, {today_label(now)}, group {start//5+1}. Identify research topics and cite each paper. Describe findings only when supported by its abstract."
                c.execute("insert into jobs values(?,?,0,'queued',?,'local')",(job,q,now))
                c.execute("insert into literature_jobs values(?,?)",(job,"\n\n".join(f"[S{i}] {s}" for i,s in enumerate(batch,1))))
            status=f"{len(evidence)} new records from {len(items)} checked"
            c.execute("insert or replace into feed_state values(?,?,?,?)",(issn,now,now+21600,status))
    except Exception as exc:
        status=f"Retry in 15 minutes — {type(exc).__name__}: {exc}"
        with db() as c: c.execute("insert or replace into feed_state values(?,?,?,?)",(issn,now,now+900,status))
    return status

def today_label(t):
    return dt.datetime.fromtimestamp(t).date().isoformat()

