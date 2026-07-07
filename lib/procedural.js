'use strict';
// PROCEDURAL MEMORY — BhatBot learns the recurring SERIES OF STEPS it takes to satisfy a kind of
// request (tool calls, MCP ticks, browser navigation — anything that shows up as a tool name), and
// recalls the known path on future look-alike requests so it can skip the exploration and go
// straight to what worked. The more it does something, the faster + more confident it gets.
//
// How it stays honest (progressively SMARTER, not just faster):
//   • A "series" is ≥2 steps. Each recorded run reinforces a matching routine (same step-signature +
//     overlapping trigger keywords) or seeds a new one.
//   • Confidence is Laplace-smoothed wins/uses; a routine is only RECALLED once it has repeated
//     (minUses) and is winning. Recency-weighted so recent behaviour dominates.
//   • Self-correcting: routines that start FAILING (a site redesign broke the click path, a flow
//     changed) decay and EXPIRE — they stop being suggested instead of misleading forever.
//
// Storage: a single JSON file (default ~/.bhatbot/procedural.json). Pure logic + fs; no other deps.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_STEPS = 2;              // a "series" — one lone tool call isn't a routine
const CLUSTER_JACCARD = 0.34;     // trigger-keyword overlap that counts as "the same kind of request"
const MIN_USES = 2;               // must have recurred before we suggest it
const MAX_ROUTINES = 300;
const HALF_LIFE_DAYS = 14;        // recency decay half-life
const EXPIRE_DAYS = 60;           // untouched routines age out
const KW_CAP = 24;                // keep a routine's keyword set bounded

const STOP = new Set(('the a an and or but to of in on for with my your our i you it this that these those is are was were be been being do does did done can could would should will just please now then here there what which who how why get set make do use go run open show tell find give take put let me my mr sir jarvis bhatbot').split(' '));

// content tokens of a request → the "kind of task" fingerprint
function keywords(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_+-]{1,}/g) || []) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.add(w);
    if (out.size >= 40) break;
  }
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
// ordered tool-name path, consecutive dups collapsed → the routine's signature
function seqSig(steps) {
  const names = (steps || []).map((s) => (typeof s === 'string' ? s : (s && s.name) || '')).filter(Boolean);
  const collapsed = names.filter((n, i) => n !== names[i - 1]);
  return collapsed.join('→');
}
function confidence(r) { return (r.wins + 1) / (r.uses + 2); }               // Laplace-smoothed
function recencyWeight(r, now) {
  const days = Math.max(0, (now - (r.lastUsed || r.createdAt || now)) / 86400000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}
function score(r, kw, now) { return jaccard(new Set(r.kw || []), kw) * confidence(r) * recencyWeight(r, now); }
function eligible(r) { return r.uses >= MIN_USES && confidence(r) >= 0.5; }
function expired(r, now) {
  if (r.losses >= 3 && r.wins === 0) return true;                            // never worked → drop
  if (r.uses >= 3 && confidence(r) < 0.25) return true;                      // stopped working → drop
  if ((now - (r.lastUsed || r.createdAt || now)) / 86400000 > EXPIRE_DAYS) return true;
  return false;
}

function load(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && Array.isArray(d.routines)) return d; } catch {}
  return { v: 1, routines: [] };
}
function save(file, data) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch {}
}
function prune(data, now) {
  data.routines = data.routines.filter((r) => !expired(r, now));
  if (data.routines.length > MAX_ROUTINES) {
    data.routines.sort((a, b) => score(b, new Set(b.kw || []), now) - score(a, new Set(a.kw || []), now));
    data.routines.length = MAX_ROUTINES;
  }
}

// Record ONE completed turn's step-series. Reinforces a matching routine or seeds a new one.
// { trigger, steps:[name|{name}], ok, ms, firstRead?:{name,input} }  → the routine (or null if too short).
function record(file, entry = {}, opts = {}) {
  const steps = entry.steps || [];
  if (steps.filter(Boolean).length < MIN_STEPS) return null;
  const now = (opts.now || Date.now)();
  const sig = seqSig(steps);
  if (!sig || sig.indexOf('→') < 0) return null;    // collapsed to a single distinct tool → not a series
  const kw = keywords(entry.trigger);
  const data = load(file);
  let r = data.routines.find((x) => x.sig === sig && jaccard(new Set(x.kw || []), kw) >= CLUSTER_JACCARD);
  const ok = entry.ok !== false;
  if (r) {
    r.uses++; if (ok) r.wins++; else r.losses++;
    r.lastUsed = now;
    r.ms = r.ms ? Math.round(r.ms * 0.7 + (entry.ms || r.ms) * 0.3) : (entry.ms || 0);   // EWMA latency
    r.kw = [...new Set([...(r.kw || []), ...kw])].slice(0, KW_CAP);
    if (entry.firstRead && entry.firstRead.name) r.firstRead = entry.firstRead;           // refresh the prefetch hint
  } else {
    r = { id: crypto.randomBytes(5).toString('hex'), sig, steps: seqSig(steps).split('→'),
      kw: [...kw].slice(0, KW_CAP), trigger: String(entry.trigger || '').slice(0, 120),
      uses: 1, wins: ok ? 1 : 0, losses: ok ? 0 : 1, ms: entry.ms || 0,
      firstRead: (entry.firstRead && entry.firstRead.name) ? entry.firstRead : null,
      createdAt: now, lastUsed: now };
    data.routines.push(r);
  }
  prune(data, now);
  save(file, data);
  return r;
}

// Recall the learned routines that best match a NEW request. Returns [{id, sig, steps, uses,
// confidence, ms, firstRead, score}] — only routines that have recurred and are winning.
function recall(file, query, opts = {}) {
  const now = (opts.now || Date.now)();
  const limit = opts.limit || 2;
  const minScore = opts.minScore != null ? opts.minScore : 0.12;
  const kw = keywords(query);
  if (!kw.size) return [];
  const data = load(file);
  return data.routines
    .filter((r) => eligible(r) && !expired(r, now))
    .map((r) => ({ id: r.id, sig: r.sig, steps: r.steps || r.sig.split('→'), uses: r.uses,
      confidence: +confidence(r).toFixed(2), ms: r.ms || 0, firstRead: r.firstRead || null, score: +score(r, kw, now).toFixed(3) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Feedback after a recalled routine was actually followed: reinforce (ok) or decay (fail). Keeps the
// bank honest so broken paths stop being suggested.
function reinforce(file, id, ok, opts = {}) {
  const now = (opts.now || Date.now)();
  const data = load(file);
  const r = data.routines.find((x) => x.id === id);
  if (!r) return false;
  r.uses++; if (ok !== false) r.wins++; else r.losses++;
  r.lastUsed = now;
  prune(data, now);
  save(file, data);
  return true;
}

// Compact context block for the recalled routines — the shortcut hint injected into the turn.
function format(hints) {
  if (!hints || !hints.length) return '';
  const lines = hints.map((h) => `- ${h.sig}  (used ${h.uses}×, ${Math.round(h.confidence * 100)}% success${h.ms ? `, ~${Math.round(h.ms / 1000)}s` : ''})`);
  return '## LEARNED ROUTINES (procedural memory — paths that worked before for tasks like this)\n\n'
    + lines.join('\n')
    + '\n\nIf one fits this request, follow it directly instead of re-exploring; adapt the arguments to the specifics. If it no longer works, proceed normally (it will be pruned).';
}

module.exports = { record, recall, reinforce, format, keywords, jaccard, seqSig, confidence, load, MIN_USES, MIN_STEPS };
