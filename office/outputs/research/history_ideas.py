"""Extract candidate questions locally from chat-history exports (ChatGPT format)."""
import io
import json
import re
import zipfile

LIMIT = 256 * 1024 * 1024

def ideas(raw):
    if raw.startswith(b"PK"):
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = [f for f in archive.infolist() if re.fullmatch(r"(?:.*/)?conversations(?:[-_]\d+)?\.json", f.filename)]
            if sum(f.file_size for f in entries) > LIMIT:
                raise ValueError("Choose an individual conversations JSON file from the ZIP.")
            if not entries: raise ValueError("This ZIP has no conversations JSON file.")
            batches = [json.loads(archive.read(f)) for f in entries]
    else:
        batches = [json.loads(raw)]
    result = []
    seen = set()
    for batch in batches:
        if not isinstance(batch,list): raise ValueError("Expected a ChatGPT conversations export.")
        for chat in sorted(batch,key=lambda c:c.get("update_time") or 0,reverse=True):
            for node in reversed(list((chat.get("mapping") or {}).values())):
                msg = node.get("message") or {}
                if msg.get("author",{}).get("role") != "user": continue
                parts = (msg.get("content") or {}).get("parts") or []
                for part in parts:
                    if not isinstance(part,str): continue
                    for line in re.split(r"(?<=[?.!])\s+|\n+",part):
                        q=line.strip()
                        if not 18<=len(q)<=440 or q.casefold() in seen: continue
                        if not (q.endswith("?") or re.match(r"(compare|investigate|research|explain|explore|evaluate)\b",q,re.I)): continue
                        seen.add(q.casefold())
                        result.append(dict(question=q,source=chat.get("title") or "Untitled chat"))
                        break
                    else: continue
                    break
                else: continue
                break
            if len(result)>=40: return result
    return result
