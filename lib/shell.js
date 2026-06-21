'use strict';
// Shell execution + destructive-command safety (SPLIT_PLAN step 7 — the classifier payoff).
// Isolating the raw exec() surface and the HARD_BLOCKED catastrophic-pattern list keeps the shell
// blast-radius in one small, reviewable module instead of co-located with the agent loop, creds,
// and system control in main.js. The confirm/autonomous/remote GATING stays in main.js (it's woven
// into the IPC + activity-window state); this module owns only the execution primitive + the
// pattern lists those gates consult.
//
// DI factory: main.js injects EXEC_PATH (its augmented PATH so spawned tools resolve homebrew/python).
const { exec } = require('child_process');
const os = require('os');

module.exports = function makeShell({ EXEC_PATH }) {
  // Catastrophic patterns that are NEVER allowed, even in autonomous mode.
  const HARD_BLOCKED = [
    /rm\s+-rf\s+\/(?:\s|$)/,
    /:\(\)\{.*\}/,
    /mkfs\./,
    /dd\s+if=.*of=\/dev\/(sd|disk)/,
  ];
  // Destructive-but-sometimes-legitimate patterns → require confirmation (gate lives in main.js).
  const CONFIRM_PATTERNS = [
    { re: /\brm\b/, reason: 'This will permanently delete files.' },
    { re: /\brmdir\b/, reason: 'This will remove a directory.' },
    { re: /\btrash\b/, reason: 'This will move files to Trash.' },
  ];

  function runShell(command, cwd, timeoutMs) {
    return new Promise((resolve) => {
      exec(command, { cwd: cwd || os.homedir(), timeout: timeoutMs || 60000, env: { ...process.env, PATH: EXEC_PATH }, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && err.killed) return resolve({ success: false, error: `Command timed out (${Math.round((timeoutMs || 60000) / 1000)}s)` });
          resolve({ success: !err, stdout: stdout || '', stderr: stderr || '', exitCode: err ? err.code : 0 });
        });
    });
  }

  return { HARD_BLOCKED, CONFIRM_PATTERNS, runShell };
};
