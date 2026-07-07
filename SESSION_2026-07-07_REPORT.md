# Session Report — 2026-07-07: TTS/STT audit + complex-task ceiling + voice-first UI

_On `main`, pushed, verify-green (38 suites). Restart the desktop app to load. Interviewed for the
four major decisions (working-memory aggressiveness, heavy-model routing, UI layout, git flow)._

---

## 1. TTS/STT audit — "identify all issues" (grounded in current `main.js`)

The 2026-06-30 dossier was **stale**: the code moved a lot since, and most voice issues it lists were
already fixed by intervening sprints. Re-audited from source. Status:

### Already fixed (verified in code — not re-done)
| Area | Where | Status |
|------|-------|--------|
| STT hallucination injection ("Talaser…" loop) | `sanitizeSteering` (main.js) — cloud + local + guidance paths | ✅ |
| Guidance-burst balloon | `MAX_GUIDANCE_CHARS` cap + consecutive-dedup | ✅ |
| Offline STT dependency | mlx-whisper fallback (`lib/localstt`) + `no_speech`/`avg_logprob` gate | ✅ |
| Misheard names/emails | `sttVocabHint` (owner/logins/vocab biasing) | ✅ |
| Background speaker acted on | `verifyEnrolledSpeaker` cocktail-party filter (`voice.verifyUser`) | ✅ |
| Early endpoint on thinking-pause | learned `lib/endpoint.js` + near-field VAD (`userSpeaking`, calibrated floor) | ✅ |
| Phone endpointing parity | `lib/voicestream.js` uses shared `createEndpointer()` | ✅ |
| Learned spoken length | `lib/spokenmodel.js` + `spoken.jsonl` feedback loop | ✅ |
| READ-verbatim vs digest | speech planner (`pure.classifySpeech`) | ✅ |

### Fixed this session
- **WS low-latency TTS transport was built but pinned OFF** (`ttsTransport:'rest'`) → every spoken
  turn paid the per-sentence REST POST + afplay respawn latency. Default now `auto`: `ttsWsActive()`
  resolves auto→ws whenever `_ttsWs.available()` (EL key + ffplay/sox — both present here), else REST.
  → kills inter-sentence latency. (`808eb97`)

### Judged already-covered (no change)
- **Barge-in TTS-tail capture** — `startVoice()` calls `stopSpeaking()` before opening the mic,
  `getUserMedia` has `echoCancellation:true`, and `bargeInInterrupt()` kills the player + ws in the
  main process. Adequately mitigated.

### Still open (documented, not fixed this pass)
- Cloud STT has only the lexical guard (no per-token confidence — model-dependent). Minor.
- Phone strict-EL: goes silent on ElevenLabs 5xx (desktop has Kokoro fallback; phone doesn't).

---

## 2. Complex-task ceiling — fix → symptom

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| Long autonomous runs "run out of juice" / lose file paths & diffs | Working memory clamped to ~32K (`capTokens`) + trim at ~28K on a 200K-window model → ~85% of context discarded | `capTokens` 32K→**150K** (`wireCapTokens`), `CONTEXT_TRIM_BUDGET` 28K→120K, `CONTEXT_KEEP_TAIL` 16K→80K (`0536e2d`) |
| Big context = expensive + heavy on ITPM | Only the static prompt was cached; message history re-billed each turn | 2nd cache breakpoint on the conversation prefix (`tagLastBlockForCache` in `anthropicRequest`); `config.convoCache` (`21bc9d2`) |
| Wide heavy fan-out throttled to ~3 agents | Heavy tier pinned to Opus (16K OTPM) | Auto-by-shape `heavyModel(text)`: fleets → Fable 5, solo deep-reasoning → Opus; `config.heavyRouting` (`0536e2d`) |

Decision (Siddhant): **aggressive ~150K** working memory, **auto by shape** heavy model.

---

## 3. Voice-first UI — summonable side drawers (`84ac005`)

Decision: **summonable side drawers**. Orb stage stays home; a left icon rail slides each viewpoint
in as a drawer over the orb (blurred, scrim, orb visible behind). Rail: Manage 🛰 · Health ❤ ·
Activity 📊 · Fleet 🦾 · Memory 🧠 · Voice 🎚 · Config ⚙. Controls: rail click (re-click closes),
⌘/Ctrl 1–6, scrim/Esc → voice. New Memory panel. Additive under `body.voicefirst`; HUD untouched.
Reusable render check: `scripts/voicefirst-visual-check.js`.

---

## 4. Dossier status
`BHATBOT_ISSUES_DOSSIER.md` updated with a 2026-07-07 status banner: §1 context ✅ resolved, §3
parallelism ✅ mitigated, §5 voice ✅ resolved. **Remaining open:** §4 local Ollama pipeline mangles
tool tasks (still escalates to cloud); minor §5.4 secret-file read UX + phone strict-EL resilience.

## 5. New config keys
`wireCapTokens` (150000) · `heavyRouting` ('auto') · `convoCache` (on). `ttsTransport` default
behavior changed (undefined/'auto' → ws when usable).
