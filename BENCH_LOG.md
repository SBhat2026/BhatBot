# Soak log

One row per `scripts/soak-supervisor.js` run. Every `verified` count is checked by the harness
itself, never by asking the agent — "the agent said done" is the one signal an endurance test
must not trust. Full records in `~/.bhatbot/bench/`.

| when | commit | min | width | verified | false-done | tok/item | $ | rss | fwd/2nd half | stopped | pass |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-27 14:32 | `45bf7b0` | 58.1 | 3 | 256 | 0 | 9245 | 0 | 56→63MB | 213/42 | failures | ❌ |
