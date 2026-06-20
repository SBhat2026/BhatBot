# Ambient Awareness Layer — Integration Notes (task #18)

Narrow, **opt-in, privacy-first** proactive monitor. New, self-contained module:
`lib/ambient.js` (+ helper `scripts/ambient/scan.js`). **NOTHING is wired into
`main.js`** — this doc tells you (the human) exactly where and how to call it.
No existing file was modified.

- **Dependencies:** none (Node built-ins + `osascript` via `child_process`).
- **OFF by default.** If `config.ambient.enabled !== true`, every exported fn is a
  no-op returning `{skipped:true}` — no osascript runs, no permission prompts.
- **Never throws.** Each watcher is independently guarded and degrades to `{error}`.
- **Privacy:** emits titles / subjects / sender names / counts / times ONLY. Never
  email bodies, links, or codes. `redact()` enforces this on every signal text.
- **Store:** dedup seen-store at `~/.bhatbot/ambient/seen.json` (auto-created,
  36h TTL, capped 500). `markSurfaced()` is the only writer.

## Config schema (`~/.bhatbot/config.json`, key `ambient`)

```json
{
  "ambient": {
    "enabled": false,
    "intervalMin": 30,
    "quietHours": [22, 7],
    "lookaheadMin": 120,
    "mailLookbackHours": 12,
    "sources": { "calendar": true, "mail": false }
  }
}
```

- `enabled` — master switch. **Default false.** Nothing runs unless this is `true`.
- `intervalMin` — how often `startAmbient()` should call `scan()` (you own the timer).
- `quietHours` `[startHour, endHour)` — wraps midnight when start > end (e.g. `[22,7]`
  = quiet 22:00–07:00). During quiet hours `scan()` still collects + dedups but
  surfaces nothing; suppressed items appear on the first non-quiet tick.
- `lookaheadMin` — calendar window to look ahead for upcoming events + conflicts.
- `mailLookbackHours` — mail window to look back for unread "needs reply" messages.
- `sources` — per-watcher enable flags. A watcher only runs if its flag is `true`
  **and** `enabled` is `true`. Defaults: calendar on, mail off.

## Exported API (`const ambient = require('./lib/ambient')`)

| Function | Signature | Returns |
|---|---|---|
| `isEnabled()` | `() → boolean` (sync) | `config.ambient.enabled === true` |
| `scan()` | `() → Promise` | `{signals:[{source,kind,text,urgency,_key}], ts, quiet?, errors?}` — only NEW, non-quiet-hours, deduped signals. `{skipped:true}` if disabled. |
| `digest(signals)` | `(signals[] \| scanResult) → string` | short plain-text briefing (urgency-sorted) to speak/notify; `''` if empty. |
| `markSurfaced(signals)` | `(signals[] \| scanResult) → {marked}` | records keys in `seen.json` so they aren't surfaced again within TTL. |
| `sources()` | `() → {enabled,intervalMin,quietHours,available,active}` (sync) | available + active watcher list. |

`scan` is `async`. `isEnabled`/`digest`/`markSurfaced`/`sources` are sync.
Signal `urgency` ∈ `'low' | 'med' | 'high'`. `kind` ∈ `event.upcoming`,
`event.conflict`, `mail.needs_reply`, `mail.item`.

## Where to wire it in `main.js`

### 1. Require it (near the other requires, e.g. by `const wsMemory = require('./lib/memory')`)

```js
const ambient = require('./lib/ambient');
```

### 2. Start a periodic timer in `app.whenReady().then(...)` (~line 6053)

Right after `startScheduler();` (~line 6071), add a call to a small `startAmbient()`
helper (define it near `startScheduler` / `scheduleBriefing` ~line 4759). Gate it on
the config flag so it's truly off by default:

```js
// in app.whenReady().then(...)
startAmbient();   // proactive ambient awareness (opt-in; no-op unless config.ambient.enabled)
```

