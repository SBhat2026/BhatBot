'use strict';
// Pure, stateless helpers extracted from main.js — SPLIT_PLAN.md step 1. These depend on nothing
// in main.js's module scope (only their arguments), so they're the safe first slice to prove the
// extraction wiring before the heavier tool-cluster modules. No Electron/fs/state imports.

// Mine a human-readable text hint from a CSS/Playwright selector (for vision-fallback clicks).
function textHintFromSelector(sel) {
  if (!sel) return '';
  const m = sel.match(/:has-text\("([^"]+)"\)/i) || sel.match(/\[aria-label="([^"]+)"\]/i)
    || sel.match(/\[placeholder="([^"]+)"\]/i) || sel.match(/\[name="([^"]+)"\]/i);
  if (m) return m[1];
  if (sel.startsWith('#')) return sel.slice(1).replace(/[-_]/g, ' ');
  return sel.replace(/[#.\[\]"'=>~]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Split text into speakable chunks (synth one while the next is prepared).
function splitForSpeech(text) {
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '').trim();
  const parts = clean.match(/[^.!?\n]+[.!?]?(\s|$)|[^.!?\n]+$/g) || [];
  const out = []; let buf = '';
  for (let p of parts) { p = p.trim(); if (!p) continue; buf = buf ? buf + ' ' + p : p; if (buf.length >= 60 || /[.!?]$/.test(p)) { out.push(buf); buf = ''; } }
  if (buf) out.push(buf);
  return out.filter((s) => s.length);
}

// Strip leaked chain-of-thought / reasoning from a model reply before it's shown OR spoken.
// Weak models (e.g. haiku) sometimes emit literal <thinking>…</thinking> / <think>… tags, or a
// dangling "<thinking The user is correcting me…" with no close, or a bare meta line narrating
// their own process. None of that should reach the chat bubble or the TTS. Conservative: only
// removes explicit reasoning markup + a leading self-narration line, never normal prose.
function stripReasoning(text) {
  let s = String(text || '');
  s = s.replace(/<thinking\b[\s\S]*?<\/thinking>/gi, ' ');   // well-formed thinking blocks
  s = s.replace(/<think\b[\s\S]*?<\/think>/gi, ' ');
  s = s.replace(/<\/?(?:thinking|think|reasoning|scratchpad)\b[^>]*>/gi, ' '); // stray open/close tags
  s = s.replace(/<thinking\b[\s\S]*$/i, ' ').replace(/<think\b[\s\S]*$/i, ' '); // dangling (never closed)
  // A leading line that is pure meta-narration about the user/turn ("The user is correcting me…").
  s = s.replace(/^\s*(?:the user (?:is|wants|seems|said|just)|i (?:should|need to|will|am going to|notice|see that)|let me (?:think|reason|consider))\b[^\n.!?]*[.!?]?\s*/i, '');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

// Estimated USD cost of a paid generation tool call (folded into the daily cost ledger).
function estimateToolCost(name, input, result) {
  if (!result || result.success === false) return 0;    // failed calls cost ~nothing
  if (name === 'generate_image') {
    const prov = result.provider || (input && input.provider) || 'openai';
    if (prov === 'flux') return 0.04;
    if (prov === 'flux-fast') return 0.003;
    const q = (input && input.quality) || 'medium';
    return q === 'high' ? 0.08 : q === 'low' ? 0.01 : 0.04;
  }
  if (name === 'generate_3d') return 0.10;              // TRELLIS via Replicate (approx)
  return 0;
}

module.exports = { textHintFromSelector, splitForSpeech, estimateToolCost, stripReasoning };
