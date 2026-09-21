# Does agent fan-out beat one agent?

**Run** `2026-09-21T23-32-11` · pre-registered in commit `d004ba1`, before either arm ran.
**Mission** find every module under `lib/` that makes an outbound network call with no timeout,
no `AbortSignal` and no `AbortController` — a real defect class, spread across 120 modules, and
decidable from the source, which is what makes it scorable.

Both arms got the same tools (`read_file`, `list_directory` — no grep, no shell), the same
24 turns and the same $0.60.

| | recall | precision | true positives | cost | wall clock | TP per $ |
|---|---|---|---|---|---|---|
| **A — solo** (1 agent, 24 turns) | 0.375 | **1.000** | 3 / 8 | $0.6558 | 79.0s | 4.6 |
| **B — fan-out** (4 drones × 6 turns) | **0.625** | **1.000** | 5 / 8 | $0.8168 | **40.9s** | **6.1** |

Union of both arms: 6 of 8. Neither found `memory.js` or `worldcup.js`.

## Scored against the pre-registration

| | predicted | actual | verdict |
|---|---|---|---|
| **H1** fan-out recall beats solo | solo 2–4/8, fan-out 5–7/8 | solo 3, fan-out 5 | **confirmed**, both inside range |
| **H2** fan-out precision no better, probably worse | solo ≥0.75, fan-out 0.5–0.8 | both 1.000 | **refuted** |
| **H3a** fan-out costs 2–4× | 2–4× | **1.25×** | **refuted** |
| **H3b** fan-out is faster | 0.35–0.8× wall clock | 0.52× | **confirmed** |
| **H4** the office tells the truth | feed lag < 1.5s | max 10.0s | **instrument wrong** — see below |
| **H5** drones talk but don't listen | ≥2 posts each, 0 citations | 6–8 posts each, **0** citations | **confirmed** |

## What the experiment actually taught

**H2 was wrong in an interesting direction.** The prediction was that a shard-local drone, under
pressure to produce names from a quarter of the codebase, would guess. Neither arm guessed once:
precision was perfect on both sides. The reason is visible in the traces — every named file was one
the agent had opened, and the brief made a wrong name cost as much as a missing one. Fan-out did not
degrade judgement; it only multiplied how much got looked at.

**H3a was wrong because fan-out is cheaper than it looks.** The predicted 2–4× assumed four system
prompts and four transcripts are simply four times the bill. They are not: each drone's transcript is
a quarter as long, and context cost is superlinear in transcript length. Four short conversations
cost 1.25× one long one — and returned 67% more findings, so fan-out won on cost per finding too
(6.1 vs 4.6 per dollar). This is the result that changes how the fleet should be used.

**H5 was right, and that is a criticism of the design, not a success.** Every drone posted
diligently — 27 board entries across four agents — and not one report referenced a sibling. The
blackboard is in every system prompt, the instruction to post findings is obeyed, and none of it
does anything, because a partitioned audit gives no drone a reason to care what another found.
Coordination machinery does not create a reason to coordinate. Until there is a mission where one
drone's finding changes what another should do, the board is overhead.

**H4's metric was badly chosen and the hypothesis is unscored.** "Feed lag" measured how long since
the feed was last *written*, not how long the room had been *wrong*. A model call takes 5–10s during
which nothing happens: the agent really is thinking, the office really is showing `thinking`, and
the number still climbed to 10s and accused the room of lying. A 1s heartbeat now re-stamps the
payload so the indicator means what it claims. The underlying question — does the room diverge from
the trace — is also partly circular here, since the roster is derived from the same trace that scores
the run; answering it properly needs a second, independent source of agent state.

## The answer key was wrong, and the agents caught it

Both arms named `imagesearch.js`. The key scored it a fabrication — it matched the literal token
`fetch(`, and `imagesearch.js` takes its fetch as a parameter and calls `fetchFn(u, …)`. Two real
unguarded HTTPS calls to Openverse and Wikimedia Commons, invisible to the regex, found by both arms
because both had actually read the file. The key was corrected (8 hits, not 7) and both arms
re-scored, which is how precision went from 0.667/0.8 to 1.000/1.000.

An answer key is a measuring instrument. It gets checked against reality like any other.

## Run 1 was void

The first attempt (`2026-09-21T23-29-08`) produced no answer from any agent in either arm. Two
causes, both in the runner rather than in either topology: a tool loop re-sends its whole transcript,
so cost grew with the square of the turn count and every agent hit its dollar cap mid-audit; and
running out of budget *during* a tool call ended the drone where it stood, so four agents that had
done the work reported none of it. Fixed by pruning old tool results and forcing one tool-free
wrap-up turn. Predictions were not touched. Both fixes belong in `lib/drone.js` proper.

## Spend

$2.33 of the $4.00 authorised — $0.06 on the turn-loop test, $0.80 on the void run, $1.47 on this
one. The pre-registered cap for the experiment was $1.40 and run 2 alone came to $1.47; the overrun
is the wrap-up turns, which were added after the cap was set.

## Defects this produced, for free

Eight modules in `lib/` can hang forever on a network call: `bioart.js`, `eval.js`,
`imagesearch.js`, `inspect.js`, `integrations/trellis.js`, `maps.js`, `memory.js`, `worldcup.js`.
`memory.js` is the one to fix first — it is on the embedding path that the headless worker runs
unattended.