```js
// new helper alongside startScheduler() (~line 4759)
let _ambientTimer = null;
function startAmbient() {
  try {
    if (!ambient.isEnabled()) return;                 // OFF by default → never schedules
    const cfg = ambient.loadConfig();
    const everyMs = Math.max(5, Number(cfg.intervalMin) || 30) * 60 * 1000;
    if (_ambientTimer) clearInterval(_ambientTimer);
    const tick = async () => {
      try {
        const res = await ambient.scan();
        if (res.skipped || !res.signals || !res.signals.length) return;
        const brief = ambient.digest(res.signals);
        // Surface via the EXISTING out-of-band path (do NOT edit these — just call them):
        telegramNotify('🛰 ' + brief);                 // → Telegram (function at ~line 4447)
        try { sendToActivity('tool-update', { type: 'thinking', text: '🛰 ambient: ' + brief.replace(/\n/g, ' ') }); } catch {}
        // (Optional) speak it: try { speakDesktop(brief, { full: true }); } catch {}
        ambient.markSurfaced(res.signals);             // dedup so it isn't re-surfaced
      } catch (e) { console.error('[ambient] tick failed:', e.message); }
    };
    _ambientTimer = setInterval(tick, everyMs);
    setTimeout(tick, 15000);   // first pass shortly after launch (after perms settle)
  } catch (e) { console.error('[ambient] start failed:', e.message); }
}
```

Notes on surfacing:
- `telegramNotify(text)` (main.js ~4447) and `sendToActivity(channel, data)`
  (~3595) already exist — call them, don't modify them.
- For higher-urgency items you could route through the `notify_user` tool path
  (tool def ~line 1888, handler `case 'notify_user'` ~line 3361) which picks
  channel by urgency/time-of-day. Simplest: map `signals.some(s=>s.urgency==='high')`
  to a `notify_user`-style call; otherwise Telegram is enough.

### 3. (Optional) Expose an `ambient` agent tool

Add a tool the agent can call to inspect/toggle ambient awareness. Tool def goes in
the tools array (near `notify_user` ~line 1888); handler goes in the tool switch
(near `case 'notify_user'` ~line 3361):

```js
// tool definition
{
  name: 'ambient',
  description: 'Inspect or control the ambient awareness layer (proactive Calendar/Mail monitoring). action: scan|status|enable|disable.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['scan', 'status', 'enable', 'disable'] },
      source: { type: 'string', description: 'optional watcher name to toggle: calendar|mail' },
    },
    required: ['action'],
  },
}
```

```js
// handler (in the tool switch)
case 'ambient': {
  const a = input.action;
  if (a === 'status') return ambient.sources();
  if (a === 'scan')   { const r = await ambient.scan(); return { ...r, digest: ambient.digest(r.signals || []) }; }
  if (a === 'enable' || a === 'disable') {
    const cur = loadConfig().ambient || {};
    const next = { ...cur, enabled: a === 'enable' };
    if (input.source) next.sources = { ...(cur.sources || {}), [input.source]: a === 'enable' };
    saveConfig({ ambient: next });   // saveConfig at main.js ~243
    if (a === 'enable') startAmbient(); else if (_ambientTimer) { clearInterval(_ambientTimer); _ambientTimer = null; }
    return { ok: true, ambient: next };
  }
  return { error: 'unknown action' };
}
```

## macOS Automation permissions

The watchers drive the Calendar and Mail apps via Apple events. The first real run
(only once `enabled:true` and the source flag is on) triggers the macOS Automation
prompt. Grant under: **System Settings → Privacy & Security → Automation → BhatBot →
enable Calendar / Mail.** Until granted, the affected watcher returns an `{error}`
(with a hint string) and the others keep working. BhatBot already surfaces these
prompts via `primeAppAutomation` (~line 6064) for Calendar; Mail may need a one-time
manual grant.

## Verified
- `node -c lib/ambient.js` and `node -c scripts/ambient/scan.js` pass.
- With `ambient.enabled` absent/false (current default), `ambient.scan()` returns
  `{skipped:true}` and makes ZERO osascript calls → no Calendar/Mail prompts.
- `node scripts/ambient/scan.js` → `ambient disabled … {skipped:true}`.
- `node scripts/ambient/scan.js --status` → lists watchers, `enabled:false`,
  `active:[]`.
