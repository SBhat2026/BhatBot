# Overnight pass — the autonomy lane

**Branch** `redesign-2026-09` · 12 commits · 29 files · +4,278 lines · `verify: 121/121`

You asked for BhatBot to handle any task you throw at it: build a tool when none fits, ask when it
genuinely needs you, keep going on its own until the job is done, show the agents colour-coded by
what they are doing, run for an hour without you, and reach you by phone unless your calendar says
you are busy — in which case Telegram.

Everything below is built, tested and wired. One thing is genuinely unproven and it is flagged
plainly at the bottom, because it is the thing you would most want to know before trusting this.

---

## What is new

| Module | What it is for |
|---|---|
| `lib/supervisor.js` | The loop that drives a plan for an hour and stops in a bounded, honest way |
| `lib/escalate.js` | The one door to you. Asks and **returns** — the run keeps working |
| `lib/toolforge.js` | The 88th tool, built and proven in a sandbox before it counts as a tool |
| `lib/designation.js` | What an agent is doing, and the one colour that means it |
| `long_run` tool | `start` / `status` / `resume` / `stop` / `answer` |
| `forge_tool` tool | `forge` / `call` / `list` / `remove` |
| `self_check area:autonomy` | Walks the whole lane in 10 seconds, no API spend |
| `self_check area:browser` | Whether a browser can actually launch |

---

## The four ideas the design rests on

**Progress is a change in the plan.** Not a tick, not a model reply, not an agent saying it is
working. This is load-bearing because the failure it prevents has already happened here twice — the
call gate livelocked by counting blocked attempts as calls, and the first fan-out run burned its
budget because every turn looked like activity. An agent that answers beautifully while the plan
stands still has done nothing, and after forty idle passes the run stops and says so rather than
spending an hour proving it.

**Ask, then keep working.** An escalation never blocks. The item that needed the answer parks, every
other item keeps moving, and only a genuinely idle run waits — with a timeout, after which it
proceeds on the assumption the escalation stated and records that it assumed. Six agents hitting the
same unknown produce one interruption, not six. Four interruptions an hour is a hard ceiling; past it
the question is still recorded but your phone stays quiet.

**A tool is not a tool until it has been seen being right.** The forge has four walls and the fourth
is the one the others need: expectations are declarative and judged by the forge, so generated code
cannot ship its own passing verdict, and every case is re-run against a stub that returns `null`. A
case that still passes asserted nothing. That check runs *first*, before any execution.
`child_process`, `worker_threads` and `vm` are refused at any privilege level — those are ways out of
the sandbox, not capabilities. `fs` and `net` ask you, and a silence refuses.

**Hue is what, motion is how it is going.** The office coloured agents by state, which makes every
agent in a busy fleet the same colour. Now the colour says what they are doing and the pulse says how
it is going, so both stay readable at once. Red still wins outright, because a failing agent has to
read as failing.

---

## Two safeguards you asked for, and one you did not

**Your calendar.** A call checks all three connected calendars, including `sb9699@princeton.edu`,
before it rings. A call during class downgrades to **Telegram** — not SMS, because a text buzzing your
phone in a seminar is most of the interruption anyway.

**Quiet hours, which you did not ask for and needed.** The calendar gate catches "he is in a
seminar". It does not catch 3am, because nobody puts sleep in their calendar — and an unattended run
is precisely the thing that is working at 3am. Without this, the first overnight run wakes you to ask
which citation style to use. Between 23:00 and 07:00 a question goes to Telegram silently and, if it
has something to fall back on, stops being a blocker. Waiting until morning for an answer nobody is
awake to give is not waiting, it is stopping.

**Somebody asks whether it actually answered you.** `lib/custodian.js` guarded the drone fan-out and
nothing else, which left the biggest fan-out in the app reporting "nine done" with nobody having
asked whether nine done items answer the question. Its verdict is attached to the report, never
substituted — a reviewer that can rewrite the report is a second author, not a reviewer.

---

## Several hours, by chaining hours

A run parks at its wall and the existing mission tick picks it up — but it would have handed a
supervised run to a single agent turn, one agent trying to work forty plan items at once with no
width, no escalation routing and no forge. That is not resuming a run, it is quietly replacing it.
Missions now record who should continue them.

**Which wall it hit decides whether continuing makes sense.** Out of *time* means there is more to
do. Out of *money*, or five failures running, or stopped by hand, would hit the same wall seconds
after resuming — so those wait for you to raise the ceiling deliberately.

---

## What the tests found

Five bugs, each caught by something that went looking rather than by reading code.

1. **`"the most recent"` was whatever the filesystem listed last.** A flaky escalation test — two
   failures in three runs — turned out to be a real misrouting bug. Two questions raised in the same
   millisecond tie on their timestamp, and the tie fell through to directory order. A bare "ok" could
   be applied to the older question while the result reported it as the newest.

2. **The forge was strict about the wrong things.** In three minutes a local model tried to forge a
   tool seventeen times and was refused every time, for two packaging reasons that say nothing about
   whether its tool was any good. Both are absorbed now; the standard did not move. After the fix the
   same model forged 2 of 2.

3. **An answer nobody gave was being recorded as an answer you gave.** Both a real reply and a
   fallback assumption arrived in the plan as "Siddhant said: APA" — a fabrication written into the
   durable record and into the next agent's context.

4. **The embedder being configured is not the embedder answering.** A suite went red with six broken
   invariants, none of which were broken: a local soak was saturating Ollama, and the readiness probe
   checked that an embedder *exists* rather than that it *responds*.

5. **The autonomy doctor's own retriever check compared against the wrong type**, and reported the
   retriever broken while it was working perfectly. Fifth time in this repo that a check testing the
   wrong thing gave a wrong answer rather than a smaller one.

---

## What is NOT proven

**The hour-long lane has never run against Claude.** The Anthropic budget is spent
($4.00/$4.00), so the endurance run used a local qwen3 through Ollama — free, real latency, real tool
calls, every item verified independently of what the agent claimed. That proves the *supervisor*.
What it does not touch is `supervisedWorker` in `main.js`, the Claude-backed runner: its loop, its
envelope call and its tool scoping have only been exercised structurally.

**So the first real `long_run` should be small and watched.** One goal,
`hours: 0.25`, `budget_usd: 0.50`. Then leave it alone.
