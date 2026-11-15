'use strict';
// ── THE TOOL CATALOG ──────────────────────────────────────────────────────────────────────────────
// Which of the ~85 tools go on the wire this turn, and what it costs to decide.
//
// THE MEASUREMENT THIS IS BUILT ON (2026-09-20, `lib/tools-schema.js` as it stands):
//   full catalog .................. 25,531 tokens
//   selected mode today ...........  4,778 tokens   (CORE 12 + top-12 by cosine)
//   CORE alone ....................  3,289 tokens   ← on EVERY turn, 69% of the above
//   all names + one-line summaries .  2,176 tokens
//   all names only ................    278 tokens
//
// The retrieval was never the expensive part. The ALWAYS-ON set was. And the same number explains
// why the making tools had to be parked: make_model (769) + make_asset (634) + make_figure (540) is
// over 1,900 tokens of schema sitting on turns that will never call any of them.
//
// WHAT WAS WRONG WITH THE OLD SHAPE. `lib/toolselect.js` embeds the query, takes a cosine top-k over
// all 85 tools, and unions a hardcoded CORE. Three consequences:
//   1. A low-confidence result returns null, which the caller reads as "send everything" — so the
//      worst case is 25,531 tokens, and it is SILENT. That regression has shipped twice, once
//      through a dead gate and once through a stale cross-model vector cache.
//   2. Ranking 85 heterogeneous tools by one cosine is a hard problem to be solving at all. The
//      recorded misses in BENCH_APP.md are not close calls — "merge these three PDFs" did not reach
//      file_tools, "what is on my calendar tomorrow" did not reach calendar.
//   3. A local model cannot reliably tool-call across 24 schemas. That, not the models, is why the
//      free tier has never had tools.
//
// THE SHAPE HERE. Two levels, resolved DETERMINISTICALLY before the model is called, because a
// round trip costs 2–8 seconds and the whole point is to spend less:
//
//   query ──(keyword scoring, 0 ms, $0)──► 1–3 CATEGORIES ──► those categories' tools ──► wire
//                                                │
//                                                └─ embeddings, if available, only to RANK WITHIN
//                                                   the resolved categories — 8 candidates, not 85
//
//   ...plus a `toolbox` meta-tool in CORE, so a model that needs something the resolver did not
//   pick asks for that category instead of the caller silently sending all 85. The 25,531-token
//   worst case stops existing.
//
// ON "TREE-BASED SEARCH". The hierarchy is real and load-bearing; a literal trie is not. Prefix
// tries buy lookup speed, and lookup speed over 85 entries is free either way — the cost here is
// tokens and round trips, which is what the two-level structure addresses. Calling it a trie would
// be describing the implementation of the cheap half.
//
// THE INVARIANT THAT MATTERS MOST: a tool this module does not recognize is never dropped. A
// connector coming online adds tools at runtime (85 → 90 has been observed), and a tool that is in
// the catalog but in no category must still be reachable, or a capability disappears with no error.
// Uncategorized tools land in `unsorted`, which is always offered. See scripts/test-toolcatalog.js.
//
// Pure + DI: no I/O, no model calls, no clock. The embedding tiebreaker is INJECTED.

