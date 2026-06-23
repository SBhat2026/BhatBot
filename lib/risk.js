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
const CONFIRM_TOOLS = new Set([
  'write_file', 'system_control', 'notion_write', 'manage_jobs', 'manage_schedule',
  'studio_write', 'write_agent_directive', 'manage_logins',
]);

// Highest blast radius: modify BhatBot's OWN code / run arbitrary code. Force a human every time.
const STEPUP_TOOLS = new Set([
  'self_fix', 'self_heal', 'self_improve', 'claude_code',
]);

// Credential/secret-touching: safe locally (vault never reaches the model), but over a remote
// channel a human must be present, so these escalate to stepup when channel === 'remote'.
const SECRET_TOOLS = new Set([
  'smart_login', 'keychain_lookup', 'onepassword_lookup', 'generate_totp',
]);

function riskOf(tool, _input, channel) {
  if (STEPUP_TOOLS.has(tool)) return 'stepup';
  if (channel === 'remote' && SECRET_TOOLS.has(tool)) return 'stepup';
  if (CONFIRM_TOOLS.has(tool)) return 'confirm';
  return 'auto';
}

module.exports = { riskOf, CONFIRM_TOOLS, STEPUP_TOOLS, SECRET_TOOLS };
