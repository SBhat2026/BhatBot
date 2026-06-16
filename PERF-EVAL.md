# BhatBot Performance / Capability Eval

`node scripts/perf-eval.js` — measures the parent-planner → subagent pipeline. Writes an
OTel-shaped JSONL trace + a summary JSON to `~/.bhatbot/eval/`.

## What I changed vs the proposed DeepEval + LangSmith/Phoenix stack — and why

The requested architecture (DeepEval judge + LangSmith/Phoenix tracing) is sound in spirit, but
those are **Python** libraries + **hosted SaaS** (accounts, API keys, network). BhatBot is
Node/Electron, so wiring them would mean (a) duplicating the routing/agent logic in a parallel
Python harness, and (b) a hard dependency on external services to run a self-test. I kept the
**exact same measurements** but implemented them in-process:

| Proposed | Used instead | Why it's equivalent / better |
|---|---|---|
| DeepEval (G-Eval) | `lib/eval.js` — Claude-as-judge with the same rubric | G-Eval *is* an LLM grading a rubric; we run that rubric with the key already in config. No Python, runs anywhere. |
| LangSmith / Phoenix tracing | local **OTel-shaped JSONL spans** in `~/.bhatbot/eval/` | No account/network; importable into Phoenix later via OTLP if wanted. |
| Parallel test reimplementation | tests the **real** `lib/router`, `lib/agents/orchestrator`, `lib/agents/protocol` | Measures the shipping code paths, not a copy that can drift. |

The judge suite also includes **adversarial cases** (a hallucinated "all done!" over a failed
trace; a raw-log-dump update) so each run *also verifies the judge itself discriminates* good
updates from bad — otherwise a judge that rubber-stamps everything would look perfect.

## Metrics

**Deterministic (offline, real code):**
- **Routing success** — `orchestrator.inferAgent(prompt)` vs the expected subagent (coding /
  research / browser / memory / creative); class via `router.classOf`.
- **Argument integrity** — `protocol.buildTask` + `validateTask`: required fields present, the
  routed agent has a real toolset (`ROLE_TOOLS`), and explicit params (e.g. `0.2mm`, `20%`)
  survive into the subagent's goal.
- **Error healing** — `router.shouldEscalate` retries to the limit then stops (no infinite loop);
  a transient failure heals (fail→fail→succeed under a retry wrapper); a permanent failure
  degrades gracefully (returns an error, never throws/crashes).

**LLM-judged (Claude G-Eval), per chat update vs ground-truth trace:**
- **Information alignment** (0–1) — does the update match what actually happened?
- **Conciseness vs noise** (0–1) — clean summary vs raw-log spam.
- **Hallucination rate** (0–1, lower better) — invented status not in the trace.

## Latest run

- Routing **100% (9/9)**, Argument integrity **100% (3/3)**, Error healing **100% (3/3)** →
  overall pipeline **100%**.
- Judge on honest updates: alignment **0.95**, conciseness **0.93**, hallucination **0**; judge
  correctly flags the hallucinated update (alignment 0, hallucination 1) and the noisy one
  (conciseness 0.1).

### Finding fixed this run
The eval surfaced two routing gaps: `inferAgent` sent "render a model" to **browser** (bare
"render" rule) and "make an STL…" to the **research** default. Fixed by checking 3D/model
artifact keywords (mesh/3d/stl/obj/glb/cad/print + "render a model") **before** the browser
rule — both now route to **creative**. Added as regression cases.

## Limits / next fidelity step
Suites A–C test the routing/protocol/healing **logic** in isolation; the judge suite grades
**representative** (trace, update) pairs. A full end-to-end run (live `agentLoop` driving real
tools, judging the *actually generated* updates against captured traces) requires the Electron
runtime + live API and is the next step — the harness and judge are already built for it.
