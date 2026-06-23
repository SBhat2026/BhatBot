#!/usr/bin/env node
'use strict';
// W5 step 1 — export fine-tuning data from BhatBot's own trace logs.
//
// Sources (all local, nothing leaves the machine):
//   • ~/.bhatbot/semantic/store.json  — episodic turns ("User: …\nAssistant: …"), the richest
//     (prompt, completion) source.
//   • ~/.bhatbot/router.jsonl         — routing decisions + which turns were CORRECTED.
//   • ~/.bhatbot/audit.log            — tool-call outcomes (ok/fail) for weak negative signal.
//
// Outputs (mlx_lm.lora-ready) to ~/.bhatbot/finetune/:
//   • sft.jsonl   — {"messages":[{role:"user",…},{role:"assistant",…}]}  (good turns → SFT)
//   • prefs.jsonl — {"prompt","chosen","rejected"}  (correction pairs → DPO, best-effort/sparse)
//   • stats.json  — counts + provenance.
//
// Usage:  node scripts/export-prefs.js [--min N] [--out DIR]
// Never throws on missing/partial logs; prints a summary and exits 0 (1 only on hard error).

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const BASE = path.join(HOME, '.bhatbot');
const OUT_DIR = argVal('--out') || path.join(BASE, 'finetune');
const MIN = Number(argVal('--min')) || 1;

// Mirrors main.js CORRECTION_RE — a user turn that signals the previous reply was wrong/unwanted.
const CORRECTION_RE = /\b(that's wrong|that is wrong|incorrect|not what i|don'?t do that|stop doing|i told you|not like that|wrong answer|you (got|did) (it|that) wrong|be more|be less|too (verbose|long|short|terse|wordy)|no,? (don'?t|stop|that|i|you)|actually,? (i|you|it)|instead of|never do)\b/i;

// Cheap secret/PII redaction so training data can't memorize keys or raw emails.
function redact(s) {
  return String(s || '')
    .replace(/sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}|AIza[0-9A-Za-z_\-]{20,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}/g, '«key»')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '«email»')
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '«phone»');
}

function argVal(flag) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; }
function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function readLines(p) { try { return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } }

// Parse an episodic record's "User: …\nAssistant: …" blob into {user, assistant, ts}.
function parseEpisode(rec) {
  const t = String(rec.text || '');
  const m = t.match(/^User:\s*([\s\S]*?)\nAssistant:\s*([\s\S]*)$/);
  if (!m) return null;
  const user = m[1].trim(), assistant = m[2].trim();
  if (!user || !assistant) return null;
  return { user, assistant, ts: rec.ts || 0 };
}

// Heuristic: drop obviously garbled STT or trivial turns so they don't poison the set.
function isUsable(ep) {
  if (!ep) return false;
  if (ep.user.length < 6 || ep.assistant.length < 8) return false;
  if (ep.assistant.length > 4000) return false;
  // mostly-noise filter: user text with almost no sentence structure + very long = likely bad STT
  const words = ep.user.split(/\s+/).length;
  if (words > 60 && !/[.?!]/.test(ep.user)) return false;
  return true;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const store = readJSON(path.join(BASE, 'semantic', 'store.json'), { records: [] });
  const episodes = (store.records || [])
    .filter((r) => r.kind === 'episodic')
    .map(parseEpisode)
    .filter(Boolean)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const sft = [];
  const prefs = [];
  let correctedCount = 0;

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const next = episodes[i + 1];
    const correctedByNext = next && CORRECTION_RE.test(next.user);

    if (correctedByNext) {
      correctedCount++;
      // The reply that drew a correction is 'rejected'; the reply AFTER the correction (same intent,
      // now satisfactory) is 'chosen'. Implicit-preference pair — sparse but high-signal.
      if (isUsable(ep) && isUsable(next)) {
        prefs.push({ prompt: redact(ep.user), chosen: redact(next.assistant), rejected: redact(ep.assistant) });
      }
      continue;   // don't also SFT on the rejected turn
    }
    if (isUsable(ep)) {
      sft.push({ messages: [{ role: 'user', content: redact(ep.user) }, { role: 'assistant', content: redact(ep.assistant) }] });
    }
  }

  // Router telemetry: count corrected routes (provenance/diagnostics only).
  const routerRows = readLines(path.join(BASE, 'router.jsonl')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const routerCorrected = routerRows.filter((r) => r.corrected).length;

  // Audit: tool failure rate (diagnostics — informs whether tool-use SFT is worth it).
  const auditRows = readLines(path.join(BASE, 'audit.log')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((r) => r.tool);
  const toolFails = auditRows.filter((r) => r.ok === false).length;

  const sftPath = path.join(OUT_DIR, 'sft.jsonl');
  const prefPath = path.join(OUT_DIR, 'prefs.jsonl');
  fs.writeFileSync(sftPath, sft.map((x) => JSON.stringify(x)).join('\n') + (sft.length ? '\n' : ''));
  fs.writeFileSync(prefPath, prefs.map((x) => JSON.stringify(x)).join('\n') + (prefs.length ? '\n' : ''));

  // MLX-LM expects train.jsonl / valid.jsonl in a data dir for `--data`. Split SFT 90/10.
  const dataDir = path.join(OUT_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const split = Math.max(1, Math.floor(sft.length * 0.9));
  fs.writeFileSync(path.join(dataDir, 'train.jsonl'), sft.slice(0, split).map((x) => JSON.stringify(x)).join('\n') + (sft.length ? '\n' : ''));
  fs.writeFileSync(path.join(dataDir, 'valid.jsonl'), sft.slice(split).map((x) => JSON.stringify(x)).join('\n') + (sft.length > split ? '\n' : ''));

  const stats = {
    ts: new Date().toISOString(),
    episodes: episodes.length, sftPairs: sft.length, prefPairs: prefs.length,
    correctedTurns: correctedCount, routerCorrected, toolFails, auditRows: auditRows.length,
    outputs: { sft: sftPath, prefs: prefPath, data: dataDir },
    readyForSFT: sft.length >= MIN,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'stats.json'), JSON.stringify(stats, null, 2));

  console.log('── BhatBot fine-tune export ──');
  console.log(`episodes parsed : ${episodes.length}`);
  console.log(`SFT pairs       : ${sft.length}  → ${sftPath}`);
  console.log(`preference pairs: ${prefs.length}  → ${prefPath}`);
  console.log(`corrected turns : ${correctedCount} (router-flagged: ${routerCorrected})`);
  console.log(`tool failures   : ${toolFails}/${auditRows.length} audited calls`);
  console.log(`mlx data dir    : ${dataDir} (train/valid split)`);
  if (sft.length < 20) console.log(`\n⚠ Only ${sft.length} SFT pairs — let traces accumulate (aim for 200+ before a real LoRA run).`);
  console.log('\nNext: bash scripts/finetune.sh   (installs mlx-lm, runs LoRA on qwen3)');
}

try { main(); } catch (e) { console.error('export-prefs failed:', e.message); process.exit(1); }
