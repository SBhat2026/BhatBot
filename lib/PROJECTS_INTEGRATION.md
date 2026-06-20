# Wiring `lib/projects.js` into main.js

Project memory with a constantly-updating summary (Task #24). BhatBot "opens a project" and keeps
a living, cumulative summary that's refreshed as work happens, and injected into the agent's memory
so BhatBot always knows the current project.

The module is **dependency-free**: the LLM is injected by main.js. All reads are sync; only
`updateSummary` / `maybeAutoSummarize` are async. Nothing throws.

Store: `~/.bhatbot/projects/<slug>.json` per project + `~/.bhatbot/projects/active.json` (`{slug}`).

---

## 0. Require it (top of main.js, with the other lib requires)

```js
const projects = require('./lib/projects');
```

---

## 1. Add a `project` agent tool

### Tool definition (add to wherever the agent tool list / `tools` array is built)

```js
{
  name: 'project',
  description: "Open and track a project with a living, auto-updating summary. Use 'open' when the user starts/switches to a project so BhatBot keeps context across turns. 'note' records a decision, milestone, or fact. 'summary' regenerates the rolling summary now. 'status' shows the active project. 'list' shows all projects. 'close' marks a project done.",
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'list', 'status', 'note', 'summary', 'close'] },
      name:   { type: 'string', description: "Project name (for 'open') or slug (for 'note'/'summary'/'close'; omit to target the active project)." },
      text:   { type: 'string', description: "For 'note': the decision/milestone/fact to record." },
      kind:   { type: 'string', enum: ['note', 'decision', 'milestone'], description: "For 'note': entry kind (default note)." },
    },
    required: ['action'],
  },
}
```

### Handler (add a `case 'project':` in the tool-dispatch switch)

`summarize` wraps an existing model call. main.js already has `callClaude(messages, apiKey, model)`,
`getApiKey()`, and `MODEL_HAIKU` — Haiku is the right cost tier for a 120-word summary.

```js
case 'project': {
  const a = toolInput.action;
  // model wrapper injected into updateSummary; returns a plain string
  const summarize = async (prompt) => {
    const r = await callClaude([{ role: 'user', content: prompt }], getApiKey(), MODEL_HAIKU);
    return (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  };
  if (a === 'open') {
    const rec = projects.open(toolInput.name || 'Project');
    if (!rec) return { error: 'Could not open project.' };
    // optional Notion mirror — see section 4
    // notion.updateProjectState({ projectName: rec.name, status: rec.status, facts: rec.highlights.slice(-5) }).catch(() => {});
    return { ok: true, slug: rec.slug, name: rec.name, status: rec.status, summary: rec.summary || '(new project)' };
  }
  if (a === 'list')   return { projects: projects.list() };
  if (a === 'status') { const r = projects.active(); return r ? { name: r.name, slug: r.slug, status: r.status, summary: r.summary, highlights: r.highlights.slice(-5) } : { active: null }; }
  if (a === 'note') {
    const slug = toolInput.name ? projects.slugify(toolInput.name) : projects.activeSlug();
    if (!slug) return { error: 'No active project. Open one first.' };
    projects.note(slug, toolInput.text || '', toolInput.kind || 'note');
    return { ok: true };
  }
  if (a === 'summary') {
    const slug = toolInput.name ? projects.slugify(toolInput.name) : projects.activeSlug();
    if (!slug) return { error: 'No active project. Open one first.' };
    const summary = await projects.updateSummary(slug, { summarize });
    // optional: notion.updateProjectState({ projectName: projects.get(slug).name, status: 'active', facts: [summary] }).catch(() => {});
    return { ok: true, summary };
  }
  if (a === 'close') {
    const slug = toolInput.name ? projects.slugify(toolInput.name) : projects.activeSlug();
    if (!slug) return { error: 'No project to close.' };
    projects.close(slug);
    return { ok: true, closed: slug };
  }
  return { error: 'Unknown project action: ' + a };
}
```

> Adjust `toolInput` / return shape to match how other tools in your switch read args and return.

---

## 2. Hook the agent loop's `finish(text)` — record the turn + cheap auto-summary

In the agent turn-completion path, after you have the user's text and the cleaned assistant text,
record the turn and fire-and-forget the auto-summary (it only calls the model every ~6 entries):

```js
// at end of the agent turn — `userText` = the user message, `cleanText` = stripped assistant reply
const _slug = projects.activeSlug();
if (_slug) {
  projects.recordTurn(_slug, userText, cleanText);
  const summarize = async (prompt) => {
    const r = await callClaude([{ role: 'user', content: prompt }], getApiKey(), MODEL_HAIKU);
    return (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  };
  projects.maybeAutoSummarize(_slug, { summarize }).catch(() => {}); // fire-and-forget, never blocks the reply
}
```

Note on the existing `finish()` at ~main.js:5657 — that one is the **TTS stream** finisher
`{ feed, finish }` (no args) and is NOT the right place. Put this hook where the **agent turn**
actually ends and you have `userText` + the final assistant text in scope (the same place
session-note `recordSpoken` / `noteActivity` flow from). If the only available text is the
streamed `display`, pass that as `cleanText`.

---

## 3. Inject the active project into the memory block

In `buildMemoryBlock(query)` (main.js ~line 757), append the active project's summary so every
prompt carries the current project context. `contextBlock()` is sync and returns `''` when none:

```js
function buildMemoryBlock(query) {
  // ... existing block assembly ...
  const proj = projects.contextBlock();      // '' when no active project
  return [/* existing pieces */, proj].filter(Boolean).join('\n\n');
}
```

(Match your actual concatenation style — just ensure `projects.contextBlock()` is appended.)

---

## 4. Optional — mirror to Notion

`lib/notion.js` exports `updateProjectState({ projectName, status, facts = [], blockers = [] })`.
Call it fire-and-forget on `open` and after `summary`/auto-summary so the project surfaces in Notion:

```js
notion.updateProjectState({
  projectName: rec.name,
  status: rec.status,           // 'active' | 'paused' | 'done'
  facts: [summary],             // or rec.highlights.slice(-5)
}).catch(() => {});
```

Don't add this unless you want the Notion mirror — it's purely additive. (Commented inline above.)

---

## API reference (`const projects = require('./lib/projects')`)

| call | sync? | returns |
|---|---|---|
| `open(name)` | sync | record; creates if missing, sets active, idempotent |
| `active()` | sync | active record or `null` |
| `activeSlug()` | sync | slug or `null` |
| `list()` | sync | `[{name, slug, status, updated, summaryLine}]` |
| `get(slug)` | sync | record or `null` |
| `note(slug, text, kind='note')` | sync | record; kind ∈ note\|turn\|decision\|milestone (decision/milestone also promote to highlights) |
| `recordTurn(slug, userText, assistantText)` | sync | record; compact truncated 'turn' entry |
| `close(slug)` / `pause(slug)` | sync | record with new status |
| `updateSummary(slug, {summarize})` | **async** | new summary string; deterministic fallback if no `summarize` |
| `maybeAutoSummarize(slug, {summarize}, everyN=6)` | **async** | `{updated, summary}`; only calls model after ≥everyN new log entries |
| `contextBlock()` | sync | memory-block string for the active project, or `''` |
| `slugify(name)` | sync | slug (for mapping a name → slug in the tool handler) |

Record shape: `{ name, slug, created, updated, status, summary, highlights:[], log:[{ts,kind,text}] }`
(log capped at last 200 entries). All writes atomic (tmp + rename); no method throws.
