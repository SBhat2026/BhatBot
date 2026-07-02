# UX Sprint — Progress Report

Branch `ux-sprint` (never pushed). Verify-green after every commit (34 suites). Each fix mapped to the
symptom it kills. **T1–T3 + the file-transfer feature are DONE; T4–T6 (the learned spoken-length loop)
remain.**

## ✅ Done

### T1 — pace against live rate headers (`f607469`)
**Symptom killed:** stalls / 429s from pacing against hardcoded tier guesses.
`lib/rate.js` (pure) parses `anthropic-ratelimit-*` headers; `main.js` captures them on EVERY response
(stream + non-stream) into `_liveRate`, and `rateBudget()` prefers the fresh live remaining/limit
(×0.95) per-axis, falling back to the windowed estimate when absent/stale. Logs once per model. 13 tests.

### T2 — drones off Opus OTPM + abort-guard (`7fadaad`)
**Symptom killed:** the recurring API 400 (`tool_use` without `tool_result`) that wedged the next turn.
- `resolveDroneModel()` — a drone spec can only request the cheap tier; `opus`/`heavyToolModel`/anything
  → Sonnet (90k OTPM). Opus reserved for the single plan+interpret calls. Made explicit + asserted.
- `sealDanglingToolUse()` (lib/history) at the single turn-exit `finish()` — an interrupted turn gets
  synthetic `[interrupted]` tool_result stubs, so the stored history is pairing-safe **at the source**.
- Opus OTPM number left static; T1's live headers self-correct it. 13 tests.

### (bonus, user-requested mid-sprint) File transfer (`6d0544b`)
**Symptom killed:** dropped files vanished on send; CSV/PDF weren't ingested.
- Whole-window drag-drop + full-screen veil (was chat-area only). Any file type.
- Attachments **persist** across turns (pinned, re-sent), image thumbnails float near the orb
  (`#attpin`) so the file stays "in hand"; works with **voice and text**; ✕ / "clear all" to remove.
- `mediaFileToBlocks`: PDF → native base64 document block; CSV/code/config/text → inlined (200KB cap);
  office/zip/unknown → tool pointer. `lib/attach.js` (pure `classifyExt`) drives it. 11 tests.

### T3 — endpointing everywhere + real user-speech gate (`5932ba2`)
**Symptom killed:** the mic cutting me off; no real acoustic-silence signal.
- Renderer Web Audio `AnalyserNode` RMS → `userSpeaking`, auto-calibrated noise floor; `tryEndWebSpeech`
  ends only when Web-Speech AND the mic are both quiet for the learned `SILENCE_MS`.
- Phone parity: `lib/voicestream` uses the shared `createEndpointer().threshold()` (seeded from
  `endpoint.json`), clamped to `[500,2000]`. 9 integration tests.
- **Open:** true speaker separation (end despite another voice) still needs the voiceid post-filter
  (`config.voice.verifyUser`, flag wired, filter TODO) or real-time diarization.

## ⬜ Remaining (T4–T6 — the learned spoken-length loop)

- **T4 — streaming digest mode.** Give `makeSpeakStream` a `digest` mode decided from the stream
  (structural detectors: code/list/table/headers/length) via a pure `classifySpeechMode(runningText)` in
  `lib/speech.js`; speak a headline first, feed the T5 learned summary on `finish()`; strengthen the
  `<speak>` static-prompt rule. Extend `test-speech.js`.
- **T5 — learned spoken-length model.** `lib/spokenmodel.js` (clone `depthmodel.js` ridge + p90-margin):
  features from the finished on-screen answer (screen_tokens, n_numbers/entities/code/list/urls,
  type_token_ratio, struct_type, qtype, has_headline) → predicted spoken tokens, censored on barge-in,
  dataset `~/.bhatbot/spoken.jsonl`, dashboard metric `L = interrupt_rate + λ·underinform_rate`. Wire the
  target word-count into `SPEECH_SYS`/`summarizeForSpeech`.
- **T6 — instrument the feedback loop.** Barge-in word-position (`interrupted@N`), under-informative
  next-turn class (`why/expand/more detail…`), `clean` default; one-slot pending row like `priorOut`.

## Config keys added so far
`rateLimitLiveFrac` (0.95), `vad.floorMargin` (1.8), `voice.verifyUser` (false).
**T5/T6 will add:** `spokenLambda` (1.0), `spokenModelMinRows` (200); artifacts `spoken.jsonl`,
`spoken-model.json`.
