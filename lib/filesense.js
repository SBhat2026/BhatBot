'use strict';
// ── FILE SENSITIVITY (for the upload gate) ────────────────────────────────────────────────────────
// Siddhant's rule: general-use files may be sent to a third party without asking, personal and
// research files must be confirmed first, and BhatBot should make that call itself — learning from
// what he approves and refuses.
//
// THE ASYMMETRY THAT DRIVES EVERY DEFAULT: wrongly asking about a screenshot costs one click.
// Wrongly uploading a research PDF or a bank statement cannot be undone — the file is on someone
// else's server the moment it leaves. So `unknown` resolves to SENSITIVE, and the learned layer may
// only ever move a file toward "general" through an explicit decision he made. It can never learn
// its way into uploading a class of file he has never approved.
//
// Classification is entirely LOCAL and reads only paths plus, at most, the first few KB of a file.
// Nothing is transmitted to decide whether something may be transmitted — that would defeat itself.
//
// Pure + fs + DI. See scripts/test-filesense.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── deterministic signals ────────────────────────────────────────────────────────────────────────

// Directories whose contents are transient, self-generated, or already public.
const GENERAL_DIRS = [
  'Downloads', 'Desktop/screenshots', 'Pictures/Screenshots', 'tmp', 'Public',
  '.bhatbot/generated', '.bhatbot/figures',
];
// Directories that hold his actual work and life.
const SENSITIVE_DIRS = [
  'Desktop/Research Files', 'Documents', 'Library/Mobile Documents', 'iCloud Drive',
  '.ssh', '.gnupg', '.aws', '.config', '.bhatbot',
];
// Filename fragments that make a file sensitive regardless of where it lives.
const SENSITIVE_NAME = /\b(passport|ssn|social.?security|tax|w-?2|1099|medical|health|insurance|prescription|bank|statement|invoice|receipt|salary|payslip|contract|nda|confidential|private|secret|credential|password|passwd|token|api.?key|secret.?key|resume|cv|transcript|recommendation|reference.?letter|application|admission|financial.?aid|fafsa|css.?profile|birth.?certificate|license|visa|immigration)\b/i;
// Research/scientific payloads — his primary work product.
const RESEARCH_EXT = new Set(['.pdb', '.cif', '.fasta', '.fa', '.fastq', '.mmcif', '.sdf', '.mol2',
  '.npy', '.npz', '.h5', '.hdf5', '.mat', '.ipynb', '.parquet', '.pt', '.pth', '.safetensors']);
// Projects that are research by nature (kept loose — it only ever promotes to sensitive).
const RESEARCH_HINT = /\b(research|protfunc|fable|prism|uricase|adaptyv|eigen|alphafold|deepfri|protein|assembly|ptdc|pmhc|biorxiv|isef|thesis|paper|manuscript|dataset)\b/i;
// Obviously-generic media that is safe by default (a screenshot, a meme, an icon).
const GENERAL_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.svg',
  '.mp4', '.mov', '.mp3', '.wav', '.zip']);

const CREDENTIAL_PEEK = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9]{20,}\b|\bghp_[A-Za-z0-9]{30,}\b|\b\d{3}-\d{2}-\d{4}\b/;

