# Local research office

Open the dashboard at http://127.0.0.1:4612 and the 3D office at http://127.0.0.1:4600. The dashboard shows the roster, per-journal search results, next checks, and research jobs. The 3D office mirrors activity at five desk terminals.

| Role | Work |
| --- | --- |
| Politics | Queries Crossref for recent American Political Science Review and International Organization papers. |
| Global health | Queries Crossref for recent BMJ Global Health and The Lancet Global Health papers. |
| Planner | Makes a plan with ChatGPT via a signed-in Codex CLI, or with Qwen for a local job. |
| Researcher | Reads the available source packet and drafts a cited brief with Qwen. |
| Reviewer | Checks claims against the packet and writes the final report with Qwen. |

Each journal job checks the 20 most recently indexed journal articles published within the last 90 days. A successful check schedules another in six hours. Failures retry after 15 minutes. SQLite remembers DOIs across restarts. Each briefing covers up to five new articles. A source may contain only the bibliographic record. Links in sources.md lead to the DOI. Model-generated citations and conclusions need checking.

Scheduled briefs use local inference. Manual jobs default to ChatGPT planning and local research. The history importer reads a ChatGPT export locally and offers questions to research.

## Restore on another Apple Silicon Mac

Extract the entire ResearchOffice folder. With Python 3.14 and Xcode command line tools available, open Restore.command in that folder. Setup installs Python and Node dependencies and downloads Node, OpenCode, Ollama and Qwen. Allow several GB of disk space. For hybrid planning, sign in to the Codex CLI with ChatGPT. Open 3D office.command copies the new office password for sign-in. The ZIP includes the selected Agent Office source revision. Each installation generates its own service credentials and database.

Install background service.command registers the per-user macOS LaunchAgent. It checks the services every minute while logged in, restarts missing components, and runs due searches. If launchctl reports an error in a restricted session, open that command from Finder in your desktop login. macOS suspends work during sleep and while powered off. Due feeds run after wake or login. The Codex recovery automation belongs to the original chat and is managed separately in the app.

To disable the login service, run launchctl bootout gui/$(id -u)/local.research-office and remove ~/Library/LaunchAgents/local.research-office.plist. Already running app processes may stay open until logout.
