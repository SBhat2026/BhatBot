# Unguarded network calls in lib/ — FIXED 2026-09-21

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

## Status: all eight closed

Every module below now passes a deadline to its fetch. `node scripts/exp/groundtruth.js` reports
**0 unguarded of 17 networked**. Timeouts are per-path rather than one global number, because the
right ceiling for a local embedding (12s — a model that has not answered in twelve seconds is
loading or wedged, not thinking) is not the right ceiling for a 12B vision generation (90s) or for
downloading a finished mesh (180s).

| module | deadline |
|---|---|
| `lib/memory.js` | 12s embeddings |
| `lib/maps.js` | 15s |
| `lib/imagesearch.js` | 15s per engine |
| `lib/worldcup.js` | 20s |
| `lib/bioart.js` | 20s search / 60s asset bytes |
| `lib/integrations/trellis.js` | 30s per poll / 180s download |
| `lib/eval.js` | 60s |
| `lib/inspect.js` | 90s vision |

`lib/eval.js` was the worst shape of the defect and worth calling out: an unbounded fetch inside a
RETRY loop. Without a deadline the loop could not reach its own retry, so its `retries` parameter
had no effect at all on the failure it existed to handle.

The checker was hardened at the same time. It is a grep, and a grep will happily count a file as
guarded because the word `AbortSignal` appears in a comment that a bad edit dropped inside a
template literal — which is exactly what happened here, in two of these eight files, while they
were being fixed. It now parses each file with `vm.Script` first and counts anything that does not
compile as unguarded.

## The fix (for reference)

`AbortSignal.timeout(ms)` on each call, with the ms from config where the caller has a
sensible budget and a conservative default where it does not. `lib/protfunc.js` is the
worked example — the same defect, fixed, after a 20s hang took the morning brief with it.

`groundtruth.js` counts a file as guarded once ANY of the guard tokens appear in it, so
re-running it after a fix is a real check only if every call site in that file was fixed.
