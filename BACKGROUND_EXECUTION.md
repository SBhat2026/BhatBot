# Running BhatBot's background work almost full time

_Researched against this machine on 2026-09-20. Every value below was read off the box
(`pmset -g custom`, `launchctl print`, `pmset -g assertions`), not taken from documentation._

The goal: the Mac lives plugged in and awake, so the second brain, the scheduler and the standing
loops run continuously rather than whenever a window happens to be open.

**The short version: you are already 80% of the way there, and the remaining 20% is three settings
and one architectural decision you should NOT make.**

---

## 1. What is already correct

### Power (AC)

```
sleep                0      ← the system never idle-sleeps on AC. This is the important one.
displaysleep        60      ← the screen goes dark after an hour; the machine does not sleep
disksleep           10
powernap             1
standby              1
tcpkeepalive         1
womp                 1      ← wake on network
```

`sleep 0` on AC means **the worker already runs indefinitely while plugged in**. A dark screen is
not a sleeping computer, and this is the single most common confusion in this area — the display
sleeping has nothing to do with whether background work runs.

### The LaunchAgent

`~/Library/LaunchAgents/com.bhatbot.synapse.plist` is well built already:

| Key | Value | Why it's right |
|---|---|---|
| `RunAtLoad` | true | starts at login |
| `KeepAlive` | `{SuccessfulExit: false}` | restarts on crash, *not* when you quit deliberately |
| `ThrottleInterval` | 60 | a crash loop waits a minute instead of spinning |
| `ProcessType` | Background | tells the scheduler this is not user-initiated work |
| `LowPriorityIO` | true | its disk I/O yields to yours |
| `Nice` | 5 | so does its CPU |
| explicit `PATH` | homebrew first | this is what `com.siddhant.bhatbot` died of — exit 127, `npm` not found under launchd's minimal PATH |

Live state right now: `state = running`, `runs = 3`, `last exit code = 0`.

---

## 2. The one architectural decision — and the answer is "don't"

The obvious move for "full time" is a **LaunchDaemon** in `/Library/LaunchDaemons`, which runs as
root from boot, with no login required. **Do not do this.** It would break the worker.

A LaunchDaemon runs outside your GUI login session, and the worker's credentials come from
`lib/llm.js` → the **login Keychain** via the `security` CLI. The login Keychain is unlocked by your
login and is reachable from your session; a root daemon gets nothing. The vault is worse — the
`CRED_REF_*` handles in `config.json` can only be decrypted by Electron's `safeStorage`, which is
keyed to your account.

So the ladder is:

| | Runs when | Can reach Keychain | Verdict |
|---|---|---|---|
| LaunchAgent (current) | you are logged in | **yes** | correct |
| LaunchDaemon | from boot, no login | no | breaks the paid pass and every credentialed loop |
| Login item / app | app is open | yes | this is what the old "daemon" actually was — it launched the GUI |

**A LaunchAgent covers everything except "logged out" and "rebooted and not logged back in."** For a
machine that stays on your desk logged in, that gap is close to zero, and closing it costs you the
credentials. Keep the agent.

---

## 3. The three settings worth changing

### 3.1 Battery sleep is set to one minute

```
Battery Power:
 sleep                1      ← one minute
 displaysleep         2
```

Unplug the machine and every background loop stops sixty seconds later. If you ever work unplugged
and expect the brain to keep weaving, it will not.

```bash
sudo pmset -b sleep 20 displaysleep 5
```

Twenty minutes on battery is a reasonable compromise; set it to `0` only if you accept the battery
cost, since nothing else will stop it.

### 3.2 Lid closed is a different mechanism, and only one thing disables it

Clamshell sleep is **not** idle sleep. `sleep 0` does not prevent it, and neither does `caffeinate`
— closing the lid sleeps the machine regardless, unless an external display is attached.

If you want lid-closed operation with no external display:

```bash
sudo pmset -a disablesleep 1      # disable ALL sleep, including clamshell
sudo pmset -a disablesleep 0      # undo
```

Caveats worth taking seriously: this is machine-wide and permanent until you undo it; a closed
MacBook Pro has meaningfully less airflow, and sustained work under a closed lid runs hotter. Given
the governor already sheds on thermal pressure, you would be arranging for it to shed. Prefer lid
open, screen dark — which is what `displaysleep 60` already gives you.

### 3.3 Disk sleep does nothing useful on an SSD

```bash
sudo pmset -c disksleep 0
```

Marginal — 10 minutes of disksleep on a 7.4 GB/s NVMe saves almost no power and adds a first-access
stall. Harmless either way.

---

## 4. What Power Nap does not do

`powernap 1` is set, and it is commonly misread as "background tasks run while asleep." It does not
do that. Power Nap wakes the machine briefly, on Apple's schedule, for **Apple's** work: Mail,
Calendar, iCloud, Find My, Time Machine, software updates. Your LaunchAgent is not on that list.

