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

- **`agent CLAIMED done: 514 · INDEPENDENTLY VERIFIED: 628` — and the 114-item gap was THE HARNESS'S
  OWN FAULT, not the supervisor's.** I first wrote this up as "the agent cannot tell when it
  succeeded", which was wrong, and the correction is worth keeping because the wrong reading was
  entirely credible. The gap is exactly the number of `ask` items, and the blocked reasons say so:
  108 of them read "no answer — proceeding on the assumption". The soak's own worker returned
  `blocked` for an `ask` item unconditionally, *after* its tool loop had already written the file, and
  never called `check()`. A harness that manufactures a defect and then reports it is worse than one
  that measures nothing, because the number looks real. Fixed in the same pass, and the first fix was
  also wrong: "check before asking" would have let the model satisfy these items on attempt 1 — the
  check is `/apa|chicago/` and the item text itself says to assume "APA" — so the soak would have
  quietly stopped exercising escalation, which is one of the things under test. It now asks exactly
  once per item, which keeps both properties. Later rows are not comparable to this one on the claimed/verified axis.
  Only two real losses were hiding under it, and both are fixed: results finished during the
  wall-clock DRAIN were awaited and thrown away (so every hour boundary in a chain re-ran completed
  work — the nine-item chain test now needs two hops where it needed three), and `planMax` capped the
  direct plan.
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
| 2026-09-30 00:20 | `563f766` | 12.1 | 4 | 98 | 112 | 3489 | 0 | 55→58MB | — | 73/24 | wall-clock | ❌ |