// Underscore is a WORD character, so /\bpassport\b/ does NOT match "passport_scan.pdf" — the most
// common way people actually name these files. Normalizing every separator to a space before testing
// is the difference between the gate working and silently letting a passport scan through.
function normalizeName(name) {
  return String(name || '').replace(/[_\-.+()[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function relTo(home, p) {
  try { return path.relative(home, path.resolve(p)); } catch { return String(p || ''); }
}
const startsWithDir = (rel, dir) => rel === dir || rel.startsWith(dir + path.sep);

function createFileSense({ home = os.homedir(), dir = path.join(os.homedir(), '.bhatbot'), now = () => Date.now(), log = () => {} } = {}) {
  const file = path.join(dir, 'file-decisions.jsonl');
  let learned = null;   // { byDir: Map, byExt: Map }

  // ── the learned layer ──────────────────────────────────────────────────────────────────────────
  // Every approve/refuse he makes is recorded against the file's DIRECTORY and EXTENSION. Those are
  // the two generalizations that actually transfer: "anything in ~/Downloads is fine" and "never a
  // .pdb". Learning on the full filename would never fire twice.
  function loadLearned() {
    if (learned) return learned;
    learned = { byDir: new Map(), byExt: new Map() };
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return learned; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (!d || !d.decision) continue;
      const bump = (map, key) => {
        if (!key) return;
        const cur = map.get(key) || { allow: 0, deny: 0 };
        if (d.decision === 'allow') cur.allow++; else cur.deny++;
        map.set(key, cur);
      };
      bump(learned.byDir, d.dir);
      bump(learned.byExt, d.ext);
    }
    return learned;
  }

  // record — called with what he actually chose. This is the entire training signal.
  function record({ filePath, decision, classification }) {
    const rel = relTo(home, filePath);
    const entry = {
      ts: new Date(now()).toISOString(),
      dir: path.dirname(rel), ext: path.extname(rel).toLowerCase(),
      name: path.basename(rel), decision,                       // 'allow' | 'deny'
      wasClassified: classification || null,
    };
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(file, JSON.stringify(entry) + '\n'); }
    catch (e) { log('[filesense] record failed: ' + e.message); }
    learned = null;                                              // reload on next classify
    return entry;
  }

  // ── classification ─────────────────────────────────────────────────────────────────────────────
  // Returns { level: 'general'|'sensitive', confidence, reasons[], needsConfirm }.
  function classify(filePath, { peek = true } = {}) {
    const abs = path.resolve(String(filePath || ''));
    const rel = relTo(home, abs);
    const name = path.basename(abs);
    const ext = path.extname(abs).toLowerCase();
    const reasons = [];

    // 1. HARD SENSITIVE — never overridable, not by learning, not by anything. A credential or an
    //    identity document must not become uploadable because a directory was approved twice.
    if (SENSITIVE_NAME.test(normalizeName(name))) {
      return { level: 'sensitive', hard: true, confidence: 0.97, needsConfirm: true,
        reasons: [`filename suggests a personal/financial document ("${name}")`] };
    }
    for (const d of ['.ssh', '.gnupg', '.aws']) {
      if (startsWithDir(rel, d)) return { level: 'sensitive', hard: true, confidence: 0.99, needsConfirm: true, reasons: [`lives in ~/${d}`] };
    }
    if (peek && looksLikeCredential(abs)) {
      return { level: 'sensitive', hard: true, confidence: 0.99, needsConfirm: true,
        reasons: ['file contents match a private key / access key / SSN pattern'] };
    }

    // 2. RESEARCH — his work product.
    if (RESEARCH_EXT.has(ext)) reasons.push(`${ext} is research data`);
    if (RESEARCH_HINT.test(normalizeName(rel))) reasons.push('path names an active research project');
    for (const d of SENSITIVE_DIRS) if (startsWithDir(rel, d)) reasons.push(`lives under ~/${d}`);
    if (reasons.length) {
      const learnedSays = learnedVerdict(abs);
      // The learned layer may soften a SOFT sensitive signal — that is the whole point of learning —
      // but only with real, repeated evidence, and never for the hard cases handled above.
      if (learnedSays === 'allow') {
        return { level: 'general', confidence: 0.8, needsConfirm: false,
          reasons: [...reasons, 'but you have repeatedly approved uploads from here'] };
      }
      return { level: 'sensitive', confidence: 0.85, needsConfirm: true, reasons };
    }

    // 3. GENERAL — transient, self-generated, or plainly generic.
    for (const d of GENERAL_DIRS) {
      if (startsWithDir(rel, d)) return { level: 'general', confidence: 0.9, needsConfirm: false, reasons: [`lives under ~/${d}`] };
    }
    if (GENERAL_EXT.has(ext) && !RESEARCH_HINT.test(normalizeName(rel))) {
      return { level: 'general', confidence: 0.75, needsConfirm: false, reasons: [`${ext} in a non-research location`] };
    }

    // 4. LEARNED, then UNKNOWN → sensitive. Asking costs a click; a wrong upload is permanent.
    const v = learnedVerdict(abs);
    if (v === 'allow') return { level: 'general', confidence: 0.7, needsConfirm: false, reasons: ['you have approved uploads from this folder before'] };
    if (v === 'deny') return { level: 'sensitive', confidence: 0.9, needsConfirm: true, reasons: ['you have refused uploads from this folder before'] };
    return { level: 'sensitive', confidence: 0.5, needsConfirm: true, reasons: ['unrecognized file — defaulting to asking first'] };
  }

  // A directory or extension needs a clear, repeated pattern before it decides anything.
  function learnedVerdict(abs) {
    const L = loadLearned();
    const rel = relTo(home, abs);
    const d = path.dirname(rel), ext = path.extname(rel).toLowerCase();
    const de = L.byExt.get(ext);
    if (de && de.deny >= 1 && de.deny >= de.allow) return 'deny';     // one refusal on a TYPE sticks
    const dd = L.byDir.get(d);
    if (dd) {
      if (dd.deny > 0) return 'deny';                                  // any refusal here → keep asking
      if (dd.allow >= 2) return 'allow';                               // two approvals → stop asking
    }
    if (de && de.allow >= 3 && de.deny === 0) return 'allow';
    return null;
  }

  function looksLikeCredential(abs) {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) return false;
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(Math.min(8192, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      return CREDENTIAL_PEEK.test(buf.toString('utf8'));
    } catch { return false; }
  }

  function stats() {
    const L = loadLearned();
    return {
      dirs: [...L.byDir.entries()].map(([k, v]) => ({ dir: k, ...v })).sort((a, b) => (b.allow + b.deny) - (a.allow + a.deny)).slice(0, 20),
      exts: [...L.byExt.entries()].map(([k, v]) => ({ ext: k, ...v })),
    };
  }

  return { classify, record, stats, file, _learnedVerdict: learnedVerdict, _reload: () => { learned = null; } };
}

module.exports = { createFileSense, normalizeName, SENSITIVE_NAME, RESEARCH_EXT, GENERAL_DIRS, SENSITIVE_DIRS };
