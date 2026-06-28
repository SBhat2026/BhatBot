#!/usr/bin/env node
'use strict';
// Tests for lib/history.js (SPLIT_PLAN step 9 — the pure agent-loop helpers). validateHistory is the
// API-400 guard that keeps a multi-step session from wedging; getting it wrong = silent conversation
// corruption, so it's locked down here: self-echo drop, orphan tool_result strip, trailing dangling
// tool_use drop, and the MID-history dangling-tool_use repair (synthetic error results). Plus image
// eviction (no-mutate) + the idempotent-retry classifier. Pure → plain node. Wired into `npm run verify`.
//   node scripts/test-history.js
const { validateHistory, evictOldImages, isRetryableTool, TRANSIENT_RE } = require('../lib/history');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- validateHistory: non-array → [] ----
ok(Array.isArray(validateHistory(null)) && validateHistory(null).length === 0, 'validateHistory(null) → []');

// ---- drops a user msg that exactly echoes the previous assistant reply (self-hallucination) ----
const echo = validateHistory([
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'The answer is 42.' },
  { role: 'user', content: 'The answer is 42.' },   // echo → dropped
]);
ok(echo.length === 2 && echo[1].role === 'assistant', 'drops user message echoing the assistant reply');

// ---- strips orphan tool_result (no preceding tool_use) ----
const orphan = validateHistory([
  { role: 'user', content: [{ type: 'text', text: 'go' }, { type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] },
]);
ok(orphan.length === 1 && orphan[0].content.every((b) => b.type !== 'tool_result'), 'strips orphan tool_result with no matching tool_use');

// ---- drops a trailing assistant turn whose tool_use never got a result ----
const trailing = validateHistory([
  { role: 'user', content: 'do it' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
]);
ok(trailing.length === 1 && trailing[0].role === 'user', 'drops trailing assistant turn with unanswered tool_use');

// ---- repairs a MID-history dangling tool_use by splicing synthetic error results ----
const mid = validateHistory([
  { role: 'user', content: 'start' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'x', input: {} }] },
  { role: 'assistant', content: 'kept going without a result' },   // interruption: no tool_result for a1
]);
const repaired = mid.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'a1'));
ok(repaired && repaired.content[0].is_error === true, 'repairs mid-history dangling tool_use with a synthetic error result');

// ---- a well-formed tool_use/tool_result pair is preserved untouched ----
const good = [
  { role: 'user', content: 'q' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'g1', name: 'x', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'ok' }] },
  { role: 'assistant', content: 'done' },
];
ok(validateHistory(good).length === 4, 'preserves a well-formed tool_use/tool_result conversation');

// ---- evictOldImages: keeps the most-recent N, never mutates the input ----
const img = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'image', source: { data: id } }] }] });
const hist = [img('a'), img('b'), img('c')];
const ev = evictOldImages(hist, 1);
const remainingImages = ev.flatMap((m) => m.content).flatMap((b) => b.content).filter((b) => b.type === 'image');
ok(remainingImages.length === 1 && remainingImages[0].source.data === 'c', 'evictOldImages keeps only the most-recent image');
ok(hist[0].content[0].content[0].type === 'image', 'evictOldImages did NOT mutate the original history (deep clone)');
ok(evictOldImages([], 2).length === 0, 'evictOldImages([]) → []');

// ---- isRetryableTool: idempotent reads yes, side-effecting actions no ----
ok(isRetryableTool('fetch_url', {}) === true, 'isRetryableTool: fetch_url retryable');
ok(isRetryableTool('web_search', {}) === true, 'isRetryableTool: web_search retryable');
ok(isRetryableTool('read_file', {}) === true, 'isRetryableTool: read_file retryable');
ok(isRetryableTool('browser', { action: 'navigate' }) === true, 'isRetryableTool: browser navigate (read) retryable');
ok(isRetryableTool('browser', { action: 'click' }) === false, 'isRetryableTool: browser click (side effect) NOT retryable');
ok(isRetryableTool('run_shell', {}) === false, 'isRetryableTool: run_shell NOT retryable');
ok(isRetryableTool('write_file', {}) === false, 'isRetryableTool: write_file NOT retryable');

// ---- TRANSIENT_RE: matches network/transient signatures, not logic errors ----
ok(TRANSIENT_RE.test('Error: ETIMEDOUT'), 'TRANSIENT_RE matches ETIMEDOUT');
ok(TRANSIENT_RE.test('429 Too Many Requests'), 'TRANSIENT_RE matches 429');
ok(TRANSIENT_RE.test('Target closed'), 'TRANSIENT_RE matches "Target closed"');
ok(!TRANSIENT_RE.test('TypeError: x is not a function'), 'TRANSIENT_RE does NOT match a logic error');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
