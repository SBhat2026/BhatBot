'use strict';
// Tool SCHEMA catalog (Phase 4 split — extracted from main.js). PURE DATA: the {name, description,
// input_schema} definitions the model sees. Implementations live in main.js executeTool / lib/*.
// Exported as a factory only because save_memory's description interpolates the live MEMORY_SECTIONS.
module.exports = function toolSchema({ MEMORY_SECTIONS = [] } = {}) {
  return [
  { name: 'read_file', description: 'Read a UTF-8 text file. Absolute paths. Large files return a paged head with total_lines; pass offset (1-based start line) and limit (line count) to page through the rest — so even a 400KB+ file is fully readable in windows.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number', description: '1-based start line (optional)' }, limit: { type: 'number', description: 'number of lines to return (optional, default 400)' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write a UTF-8 file, mkdir -p on parent. Use for NEW files or full rewrites; to change a few lines of an EXISTING file prefer edit_file (far cheaper in output tokens).',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Surgically patch an EXISTING UTF-8 text file by replacing an exact string — instead of rewriting the whole file (saves large amounts of output). old_string must occur EXACTLY ONCE (include enough surrounding context to be unique); 0 or >1 matches fails with the file left unchanged. Pass replace_all:true to replace every occurrence. Write is atomic (temp+rename); returns a diff preview. For a brand-new file use write_file.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean', description: 'replace EVERY occurrence (default false → old_string must be unique)' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'list_directory', description: 'List directory entries with name + type.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_shell', description: 'Run a shell command (60s). rm/rmdir/trash require user confirmation. Homebrew + claude CLI on PATH.',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } },
  { name: 'fetch_url', description: 'HTTP GET a URL, return text (15s, 50KB cap).',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'open_in_browser', description: "Open a URL in Siddhant's default browser.",
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'delegate_project', description: 'Launch a large, multi-step project goal on the workspace multi-agent orchestrator IN THE BACKGROUND (planner → up to 3 coding/research/browser/memory/creative agents in parallel over structured state). Returns IMMEDIATELY with a job_id — task progress streams to the Activity panel and is announced aloud; you keep chatting normally. Use for big tasks that would otherwise blow up the chat context (building features, long research, multi-file work). After calling, confirm launch in one short sentence and END your turn. Check/steer/cancel later with manage_jobs. Optionally name a workspace to continue an existing project.',
    input_schema: { type: 'object', properties: { goal: { type: 'string' }, workspace: { type: 'string', description: 'workspace slug/name; omit to use/create the active one' }, max_tasks: { type: 'number' } }, required: ['goal'] } },
  { name: 'manage_jobs', description: 'Inspect and control BACKGROUND jobs (delegated projects and their agent tasks). action "list" = every job with id/status/progress/note — use it to report how background work is going. "cancel" = stop a job and its queued subtasks (needs job_id). "guide" = queue a plain-English steering note that all subsequent tasks of that project must follow (needs job_id + guidance), e.g. "skip the research task" or "use TypeScript" — a task job_id routes to its parent project. Use this — not passive acknowledgment — whenever Siddhant redirects running background work.',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'cancel', 'guide'] }, job_id: { type: 'string' }, guidance: { type: 'string' } }, required: ['action'] } },
  { name: 'media_control', description: 'Control Spotify + system audio. Without a device it controls the Mac\'s Spotify via AppleScript. With a `device` (e.g. "phone") it uses Spotify Connect to control THAT device anywhere (needs one-time link + Premium). list_devices = show available Spotify devices; transfer = move playback to a device. set_volume = Spotify volume; set_system_volume = macOS output (0-100). make_playlist = CREATE a Spotify playlist and fill it: pass `name` + `tracks` (array of "song artist" strings to search & add). Needs the playlist-modify scopes — if it 403s, re-run scripts/spotify-auth.js once.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['play_track','pause','resume','next','previous','set_volume','get_now_playing','search_and_play','set_system_volume','list_devices','transfer','make_playlist'] },
      query: { type: 'string', description: 'Track/artist for play_track or search_and_play' },
      volume: { type: 'number', description: '0-100 for volume actions' },
      device: { type: 'string', description: 'Target device name for Spotify Connect, e.g. "phone", "iPhone", "Mac". Omit to control the Mac\'s local Spotify app.' },
      name: { type: 'string', description: 'make_playlist: the playlist name.' },
      description: { type: 'string', description: 'make_playlist: optional playlist description.' },
      tracks: { type: 'array', items: { type: 'string' }, description: 'make_playlist: songs to add, each a search string like "Weightless Marconi Union". Up to 100.' },
      public: { type: 'boolean', description: 'make_playlist: make it public (default false/private).' }
    }, required: ['action'] } },
  { name: 'system_control', description: 'macOS GUI/system automation via AppleScript + System Events. Control ANY app: open_app/activate_app (launch + focus any app by name, e.g. "Photos", "App Store", "Notes", "Messages", "Claude"), quit_app (close an app), keystroke (type text), shortcut (key+modifiers like command/shift/option/control), menu (click a menu item via app+menuPath e.g. ["File","Save"]), clipboard_get/clipboard_set, notification, or applescript (run raw AppleScript). Use this for things the browser/shell cannot do (launching/quitting apps, clicking native UI, window/menu control, clipboard).',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['applescript','open_app','activate_app','quit_app','keystroke','shortcut','menu','clipboard_get','clipboard_set','notification'] },
      app: { type: 'string', description: 'Target app name for open_app/activate_app/quit_app/menu' },
      script: { type: 'string', description: 'Raw AppleScript for action=applescript' },
      text: { type: 'string', description: 'Text for keystroke/clipboard_set/notification' },
      title: { type: 'string', description: 'Title for notification' },
      key: { type: 'string', description: 'Single key for shortcut (e.g. "s")' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'e.g. ["command"], ["command","shift"]' },
      menuPath: { type: 'array', items: { type: 'string' }, description: 'e.g. ["File","Save"]' }
    }, required: ['action'] } },
  { name: 'browser_workflow', description: 'Record/replay reusable browser macros. start_recording → do browser actions → save_workflow{name} captures the working steps; replay_workflow{name} re-runs them; list_workflows / show_workflow / delete_workflow / cancel_recording. Use to save multi-step web tasks (login, navigate, fill, extract) the user repeats.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['start_recording','save_workflow','cancel_recording','list_workflows','show_workflow','replay_workflow','delete_workflow'] },
      name: { type: 'string' }, description: { type: 'string' }
    }, required: ['action'] } },
  { name: 'browser_observe', description: 'Watch-my-browsing + learn from it. CONSENT-FIRST: a real observation session is time-boxed and Siddhant must agree — ALWAYS ASK him first ("Mind if I watch your browsing for ~5–10 min to learn how you do this?") before action:"start". Flow: "start"{minutes:5-10} opens the BhatBot browser and captures his steps (passwords/OTPs excluded); when he is done, "review" returns a digest of what he did (sites + steps) — narrate it and ASK which parts to remember; "save"{items:[...plain-English habits he approved], name?} writes ONLY the approved items to long-term memory (optionally also a replayable workflow). "stop" ends a session early. Lighter actions (no session): "status" → is he interacting now + recent steps + whether a session is active; "wait" → block until he is idle so you do not fight his cursor; "learn"{name} → save the buffered steps as a workflow; "clear" → reset the buffer. The agent also auto-yields before its own browser actions while he is active.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['start', 'stop', 'review', 'save', 'status', 'wait', 'learn', 'clear'] },
      minutes: { type: 'number', description: 'For start: how long to observe (5–10 typical, max 15).' },
      items: { type: 'array', items: { type: 'string' }, description: 'For save: the plain-English habits/preferences Siddhant APPROVED remembering.' },
      name: { type: 'string', description: 'For learn/save: workflow name to also save the steps under.' },
      description: { type: 'string' },
      idleMs: { type: 'number', description: 'How long counts as "idle" (default 1500).' },
      timeoutMs: { type: 'number', description: 'For wait: max wait (default 120000).' }
    }, required: ['action'] } },
  { name: 'save_memory', description: `Persist a fact to long-term memory (action "save", default — give section ∈ {${MEMORY_SECTIONS.join(', ')}} + content). Saved facts are also mined into a knowledge graph of entities + relationships. action "query" answers MULTI-HOP questions about how things connect ("what does the project I started last week use?", "who works on X?") by traversing that graph — pass the question as content; section not needed.`,
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['save', 'query'], description: 'save (default) or query the knowledge graph' }, section: { type: 'string', enum: MEMORY_SECTIONS }, content: { type: 'string', description: 'the fact (save) or the question (query)' } }, required: ['content'] } },
  { name: 'plugin', description: 'Run a user-defined plugin tool in a secure SANDBOX (worker thread, no access to the filesystem/network/vault unless the plugin opts in, hard timeout). Plugins live in config.plugins ([{name, description, code}]). action:"list" shows installed plugins; action:"run"{name,input} executes one. Use for safe community/dynamically-generated tools.',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'run'] }, name: { type: 'string' }, input: { type: 'object' } }, required: ['action'] } },
  { name: 'browser', description: 'Dedicated headless Playwright browser; you SEE its screenshots (vision). actions: navigate, click, type, screenshot, get_text, evaluate, login. Use action:"login" to sign into a site: pass url, username, and credRef (a CRED_REF_ handle from keychain_lookup / the vault) — it auto-detects the fields, fills them, and submits. The password is resolved in-process; NEVER put a raw password in `text`.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['navigate', 'click', 'type', 'screenshot', 'get_text', 'evaluate', 'login'] },
      url: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, js: { type: 'string' },
      username: { type: 'string', description: 'For login: the username/email (not secret).' },
      credRef: { type: 'string', description: 'For login: a CRED_REF_ handle for the password (from keychain_lookup or the vault). Resolved in-process.' }
    }, required: ['action'] } },
  { name: 'keychain_lookup', description: "Look up a password in the macOS login Keychain by service (e.g. 'github.com') and optional account. Returns a CRED_REF_ handle (NOT the raw password) + the username, which you pass to browser login. NOTE: only items in the login keychain that allow BhatBot are readable — Safari/iCloud Keychain and Chrome's own store are NOT accessible, and macOS may prompt once to grant access.",
    input_schema: { type: 'object', properties: {
      service: { type: 'string', description: "Keychain service name, e.g. a domain like 'github.com'." },
      account: { type: 'string', description: 'Optional username/email to disambiguate.' }
    }, required: ['service'] } },
  { name: 'generate_totp', description: 'Generate the current 6-digit TOTP (2FA) code from a stored TOTP secret. Pass credRef = a CRED_REF_ handle for the base32 TOTP secret (stored via the vault). Use right after a login when a site asks for a 2FA code.',
    input_schema: { type: 'object', properties: {
      credRef: { type: 'string', description: 'CRED_REF_ handle for the base32 TOTP secret.' }
    }, required: ['credRef'] } },
  { name: 'onepassword_lookup', description: "Look up a login in 1Password via the `op` CLI by item name (e.g. 'GitHub'). Returns a CRED_REF_ handle (NOT the raw password) + the username — pass the handle as credRef to browser login. Requires the 1Password CLI installed and signed in; returns a helpful error otherwise.",
    input_schema: { type: 'object', properties: {
      item: { type: 'string', description: 'The 1Password item name or id.' },
      vault: { type: 'string', description: 'Optional vault name to disambiguate.' }
    }, required: ['item'] } },
  { name: 'notion_write', description: 'Persist a durable fact to the Notion Memory database (human-readable long-term memory, searchable from any device). Use alongside save_memory for facts worth keeping in structured external memory. No-op if Notion is not configured.',
    input_schema: { type: 'object', properties: {
      fact: { type: 'string', description: 'The fact to remember — one clear sentence.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Topic tags, e.g. ["prism","paper"].' },
      source: { type: 'string', enum: ['agent', 'user', 'tool'], description: 'Where the fact came from. Default agent.' },
      confidence: { type: 'number', description: '0–1 confidence. Default 0.8.' }
    }, required: ['fact'] } },
  { name: 'notion_search', description: 'Search the Notion Memory database by keyword. Returns matching facts with tags and dates. Use when asked about something previously stored, or to check Notion memory before answering. No-op if Notion is not configured.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'Keyword(s) to match against stored facts.' },
      limit: { type: 'number', description: 'Max results. Default 5.' }
    }, required: ['query'] } },
  { name: 'notion_log_activity', description: "Append an entry to today's page in the Notion Daily Log (self-logging of significant completed work: deploys, decisions, finished tasks). Do NOT log routine tool calls. No-op if Notion is not configured.",
    input_schema: { type: 'object', properties: {
      event: { type: 'string', description: 'What happened — one line.' },
      tool: { type: 'string', description: 'Tool/system involved (optional).' },
      result: { type: 'string', description: 'Outcome (≤200 chars, optional).' },
      duration_ms: { type: 'number', description: 'Duration in ms (optional).' }
    }, required: ['event'] } },
  { name: 'gmail', description: "SIDDHANT'S GMAIL — search, read, draft, and label email. Actions: `search` (Gmail query in `query`, e.g. \"from:adaptyv is:unread newer_than:7d\"), `read` (full body of one message by `id` from a prior search), `draft` (create a draft — NEVER auto-sends; pass to/subject/body, add threadId to reply in-thread), `label` (add/remove labels by name on a message `id`, creating labels as needed). Use for the morning brief, finding a specific thread, or preparing a reply for Siddhant to review. No-op if Google is not configured (`npm run google:auth`).",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['search', 'read', 'draft', 'label'], description: 'What to do.' },
      query: { type: 'string', description: 'search: a Gmail search query (supports from:/to:/subject:/is:unread/newer_than: etc).' },
      id: { type: 'string', description: 'read/label: the message id from a search result.' },
      limit: { type: 'number', description: 'search: max messages (default 10, cap 25).' },
      to: { type: 'string', description: 'draft: recipient address.' },
      cc: { type: 'string', description: 'draft: cc address (optional).' },
      subject: { type: 'string', description: 'draft: subject line.' },
      body: { type: 'string', description: 'draft: plain-text body.' },
      threadId: { type: 'string', description: 'draft: reply within this thread (optional).' },
      add: { type: 'array', items: { type: 'string' }, description: 'label: label names to add (e.g. ["Important"]).' },
      remove: { type: 'array', items: { type: 'string' }, description: 'label: label names to remove (e.g. ["UNREAD"] to mark read).' }
    }, required: ['action'] } },
  { name: 'davinci_resolve', description: "DAVINCI RESOLVE — control Siddhant's video editor via its scripting API (Resolve must be RUNNING). Actions: `status` (product/version/current page/project), `list_projects`, `open_project` (by `name`), `project_info` (timeline count + current timeline), `list_timelines`, `timeline_info` (frames/tracks/markers of the current timeline), `switch_page` (`page`: media/cut/edit/fusion/color/fairlight/deliver), `add_marker` (on the current timeline at `frame` — optional color/name/note), `render` (queue + start rendering). Returns a clear error if Resolve isn't running or External Scripting is disabled.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'list_projects', 'open_project', 'project_info', 'list_timelines', 'timeline_info', 'switch_page', 'add_marker', 'render'], description: 'What to do in Resolve.' },
      name: { type: 'string', description: 'open_project: the project name to load.' },
      page: { type: 'string', description: 'switch_page: media/cut/edit/fusion/color/fairlight/deliver.' },
      frame: { type: 'number', description: 'add_marker: timeline frame (defaults to the current playhead).' },
      color: { type: 'string', description: 'add_marker: marker color (Blue/Red/Green/Yellow/...). Default Blue.' },
      note: { type: 'string', description: 'add_marker: marker note text (optional).' }
    }, required: ['action'] } },
  { name: 'calendar', description: "SIDDHANT'S GOOGLE CALENDAR — see and manage events. Actions: `list` (upcoming events; optional timeMin/timeMax ISO window + `query`), `create` (new event: summary + start; end/attendees/location optional — all-day if start is a bare YYYY-MM-DD, timed if full ISO datetime), `update` (change an event by `id`), `delete` (remove an event by `id`). Pairs with manage_schedule so BhatBot knows what's actually on the calendar. No-op if Google is not configured.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'What to do.' },
      id: { type: 'string', description: 'update/delete: the event id.' },
      summary: { type: 'string', description: 'create/update: event title.' },
      description: { type: 'string', description: 'create/update: notes (optional).' },
      location: { type: 'string', description: 'create/update: place (optional).' },
      start: { type: 'string', description: 'create/update: ISO datetime (2026-07-11T14:00:00-07:00) for timed, or YYYY-MM-DD for all-day.' },
      end: { type: 'string', description: 'create/update: ISO datetime or date; defaults to start.' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'create: guest email addresses (optional).' },
      timeMin: { type: 'string', description: 'list: ISO lower bound (default now-1h).' },
      timeMax: { type: 'string', description: 'list: ISO upper bound (optional).' },
      query: { type: 'string', description: 'list: free-text filter (optional).' },
      limit: { type: 'number', description: 'list: max events (default 10, cap 50).' }
    }, required: ['action'] } },
  { name: 'drive', description: "SIDDHANT'S GOOGLE DRIVE — find, read, and create files. Actions: `search` (by text in `query`, or a raw Drive query if it contains : or =), `read` (extract text of a file by `id` — Google Docs export as text, Sheets as CSV, plain files inline), `create` (write a new file: name + content, optional mimeType/folderId). Use to pull a doc into context or save an output to Drive. No-op if Google is not configured.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['search', 'read', 'create'], description: 'What to do.' },
      query: { type: 'string', description: 'search: text to find (or a raw Drive query with : / =).' },
      id: { type: 'string', description: 'read: the file id from a search result.' },
      limit: { type: 'number', description: 'search: max files (default 10, cap 50).' },
      name: { type: 'string', description: 'create: file name.' },
      content: { type: 'string', description: 'create: file contents.' },
      mimeType: { type: 'string', description: 'create: MIME type (default text/plain).' },
      folderId: { type: 'string', description: 'create: parent folder id (optional).' }
    }, required: ['action'] } },
  { name: 'browser_devtools', description: "CHROME DEVTOOLS on the live browser page (the same Playwright page browser/browser_observe drive). Actions: `network` (recent network requests — url/method/status/type/size, optional `filter` substring), `console` (captured console messages + page errors), `metrics` (performance timing + Core Web Vitals-ish numbers: DOMContentLoaded, load, FCP, LCP, transfer size), `evaluate` (run a JS `expression` in page context and return its value). Use to debug why a page misbehaves, inspect API calls a site makes, or measure load performance. Requires a browser session — call `browser` first if none is open.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['network', 'console', 'metrics', 'evaluate'], description: 'What to inspect.' },
      filter: { type: 'string', description: 'network: only return requests whose URL contains this substring.' },
      limit: { type: 'number', description: 'network/console: max entries (default 30).' },
      expression: { type: 'string', description: 'evaluate: JavaScript to run in the page (e.g. "document.title").' }
    }, required: ['action'] } },
  { name: 'bioart', description: "NIH BioArt — search + fetch PROFESSIONAL, PUBLIC-DOMAIN scientific & medical illustrations (2000+, from NIAID: viruses, cells, proteins, anatomy, lab equipment, organisms…). Use this to get a real, high-quality illustration to drop into a figure/diagram/slide/canvas INSTEAD of AI-generating art from scratch — the results are clean vector-quality references. Actions: `search` (find illustrations matching `query`, returns id/title/description/formats/thumbnail) then `get` (download one by `id`, choose a `format` PNG/SVG/EPS/AI/JPG — saves it locally and returns the path so you can use it in make_figure/show_visuals/studio). Free to use (public domain), no attribution required.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['search', 'get'], description: 'search for illustrations, or get (download) one.' },
      query: { type: 'string', description: 'search: what to look for, e.g. "t cell", "sars-cov-2", "mitochondria".' },
      limit: { type: 'number', description: 'search: max results (default 12, cap 50).' },
      id: { type: 'string', description: 'get: the illustration id from a search result.' },
      format: { type: 'string', enum: ['PNG', 'SVG', 'EPS', 'AI', 'JPG'], description: 'get: file format to download (default PNG — best for embedding; SVG for vector editing).' },
      fileId: { type: 'string', description: 'get: a specific file id (optional; normally resolved from id+format).' }
    }, required: ['action'] } },
  { name: 'vision_local', description: `Second-opinion vision from a LOCAL model (via Ollama) on the current browser page. Free/offline. Use to cross-check your own read or when you want an independent description.`,
    input_schema: { type: 'object', properties: { prompt: { type: 'string', description: 'What to ask about the page' } } } },
  { name: 'ui_inspect', description: 'Capture a screenshot (target:"browser" = current Playwright page, target:"screen" = the whole Mac screen) and get STRUCTURED visual QA findings from a local vision model: {pass, findings:[{severity,where,issue,fix_hint}]}. The screenshot is attached so you can also see it yourself. Use in a build → launch → inspect → fix loop to visually verify a UI and decide whether to keep iterating.',
    input_schema: { type: 'object', properties: { target: { type: 'string', enum: ['browser', 'screen'] }, goal: { type: 'string', description: 'what to check for / acceptance criteria' } } } },
  { name: 'screen_parse', description: 'VISION-DRIVEN CONTROL of ANY app (not just web): capture the Mac screen (target:"screen") or the Playwright page (target:"browser") and run OmniParser to get a structured map of on-screen ELEMENTS — each with type (text/icon), its label/content, and ready-to-use click coordinates. Use this to operate native desktop apps that have no DOM (Spotify, Finder, Preferences, any GUI). Then call vision_click with an element’s click.x/click.y. Pass query to filter to elements whose label contains a string. semantics:true also AI-captions icons (richer but ~60s slower; default false ≈ 5s). The screenshot is returned so you also see it. Requires the local OmniParser install.',
    input_schema: { type: 'object', properties: {
      target: { type: 'string', enum: ['screen', 'browser'], description: 'screen = whole Mac (native apps); browser = Playwright page.' },
      query: { type: 'string', description: 'Only return elements whose label contains this text (e.g. "Sign in").' },
      semantics: { type: 'boolean', description: 'Caption icons too (slower). Default false.' }
    } } },
  { name: 'vision_click', description: 'Click at coordinates from screen_parse (vision-driven control). For target:"screen" the coords are Mac screen points and the click is delivered via the OS (needs Accessibility permission); for target:"browser" it clicks in the Playwright page. Use after screen_parse to actuate a native-app element. double:true for a double-click. CLOSED-LOOP: it returns a fresh post-click screenshot so you can SEE the result and confirm it landed (don\'t fire-and-assume). Pass `expect` (text you should see if the click worked) and it also reports verified:true/false so you can retry/replan on a miss.',
    input_schema: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
      target: { type: 'string', enum: ['screen', 'browser'], description: 'Must match the screen_parse target the coords came from.' },
      double: { type: 'boolean' },
      expect: { type: 'string', description: 'Optional: text/label that should be visible if the click succeeded. Returns verified:true/false so you can replan on a mismatch.' }
    }, required: ['x', 'y'] } },
  { name: 'ask_ai', description: 'Query ANOTHER AI model for research, a second opinion, or to cross-check. Providers: claude (Sonnet), openai (GPT), gemini (Google), local (your Ollama models). Use when you want an independent answer or to compare models.',
    input_schema: { type: 'object', properties: {
      provider: { type: 'string', enum: ['claude', 'openai', 'gemini', 'local'] },
      prompt: { type: 'string', description: 'The question/prompt to send' },
      model: { type: 'string', description: 'Optional model override (e.g. an Ollama model name)' }
    }, required: ['provider', 'prompt'] } },
  { name: 'write_agent_directive', description: 'Write a complete, structured directive (system prompt + task instructions) for another AI agent or automated workflow (Claude Code prompt, n8n spec, second Bhatbot, generic agent). Output is a self-contained block ready to paste.',
    input_schema: { type: 'object', properties: {
      target_agent: { type: 'string', enum: ['claude_code', 'bhatbot_instance', 'n8n_workflow', 'generic_llm_agent'] },
      task_description: { type: 'string', description: 'What the agent should accomplish. Be specific.' },
      context: { type: 'string', description: 'File paths, project state, constraints the agent needs.' },
      output_format: { type: 'string', enum: ['markdown_prompt', 'json_spec', 'shell_script', 'yaml_workflow'], default: 'markdown_prompt' }
    }, required: ['target_agent', 'task_description'] } },
  { name: 'studio_write', description: 'Write/replace the live HTML design canvas (Bhatbot Studio window) and open it — renders instantly. Use when asked to design, prototype, or visualize a UI/page/chart. Provide a full standalone HTML document (inline CSS/JS).',
    input_schema: { type: 'object', properties: { html: { type: 'string', description: 'Full standalone HTML document' } }, required: ['html'] } },
  { name: 'claude_code', description: 'Delegate a coding/build task to the Claude Code CLI (headless, one-shot, 5min). For larger interactive work, the Claude Code terminal window is better. Returns Claude Code output.',
    input_schema: { type: 'object', properties: { prompt: { type: 'string' }, cwd: { type: 'string', description: 'Project dir (default BHATBOT_PROJECT or home)' } }, required: ['prompt'] } },
  { name: 'generate_image', description: 'Generate an image from a text prompt. PLUGGABLE backend: provider:"openai" = GPT Image (best at following complex instructions/text-in-image; default); "flux" = FLUX Pro via Replicate (highest visual quality/photoreal); "flux-fast" = FLUX schnell (cheap, ~seconds — great for drafts/iteration); "auto" routes by quality (low→fast, high→flux, else openai). Use for logos, illustrations, diagrams, UI mockups, graphical abstracts, posters — anything raster/photographic SVG cannot express. The result is returned to you as a vision block so you CAN see it: critique and call again with fixes. Write a precise, detailed prompt (style, composition, colors, mood).',
    input_schema: { type: 'object', properties: {
      prompt: { type: 'string', description: 'Detailed image prompt — be specific about style, composition, colors, mood.' },
      provider: { type: 'string', enum: ['auto', 'openai', 'flux', 'flux-fast'], description: 'auto (default) routes by quality. openai=GPT Image. flux=FLUX Pro (best quality, needs replicateKey). flux-fast=FLUX schnell (fast draft).' },
      quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'For openai: low≈$0.01, medium≈$0.04, high≈$0.08. Also steers auto routing. Default medium.' },
      size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'], description: 'Square for icons/logos; landscape/portrait for illustrations.' },
      filename: { type: 'string', description: 'Optional filename (no extension). Defaults to timestamp.' }
    }, required: ['prompt'] } },
  { name: 'make_figure', description: 'Render a DATA-ACCURATE figure (matplotlib/seaborn) from a real data file (.csv/.tsv/.json/.xlsx) — for papers, results, analysis. UNLIKE generate_image (which invents pixels), this plots your real numbers. Modes: action:"oneshot" (DEFAULT, fastest) — profile + auto-pick the most informative figures for `goal` + render them + cache the recipe, in one call (recurring data shapes return instantly from cache, mirrored to Notion). action:"analyze" profiles the data and SUGGESTS figures without drawing. action:"render" draws one from a high-level `spec` OR custom `code` (preloaded `df` and `plt`). The PNG is returned as a vision block so you can critique and re-render. Saves PNG+PDF+SVG. To plot from an Overleaf paper: use the browser to download the project source/CSV locally, then point `data` at the file.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['oneshot', 'analyze', 'render'], description: 'oneshot = auto-pick + render best figures + cache recipe (default); analyze = profile + suggest only; render = draw one explicit figure.' },
      data: { type: 'string', description: 'Absolute path to the data file (.csv/.tsv/.json/.xlsx/.parquet).' },
      goal: { type: 'string', description: 'For oneshot: what you want to show (e.g. "distribution of accuracy", "correlation between metrics", "compare groups"). Steers which figures are chosen.' },
      n: { type: 'number', description: 'For oneshot: how many figures to produce (default 3).' },
      spec: { type: 'object', description: 'For render: {kind:bar|line|scatter|hist|box|violin|heatmap, x, y, hue, title, xlabel, ylabel, width, height}.' },
      code: { type: 'string', description: 'For render (advanced): custom matplotlib code. `df` (DataFrame) and `plt` are already loaded; just draw — saving is handled. Overrides spec.' },
      formats: { type: 'array', items: { type: 'string', enum: ['png', 'pdf', 'svg'] }, description: 'Output formats. PNG always included. Default [png]. Use pdf/svg for Overleaf.' },
      filename: { type: 'string', description: 'Output filename (no extension). Defaults to timestamp.' }
    }, required: ['action', 'data'] } },
  { name: 'simulate', description: 'Run a PHYSICS, CHEMISTRY, or MATH-MODELING simulation in a sandboxed scientific Python env. Available libraries (the actual projects, pre-installed): scipy (ODE/PDE via integrate.solve_ivp, optimize, linalg, stats), sympy (symbolic math/CAS, sympy.physics.mechanics), numpy, networkx (network models), pint (units), numba (JIT speed), pymunk (2D physics), rdkit (cheminformatics: molecules/reactions/descriptors), ase (atomistic), mujoco (3D physics/robotics), openmm (molecular dynamics), pyscf (quantum chemistry HF/DFT). Usage: action:"capabilities" lists what is actually installed + what each does (call this first if unsure). action:"run" executes your Python `code` in that env — call emit(key=value) to return structured results, and use matplotlib (the figure is auto-saved and returned as a vision block so you SEE it). `np`, `plt`, `math`, `json` are preloaded; import the rest. Long sims: raise timeoutMs (max 600000). Use this — NOT plain run_shell — for any real numerical/scientific simulation.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['run', 'capabilities'], description: 'run = execute code (default); capabilities = list installed libraries.' },
      code: { type: 'string', description: 'Python source to run in the simulation sandbox. Preloaded: np, plt, math, json, emit(). Import scipy/sympy/rdkit/etc as needed. Call emit(name=value) for JSON results; draw with matplotlib to return a figure.' },
      timeoutMs: { type: 'number', description: 'Max run time in ms (default 120000, max 600000). Raise for heavy MD/quantum runs.' }
    }, required: ['action'] } },
  { name: 'math_reason', description: 'Solve a COMPLEX, multi-step MATH / quantitative-reasoning problem with a code-first agent (smolagents) that writes and EXECUTES Python (numpy/sympy/scipy authorized) to compute a verifiable answer — not a guessed one. Use for hard algebra/calculus/number-theory/probability/optimization word problems, derivations, or anything where step-by-step computation beats mental math. Returns the final answer plus the code it ran. Runs in the simulation sandbox; needs scripts/sim-setup.sh.',
    input_schema: { type: 'object', properties: {
      task: { type: 'string', description: 'The math/reasoning problem, in full. Ask for the final numeric/closed-form answer explicitly.' },
      model: { type: 'string', description: 'Reasoning model (default claude-sonnet-4-6). Use a stronger model for harder problems.' },
      maxSteps: { type: 'number', description: 'Max reasoning steps (default 6, max 12).' },
      timeoutMs: { type: 'number', description: 'Max run time ms (default 180000, max 600000).' }
    }, required: ['task'] } },
  { name: 'sci_compute', description: 'QUANTITATIVE & scientific-modeling sandbox — the numerics/finance/stats/ML sibling of `simulate`. Runs Python in a dedicated venv with: numpy, scipy, sympy, pandas, matplotlib, mpmath (arbitrary-precision real/complex analysis — set mp.mp.dps), statsmodels (regression/ARIMA/tests), arch (GARCH), yfinance (market data), QuantLib (derivatives pricing), torch (tensors/NN on Apple-Silicon — DEVICE="mps" auto-detected), scikit-learn, control (state-space/Bode). PRELOADED helpers so you write minimal code — quant: returns(), log_returns(), ann_vol(), sharpe(), sortino(), max_drawdown(), var_cvar(), black_scholes(S,K,T,r,sigma,kind), mc_gbm(S0,mu,sigma,T,...); numerics: mp, solve_ode(f,y0,t_span); ml: DEVICE, to_dev(x). Usage: action:"capabilities" lists what actually installed (call first if unsure). action:"run" executes your `code` — call emit(key=value) for structured results and use matplotlib (figure auto-returned as an image so you SEE it). Use this for stock/options/risk modeling, Monte-Carlo, time-series, high-precision math, or GPU ML; use `simulate` for physics/chemistry. Needs scripts/scicompute-setup.sh (reports an install hint if absent).',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['run', 'capabilities'], description: 'run your code (default) | list installed libraries + helpers.' },
      code: { type: 'string', description: 'Python to execute. emit(key=value) returns JSON; matplotlib figures are auto-returned as an image.' },
      timeoutMs: { type: 'number', description: 'max runtime ms (default 120000, cap 600000).' }
    }, required: [] } },
  { name: 'container_run', description: 'Run a command inside a DOCKER CONTAINER — the strongest isolation lane, layered over the untrusted-code wall. Real filesystem/network/memory isolation with clean teardown. NEVER inherits BhatBot\'s env/secrets/keychain; for generated or cloned code the network defaults to OFF (set trusted:true only for code you vouch for). action:"status" probes whether the Docker daemon is reachable (returns availability + install hint; falls back to the scrubbed-subprocess sandbox floor when absent). action:"run" executes `cmd` in `image` (or pick a stack: node/python/rust/go → a slim base image), optionally mounting a host dir at /w. Use for building/testing an untrusted repo, running a risky generated script, or any hermetic reproducible task.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['run', 'status'], description: 'run a container (default) | probe daemon availability.' },
      image: { type: 'string', description: 'Docker image (e.g. "python:3.13-slim"). If omitted, derived from `stack`.' },
      stack: { type: 'string', enum: ['node', 'python', 'rust', 'go', 'debian'], description: 'shortcut to a slim base image when `image` is omitted.' },
      cmd: { type: 'string', description: 'shell command to run inside the container.' },
      mount: { type: 'string', description: 'host directory to mount read-write at /w (optional).' },
      trusted: { type: 'boolean', description: 'true = allow network (bridge). Default false → network:"none" for untrusted/generated code.' },
      memory: { type: 'string', description: 'memory ceiling (default "4g").' },
      cpus: { type: 'string', description: 'cpu ceiling (default "2").' },
      timeoutMs: { type: 'number', description: 'max runtime ms (default 600000).' }
    }, required: [] } },
  { name: 'molecule', description: 'Show a PROTEIN or small MOLECULE in 3D. action:"view" (default) opens an INTERACTIVE 3Dmol.js viewer window (rotate/zoom, style toggles cartoon/stick/sphere/surface); action:"render" produces a PUBLICATION-QUALITY ray-traced PNG still via PyMOL (returned as an image). Inputs (give one): pdb (4-char RCSB id, e.g. "1CRN", "6VXX"), file (local .pdb/.cif/.sdf/.mol2/.xyz), smiles (e.g. "CC(=O)Oc1ccccc1C(=O)O" for aspirin), or name (common/IUPAC, resolved via PubChem). Small molecules get 3D coords + properties (formula, MW, logP, HBD/HBA, TPSA) from RDKit. Use for structural biology, chemistry, drug-molecule questions, or whenever Siddhant wants to SEE a structure.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['view', 'render'], description: 'view = interactive window (default); render = PyMOL ray-traced still PNG.' },
      pdb: { type: 'string', description: '4-character RCSB PDB id, e.g. "1CRN".' },
      file: { type: 'string', description: 'Absolute path to a local structure file (.pdb/.cif/.sdf/.mol2/.xyz).' },
      smiles: { type: 'string', description: 'SMILES string for a small molecule.' },
      name: { type: 'string', description: 'Molecule name (common or IUPAC); resolved to a structure via PubChem.' },
      style: { type: 'string', enum: ['cartoon', 'stick', 'sphere', 'surface'], description: 'Render style. Default: cartoon for proteins, stick for small molecules.' }
    } } },
  { name: 'maps', description: 'Show a MAP or get DIRECTIONS in an in-app map window. action:"show" (default) centers on a place/address with a marker; action:"route" draws driving/walking/cycling directions between two places and returns distance + ETA. Inputs: for show → query (place or address, e.g. "Eiffel Tower" or "1600 Amphitheatre Pkwy"); for route → from + to (+ optional mode: driving|walking|cycling). Uses OpenStreetMap (free, no key); if a Google Maps key is configured it upgrades geocoding accuracy and enables Google JS rendering + a 3D tilt view. Returns an inline map image AND opens an interactive window with a ROUTE PLANNER (type/click From-To, add stops, drag pins to re-route). Use for "where is…", "how far / how long to get to…", "show me … on a map", trip planning.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['show', 'route'], description: 'show = center on a place (default); route = directions from→to.' },
      query: { type: 'string', description: 'Place or address to show (for action:show).' },
      from: { type: 'string', description: 'Origin place/address (for action:route).' },
      to: { type: 'string', description: 'Destination place/address (for action:route).' },
      mode: { type: 'string', enum: ['driving', 'walking', 'cycling'], description: 'Travel mode for directions (default driving).' },
      zoom: { type: 'number', description: 'Zoom level for show (default 14).' }
    } } },
  { name: 'predict_function', description: 'Predict a PROTEIN\'s molecular FUNCTION with FABLE (Siddhant\'s ProtFunc model) and SEE it on the 3D structure. Give a protein `sequence` (raw amino acids or FASTA) and/or a `uniprot_id`. Returns the top predicted GO molecular-function terms with confidence, the inferred organism, and any calibration warnings. By default it ALSO fetches the AlphaFold/ESMFold structure with per-residue saliency written into B-factors and opens it in the 3D viewer colored by importance (blue=low → red=high), so the functionally important residues stand out. Use for "what does this protein do", function annotation, or visualizing which residues drive the prediction. NOTE: FABLE is trained on insect+mammal and can misclassify some enzymes — treat as a hint, and the per-term warning is shown.',
    input_schema: { type: 'object', properties: {
      sequence: { type: 'string', description: 'Protein amino-acid sequence (raw or FASTA; header accession is auto-detected).' },
      uniprot_id: { type: 'string', description: 'Optional UniProt accession (e.g. "P0DTC2") — improves structure lookup (AlphaFold) and organism grounding.' },
      taxon: { type: 'string', enum: ['auto', 'insect', 'mammal'], description: 'Organism calibration. Default auto (inferred).' },
      show_structure: { type: 'boolean', description: 'Open the saliency-colored 3D structure in the viewer (default true).' }
    }, required: ['sequence'] } },
  { name: 'play_chess', description: 'Open a playable chess game in its own window for Siddhant. Default = standard chess vs a Stockfish AI (difficulty easy/medium/hard). Pass variant:"atomic" for ATOMIC chess (captures explode adjacent non-pawn pieces; win by exploding the king) or variant:"standard" to use the offline applet — both variants run a fully legal-move-enforced engine (chess.js + custom atomic) with an optional built-in bot. Use whenever he wants to play chess.',
    input_schema: { type: 'object', properties: {
      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'], description: 'Stockfish strength for the default standard-AI board: easy/medium/hard. Default medium.' },
      variant: { type: 'string', enum: ['standard', 'atomic'], description: 'Open the offline legal-enforced applet in this variant (atomic = exploding captures). Omit for the classic Stockfish-AI board.' }
    } } },
  { name: 'screen_observe', description: 'WATCH SIDDHANT\'S WHOLE SCREEN to learn how he works — use this when he SAYS to (e.g. "watch my screen", "start watching", "learn how I do this"). Covers ANY app, not just the browser (that is browser_observe). His command IS the consent, so you do NOT need to ask again — just start. Flow: action:"start"{minutes:1-30} begins a time-boxed session that notes what he is doing every ~25s via the LOCAL vision model (no screenshots are saved; passwords/codes/cards are skipped). When he is done, action:"review" returns the notes — narrate them and ASK which to remember; action:"save"{items:[...approved plain-English habits]} writes ONLY approved items to long-term memory. "stop" ends early; "status" shows whether active + recent notes; "snapshot" describes the screen once. Never auto-start without his word.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['start', 'stop', 'status', 'review', 'save', 'snapshot', 'clear'], description: 'start a watch session, stop it, check status, review the notes, save approved items, take a one-shot snapshot, or clear the buffer.' },
      minutes: { type: 'number', description: 'For start: session length 1–30 (default 7).' },
      everySeconds: { type: 'number', description: 'For start: capture interval 10–60s (default 25).' },
      items: { type: 'array', items: { type: 'string' }, description: 'For save: approved plain-English facts/habits to remember.' }
    }, required: ['action'] } },
  { name: 'request_permissions', description: 'Trigger the macOS Screen Recording + Accessibility permission prompts for BhatBot and open the matching System Settings → Privacy panes so Siddhant can toggle the app on. Use when vision_click / screen_parse / native login / AppleScript fail for permissions, or when he asks to "grant permissions" / "fix permissions".', input_schema: { type: 'object', properties: {} } },
  { name: 'ambient', description: 'Inspect or control the AMBIENT AWARENESS layer — opt-in proactive monitoring of Siddhant\'s Calendar (upcoming events + conflicts) and Mail (unread needing a reply) that surfaces high-signal items unprompted. OFF by default; privacy-first (titles/subjects/counts only, redacted, quiet-hours-aware). action:"status" shows watchers + state; "scan" runs one pass now (only enabled sources) and returns a digest; "read"{source:"mail"|"calendar"} does an ON-DEMAND pull of ONE source right now even if always-on monitoring is OFF (use this to check important unread email or upcoming events on request, e.g. in the morning brief, without turning on background notifications); "enable"/"disable" toggle background monitoring (optionally a single source). Use when Siddhant asks to "keep an eye on my calendar/email", "any important emails", "what\'s coming up", or to read mail/calendar for a brief.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['scan', 'read', 'status', 'enable', 'disable'] },
      source: { type: 'string', enum: ['calendar', 'mail'], description: 'For "read": which source to pull now. For enable/disable: toggle just this watcher.' },
      hours: { type: 'number', description: 'For "read" mail: lookback window in hours (default 12 — overnight). Use 168 for "past week", 24 for "today".' }
    }, required: ['action'] } },
  { name: 'project', description: "Open and track a PROJECT with a living, auto-updating summary. Use 'open' when Siddhant starts or switches to a project so BhatBot keeps its context across turns (the active project's summary is injected into your memory every turn, and it auto-refreshes as work happens). 'note' records a decision/milestone/fact; 'summary' regenerates the rolling summary now; 'status' shows the active project; 'list' shows all; 'close' marks one done. Open a project whenever he's clearly working on a named, ongoing thing.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['open', 'list', 'status', 'note', 'summary', 'close'] },
      name: { type: 'string', description: "Project name (for 'open') or slug (for note/summary/close; omit to target the active project)." },
      text: { type: 'string', description: "For 'note': the decision/milestone/fact to record." },
      kind: { type: 'string', enum: ['note', 'decision', 'milestone'], description: "For 'note': entry kind (default note)." }
    }, required: ['action'] } },
  { name: 'subagent', description: 'Delegate to a PERSISTENT specialized sub-agent that keeps its OWN memory/context across tasks and has a scoped toolset — for recurring, focused work and for doing several things at once. Agents: "research" (analysis/sources/synthesis), "coding" (code changes + verify, can use claude_code), "lifeadmin" (scheduling/reminders/logistics). action:"run"{agent, task, background?} runs it (background:true returns immediately and works in parallel while you keep going — use for "do X and Y at the same time"); "list" shows agents + how many turns each remembers; "history"{agent}; "reset"{agent} wipes one agent\'s memory. Use this instead of doing big specialized work inline when it benefits from a dedicated, remembering specialist.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['run', 'list', 'history', 'reset', 'handoff', 'a2a_log'], description: '"handoff" dispatches via a standardized A2A envelope (future-proof; carries context + artifacts); "a2a_log" shows recent handoffs.' },
      agent: { type: 'string', enum: ['research', 'coding', 'lifeadmin'], description: 'Which specialist (the handoff target for action:handoff).' },
      task: { type: 'string', description: 'For run/handoff: what you want the sub-agent to do (it remembers prior tasks in its thread).' },
      context: { type: 'string', description: 'For handoff: background the target agent needs.' },
      artifacts: { type: 'array', description: 'For handoff: inputs to pass along (strings or objects).' },
      background: { type: 'boolean', description: 'For run: true = start it in parallel and return immediately (you get notified on completion); false = wait for the result.' },
      maxSteps: { type: 'number', description: 'For run/handoff: tool-loop budget (default 8, max 16).' }
    }, required: ['action'] } },
  { name: 'agent_team', description: 'Deploy MULTIPLE agents on ONE task IN PARALLEL (real wall-clock speedup + deeper planning). Two modes: action:"ensemble"{task, roles?} runs the SAME task through several agents that each take a DIFFERENT role (default: implementer / skeptic / synthesizer) all at once, then synthesizes their takes into one decisive answer — use for hard reasoning, planning, design decisions, or any "look at this from multiple angles / be thorough" request. action:"test_app"{target, goal?} unleashes an INDEPENDENT QA agent that drives a website or app like a real user (own browser + vision), probes flows/edge-cases, and reports concrete bugs + a verdict — use to "test my site/app", verify a build, or QA a deploy. Optionally pass custom `roles` (each {name, persona, tools?}) to form a bespoke team.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['ensemble', 'test_app'], description: 'ensemble = N agents, same task, parallel, synthesized. test_app = one independent tester drives a site/app.' },
      task: { type: 'string', description: 'For ensemble: the single task all agents tackle in parallel.' },
      target: { type: 'string', description: 'For test_app: a URL (https://… or a domain) or a Mac app name to test.' },
      goal: { type: 'string', description: 'For test_app: what to verify / acceptance criteria (optional).' },
      roles: { type: 'array', description: 'For ensemble (optional): custom team — array of {name, persona, tools?(string[])}. Omit for the default implementer/skeptic/synthesizer trio.',
        items: { type: 'object', properties: { name: { type: 'string' }, persona: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } } }, required: ['name', 'persona'] } },
      maxSteps: { type: 'number', description: 'Per-agent tool-loop budget (default 8 ensemble / 12 test_app, max 16).' }
    }, required: ['action'] } },
  { name: 'fleet', description: 'IRON LEGION — run SEVERAL DISTINCT tasks AT ONCE, each handled by its own autonomous suit (sub-agent) in PARALLEL, surfaced in a LIVE "Legion" panel where Siddhant watches each suit and can steer it in real time. Use when he gives multiple separate jobs to do simultaneously ("do X, Y and Z at the same time"), or to split a big build across parallel workers (one suit per feature / file / site-section, plus a tester suit). Pass tasks:[{role,task,tools?}] (2–6). Returns when all suits finish, with each suit\'s result. NOTE: for the SAME task from multiple angles use agent_team ensemble instead; for ONE focused job use a single tool/subagent.',
    input_schema: { type: 'object', properties: {
      tasks: { type: 'array', description: '2–6 distinct jobs to run concurrently. Each {role (short label, e.g. "frontend"), task (what that suit should do), tools?(string[] to scope its toolset)}.',
        items: { type: 'object', properties: { role: { type: 'string' }, task: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } } }, required: ['task'] } },
      maxSteps: { type: 'number', description: 'Per-suit tool-loop budget (default 8, max 16).' }
    }, required: ['tasks'] } },
  { name: 'deploy_drones', description: 'DEPLOY DRONES — launch N scoped-down instances of BhatBot ("drones") on a mission, each with its own persona, a STRICT tool subset, its own workspace, a budget slice, and a shared BLACKBOARD so they see each other\'s live status/findings. Supervised as a fleet: budget-derived width, per-fleet spend envelope, and stall-reaping (a silent drone is nudged then reaped as partial). Use for "deploy K drones to each do X and argue for it", swarm-style exploration, or splitting a mission across specialists that coordinate. Give explicit `drones:[{persona|role, goal, tools?, hermetic?}]`, or just a `mission` and BhatBot designs the fleet. synthesize:true (default) merges the drones\' reports into one recommendation. Set hermetic:true on a drone whose GENERATED code must run only in the sandbox (no secrets/network). Differs from `fleet` (independent suits) by adding the blackboard, budget envelope, reaping, and synthesis.',
    input_schema: { type: 'object', properties: {
      mission: { type: 'string', description: 'The overall mission. If `drones` is omitted, BhatBot designs the fleet from this.' },
      drones: { type: 'array', description: 'Explicit drones (optional). Each {persona?{name,brief,style} OR role (research|coding|browser|creative|memory), goal, tools?(string[] to scope), hermetic?(bool)}.',
        items: { type: 'object', properties: { role: { type: 'string' }, goal: { type: 'string' }, brief: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } }, hermetic: { type: 'boolean' }, persona: { type: 'object' } } } },
      hardCap: { type: 'number', description: 'Max drones to launch (default 6).' },
      budgetUsd: { type: 'number', description: 'Total fleet spend envelope in USD (default 2). Split across drones.' },
      maxTurns: { type: 'number', description: 'Per-drone tool-loop budget (default 8, max 12).' },
      synthesize: { type: 'boolean', description: 'Merge drone reports into one recommendation (default true).' }
    }, required: [] } },
  { name: 'find_papers', description: 'Search the SCHOLARLY literature — arXiv (keyless) + Semantic Scholar (higher limits with a key) — merged and deduped into normalized records {title, authors, year, source, citations, pdfUrl, abstract}. Use for literature reviews, "what\'s the state of X research", finding primary sources, or grounding a claim in papers (especially comp-bio / GNN / ML topics). For a triangulated, cited review deploy_drones with disjoint source mandates on top of this.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'The topic / search query.' },
      max: { type: 'number', description: 'Max papers to return (default 8, max 25).' }
    }, required: ['query'] } },
  { name: 'plan_and_run', description: 'PLAN-AND-EXECUTE a high-level GOAL: BhatBot decomposes it into the fewest parallelizable subtasks (a task DAG), shows the plan in the Legion panel, then dispatches a guardrailed team layer-by-layer — independent steps run in parallel, dependent steps wait for and receive their upstream results — and returns the combined outcome. Use for a BIG multi-part goal ("build X with parts a/b/c", "research then draft then review"). dryRun:true returns the PLAN ONLY (no execution) so Siddhant can approve/adjust first. For several already-separate jobs use `fleet`; for one focused job use the direct tool.',
    input_schema: { type: 'object', properties: {
      goal: { type: 'string', description: 'the high-level goal to decompose and accomplish.' },
      dryRun: { type: 'boolean', description: 'true = return the proposed plan WITHOUT running it (preview/approve first).' },
      maxSteps: { type: 'number', description: 'max subtasks (default 6, hard cap 8).' },
      maxParallel: { type: 'number', description: 'max agents running at once (default 4, hard cap 6).' }
    }, required: ['goal'] } },
  { name: 'build_project', description: 'BUILD A WHOLE THING IN ONE TURN — the completion engine for heavy creative/engineering builds (e.g. "design and simulate an Iron Man suit", a device, a game, a machine, a data product). It DECOMPOSES the build into independent lanes, runs them as a PARALLEL fleet on a shared blackboard, INTEGRATES the results, then ASSEMBLES the actual deliverable(s): a real physics/quantitative pass (via simulate) AND an INTERACTIVE 3D Three.js scene with a spec sheet (via studio_write), completion-gating the render. It saves everything as a RESUMABLE project (locked specs + artifacts) so Siddhant can continue later. USE THIS instead of hand-rolling a long fleet+studio+sim sequence. FIRST gather the key specs from Siddhant with ask_options (dimensions, colours, features), then call build_project with those specs — for anything he leaves unspecified, ASSUME a sensible default and note it (prioritise finishing the whole build this turn). Prefer ONE build_project call over an open-ended interview.',
    input_schema: { type: 'object', properties: {
      goal: { type: 'string', description: 'What to design/build, in one line (e.g. "a wearable Iron-Man-style powered suit").' },
      spec: { type: 'object', description: 'The gathered specifications as key→value (e.g. {height:"70.5in", build:"lean, size 38R", colors:"blue/silver", features:"repulsors, energy shield, grapple", flight:"yes"}). Include assumed defaults too.' },
      deliverable: { type: 'string', enum: ['studio', 'sim', 'both'], description: 'studio = interactive 3D viewer; sim = physics/data only; both (default) = 3D viewer backed by a real physics pass.' },
      mode: { type: 'string', enum: ['collaborative', 'auto'], description: 'collaborative (default) = build one pass then check in with Siddhant and refine WITH him until he is happy. auto = run autonomously in the background, refining for HOURS until self-judged done or it hits the spend/time cap; returns immediately. Use auto only when he says "auto-run / run on your own / work on it for a while".' },
      budgetUsd: { type: 'number', description: 'auto mode: stop after ~$this in API spend (default 10).' },
      hours: { type: 'number', description: 'auto mode: stop after this many hours (default 4).' },
      workstreams: { type: 'array', description: 'OPTIONAL explicit parallel lanes [{role, task}]; omit to let BhatBot decompose automatically.',
        items: { type: 'object', properties: { role: { type: 'string' }, task: { type: 'string' } } } },
      projectName: { type: 'string', description: 'Optional name for the saved project (defaults to the goal).' }
    }, required: ['goal'] } },
  { name: 'self_improve', description: 'Scan BhatBot\'s own tool-call AUDIT LOG for recurring failures and have Claude Code DRAFT a fix as a reviewable diff (it does NOT apply changes — Siddhant is the merge gate). Use when asked to "improve yourself" / "fix your recurring errors", or run it periodically. action:"scan" finds the top recurring failing tool (≥ minCount, default 3) and writes a proposed-fix .md to ~/.bhatbot/self-improve/ + notifies. dryRun:true just reports the failure clusters without invoking Claude Code.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['scan'], description: 'scan the audit log + draft a fix.' },
      dryRun: { type: 'boolean', description: 'Only report recurring-failure clusters; do not draft.' },
      minCount: { type: 'number', description: 'Min repeats before drafting (default 3).' }
    } } },
  { name: 'world_cup', description: 'FIFA World Cup 2026 live data + analysis. PICK THE ACTION BY INTENT: (1) "open" — for "show me / pull up the standings / scores / table": opens the live auto-updating page in his browser, returns nothing to read; just say "Pulled up the live standings". (2) "watch" — for "what should I watch / what\'s happening with the game / give me insights / fill me in / anything good on": returns live scores + a RECOMMENDED match to watch + key insights (model prediction, Elo, recent form, group stakes) + a fresh web scan of what people are saying. Use this signal to give YOUR OWN opinion on what to watch and a couple of sharp insights — be conversational and concise, don\'t just list the data. (3) "predict"{home,away} — one matchup win/draw/loss. (4) "group"{label A–L} — one group table. (5) "odds" — Monte-Carlo title odds (expensive, use sparingly). Default action is "open".',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['open', 'watch', 'predict', 'group', 'odds', 'standings'] },
      home: { type: 'string', description: 'Team abbreviation or name (for predict).' },
      away: { type: 'string', description: 'Team abbreviation or name (for predict).' },
      label: { type: 'string', description: 'Group letter A–L (for group).' },
      sims: { type: 'number', description: 'Monte-Carlo iterations (default 6000).' }
    } } },
  { name: 'news', description: 'Skim the latest NYT headlines + abstracts for a quick read (Siddhant has a NYT account; uses public NYT feeds, no login needed). Use for "what\'s the news / world news / today\'s headlines / what\'s happening in the world", and it powers the daily morning world-news skim. Returns a compact numbered list (headline — abstract). sections: world (default), us, politics, business, technology, science, home. limit default 6.',
    input_schema: { type: 'object', properties: {
      section: { type: 'string', enum: ['world', 'us', 'politics', 'business', 'technology', 'science', 'home'], description: 'News section (default world).' },
      limit: { type: 'number', description: 'How many headlines (default 6, max ~15).' }
    } } },
  { name: 'web_search', description: 'Search the web and get back ranked results (title, URL, short summary) WITHOUT already knowing a URL. Use this FIRST for any live/current/factual lookup where you do not have a specific page in mind — then fetch_url or browser the most promising result for the full text. Parallel-safe (read-only). query required; limit default 6 (max 12). Free by default (DuckDuckGo); uses Brave/Serper/Tavily automatically if a key is configured.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'The search query.' },
      limit: { type: 'number', description: 'How many results (default 6, max 12).' }
    }, required: ['query'] } },
  { name: 'self_fix', description: 'SELF-HEALING: have BhatBot fix its OWN code with its built-in Claude Code, verified + auto-reverted on failure. Given a problem description and a `verify` shell command that must exit 0 when fixed, it: snapshots git, runs Claude Code headless to edit the repo, runs verify, and KEEPS the change only if verify passes (else git-reverts). Use when a capability is broken / a tool keeps failing / the World Cup harness logs a FAIL. Self-aware loop: pair with the iteration log. apply:false drafts only (no edits).',
    input_schema: { type: 'object', properties: {
      problem: { type: 'string', description: 'What is broken + any error/log excerpt.' },
      verify: { type: 'string', description: 'Shell command that exits 0 once fixed (e.g. "node scripts/worldcup-iterate.js").' },
      files: { type: 'string', description: 'Optional file path hints to focus the fix.' },
      apply: { type: 'boolean', description: 'true = actually edit+verify+keep/revert; false = draft only.' },
      maxRounds: { type: 'number', description: 'Fix→verify attempts before giving up (default 2).' }
    } } },
  { name: 'self_heal', description: 'AUTONOMOUS self-healing loop (the always-on version of self_fix). DISABLED by default — does nothing until Siddhant turns it on. When enabled it watches for BhatBot\'s own mistakes (repeated tool failures, bugs he flags, failing self-tests, runtime crashes) and fixes them with Claude Code, verify-gated + auto-reverted, committed locally (never pushed). action:"status" shows state + queue; "enable"/"disable" toggle it; "run" forces one fix cycle now; "queue"{problem,verify?} manually enqueue a mistake to fix. Use "status" when asked "can you fix yourself / are you self-healing", and "enable"/"disable" when he says to turn self-healing on/off.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'enable', 'disable', 'run', 'queue'] },
      problem: { type: 'string', description: 'For "queue": what is broken (a mistake to fix).' },
      verify: { type: 'string', description: 'For "queue": shell command that exits 0 once fixed (default: node scripts/verify-syntax.js).' }
    }, required: ['action'] } },
  { name: 'self_reflect', description: 'PROACTIVE SELF-REFLECTION (not a fix loop). BhatBot examines its OWN operational logs, architecture, and history, then expresses — in first person — what it genuinely WANTS to improve about itself, ranked, with evidence and concrete implementation proposals. This is the tool for "what do you want to improve / fix about yourself", "what would you change", "what are you not happy with / unhappy about", "what\'s your top priority for yourself", "how would you implement <that thing>", "what do you think about your <memory/cost/speed>". It surfaces OPINIONS to Siddhant — it never edits code or triggers self_fix/self_improve. scope narrows the dimension; depth "brief" = just the top desire; focus = a topic to emphasize or an implementation question to drill into.',
    input_schema: { type: 'object', properties: {
      scope: { type: 'string', enum: ['all', 'performance', 'capability', 'knowledge', 'structural'], description: 'Which dimension to reflect on (default all).' },
      depth: { type: 'string', enum: ['brief', 'full'], description: '"brief" = top desire only; "full" = all desires (default full).' },
      focus: { type: 'string', description: 'Optional topic to emphasize ("the memory stuff", "cost"), or an implementation question ("how would you build it") to drill into.' }
    } } },
  { name: 'self_drive', description: 'ON-DEMAND AUTONOMOUS SELF-IMPROVEMENT (Phase 6 — ACTS on self_reflect\'s desires). NOT always-on: BhatBot does not constantly update itself. A finite session runs only when Siddhant asks, or when a capability gap is hit. Per cycle it: reflects, picks the top automatable LOCAL/STRUCTURAL desire, runs a sequential VANGUARD pipeline (SCOUT researches → ORACLE+ECHO plan+review → FORGE writes via claude_code → ATLAS verifies → MEDIC resolves), and KEEPS the change only if `npm run verify` passes (else reverts). Commits to an isolated LOCAL per-session branch and NEVER pushes to a remote. Hard rails: risk.js classifies + blocks any desire touching the frozen guardrail/secret zone BEFORE any write; verify-or-revert; idle-only; combined daily cap (shared with self-heal); rate-budget-paced (sleeps when OTPM is spent, resumes on reset). action:"start"/"run" begins a session (optional focus, maxCycles); "stop" halts gracefully (now:true = immediate); "status" shows state + last session; "enable"/"disable" toggle the feature. Use "start" for "improve yourself / work on yourself", "stop" for "stop improving yourself", "status" for "are you improving yourself / what did self-drive do".',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'start', 'run', 'stop', 'enable', 'disable'] },
      focus: { type: 'string', description: 'For start/run: a topic to bias the reflection toward (e.g. "speed", "the memory system").' },
      maxCycles: { type: 'number', description: 'For start/run: cap the desires implemented this session (default 5).' },
      now: { type: 'boolean', description: 'For stop: halt immediately (revert any mid-cycle edit) instead of after the current cycle.' }
    }, required: ['action'] } },
  { name: 'health', description: 'BIOMETRICS / HEALTH — Siddhant\'s Garmin data (resting HR, HRV, sleep, body battery, stress, steps, VO₂max, training readiness, SpO₂, weight) with trends + where he could improve. Use for "show my health / biometrics / how am I doing", "how did I sleep", "what\'s my resting heart rate / HRV / body battery", "any health trends", "should I train hard today". NOT medical advice — decision-support over his own wearable data. action:"show" (default) opens the Health tab + returns the latest portrait + flags; "sync" pulls fresh data from Garmin now; "insights" syncs + gives a ranked read of trends/improvements/suggestions; "status" shows the connection; "monitor"{enable} toggles the proactive background monitor; "login"{mfa} does the one-time Garmin login. Pass sync:true on show to refresh first.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['show', 'sync', 'insights', 'trends', 'today', 'status', 'monitor', 'login'] },
      sync: { type: 'boolean', description: 'Refresh from Garmin before showing (default false for show, true for insights).' },
      enable: { type: 'boolean', description: 'For monitor: turn the proactive background monitor on/off.' },
      mfa: { type: 'string', description: 'For login: the Garmin MFA code if prompted.' }
    } } },
  { name: 'ops_status', description: 'WHAT IS BHATBOT MANAGING RIGHT NOW — a live snapshot so Siddhant can confirm it\'s always working: every background service (self-heal, self-drive, patrol, ambient, scheduler, health monitor, cloud relay) with on/off + detail, the active agent fleet, upcoming scheduled tasks, rate-limit budget, today\'s spend, and the recent event stream. Use for "what are you doing / working on / managing", "what\'s running", "are you still working", "show me your status / operations / what you\'re handling", "open the manage tab". Opens the Manage tab by default (show:false to just return the data).',
    input_schema: { type: 'object', properties: {
      show: { type: 'boolean', description: 'Open the Manage tab (default true).' }
    } } },
  { name: 'hud_control', description: 'DRIVE THE HUD — reshape what Siddhant is looking at to fit the current work. The main window is a 5-tab HUD (command, fleet, health, management, code) plus hidden work surfaces (activity, canvas, notes, routines, nexus, studio) that are NOT in his nav — YOU surface them when you work with them, because he wants to see what you\'re doing. Use proactively: pull up `canvas` before layering images, `fleet` when dispatching agents, `code` when running Claude Code, `activity` for a long tool run; switch command `layout` (1 = symmetric flanking panels, 2 = wide hologram stage — better for media-heavy work) and `focus` (enlarge the orb / media / jobs column) to match the task. Send panel:"command" (or focus:"reset") when done to hand the stage back.',
    input_schema: { type: 'object', properties: {
      panel: { type: 'string', enum: ['command', 'fleet', 'health', 'management', 'code', 'activity', 'canvas', 'notes', 'routines', 'nexus', 'studio', 'presence', 'voice', 'settings'], description: 'Bring this surface up on the stage. `presence` (or `fleet`) opens the FLEET tab, whose hero view is a live 3D office where each running agent is a character — nice when a fleet is working.' },
      layout: { type: 'integer', enum: [1, 2], description: 'Command-tab layout: 1 symmetric, 2 wide hologram stage.' },
      focus: { type: 'string', enum: ['orb', 'media', 'jobs', 'reset'], description: 'Enlarge one command column (or reset).' }
    } } },
  { name: 'manage_schedule', description: 'Schedule BhatBot to do things PROACTIVELY/AUTONOMOUSLY — reminders, recurring checks, "every morning brief me", "in 30 minutes do X", "every Monday at 9am". Each schedule runs the given `prompt` through the full agent at its time (no one watching), then speaks the result aloud and texts it to Telegram. Use this whenever Siddhant asks for something to happen later or repeatedly. Actions: add (create), list, remove{id}, enable{id}, disable{id}, run{id} (fire now). For timing pass ONE of: kind:"daily"+at:"HH:MM" / kind:"weekly"+at:"HH:MM"+dow(0=Sun) / kind:"interval"+everyMinutes|everyHours / kind:"once"+runAt(ISO), OR the shortcuts inMinutes / inHours / everyMinutes / everyHours.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['add', 'list', 'remove', 'enable', 'disable', 'run'], description: 'What to do.' },
      id: { type: 'string', description: 'Schedule id (for remove/enable/disable/run).' },
      title: { type: 'string', description: 'Short label for the schedule.' },
      prompt: { type: 'string', description: 'The task to run at the scheduled time, phrased as an instruction to yourself (e.g. "Check git status of ~/bhatbot and report anything uncommitted").' },
      kind: { type: 'string', enum: ['daily', 'weekly', 'interval', 'once'], description: 'Recurrence type.' },
      at: { type: 'string', description: 'For daily/weekly: time "HH:MM" (24h, local).' },
      dow: { type: 'number', description: 'For weekly: day of week 0=Sun..6=Sat.' },
      runAt: { type: 'string', description: 'For once: ISO datetime to fire.' },
      inMinutes: { type: 'number', description: 'Shortcut: fire once N minutes from now.' },
      inHours: { type: 'number', description: 'Shortcut: fire once N hours from now.' },
      everyMinutes: { type: 'number', description: 'Shortcut: repeat every N minutes.' },
      everyHours: { type: 'number', description: 'Shortcut: repeat every N hours.' },
      announce: { type: 'boolean', description: 'Speak the result aloud (default true).' },
      notify: { type: 'boolean', description: 'Text the result to Telegram (default true).' }
    }, required: ['action'] } },
  { name: 'smart_login', description: 'Sign into a site/app using a SAVED domain login profile, handling 2-factor automatically. Fills the first factor (username+password from the vault), then for 2FA — if a TOTP secret is on file it generates+enters the code SILENTLY; otherwise it CALLS and TEXTS Siddhant for the code and waits for his phone reply (code, or "approved" for a push prompt), then enters it. Pass `url`/`host` for a saved profile, or inline `username`+`credRef`(+`totpRef`). TWO MODES via `target`: omit (default) = the dedicated Playwright browser window (sessions persist → most logins skipped). target:"chrome"|"safari"|"edge"|"arc"|"firefox"|"brave" = sign in inside that REAL browser by opening the url and typing (vision-assisted) — for sites that must run in your everyday browser. target:"app" + app:"<App Name>" = sign into a NATIVE Mac app. Native modes type the password via clipboard (then wipe it) and need Accessibility (+ Screen Recording for vision field-focus). For a new site, save a profile with manage_logins first.',
    input_schema: { type: 'object', properties: {
      url: { type: 'string', description: 'Login page URL (e.g. https://overleaf.com/login). Or use host.' },
      host: { type: 'string', description: 'Domain key for a saved profile (e.g. "overleaf.com").' },
      target: { type: 'string', enum: ['window', 'chrome', 'safari', 'edge', 'arc', 'firefox', 'brave', 'app'], description: 'Where to log in. Default (omitted/"window") = Playwright window. A browser name = that real browser. "app" = a native Mac app (set `app`).' },
      app: { type: 'string', description: 'For target:"app": the native app name (e.g. "Slack", "Discord").' },
      browser: { type: 'string', description: 'Alternative to target for naming a real browser (e.g. "Google Chrome").' },
      vision: { type: 'boolean', description: 'For native modes: use OmniParser to focus the right field (default true; set false to use plain Tab order).' },
      username: { type: 'string', description: 'Override the saved username (optional).' },
      credRef: { type: 'string', description: 'Override password: a CRED_REF_ handle (resolved in-process; never a raw password).' },
      totpRef: { type: 'string', description: 'Override TOTP: a CRED_REF_ handle for the base32 2FA secret → silent 2FA.' },
      twoFactor: { type: 'string', enum: ['auto', 'totp', 'phone', 'none'], description: 'Force the 2FA path. auto=TOTP if available else phone.' },
      waitMs: { type: 'number', description: 'How long to wait for the phone 2FA reply (default 150000).' }
    } } },
  { name: 'manage_logins', description: 'Manage domain-keyed login profiles used by smart_login. action:"set" saves/updates a profile (store the password in the vault first → pass its CRED_REF_ handle as credRef; optionally totpRef for silent 2FA). "list" shows saved sites (never secrets), "get" one, "delete" removes one. Use this to teach BhatBot how to sign into sites you visit often (youtube, overleaf, spotify, …).',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['set', 'list', 'get', 'delete'] },
      host: { type: 'string', description: 'Domain (e.g. "overleaf.com"). Required except for list.' },
      username: { type: 'string' },
      url: { type: 'string', description: 'Login page URL.' },
      credRef: { type: 'string', description: 'CRED_REF_ handle for the password (from the vault / keychain_lookup / onepassword_lookup).' },
      totpRef: { type: 'string', description: 'CRED_REF_ handle for the base32 TOTP secret (enables silent 2FA).' },
      twoFactor: { type: 'string', enum: ['auto', 'totp', 'phone', 'none'], description: 'Default auto.' }
    }, required: ['action'] } },
  { name: 'generate_3d', description: 'Convert a 2D image into a textured 3D model (GLB) using Microsoft TRELLIS via Replicate. Input a local PNG/JPG path (from generate_image or the user). Output a GLB with PBR textures saved locally. Takes 30–90s. Requires replicateKey in config. Good for: 3D logos, object prototypes, Skipper assets, structure visualizations.',
    input_schema: { type: 'object', properties: {
      image_path: { type: 'string', description: 'Absolute path to input PNG or JPG.' },
      texture_size: { type: 'number', enum: [512, 1024, 2048], description: 'Texture resolution. Default 1024.' },
      filename: { type: 'string', description: 'Output filename (no extension). Defaults to timestamp.' }
    }, required: ['image_path'] } },
  { name: 'make_printable', description: 'Turn a 2D image into a 3D-PRINTABLE mesh (STL), or convert an existing 3D model to STL. Deterministic + local (no API, no cost). Use this — not generate_3d — when the goal is 3D PRINTING. Modes: "extrude" = threshold the image to a silhouette and extrude it into a solid (logos, stamps, keychains, name plates, cookie-cutters); "relief" = grayscale height-map / backlit lithophane (use invert for lithophanes); "convert" = an existing model (e.g. a generate_3d .glb) → STL. If no path is given it uses the most recently imported/dragged image. Units are millimetres.',
    input_schema: { type: 'object', properties: {
      path: { type: 'string', description: 'Absolute path to the image (extrude/relief) or model (convert). Omit to use the last imported image.' },
      mode: { type: 'string', enum: ['extrude', 'relief', 'convert'], description: 'extrude (silhouette solid) | relief (lithophane/height-map) | convert (model→STL). Default extrude.' },
      height_mm: { type: 'number', description: 'Extrude depth or relief height in mm. extrude default 4, relief default 3.' },
      base_mm: { type: 'number', description: 'Flat base thickness in mm under the shape (0 = none).' },
      size_mm: { type: 'number', description: 'Longest side of the print in mm. extrude default 60, relief default 80.' },
      invert: { type: 'boolean', description: 'Invert light/dark. For a backlit lithophane (dark=thick), set true.' },
      filename: { type: 'string', description: 'Output filename (no extension). Defaults to a timestamp.' },
      preview: { type: 'boolean', description: 'Open an interactive 3D preview (Quick Look) of the result. Default true.' }
    }, required: [] } },
  { name: 'notify_user', description: 'Reach Siddhant out-of-band when you need a decision mid-task, or when a long task he queued remotely finishes. Channel is chosen by urgency + time of day. He can REPLY to an SMS or answer a call and it routes back to you. Do NOT use for routine output.',
    input_schema: { type: 'object', properties: {
      message: { type: 'string', description: 'The message. For a call, write it as a spoken sentence; for SMS keep it ≤300 chars and end with a clear question if you want a reply.' },
      urgency: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'call'], description: 'info/low = ⚪ Telegram (written record). medium = 🟡 SMS (Telegram during quiet hours 23:00–07:00) — async decisions. high = 🔴 SMS regardless of hour (loud). call = real phone call via Twilio (production-down only; quiet hours auto-downgrade to an URGENT SMS). Default low.' },
      awaitReply: { type: 'boolean', description: 'Set true when you need his answer to CONTINUE the task — registers a pending question so his SMS reply resumes it. End the message with one clear question.' },
      taskId: { type: 'string', description: 'Short id for the pending question (with awaitReply), e.g. "deploy-retry". Auto-generated if omitted.' }
    }, required: ['message'] } },
  { name: 'ask_options', description: 'Ask Siddhant to CHOOSE from a set of options with an INTERACTIVE CARD shown right in the app — instead of listing choices as text he has to read and type back. Use this ANY time you would otherwise write "pick one / choose any / which of these / do you want A, B, or C" (loadout features, colour schemes, plan variants, scope choices). He taps his choice(s) and you receive them back. PREFER this over a text list. Add a VISUAL to each option so he SEES it: set imageQuery (a real photo is fetched) or generate:true (an image is generated) per option — great for colours, styles, materials, places, products. multi:true → checkboxes + Confirm; multi:false/omit → single-select (one tap submits). Returns { selected: [chosen labels] }. Desktop app only.',
    input_schema: { type: 'object', properties: {
      question: { type: 'string', description: 'The prompt shown above the options, e.g. "Pick your suit loadout".' },
      options: { type: 'array', description: '2–12 choices. Each is { label, description?, imageQuery?, generate? } — imageQuery fetches a real photo to show on the card; generate:true generates one instead.',
        items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' }, imageQuery: { type: 'string', description: 'search terms for a real photo to show on this option' }, image: { type: 'string', description: 'an explicit image URL/data-URI (overrides imageQuery)' }, generate: { type: 'boolean', description: 'generate the option image instead of searching' } }, required: ['label'] } },
      multi: { type: 'boolean', description: 'true = multi-select (checkboxes + Confirm). false/omit = single-select (tap to choose).' },
      allowText: { type: 'boolean', description: 'Show an inline free-text box so he can type his own answer instead of picking a preset (default on). The typed text comes back in `text`.' },
      autoVisual: { type: 'boolean', description: 'Auto-fetch a relevant photo for EVERY option from its label when you did not set imageQuery yourself. Turn this on whenever the choice is visual (products, colours, materials, places, designs, foods, people) so he SEES each option. Leave off for abstract choices (yes/no, plan A/B).' }
    }, required: ['question', 'options'] } },
  { name: 'show_visuals', description: "SHOW pictures on the in-app VISUAL CANVAS (draggable, resizable, layered) while you keep talking — instead of reading long descriptions aloud. Call this EARLY in any descriptive/informational answer about something visual (a place like the Colosseum, a landmark, an object, a design, a person, a comparison) so the images appear as you narrate — lower TTS latency, richer experience. Smart-mix source: real photos are searched by default (for real things); set generate:true for a concept/abstract image. Non-blocking — it returns immediately; carry on describing the subject in your own words and do NOT read image URLs aloud.",
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'What to show, e.g. "Roman Colosseum interior and exterior".' },
      title: { type: 'string', description: 'Optional heading for this set on the canvas.' },
      count: { type: 'number', description: 'How many images (default 6, max 12).' },
      generate: { type: 'boolean', description: 'true = generate the image(s) with AI (for concepts/abstract things); default false = search real photos.' },
      urls: { type: 'array', items: { type: 'string' }, description: 'Optional explicit image URLs to display instead of searching.' }
    }, required: [] } },
  { name: 'ask_form', description: 'Collect SEVERAL pieces of information from Siddhant AT ONCE with an interactive FORM card (multiple labelled boxes on one card) — instead of interviewing him field-by-field across many turns. Use this whenever you need 2+ distinct inputs to proceed (e.g. name + email + date; project title + goal + deadline; dimensions + colour + material). Each field can be a text box, a number box, a longer textarea, a single-select dropdown, or a multi-select chip group. He fills them in and taps Submit; you receive { values: { fieldKey: value } } (multi-select values come back as arrays). PREFER one ask_form over a long back-and-forth. Desktop app only.',
    input_schema: { type: 'object', properties: {
      title: { type: 'string', description: 'Heading shown at the top of the form, e.g. "Trip details".' },
      fields: { type: 'array', description: '1–10 fields to collect. Each: { key, label, type?, placeholder?, required?, options?, default? }. type ∈ text|number|textarea|select|multiselect (default text). options (array of strings) is required for select/multiselect.',
        items: { type: 'object', properties: {
          key: { type: 'string', description: 'machine key the value comes back under' },
          label: { type: 'string', description: 'human label shown above the box' },
          type: { type: 'string', enum: ['text', 'number', 'textarea', 'select', 'multiselect'], description: 'input kind (default text)' },
          placeholder: { type: 'string' },
          required: { type: 'boolean', description: 'block Submit until filled (default false)' },
          options: { type: 'array', items: { type: 'string' }, description: 'choices for select/multiselect' },
          default: { description: 'prefilled value' }
        }, required: ['key', 'label'] } },
      submitLabel: { type: 'string', description: 'Text on the submit button (default "Submit").' }
    }, required: ['fields'] } },
  { name: 'phone_mirror', description: "CONTROL SIDDHANT'S IPHONE through macOS iPhone Mirroring — tap, type, swipe and read the phone screen the same way you drive any native Mac app (via screen_parse + vision_click on the mirrored window). Actions: `status` (is iPhone Mirroring open/connected + a screenshot), `open` (launch/focus the iPhone Mirroring app, returns a screenshot to see the phone), `call_to_start` (place a real phone call asking Siddhant to open/unlock his phone so mirroring can connect, then continue — use this when the phone is locked or mirroring is disconnected and you need him to bring it online), `home` (go to the iPhone home screen), `screenshot` (grab the current phone screen). To actually TAP something on the phone: call `open` (or `status`), then use screen_parse(target:\"screen\") to map the mirrored window and vision_click on the element — the same closed loop you use for any desktop app. Requires macOS 15+ iPhone Mirroring set up once, plus Accessibility + Screen Recording permissions.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'open', 'call_to_start', 'home', 'screenshot'], description: 'what to do' },
      message: { type: 'string', description: 'For call_to_start: the spoken sentence to say when Siddhant answers (e.g. "I need to send a text from your phone — please unlock it and open iPhone Mirroring, then tell me to go ahead").' }
    }, required: ['action'] } }
  ];
};
