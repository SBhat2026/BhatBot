'use strict';
// Audit module — SPLIT_PLAN.md step 2. Append-only ledger of every tool call (forensic trail +
// feed for the cost/self-improve loops). Factory takes the few main.js deps it needs:
//   isRemote()         → tag the source as desktop vs remote/phone
//   estimateToolCost() → per-tool $ estimate (pure)
//   recordToolCost()   → fold that $ into the daily cost ledger
// redactForAudit + AUDIT_PATH live here; main.js destructures AUDIT_PATH from the factory so its
// other callers (requestConfirm) keep working.
const fs = require('fs');
const path = require('path');
const os = require('os');

const AUDIT_PATH = path.join(os.homedir(), '.bhatbot', 'audit.log');
const AUDIT_SECRET_KEYS = /^(password|pass|secret|token|api[_-]?key|credref|cred_ref|totp|otp|pin|passphrase|authorization)$/i;
function redactForAudit(obj) {
  try {
    return JSON.stringify(obj, (k, v) => {
      if (AUDIT_SECRET_KEYS.test(k)) return '«redacted»';
      if (typeof v === 'string' && !/CRED_REF_/.test(v) && v.length > 200) return v.slice(0, 200) + '…';
      return v;
    }).slice(0, 1000);
  } catch { return ''; }
}

module.exports = function makeAudit({ isRemote, estimateToolCost, recordToolCost } = {}) {
  // meta (W2): the LLM step that invoked this tool — {model,tin,tout,usd}. Lets every audit entry
  // carry full energy/cost telemetry (tokens_in/out, model, llm $, latency) not just the tool's own $.
  function auditLog(name, input, result, ms, meta) {
    try {
      fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
      const r = result || {};
      let usd; try { usd = estimateToolCost && estimateToolCost(name, input, r); if (usd) recordToolCost && recordToolCost(name, usd); } catch {}
      const m = meta || {};
      fs.appendFileSync(AUDIT_PATH, JSON.stringify({
        ts: new Date().toISOString(), tool: name,
        source: (isRemote && isRemote()) ? 'remote/phone' : 'desktop',
        args: redactForAudit(input), ok: r.success !== false,
        ms: ms != null ? Math.round(ms) : undefined,
        usd: usd || undefined,
        model: m.model || undefined,
        tin: m.tin || undefined,
        tout: m.tout || undefined,
        llmUsd: m.usd || undefined,
        result: String(r.error || r.result || (r.success !== false ? 'ok' : '')).slice(0, 300),
      }) + '\n');
    } catch {}
  }
  function readAudit(limit = 100) {
    try {
      const lines = fs.readFileSync(AUDIT_PATH, 'utf8').trim().split('\n');
      return lines.slice(-Math.min(2000, limit)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch { return []; }
  }
  return { AUDIT_PATH, auditLog, readAudit, redactForAudit };
};
