# Soak log

One row per `scripts/soak-supervisor.js` run. Every `verified` count is checked by the harness
itself, never by asking the agent — "the agent said done" is the one signal an endurance test
must not trust. Full records in `~/.bhatbot/bench/`.

## The baseline, 2026-09-30 00:04 — `4e6d52d`

The row below is the "before" every later claim is measured against, and the honest reading of it is
**flat, not fast**: 325 items verified in the first 31 minutes and 302 in the second. An hour-long run
that ends because the clock ran out rather than because a wall tripped, with no degradation curve, is
the thing this harness exists to demonstrate. 2,628 model calls, **zero errors**. RSS 56→78MB.

Three numbers worth keeping separately in mind:

- **`agent CLAIMED done: 514 · INDEPENDENTLY VERIFIED: 628`.** The agent UNDER-claims by 114 items: it
  did the work, the artifact is on disk and the harness found it, and the agent still reported partial
  or blocked. With `false "done": 0` this is failing in the safe direction, but a run that cannot tell
  when it succeeded will re-attempt work it has already finished and burn an hour proving it. This is
  the most interesting defect in the baseline and it is not a wall, a leak or a cost problem.
- **Forge: 64 successes in 226 attempts (28%).** Every refusal in the tail is the same thing — qwen3
  writing a roman-numeral converter that fails its own test cases, off by one subtractive pair. That is
  a small-model arithmetic limit, correctly caught by the sandbox before the tool counted, and
  correctly escalated. It is a property of the harness's synthetic items, not of production.
- **1,817 native `tool_calls`, 0 content-scrapes.** This is the capability confirmation the local lane
  rests on, measured on the real path rather than inferred from a 3-shot probe.

Measurement note: an earlier attempt at this baseline is not in the table because `planMax` capped 800
items to 40 and it exhausted its plan in 6.3 minutes reporting `blocked` — which reads exactly like a
stamina failure and is nothing of the kind. A second attempt had `npm run verify` running across
minutes 11–14; throughput fell from ~15/min to ~1/min and recovered the moment it finished. **Nothing
CPU- or Ollama-heavy may run beside a soak.** The row below had the machine to itself.

| when | commit | min | width | verified | false-done | tok/item | $ | rss | energy | fwd/2nd half | stopped | pass |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-29 22:57 | `ea07b4c` | 6.3 | 3 | 39 | 0 | 4352 | 0 | 56→56MB | 4.41Wh | 38/1 | blocked | ✅ |
| 2026-09-30 00:04 | `4e6d52d` | 62 | 3 | 628 | 0 | 5497 | 0 | 56→78MB | 23.49Wh | 325/302 | wall-clock | ✅ |
