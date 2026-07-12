'use strict';
// DaVinci Resolve native bridge. Spawns the bundled Python bridge (assets/resolve_bridge.py),
// which talks to a RUNNING Resolve via the installed DaVinciResolveScript module. Best-effort:
// every failure comes back as { success:false, error } — never throws to the agent loop.
const path = require('path');
const { spawn } = require('child_process');

const BRIDGE = path.join(__dirname, '..', 'assets', 'resolve_bridge.py');
const ACTIONS = ['status', 'list_projects', 'open_project', 'project_info', 'list_timelines', 'timeline_info', 'switch_page', 'add_marker', 'render'];

function python() {
  // Prefer the framework python3 (has the module path); fall back to PATH python3.
  return process.env.RESOLVE_PYTHON || 'python3';
}

function run(action, params = {}, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = spawn(python(), [BRIDGE, JSON.stringify({ action, params })], { env: { ...process.env } });
    } catch (e) { return resolve({ success: false, error: 'could not launch python3: ' + e.message }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ success: false, error: 'DaVinci Resolve bridge timed out (is Resolve running?)' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ success: false, error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out.trim()); } catch { parsed = null; }
      if (!parsed) return resolve({ success: false, error: (err.trim() || out.trim() || 'no response from Resolve bridge').slice(0, 400) });
      if (parsed.error) return resolve({ success: false, error: parsed.error });
      return resolve({ success: true, ...parsed });
    });
  });
}

// Single entry the tool layer calls. Validates the action, forwards the rest as params.
async function resolveTool(input = {}) {
  const action = String(input.action || 'status');
  if (!ACTIONS.includes(action)) return { success: false, error: `unknown DaVinci Resolve action '${action}'. Valid: ${ACTIONS.join(', ')}` };
  const { action: _a, ...params } = input;
  return run(action, params);
}

module.exports = { resolveTool, run, ACTIONS };
