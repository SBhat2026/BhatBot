import json
from urllib.request import Request, urlopen
from mcp.server.fastmcp import FastMCP

api = FastMCP("local-research")

@api.tool()
def submit_research(question: str) -> str:
    """Queue a question for planning, local research and citation review."""
    request = Request("http://127.0.0.1:4612/jobs", data=json.dumps({"question":question}).encode(), headers={"Content-Type":"application/json"})
    with urlopen(request,timeout=10) as response:
        return response.read().decode()

@api.tool()
def research_status(job_id: str) -> dict:
    """Return the job, recent activity and the completed report when available."""
    with urlopen("http://127.0.0.1:4612/state",timeout=10) as response:
        state=json.load(response)
    job=next((row for row in state["jobs"] if row["id"]==job_id),None)
    if job is None: return {"error":"Unknown or archived job"}
    result={"job":job,"events":[e for e in state["events"] if e["job"]==job_id][:6]}
    if job["status"]=="complete":
        with urlopen("http://127.0.0.1:4612/runs/"+job_id+"/report.md",timeout=10) as response:
            result["report"]=response.read().decode()
    return result

if __name__=="__main__":
    api.run()
