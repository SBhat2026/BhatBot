# Unguarded network calls in lib/

Found by the fan-out experiment (2026-09-21) and confirmed mechanically by
`scripts/exp/groundtruth.js`, which is the check to re-run after fixing any of these.

Each of these makes an outbound request with no timeout, no `AbortSignal` and no
`AbortController` anywhere in the file. A dead or slow host hangs the caller forever.
The morning brief that failed 683 times in 16 days failed this way.

| module | why it matters |
|---|---|
| `lib/bioart.js` | Search + asset fetch. Already proved it can rot: the site rotated its action id under us. |
| `lib/eval.js` | Calls Anthropic directly. An API stall blocks an eval run with no upper bound. |
| `lib/imagesearch.js` | Two injected-fetch call sites (Openverse, Wikimedia). The one the regex originally missed — see the experiment report. |
| `lib/inspect.js` | Used from the agent loop, so a hang is a hang of the turn the user is waiting on. |
| `lib/integrations/trellis.js` | Third-party 3D service — exactly the kind of host that goes slow rather than down. |
| `lib/maps.js` | Geocoding on the user-facing path. |
| `lib/memory.js` | **Fix first.** On the embedding path the headless worker runs unattended — a hung Ollama stalls the whole nightly pass with nobody watching. |
| `lib/worldcup.js` | Two call sites, one of them a generic URL fetch. |

## The fix

`AbortSignal.timeout(ms)` on each call, with the ms from config where the caller has a
sensible budget and a conservative default where it does not. `lib/protfunc.js` is the
worked example — the same defect, fixed, after a 20s hang took the morning brief with it.

`groundtruth.js` counts a file as guarded once ANY of the guard tokens appear in it, so
re-running it after a fix is a real check only if every call site in that file was fixed.
