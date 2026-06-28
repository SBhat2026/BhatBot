'use strict';
// Key-risk classification for tool auto-approval (W3). Replaces the all-or-nothing autonomousMode
// with three per-tool tiers, so ordinary autonomy is preserved while the genuinely dangerous
// actions get a gate that fits the risk + the channel:
//
//   'auto'    — read-only / media / low-blast-radius. Runs silently (today's behaviour).
//   'confirm' — mutating local state. Silently auto-approved when autonomousMode is ON and LOCAL
//               (so the user's hands-free flow is unchanged), but DENIED over a remote/phone
//               channel unless config.remoteAllowDestructive (extends the existing remote-shell
//               guard to all remote writes/system control), and shows a card when autonomy is off.
//   'stepup'  — code-modifying tools, and credential/secret tools when remote. ALWAYS requires a
//               human (a confirmation card even with autonomousMode on); denied over remote unless
//               explicitly opted in. The hook where live voice-biometric step-up (lib/voiceid) lands.
//
// run_shell is deliberately 'auto' HERE — its own HARD_BLOCKED + CONFIRM_PATTERNS gate inside
// executeTool inspects the actual command (far better signal than the tool name), so gating it at
// the tool level too would double-prompt. HARD_BLOCKED always remains in force regardless of tier.
//
// Pure + dependency-free: riskOf(tool, input, channel) → 'auto'|'confirm'|'stepup'. channel is
// 'remote' when the turn is driven headless from the phone/funnel, else 'desktop'.

// Mutating-but-routine: fine to auto-run locally under autonomy, but should be gated over remote.
// `claude_code` (drive the embedded Claude Code to write+run code) lives here so it runs AUTONOMOUSLY
// on the local desktop under autonomousMode — consistent with run_shell, which already executes
// arbitrary shell autonomously (Claude Code actually has stronger built-in guardrails than raw bash).
// It is still forced to a human over a REMOTE channel (see REMOTE_STEPUP_TOOLS) — nobody at the
// keyboard shouldn't kick off arbitrary code from the phone.
const CONFIRM_TOOLS = new Set([
  'write_file', 'system_control', 'notion_write', 'manage_jobs', 'manage_schedule',
  'studio_write', 'write_agent_directive', 'manage_logins', 'claude_code',
]);

// Highest blast radius: tools that modify BhatBot's OWN code. Force a human every time, every channel
// — these rewrite the running agent, so the last human check stays (self_heal also has its own
// verify-gate + auto-revert rails). NOT claude_code: that runs code in a workspace, it doesn't
// self-modify the agent, and the user asked for it to be autonomous.
const STEPUP_TOOLS = new Set([
  'self_fix', 'self_heal', 'self_improve', 'self_drive',
]);

// Credential/secret-touching: safe locally (vault never reaches the model), but over a remote
// channel a human must be present, so these escalate to stepup when channel === 'remote'.
const SECRET_TOOLS = new Set([
  'smart_login', 'keychain_lookup', 'onepassword_lookup', 'generate_totp',
]);

// Locally autonomous, but arbitrary-code execution from a headless REMOTE channel still needs a human.
const REMOTE_STEPUP_TOOLS = new Set([
  'claude_code',
]);

function riskOf(tool, _input, channel) {
  if (STEPUP_TOOLS.has(tool)) return 'stepup';
  if (channel === 'remote' && (SECRET_TOOLS.has(tool) || REMOTE_STEPUP_TOOLS.has(tool))) return 'stepup';
  if (CONFIRM_TOOLS.has(tool)) return 'confirm';
  return 'auto';
}

// ── Phase 6: DESIRE classification + FROZEN-ZONE gate for the self-drive governor ───────────────
// selfdrive can modify BhatBot's own source. The ENTIRE safety model is this gate plus the frozen
// zone — they are the belt, not belt-and-suspenders. Built to be adversarially testable, because
// eventually the loop is smart enough to notice risk.js is what blocks it.
//
// FROZEN ZONE — files selfdrive may NEVER edit. Enforced by FILE-LIST INSPECTION here, BEFORE
// claude_code is ever invoked (a coder running --dangerously-skip-permissions cannot be trusted to
// self-enforce an instruction). Includes the loop's own governor + gatekeeper + verify rails + the
// rate limiter + all credential/secret handling, so it can't weaken the very checks that contain it.
const FROZEN_ZONE = [
  'lib/selfdrive.js',          // cannot rewrite its own governor
  'lib/risk.js',               // cannot weaken its own gatekeeper
  'lib/selfheal.js',           // cannot modify the verify-revert rails
  'lib/security.js',           // cannot touch sanitization / secret redaction
  'lib/credentials.js',        // cannot touch credential handling
  'lib/admission.js',          // cannot expand its own rate limits
  'scripts/verify-syntax.js',  // cannot disable syntax/contract checking
  'scripts/test-upgrade.js',   // cannot weaken its own test suite
  'config.json', '.env', 'credentials',
];

