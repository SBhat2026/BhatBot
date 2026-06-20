# Semantic Memory Layer — Integration Notes (task #12)

Embedding-based long-term recall. New, self-contained module: `lib/semantic.js`.
NOTHING below has been wired yet — this doc tells you (the human) exactly where
and how to call it. No existing file was modified.

- **Dependencies:** none (Node built-ins + global `fetch`).
- **Embeddings:** OpenAI `text-embedding-3-small` via `fetch`.
- **Key source:** `process.env.OPENAI_API_KEY` (cloud) OR `openaiKey` in
  `~/.bhatbot/config.json` (desktop). You already have `openaiKey` set.
- **Store:** `~/.bhatbot/semantic/store.json` (auto-created; capped at 5000
  records, oldest **episodic** evicted first).
- **Cost:** ~$0.00002 / 1k tokens. A fact or a turn is well under 1k tokens →
  effectively free at personal scale.
- **Graceful degradation:** with no key, every function returns `{skipped:true}`
  or `[]` and never throws. Safe to call from hot paths unconditionally.

## Two memory kinds

- `kind:'semantic'` — durable facts / preferences (mirror of `memory.md`,
  Notion shared bank). "What is true."
- `kind:'episodic'` — timestamped events / turns. "What happened, when."

## Exported API (`const semantic = require('./lib/semantic')`)

| Function | Signature | Returns |
|---|---|---|
| `isReady()` | `() → boolean` | key present? |
| `upsert(rec)` | `({text, kind='semantic', meta={}}) → Promise` | `{id, action:'insert'\|'update', deduped?}` or `{skipped:true}`. Embeds + stores; dedups same-kind near-identical text (cosine ≥ 0.95 → refresh ts). |
| `search(query, opts)` | `(query, {kind?, k=6, minScore=0.2}) → Promise<[{text,kind,ts,score,meta}]>` | cosine-ranked desc; `[]` on no-key/empty. |
| `recent(opts)` | `({kind?, k=20}) → [{text,kind,ts,meta}]` | newest first; **no embedding call** (sync, free). |
| `stats()` | `() → {total, episodic, semantic, ready, capacity}` | counts; no embedding call. |
| `backfill(items)` | `([{text,kind,ts,meta}]) → Promise<{added,updated,skipped,total}>` | bulk upsert, batched ≤64/request. |
| `cosine(a,b)` | helper | similarity. |
| `STORE_PATH` | const | absolute store path. |

`search`/`upsert`/`backfill` are `async`. `recent`/`stats`/`isReady` are sync.

## Where to wire it in `main.js`

All calls below are **fire-and-forget** (`.catch(()=>{})`) — recall must never
block or fail a turn. Add `const semantic = require('./lib/semantic');` near the
other `require`s (currently `const wsMemory = require('./lib/memory');` at line 20).

### 1. Write durable facts → semantic store
In `saveMemoryEntry(section, content)` (main.js ~line 2647), **after** the Notion
mirror (the `notion.appendMemory(...)` line ~2663), add:

```js
try { semantic.upsert({ text: content, kind: 'semantic', meta: { section } }).catch(() => {}); } catch {}
```

So every fact saved to `memory.md` also lands in the vector store. Dedup is
automatic, so re-saves just refresh the ts.

### 2. Reconcile from Notion → semantic store (optional but recommended)
In `syncMemoryFromNotion()` (main.js ~line 2670), when iterating `missing` facts,
also `semantic.upsert({ text: m.fact, kind: 'semantic', meta: { section: 'Notes', source: 'notion' } })`.
Keeps the vector store in sync with facts the cloud wrote while the Mac slept.

### 3. Merge semantic recall into the memory block
In `buildMemoryBlock(query)` (main.js ~line 736), it already assembles tiers
(long-term lexical, Notion shared, episodic, working). Add a semantic tier.
Because `buildMemoryBlock` is currently **sync**, the clean options are:

- **Preferred:** pre-warm a cached result, like `_notionRecall`. Add a
  `refreshSemanticRecall(query)` modeled on `refreshNotionRecall` (~line 721)
  that does `const hits = await semantic.search(query, { k: loadConfig().semanticK || 5 });`
  and stores `{key, text}` in a module-scoped `_semanticRecall`. Call it from the
  same place `refreshNotionRecall` is invoked, then in `buildMemoryBlock` append:

```js
const semBank = (_semanticRecall.text && _semanticRecall.key === notionRecallKey(query)) ? _semanticRecall.text : '';
if (semBank) out += '\n\n## SEMANTIC RECALL (embedding match)\n\n' + semBank;
```
  Format hits as `hits.map(h => '- ' + h.text + ' (' + h.score.toFixed(2) + ')').join('\n')`.

- Gate behind `loadConfig().semanticRecall !== false` so it can be toggled,
  mirroring `memoryRetrieval` / `episodicRecall`.

### 4. Log each turn → episodic store
Where a turn completes (after the assistant reply is produced in the agent loop),
add fire-and-forget:

```js
try { semantic.upsert({ text: `User: ${userText}\nAssistant: ${assistantText.slice(0,800)}`, kind: 'episodic', meta: { surface: 'desktop' } }).catch(() => {}); } catch {}
```

This builds the episodic timeline ("what happened, when"). The 5000-cap evicts
oldest episodic first, so durable semantic facts are preserved under pressure.

## Where to wire it in `cloud/`

Same module works server-side via `OPENAI_API_KEY`. (Self-contained; copy/require
`lib/semantic.js` or point at it — your call. It writes to `~/.bhatbot/semantic`
on whatever host runs it; for cloud set `HOME`/run under a writable home, or fork
the path if you containerize.) Wire points:
- On fact write (cloud's equivalent of `saveMemoryEntry`): `semantic.upsert({text, kind:'semantic', meta})`.
- On recall/context build: merge `await semantic.search(query)` into the prompt.
- On each agent turn: `semantic.upsert({..., kind:'episodic'})`.

## Optional config knobs (read via `loadConfig()`, all default-on/safe)
- `semanticRecall` (bool, default true) — gate tier 5 in `buildMemoryBlock`.
- `semanticK` (int, default 5) — top-k for recall merge.

## Maintenance / tooling
- Backfill from `memory.md`: `node scripts/semantic/backfill.js`
- Manual query: `node scripts/semantic/query.js "your query" [--kind=semantic|episodic] [--k=8] [--min=0.15]`
- Inspect: `semantic.stats()` or read `~/.bhatbot/semantic/store.json`.

## Verified
- `node -c` passes on all three files.
- `backfill.js` parsed 62 lines from `memory.md` → 58 semantic records (4 deduped).
- `query.js "how do I pronounce his name"` returned the pronunciation facts
  ranked top (cosine ~0.46). End-to-end confirmed with the real `openaiKey`.
