# Soak log

One row per `scripts/soak-supervisor.js` run. Every `verified` count is checked by the harness
itself, never by asking the agent — "the agent said done" is the one signal an endurance test
must not trust. Full records in `~/.bhatbot/bench/`.

| when | commit | min | width | verified | false-done | tok/item | $ | rss | fwd/2nd half | stopped | pass |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-29 22:57 | `ea07b4c` | 6.3 | 3 | 39 | 0 | 4352 | 0 | 56→56MB | 4.41Wh | 38/1 | blocked | ✅ |