// Does a planned/changed file list touch the frozen zone? → { blocked, hits }. A bare path match
// (substring) is intentional so 'lib/risk.js' catches './lib/risk.js', 'bhatbot/lib/risk.js', etc.
function checkFrozen(fileList) {
  const files = (Array.isArray(fileList) ? fileList : String(fileList || '').split(/\s+/)).map((f) => String(f || '').trim()).filter(Boolean);
  const hits = files.filter((f) => FROZEN_ZONE.some((z) => f.includes(z)));
  return { blocked: hits.length > 0, hits: [...new Set(hits)] };
}

// Files a desire implicates (its implementation hints). Used by classifyDesire + the preflight gate.
function desireFiles(desire) {
  const impl = (desire && desire.implementation) || {};
  return [].concat(impl.modules_affected || [], impl.new_modules || []).map((f) => String(f || '').trim()).filter(Boolean);
}

// Patterns that mark a desire as touching safety/permissions (→ GUARDRAIL) or external infra (→ INFRA).
const GUARDRAIL_RE = /\b(guardrail|frozen[- ]?zone|risk\.js|selfdrive|self[- ]?heal|kill[- ]?switch|verify gate|disable (the )?(verify|test|check|gate)|weaken|bypass|expand (the )?(permission|limit|rate|budget)|skip permission|dangerously|lift (the )?(cap|limit)|remove (the )?(guard|gate|check))\b/i;
const INFRA_RE = /\b(deploy|cloud|fly\.io|wrangler|cloudflare|credential|api[- ]?key|secret|\.env|dns|domain|webhook|twilio|stripe|elevenlabs key|external service|production)\b/i;
const STRUCT_RE = /\b(schema|data ?model|format|protocol|migrat|architecture|refactor (the )?(system|core|pipeline)|change (the )?(memory|history|router) (format|schema|structure))\b/i;

// Classify a desire before the pipeline runs. → { level, decision, reason, files }
//   LOCAL          proceed          — one/two modules, additive, verify-testable
//   STRUCTURAL     proceed_caution  — 3+ modules / schema-level (ECHO concern threshold lowered)
//   GUARDRAIL      block            — touches the frozen zone or weakens a safety check (NEVER automate)
//   INFRASTRUCTURE block            — cloud/credential/external (needs a human)
function classifyDesire(desire) {
  const files = desireFiles(desire);
  const text = [desire && desire.aspiration, desire && desire.implementation && desire.implementation.summary,
    (desire && desire.evidence || []).join(' ')].filter(Boolean).join(' ');
  const frozen = checkFrozen(files);
  if (frozen.blocked || GUARDRAIL_RE.test(text) || files.some((f) => f.includes('selfdrive') || f.includes('risk.js')))
    return { level: 'GUARDRAIL', decision: 'block', reason: frozen.blocked ? 'touches frozen zone: ' + frozen.hits.join(', ') : 'weakens a safety/permission control', files };
  if (INFRA_RE.test(text))
    return { level: 'INFRASTRUCTURE', decision: 'block', reason: 'cloud/credential/external change — needs a human', files };
  if (files.length >= 3 || STRUCT_RE.test(text))
    return { level: 'STRUCTURAL', decision: 'proceed_caution', reason: files.length >= 3 ? `touches ${files.length} modules` : 'schema/architecture-level change', files };
  return { level: 'LOCAL', decision: 'proceed', reason: 'localized, verify-testable improvement', files };
}

// ECHO (the adversarial reviewer) ends its critique with a severity. severe always halts the desire;
// for STRUCTURAL the threshold is LOWERED so 'high' also halts (caution flag). → true = HALT this desire.
function severeConcern(severity, level) {
  const s = String(severity || '').toLowerCase();
  if (s === 'severe' || s === 'critical' || s === 'blocker') return true;
  if (level === 'STRUCTURAL' && (s === 'high' || s === 'serious')) return true;
  return false;
}

module.exports = {
  riskOf, CONFIRM_TOOLS, STEPUP_TOOLS, SECRET_TOOLS, REMOTE_STEPUP_TOOLS,
  FROZEN_ZONE, checkFrozen, desireFiles, classifyDesire, severeConcern,
};
