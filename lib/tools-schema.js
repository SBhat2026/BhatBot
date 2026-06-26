'use strict';
// Tool SCHEMA catalog (Phase 4 split — extracted from main.js). PURE DATA: the {name, description,
// input_schema} definitions the model sees. Implementations live in main.js executeTool / lib/*.
// Exported as a factory only because save_memory's description interpolates the live MEMORY_SECTIONS.
module.exports = function toolSchema({ MEMORY_SECTIONS = [] } = {}) {
  return [
  { name: 'read_file', description: 'Read a UTF-8 text file (100KB max). Absolute paths.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
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
  { name: 'plan_and_run', description: 'PLAN-AND-EXECUTE a high-level GOAL: BhatBot decomposes it into the fewest parallelizable subtasks (a task DAG), shows the plan in the Legion panel, then dispatches a guardrailed team layer-by-layer — independent steps run in parallel, dependent steps wait for and receive their upstream results — and returns the combined outcome. Use for a BIG multi-part goal ("build X with parts a/b/c", "research then draft then review"). dryRun:true returns the PLAN ONLY (no execution) so Siddhant can approve/adjust first. For several already-separate jobs use `fleet`; for one focused job use the direct tool.',
    input_schema: { type: 'object', properties: {
      goal: { type: 'string', description: 'the high-level goal to decompose and accomplish.' },
      dryRun: { type: 'boolean', description: 'true = return the proposed plan WITHOUT running it (preview/approve first).' },
      maxSteps: { type: 'number', description: 'max subtasks (default 6, hard cap 8).' },
      maxParallel: { type: 'number', description: 'max agents running at once (default 4, hard cap 6).' }
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
    }, required: ['message'] } }
  ];
};
