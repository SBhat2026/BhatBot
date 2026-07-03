#!/usr/bin/env node
'use strict';
// T2 — the abort-guard un-orphans tool_use at the SOURCE, and drones never resolve to Opus.
//   • sealDanglingToolUse (lib/history): a turn interrupted mid-tool-call gets synthetic '[interrupted]'
//     results so the stored history is pairing-safe, and the result passes validateHistory unchanged.
//   • resolveDroneModel (main.js, extracted): ALWAYS Sonnet (Haiku retired — no sub-Sonnet cloud tier).
// Pure — runs in node, in verify.
const fs = require('fs');
const path = require('path');
const { sealDanglingToolUse, validateHistory } = require('../lib/history');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- sealDanglingToolUse: trailing assistant tool_use with no result → sealed ----
const dangling = [
  { role: 'user', content: 'make a simulation' },
  { role: 'assistant', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'toolu_A', name: 'simulate', input: {} }] },
];
const sealed = sealDanglingToolUse(dangling);
const lastUser = sealed[sealed.length - 1];
ok(lastUser.role === 'user' && Array.isArray(lastUser.content), 'seal: appends a user message after the dangling tool_use');
ok(lastUser.content.length === 1 && lastUser.content[0].type === 'tool_result' && lastUser.content[0].tool_use_id === 'toolu_A', 'seal: synthetic tool_result matches the un-answered tool_use id');
ok(lastUser.content[0].is_error === true && /interrupted/.test(lastUser.content[0].content), 'seal: stub is flagged is_error with an [interrupted] note');

// ---- the sealed history is accepted by validateHistory with NO further repair (no orphan remains) ----
const validated = validateHistory(sealed);
ok(validated.length === sealed.length, 'seal: sealed history needs no validateHistory repair (already paired)');

// ---- multiple tool_use in one turn → each gets a stub ----
const multi = sealDanglingToolUse([
  { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }, { type: 'tool_use', id: 'b', name: 'y', input: {} }] },
]);
ok(multi[multi.length - 1].content.map((b) => b.tool_use_id).join(',') === 'a,b', 'seal: every tool_use in the turn gets a matching stub');

// ---- no-op cases ----
ok(sealDanglingToolUse([{ role: 'assistant', content: 'plain reply' }]).length === 1, 'seal: assistant text-only → unchanged');
ok(sealDanglingToolUse([
  { role: 'assistant', content: [{ type: 'tool_use', id: 'z', name: 'x', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', content: 'done' }] },
]).length === 2, 'seal: already-paired tool_use → unchanged');
ok(sealDanglingToolUse([]).length === 0 && Array.isArray(sealDanglingToolUse(null)), 'seal: empty/null → safe');

// ---- resolveDroneModel (extracted from main.js by brace-matching) — drones never on Opus ----
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function extract(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig); if (start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}
// Haiku retired: resolveDroneModel now ALWAYS returns Sonnet (no sub-Sonnet cloud tier).
const resolveDroneModel = new Function('MODEL_SONNET', extract(main, 'resolveDroneModel') + '\nreturn resolveDroneModel;')('claude-sonnet-4-6');
ok(resolveDroneModel('opus') === 'claude-sonnet-4-6', 'drone: spec model "opus" → Sonnet (never drains Opus OTPM)');
ok(resolveDroneModel('claude-opus-4-8') === 'claude-sonnet-4-6', 'drone: explicit opus id → Sonnet');
ok(resolveDroneModel(undefined) === 'claude-sonnet-4-6', 'drone: default (no model) → Sonnet');
ok(resolveDroneModel('haiku') === 'claude-sonnet-4-6', 'drone: "haiku" → Sonnet (Haiku retired — no downgrade tier)');
ok(resolveDroneModel('sonnet') === 'claude-sonnet-4-6', 'drone: "sonnet" → Sonnet');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