While the machine sleeps, `setInterval` in the worker does not fire. The timer resumes on wake and
fires late. So "almost full time" genuinely does mean "do not let it sleep" — there is no sleeping
mode in which this work continues.

---

## 5. Holding wakefulness from inside the worker

Right now the machine is awake because of assertions owned by other processes:

```
pid 324(powerd)   PreventUserIdleSystemSleep  "Prevent sleep while display is on"   02:50:53
pid 13236(Claude) NoIdleSleepAssertion        "Electron"                            00:05:38
```

That is fine on AC where `sleep 0` already applies, but it means wakefulness is incidental — it
depends on who else happens to be running.

The power-respectful pattern is for the worker to hold an assertion **only while it is actually
working**, which is ~4–24 seconds per 30-minute cycle:

```js
// spawned at the start of a cycle, killed at the end
const caf = spawn('caffeinate', ['-i', '-w', String(process.pid)]);
// ... cycle ...
caf.kill();
```

Two guards, and both are needed. Killing it at the end of the cycle is what makes the assertion
*per-cycle* rather than permanent. `-w <pid>` pointed at our own pid is the backstop: if the worker
crashes mid-cycle and never reaches the kill, `caffeinate` exits when the process it is watching
does, so a crash cannot leave the Mac awake forever. That last failure mode is the one every
"keep awake" utility has, and it is worth one extra argument to avoid.

Implemented in `scripts/synapse-worker.js` (`withWakefulness`); verify with `pmset -g assertions`,
where the worker should appear during a cycle and be absent between them.

---

## 6. `ProcessType: Background` — correct now, worth revisiting later

`ProcessType: Background` is documented as being for work "not directly requested by the user," with
resource limits meant to keep it from disturbing you. In practice it places the job in a low QoS
band, and on Apple silicon low-QoS work is scheduled on the **efficiency cores**.

For what the worker does today — a 4–24 second cycle every 30 minutes, mostly I/O and small
embeddings — that is exactly right, and changing it would be a mistake.

**It stops being right if the plan's §7 lands.** Moving the weaver, triage classification and the
gardener onto the worker with a resident local model changes the shape of the job from "occasional
small burst" to "continuous inference." At that point:

- the node process orchestrating it is still fine on E-cores (it is waiting on the GPU);
- but if you see the cycle time grow disproportionately, `ProcessType: Adaptive` is the setting to
  try — it starts as background and gets promoted when the job becomes user-visible.

Do not pre-emptively change it. Measure the cycle time after §7 and change it only if the number
says so.

---

## 7. The part that actually matters

Everything above is about *permission* to run. The more useful question is whether there is enough
work to fill the time, and today there is not:

```
15:21:52 [synapse] gardener: 292 decayed, 1 pruned, 0 merged, 0 promoted
15:22:05 [synapse] paid pass: +$0 — 0 new link(s), 0 refreshed
15:22:05 cycle done in 24s — 1989 nodes / 660 edges
```

A 24-second cycle every 30 minutes is **1.3% duty**. The machine being awake for the other 98.7%
buys nothing until the loops have something to do. Four of them — weaver, triage, patrol, the
backlog worker — are down entirely because they live in the Electron process (`REDESIGN_PLAN.md`
§6), and the weaver has 633 unexplained links it cannot touch because the paid pass is budget-gated.

So the ordering is: **capability split first, uptime second.** Once the weaver runs headless against
a local model, "almost full time" turns 633 unexplained links into roughly eleven minutes of free
work, and continuous uptime starts to mean something. Right now it would mean an idle process
waiting for a timer.

---

## 8. Recommended, in order

| | Change | Command | Why |
|---|---|---|---|
| 1 | Battery sleep 1 → 20 min | `sudo pmset -b sleep 20 displaysleep 5` | today, unplugging kills every loop in 60s |
| 2 | Keep the LaunchAgent | — | a LaunchDaemon cannot read the login Keychain |
| 3 | Per-cycle `caffeinate` | ✅ done — `withWakefulness` | wakefulness that cannot outlive the process |
| 4 | Leave `ProcessType: Background` | — | correct for a 1.3% duty cycle; revisit after §7 |
| 5 | Lid-closed only if you must | `sudo pmset -a disablesleep 1` | thermally worse; prefer lid open, screen dark |
| 6 | Give the loops something to do | `REDESIGN_PLAN.md` §6, §7 | uptime without work is an idle timer |

**Not recommended:** a LaunchDaemon (breaks credentials), a blanket `caffeinate` (survives crashes),
Amphetamine or similar (duplicates `pmset` with a GUI), or raising `ProcessType` before measuring.

### Checking it is true

```bash
launchctl print gui/$UID/com.bhatbot.synapse | grep -E 'state|runs|last exit'
pmset -g custom | sed -n '/AC Power/,$p'
pmset -g assertions | grep -i prevent
tail -f ~/.bhatbot/logs/synapse-worker.log
```
