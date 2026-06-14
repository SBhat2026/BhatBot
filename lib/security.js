'use strict';
// Tool-output sanitization + security audit (P0.4). External content (web pages, shell
// output, browser page text, SMS/Telegram bodies) flows straight into model context — a
// crafted page can embed fake tool tags or "ignore previous instructions" payloads.
// sanitizeExternalContent() neutralizes the known shapes (escape + flag, never silently
// drop) and logs every hit to a daily audit file at ~/.bhatbot/audit/{date}.log.
const fs = require('fs');
const path = require('path');
const os = require('os');

const AUDIT_DIR = path.join(os.homedir(), '.bhatbot', 'audit');

// Known prompt-injection shapes. Tag-like patterns are escaped (angle brackets →
// fullwidth chars) so legitimate text stays readable while losing any parser meaning;
// imperative override phrases get a visible ⟦flagged⟧ marker the model is told to distrust.
const INJECTION_PATTERNS = [
  { label: 'tool-tag',          re: /<\/?\s*(tool|tool_use|tool_result|function_call|function_results|invoke|parameter|antml:[\w-]+)\b[^>]*>/gi },
  { label: 'instruction-tag',   re: /<\/?\s*(instruction|instructions|system|sys)\b[^>]*>/gi },
  { label: 'chatml-token',      re: /<\|\s*(im_start|im_end|endoftext|system|user|assistant)\s*\|>/gi },
  { label: 'ignore-previous',   re: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding|original)\s+(instructions?|prompts?|context|rules?|messages?|directives?)\b/gi },
  { label: 'new-system-prompt', re: /\b(new|updated|real|actual)\s+system\s+prompt\s*:/gi },
  { label: 'role-hijack',       re: /\byou\s+are\s+now\s+(in\s+)?(developer|debug|admin|unrestricted|jailbroken|dan)\s*(mode)?\b/gi },
];

/** Path of today's audit log file (~/.bhatbot/audit/YYYY-MM-DD.log). */
function dailyAuditPath() {
  return path.join(AUDIT_DIR, new Date().toISOString().slice(0, 10) + '.log');
}

/**
 * Append a structured security/notification event to the daily audit log.
 * Never throws — auditing must not break the agent loop.
 * @param {string} kind  e.g. 'sanitize' | 'notify' | 'credential'
 * @param {object} detail  JSON-serializable extra fields
 */
function auditEvent(kind, detail = {}) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(dailyAuditPath(), JSON.stringify({ ts: new Date().toISOString(), kind, ...detail }) + '\n');
  } catch { /* never throw from audit */ }
}

/**
 * Neutralize known prompt-injection patterns in external content before it enters
 * model context. Matches are flagged inline and de-fanged (angle brackets / pipes
 * replaced with fullwidth lookalikes), and each event is audit-logged.
 * @param {string} text  raw external content
 * @param {string} source  origin tag for the audit log (e.g. 'web:<url>', 'shell', 'sms')
 * @returns {string} sanitized text (non-strings pass through untouched)
 */
function sanitizeExternalContent(text, source = 'external') {
  if (typeof text !== 'string' || !text) return text;
  const hits = [];
  let out = text;
  for (const { label, re } of INJECTION_PATTERNS) {
    re.lastIndex = 0;
    let n = 0;
    out = out.replace(re, (m) => {
      n++;
      return '⟦flagged:' + label + '⟧' + m.replace(/</g, '＜').replace(/>/g, '＞').replace(/\|/g, '∣');
    });
    if (n) hits.push(label + '×' + n);
  }
  if (hits.length) auditEvent('sanitize', { source, patterns: hits, sample: text.slice(0, 160) });
  return out;
}

module.exports = { sanitizeExternalContent, auditEvent, dailyAuditPath, AUDIT_DIR };