// ── CATEGORIES ────────────────────────────────────────────────────────────────────────────────────
// `summary` is what the model reads in the toolbox schema, so it is written for a reader choosing
// between fourteen options, not as a description of the code.
//
// `keywords` are scored, not matched: [word, weight]. Weight 3 = this word alone names the
// category ("blender" → make). Weight 2 = strong. Weight 1 = suggestive, needs company. Words are
// matched on boundaries so "render" does not fire inside "renderer".
//
// `patterns` are STRUCTURAL signals — a filesystem path, a URL, a code fence. These are worth more
// than any keyword because they are unambiguous: "read ~/notes/todo.md" is a file operation no
// matter that "notes" also names a Mac app, and keyword scoring alone got that one wrong.
// `quickRoute` already leans on exactly these three regexes for the same reason.
const CATEGORIES = {
  files: {
    label: 'Files',
    summary: 'Files and documents: read, write, patch, list; image conversion, PDFs.',
    tools: ['read_file', 'write_file', 'edit_file', 'list_directory', 'file_tools', 'tidy_files'],
    keywords: [['clean up', 3], ['cleanup', 3], ['declutter', 3], ['redundant', 3], ['duplicates', 3], ['free up space', 3], ['disk space', 3], ['review folder', 3], ['file', 2], ['folder', 2], ['directory', 2], ['pdf', 3], ['resize', 3], ['compress', 3],
      ['convert', 2], ['merge', 2], ['split', 2], ['rotate', 2], ['rename', 2], ['read', 1], ['write', 1],
      ['edit', 1], ['save', 1], ['csv', 1], ['path', 1], ['document', 1], ['thumbnail', 2], ['image file', 3]],
    patterns: [
      // A filesystem path or a bare filename with an extension. Unambiguous, and it must outrank a
      // keyword that happens to appear in the path ("~/notes/todo.md" is not the Notes app).
      [/(^|\s)[~./][\w./-]*\/[\w.-]+/, 3],
      [/\b[\w-]+\.(?:js|ts|py|md|json|html|css|sh|txt|yml|yaml|toml|csv|pdf|png|jpe?g|stl|glb|docx?|xlsx?)\b/i, 3],
    ],
  },
  shell: {
    label: 'Shell & code',
    summary: 'Shell commands, Docker, and delegating a coding task to Claude Code.',
    tools: ['run_shell', 'container_run', 'claude_code', 'xcode'],
    keywords: [['shell', 3], ['terminal', 3], ['command', 2], ['bash', 3], ['npm', 2], ['git', 2],
      ['commit', 2], ['install', 2], ['docker', 3], ['container', 3], ['build', 1], ['compile', 2],
      ['run', 1], ['script', 1], ['refactor', 2], ['debug', 2], ['repo', 2], ['code', 1], ['test', 1]],
    patterns: [[/```/, 3], [/\$\s?\w+\s+-{1,2}\w/, 2]],
  },
  web: {
    label: 'Web',
    summary: 'Web search, fetching URLs, driving a browser, and scholarly papers.',
    tools: ['fetch_url', 'open_in_browser', 'web_search', 'browser', 'browser_workflow', 'browser_observe', 'browser_devtools', 'find_papers'],
    keywords: [['web', 2], ['browser', 3], ['url', 3], ['website', 3], ['site', 2], ['google', 2],
      ['search', 1], ['navigate', 2], ['page', 1], ['link', 1], ['download', 1], ['scrape', 3],
      ['devtools', 3], ['paper', 2], ['arxiv', 3], ['citation', 2], ['literature', 2], ['online', 2],
      ['look up', 2], ['browse', 3]],
    patterns: [[/https?:\/\/|\bwww\./i, 3]],
  },
  vision: {
    label: 'Screen vision',
    summary: 'Seeing the screen: screenshot, parse it into elements, click them.',
    tools: ['ui_inspect', 'screen_parse', 'vision_click', 'vision_local', 'screen_observe'],
    keywords: [['screenshot', 3], ['screen', 3], ['click', 3], ['see', 1], ['look at', 2], ['visible', 2],
      ['on screen', 3], ['capture', 2], ['button', 1], ['what am i', 2], ['watch', 2], ['element', 1]],
  },
  desktop: {
    label: 'Mac & devices',
    summary: 'Mac apps and devices: AppleScript, Spotify, Resolve, iPhone, the HUD.',
    tools: ['system_control', 'media_control', 'davinci_resolve', 'phone_mirror', 'play_chess', 'request_permissions', 'hud_control', 'world_view', 'phone_call', 'contacts', 'free_memory'],
    keywords: [['memory', 2], ['ram', 3], ['hogging', 3], ['running slow', 3], ['mac is slow', 3], ['quit', 2], ['call', 3], ['ring', 2], ['dial', 3], ['contact', 3], ['contacts', 3], ['phone number', 3], ['number for', 2], ['webcam', 3], ['live cam', 3], ['camera in', 2], ['show me', 1], ['what s it like in', 3], ["what's it like in", 3], ['world', 1], ['spotify', 3], ['music', 3], ['song', 3], ['play', 2], ['pause', 2], ['volume', 3],
      ['playlist', 3], ['app', 2], ['applescript', 3], ['launch', 2], ['quit', 2], ['open', 1],
      ['resolve', 2], ['davinci', 3], ['video edit', 3], ['iphone', 3], ['phone', 2], ['chess', 3],
      ['hud', 3], ['window', 2], ['permission', 2], ['finder', 3], ['notes', 1]],
  },
  mail: {
    label: 'Mail, calendar & drive',
    summary: 'Gmail, the inbox-triage ledger, Google Calendar and Drive.',
    tools: ['gmail', 'triage_mail', 'calendar', 'drive'],
    keywords: [['email', 3], ['e-mail', 3], ['mail', 3], ['gmail', 3], ['inbox', 3], ['unread', 3],
      ['message', 1], ['thread', 2], ['sender', 2], ['archive', 2], ['calendar', 3], ['event', 2],
      ['meeting', 3], ['schedule', 1], ['tomorrow', 1], ['drive', 2], ['spreadsheet', 2], ['doc', 1],
      ['reply', 2], ['draft', 2], ['label', 2], ['triage', 3]],
  },
  ask: {
    label: 'Asking Siddhant',
    summary: 'Asking Siddhant something: notify, options card, form, show pictures.',
    tools: ['notify_user', 'ask_options', 'ask_form', 'show_visuals'],
    keywords: [['ask', 2], ['choose', 2], ['option', 2], ['decide', 2], ['confirm', 2], ['notify', 3],
      ['tell me', 1], ['show me', 1], ['form', 2], ['which one', 2], ['prefer', 1]],
  },
  make: {
    label: 'Making things',
    summary: 'Producing artifacts: images, Blender 3D, STL, figures, video, canvas.',
    tools: ['generate_image', 'generate_3d', 'make_asset', 'make_model', 'make_printable', 'make_figure', 'visual_build', 'studio_write', 'bioart'],
    keywords: [['image', 2], ['picture', 2], ['logo', 3], ['render', 2], ['blender', 3], ['3d', 3],
      ['model', 1], ['stl', 3], ['print', 2], ['mesh', 3], ['glb', 3], ['figure', 2], ['chart', 2],
      ['plot', 2], ['graph', 2], ['diagram', 2], ['video', 3], ['animation', 3], ['design', 2],
      ['poster', 3], ['illustration', 3], ['draw', 2], ['asset', 2], ['canvas', 2], ['generate', 1]],
  },
  science: {
    label: 'Science & math',
    summary: 'Simulation, quantitative modelling, maths, molecules, protein function.',
    tools: ['simulate', 'sci_compute', 'math_reason', 'molecule', 'predict_function'],
    keywords: [['simulate', 3], ['simulation', 3], ['physics', 3], ['chemistry', 3], ['molecule', 3],
      ['protein', 3], ['pdb', 3], ['solve', 2], ['equation', 3], ['integral', 3], ['derivative', 2],
      ['calculate', 2], ['compute', 2], ['statistics', 2], ['regression', 2], ['pendulum', 3],
      ['dynamics', 2], ['numerical', 2], ['math', 2], ['prove', 2], ['fold', 2], ['alphafold', 3],
      ['binder', 2], ['residue', 2], ['sequence', 1]],
  },
  memory: {
    label: 'Memory & projects',
    summary: 'Durable memory, the Notion bank, and project tracking.',
    tools: ['save_memory', 'notion_write', 'notion_search', 'notion_log_activity', 'project'],
    keywords: [['remember', 3], ['memory', 3], ['recall', 3], ['forget', 2], ['note', 1], ['notion', 3],
      ['project', 3], ['fact', 2], ['know about', 2], ['told you', 2], ['last time', 2], ['previously', 2]],
  },
  agents: {
    label: 'Agents & big jobs',
    summary: 'Delegating work: specialists, parallel teams, drones, plans, big builds.',
    tools: ['subagent', 'agent_team', 'fleet', 'deploy_drones', 'mission_plan', 'plan_and_run', 'build_project', 'delegate_project', 'manage_jobs', 'write_agent_directive', 'long_run', 'forge_tool'],
    // The phrasings that reach for the HOUR-LONG lane are about duration and absence, not about
    // agents: "work on this while I'm asleep" contains none of the words above and resolved to
    // nothing. With ~20 of 89 tools offered per turn, a tool the resolver cannot find is a tool the
    // agent does not have — which is exactly how Siddhant came to find the phone line broken by
    // hearing it rather than by BhatBot checking.
    keywords: [['agent', 3], ['team', 2], ['parallel', 3], ['drone', 3], ['fleet', 3], ['delegate', 3],
      ['in the background', 3], ['background', 2], ['plan', 2], ['decompose', 3], ['job', 2],
      ['while i', 2], ['at the same time', 3], ['specialist', 2], ['orchestrate', 3], ['mission', 2],
      ['for an hour', 3], ['for hours', 3], ['overnight', 3], ['while im asleep', 3], ["while i'm asleep", 3],
      ['while i sleep', 3], ['asleep', 3], ['keep going', 3], ['on your own', 3], ['autonomous', 3], ['without me', 3],
      ['until it', 2], ['until you', 2], ['long run', 3], ['unattended', 3], ['check back', 2],
      // and the phrasings that mean "you do not have a tool for this"
      ['build a tool', 3], ['make a tool', 3], ['custom tool', 3], ['forge', 3], ['no tool', 3],
      ['you cant do', 3], ["you can't do", 3], ['write a script for', 3]],
  },
  self: {
    label: 'BhatBot itself',
    summary: "BhatBot's own code and state, plus Siddhant's Garmin biometrics.",
    tools: ['self_improve', 'self_fix', 'self_heal', 'self_reflect', 'self_drive', 'self_check', 'health', 'ops_status'],
    // "is your phone line working" resolved to DESKTOP before self_check joined this category —
    // it matched the word "phone" and nothing else. With ~20 of 91 tools offered per turn, a tool
    // the resolver cannot find is a tool the agent does not have, so the phrasings someone actually
    // uses to report that BhatBot itself is broken are listed explicitly.
    keywords: [['yourself', 3], ['your own', 3], ['self', 2], ['your code', 3], ['improve', 2],
      ['heal', 2], ['reflect', 2], ['what are you', 3], ['status', 2], ['running right now', 3],
      ['garmin', 3], ['sleep', 2], ['heart rate', 3], ['hrv', 3], ['biometric', 3], ['body battery', 3],
      ['diagnos', 3], ['self check', 3], ['are you broken', 3], ['is your', 3], ['why did that fail', 3],
      ['your phone line', 3], ['application error', 3], ['not working', 2], ['check yourself', 3],
      ['what is broken', 3], ['something wrong with you', 3],
      // Measured against real phrasings rather than invented ones: "why did that call fail" and
      // "are your tools broken" both resolved to NOTHING until these were added.
      ['your tools', 3], ['call fail', 3], ['your voice', 3], ['your calls', 3], ['are you ok', 3]],
  },
  creds: {
    label: 'Logins & secrets',
    summary: 'Passwords, Keychain, 1Password, 2FA codes, signing into sites.',
    tools: ['keychain_lookup', 'generate_totp', 'onepassword_lookup', 'smart_login', 'manage_logins'],
    keywords: [['password', 3], ['login', 3], ['log in', 3], ['log into', 3], ['sign into', 3], ['sign in', 3], ['keychain', 3],
      ['1password', 3], ['credential', 3], ['2fa', 3], ['totp', 3], ['two-factor', 3], ['otp', 3],
      ['account', 1], ['authenticate', 2]],
  },
  info: {
    label: 'Live info & setup',
    summary: 'Live info and setup: World Cup, news, maps, ambient, schedules, connectors.',
    tools: ['world_cup', 'news', 'maps', 'ambient', 'manage_schedule', 'ask_ai', 'connectors', 'plugin'],
    keywords: [['world cup', 3], ['standings', 3], ['fixture', 3], ['score', 2], ['odds', 2],
      ['bracket', 3], ['news', 3], ['headline', 3], ['weather', 2], ['map', 3], ['directions', 3],
      ['ambient', 3], ['remind', 3], ['every morning', 3], ['every day', 2], ['recurring', 3],
      ['connector', 3], ['plugin', 3], ['another ai', 3], ['chatgpt', 2], ['gemini', 2], ['second opinion', 3]],
  },
};

// Tools that earn their place on every single turn. Deliberately tiny: this set used to be twelve
// tools and 3,289 tokens, which was 69% of a selected turn's tool budget spent on capabilities most
// turns never touch. `toolbox` is what makes a small CORE safe — anything not wired is one cheap
// call away rather than absent.
const CORE = ['toolbox', 'notify_user'];

// Where a tool goes when nothing claims it. Never omitted from the wire — see the header.
const UNSORTED = 'unsorted';

const TOOLBOX_NAME = 'toolbox';

// ── index ─────────────────────────────────────────────────────────────────────────────────────────

/** name → category key, built once from CATEGORIES. */
function buildIndex() {
  const idx = {};
  for (const [key, c] of Object.entries(CATEGORIES)) for (const t of c.tools) idx[t] = key;
  return idx;
}
const INDEX = buildIndex();

/** Which category a tool belongs to; UNSORTED for anything unrecognized (a runtime connector tool). */
function categoryOf(name) { return INDEX[name] || UNSORTED; }

/**
 * Group a live catalog by category. Reports what it could not place rather than hiding it —
 * `unsorted` being non-empty is information, not an error, but it should be visible.
 */
function groupTools(tools = []) {
  const groups = {};
  const unsorted = [];
  for (const t of tools) {
    if (!t || !t.name) continue;
    if (t.name === TOOLBOX_NAME) continue;              // the meta-tool is not in any category
    const k = categoryOf(t.name);
    if (k === UNSORTED) { unsorted.push(t.name); continue; }
    (groups[k] = groups[k] || []).push(t.name);
  }
  return { groups, unsorted };
}

// ── resolution ────────────────────────────────────────────────────────────────────────────────────

// Word-boundary match for a keyword that may contain spaces, tolerating the common English
// inflections — "archived" must match `archive`, "screenshots" must match `screenshot`.
//
// Deliberately a short suffix list rather than a stemmer. `er`/`ers` are NOT included, because they
// change the referent more often than not: "render" vs "renderer" is a different thing, and a
// stemmer that conflates them turns a precise keyword into a noisy one. Keywords are escaped
// because they are data, and a category list is the kind of thing people paste regexes into.
const INFLECTIONS = '(?:s|es|d|ed|ing)?';

function hasWord(text, word) {
  const w = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${w}${INFLECTIONS}([^a-z0-9]|$)`, 'i').test(text);
}

/**
 * resolve(query, opts) → [{ category, score, hits }] , highest first.
 *
 * Deterministic, zero-cost, zero-latency. `max` caps how many categories reach the wire — three is
 * the default because a request that genuinely spans four categories is better served by the model
 * calling `toolbox` for the fourth than by pre-loading everything.
 */
function resolve(query, { max = 3, minScore = 2 } = {}) {
  const q = String(query || '').toLowerCase();
  if (!q.trim()) return [];
  const scored = [];
  for (const [key, c] of Object.entries(CATEGORIES)) {
    let score = 0;
    const hits = [];
    for (const [word, weight] of c.keywords || []) {
      if (hasWord(q, word)) { score += weight; hits.push(word); }
    }
    // Structural signals are scored against the ORIGINAL text, not the lowercased copy, because a
    // path or a filename can be case-sensitive and a regex here may legitimately care.
    for (const [re, weight] of c.patterns || []) {
      try { if (re.test(query)) { score += weight; hits.push(String(re)); } } catch { /* a bad pattern must not sink resolution */ }
    }
    if (score >= minScore) scored.push({ category: key, score, hits });
  }
  // Ties broken by category order, which is stable, so the same query always resolves the same way.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}

// ── selection ─────────────────────────────────────────────────────────────────────────────────────

/**
 * select(query, tools, opts) → { tools, names, categories, unsorted, reason }
 *
 * NEVER returns null. That is the whole difference from lib/toolselect.js: "I am not sure" resolves
 * to CORE + the toolbox meta-tool (a few hundred tokens and one optional round trip), never to the
 * full 25,531-token catalog.
 *
 * opts.rank — optional (names[]) => names[] reranker, for the embedding tiebreaker. It is applied
 * WITHIN the resolved categories, never across the whole catalog, and it may only reorder or trim;
 * anything it drops below `perCategory` is still reachable through toolbox.
 */
function select(query, tools = [], { max = 3, minScore = 2, rank = null, perCategory = Infinity } = {}) {
  const byName = new Map(tools.filter((t) => t && t.name).map((t) => [t.name, t]));
  const { groups, unsorted } = groupTools(tools);
  const picked = resolve(query, { max, minScore });

  const keep = new Set();
  for (const n of CORE) if (byName.has(n)) keep.add(n);
  // Uncategorized tools are ALWAYS offered — a connector tool that arrived at runtime has no
  // category and must not vanish from every turn because of it.
  for (const n of unsorted) keep.add(n);

  for (const p of picked) {
    let names = groups[p.category] || [];
    if (rank && names.length > 1) {
      try {
        const reranked = rank(names, p.category);
        if (Array.isArray(reranked) && reranked.length) names = reranked.filter((n) => byName.has(n));
      } catch { /* a failed reranker must not cost the category */ }
    }
    for (const n of names.slice(0, perCategory)) keep.add(n);
  }

  const subset = tools.filter((t) => t && keep.has(t.name));   // preserve catalog order
  return {
    tools: subset,
    names: subset.map((t) => t.name),
    categories: picked.map((p) => p.category),
    unsorted,
    reason: picked.length ? `resolved to ${picked.map((p) => `${p.category}(${p.score})`).join(', ')}`
      : 'no category matched — core + toolbox only',
  };
}

// ── the toolbox meta-tool ─────────────────────────────────────────────────────────────────────────

/**
 * The schema for the escape hatch. Carrying the category list INSIDE the description is the point:
 * the model sees all fourteen options for a couple of hundred tokens and can name the one it needs,
 * instead of the caller guessing or falling back to the entire catalog.
 */
function toolboxSchema() {
  const lines = Object.entries(CATEGORIES).map(([k, c]) => `  ${k} — ${c.summary}`).join('\n');
  return {
    name: TOOLBOX_NAME,
    description:
      'Fetch the tools for a CATEGORY of work when what you need is not already on the wire. '
      + 'Only the categories relevant to the request are loaded each turn; everything else is one call away. '
      + 'Call this the moment you realize you need a capability you cannot see, rather than saying you cannot do it.\n\nCATEGORIES:\n'
      + lines,
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: Object.keys(CATEGORIES), description: 'which category of tools to load' },
        why: { type: 'string', description: 'one short phrase: what you are about to do with them' },
      },
      required: ['category'],
    },
  };
}

/** Full schemas for one category — what a `toolbox` call returns to the wire. */
function expand(category, tools = []) {
  const want = new Set((CATEGORIES[category] || {}).tools || []);
  return tools.filter((t) => t && want.has(t.name));
}

/** Names + one-line summaries for a category, for a cheap textual answer to a toolbox call. */
function describe(category, tools = []) {
  const c = CATEGORIES[category];
  if (!c) return null;
  const byName = new Map(tools.filter((t) => t && t.name).map((t) => [t.name, t]));
  return {
    category,
    label: c.label,
    summary: c.summary,
    tools: c.tools.filter((n) => byName.has(n)).map((n) => ({
      name: n,
      summary: String(byName.get(n).description || '').replace(/\s+/g, ' ').slice(0, 140),
    })),
  };
}

module.exports = {
  CATEGORIES, CORE, UNSORTED, TOOLBOX_NAME,
  categoryOf, groupTools, resolve, select, toolboxSchema, expand, describe,
};
