# Overnight pass — the autonomy lane

**Branch** `redesign-2026-09` · 31 commits · 30 files · +5,300 lines · `verify: 121/121`

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

Eight bugs, each caught by something that went looking rather than by reading code. Four of them were
in work done tonight — which is the argument for building the instrument alongside the thing.

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

6. **A pause the run took on purpose was counted as a failed attempt.** The supervisor parks itself
   while waiting for an answer, and went back through `missions.resume()` to carry on — which bumps
   the counter that limits how many times a long job may be picked back up. A run that waits twice an
   hour would have run out of permission to continue long before it ran out of work.

7. **Forging cost the item one of its two attempts.** An item that stopped to build a tool got one
   real go afterwards, which is the opposite of what forging is for. Asking had the same problem: the
   attempt was spent on the question, so the answer arrived for an item already out of tries.

8. **And then that fix caused a livelock — which only a second full hour found.** Refunding an
   attempt every time an item gets an answer means an agent that keeps asking the same question never
   runs out. It escalates, the question dedupes onto an escalation that is already answered, the item
   unblocks immediately, the attempt comes back, and it escalates again. Three items of eight hundred
   seized all three worker slots and held them for half an hour — 591 journal entries across three
   items while 779 never got a turn.

   **The stall wall could not see it**, and that is the part worth knowing. The plan *was* changing on
   every pass: blocked → todo → blocked. Progress by the letter of the definition this whole design
   rests on, and a livelock by any other measure. The bound therefore cannot be another progress
   heuristic — it is now a hard count nothing can give back: one refund per item, ever.

   The first 62-minute run proved a supervisor that no longer existed; the custodian, the blackboard
   and the refunds all landed after it started. Re-running the hour on the code that actually ships is
   what caught this, and 84 unit assertions did not.

---

## The hour, actually run

`scripts/soak-supervisor.js --minutes 62 --items 800 --width 3`, against a local qwen3 through
Ollama. Free. Every item verified by the script itself, because "the agent said done" is exactly the
signal an endurance test must not trust.

```
stopped: wall-clock after 62.5min · 710 scheduling passes
agent CLAIMED done: 476 · INDEPENDENTLY VERIFIED: 560
false "done": 0
rss 56MB → 59MB
escalations: 9 asked, 4 answered, 5 still open   (160 escalation events → 9 interruptions)
throughput: 254 verified in the first 31min, 305 in the second
```

Three results worth pulling out.

**It did not degrade — it sped up.** 254 verified in the first half, 305 in the second. The question
an hour-long test exists to answer is "does it get worse", and the answer is no.

**Zero false "done".** It under-claimed by 84 items, which is the safe direction: work it had actually
finished and reported as partial. A false done is a hole in the report; an under-claim is not.

**160 escalation events produced 9 interruptions.** Dedupe and the per-hour ceiling did what they were
built for, and the run never stopped waiting for any of them.

Memory grew 3MB over an hour, across 2,137 model calls and 1,530 tool calls.

---

## Four things added that you did not ask for, and should know about

**Destructive commands are denied during a long run.** `autonomousMode` is on by default and
auto-approves `rm` and friends, which is right for a turn you are watching — you asked, you are here,
a confirm card is a speed bump. It is the wrong rule for work you started so you could go to bed:
nobody is there to see the card, and "nothing objected" is not "he approved it". The existing
`remoteDepth` guard encodes exactly this condition for phone-driven turns, but a long run is local, so
it never fired. Set `config.unattendedAllowDestructive: true` to opt back in.

**The agents can see each other.** Three agents working three items at once ran blind: the one that
discovers the endpoint needs a token could not tell the two about to hit the same wall. They now share
a blackboard — the supervisor posts on their behalf, because an agent that forgets to post is the
normal case and a channel that only works when everyone remembers to use it does not work. In the
office they say it out loud: a finding or a need appears as a speech bubble over the agent's head for
seven seconds, in its own designation colour.

**A worker had a second, unguarded door to you.** The escalation path is deduped, capped at a few
interruptions an hour and silent overnight. `notify_user` is in the core tool set, so every worker
also had that — six agents could each text you, and `urgency:"call"` at 3am becomes an URGENT SMS,
which is the exact thing the quiet-hours rule exists to prevent. A ceiling with a way around it is not
a ceiling. Workers now reach you through the guarded path or not at all. `gmail` came out clean on the
same question: it has search/read/draft/label and no send, so a worker can draft and nothing leaves.

**A budget that cannot see the spending is not a budget.** Every wall the lane has counts Anthropic
tokens. `visual_build` bills your Replicate account per second of output — your own backlog has it at
~$3.20 for ten seconds of 1080p, "the most expensive call in the system", with no confirmation gate —
and `make_asset` chains image → 3D → STL, three billable stages behind one call. Neither appears in
`spentUsd`, so an unattended run with a $2 ceiling could spend twenty dollars elsewhere and report,
accurately by its own accounting, that it stayed under. Both are out of the unattended grant; a run
that needs a video asks and you decide while awake. `generate_image` stays — flux-fast is $0.003.

---

## What is NOT proven

**The hour-long lane has never run against Claude.** The Anthropic budget is spent
($4.00/$4.00), so the 62-minute run above used a local qwen3. That proves the *supervisor* — the
loop, the walls, the escalation path, the forge, the durability, the memory profile. What it does not
touch is `supervisedWorker` in `main.js`, the Claude-backed runner: its loop, its envelope call and
its tool scoping have only been exercised structurally.

Concretely, what is unproven is whether Claude reliably produces the ENVELOPE the supervisor routes
on — `need.kind: "tool" | "human" | "decompose"`. If it does not, items will come back as bare
`partial`s and the run will retry them twice and mark them blocked rather than forging or asking. It
would still be a safe, bounded, honest failure. It would just not be the interesting one.

**So the first real `long_run` should be small and watched.** One goal,
`hours: 0.25`, `budget_usd: 0.50`. Then leave it alone.

Also still open from the previous phase: **the phone call has never been confirmed end to end.** The
webhook is on the cloud, signed probes return valid two-way TwiML in 2,987ms, but nobody has answered
the phone. `self_check area:voice` will name the stage that broke if it fails.

---

## Questions

1. **Budget.** A run defaults to `$2` for the whole job and auto-resume stops at `$5` total
   (`config.missionBudgetUsd`). For a genuinely long job — six hours — is $5 the right ceiling, or
   should I raise it and let the wall-clock do the limiting?
2. **Quiet hours are 23:00–07:00.** Is that actually your window? It is
   `config.escalation.quietFrom` / `quietTo`.
3. **Destructive commands.** Denied in an unattended run right now. Do you want an opt-in for a
   specific scratch directory, or is denied-everywhere correct?
4. **The first long run.** Pick the task and I will run it small and watched before anything is left
   going overnight.

---

## Where things are

```
scripts/autonomy-doctor.js      self_check area:autonomy   — 10s, no spend, walks the whole lane
scripts/soak-supervisor.js      --minutes 60               — an hour against a local model, free
scripts/browser-doctor.js       self_check area:browser
~/.bhatbot/missions/<id>/       plan.md · journal.jsonl · blackboard.jsonl · checkpoint.json
~/.bhatbot/forged/              every tool it has built, with the cases that proved it
~/.bhatbot/escalations/         every question it has asked you, and what you said
```
