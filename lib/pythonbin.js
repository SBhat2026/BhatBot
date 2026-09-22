'use strict';
// ── WHICH PYTHON? ─────────────────────────────────────────────────────────────────────────────────
// "python3" on PATH is whichever one happens to be first, and on this machine that is not a stable
// fact: a Homebrew python without Pillow, a framework python with it, and whatever a venv activation
// left behind all answer to the same name. A bare `python3` therefore works until the day it does
// not, and the failure reads as "the tool is broken" rather than "the wrong interpreter answered".
// It cost a false verify failure in this repo already, and lib/filetools.js has been flagged by
// scripts/toolcheck.js on every single run for exactly this.
//
// THE RULE: the right python is the one that can import what the caller needs. Not the first on
// PATH, not a hardcoded path, and not "the one the TTS uses" — main.js resolves its interpreter by
// probing for `kokoro_onnx`, which proves nothing about Pillow. So the module to import IS the
// argument, and each caller gets an interpreter proven to satisfy its own dependency.
const fs = require('fs');
const { spawnSync } = require('child_process');

// Ordered by how likely they are to be the deliberately-provisioned one rather than an accident.
// A configured path wins outright; the framework builds come next because that is where this
// machine's science stack lives; PATH is last precisely because it is the least predictable.
function candidates(configBin) {
  const out = [];
  if (configBin) out.push(configBin);
  out.push(
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    'python3',
  );
  return [...new Set(out)];
}

const _cache = new Map();   // requires → resolved path

/**
 * resolve({ requires, configBin, timeoutMs }) → { bin, proven, tried }
 *
 * `proven` is the part that matters: TRUE means this interpreter was observed importing the module,
 * FALSE means nothing could and the caller is getting a best guess. A caller that needs to explain
 * a failure can say which it was, instead of reporting "python3 failed" and leaving the user to
 * work out that there are four of them.
 */
function resolve({ requires = '', configBin = '', timeoutMs = 8000 } = {}) {
  const key = requires || '(any)';
  if (_cache.has(key)) return _cache.get(key);

  const list = candidates(configBin);
  const tried = [];
  for (const p of list) {
    try {
      // A bare name has to be probed rather than stat'd — it is resolved by PATH, not by the disk.
      if (p.includes('/') && !fs.existsSync(p)) continue;
      const probe = requires ? ['-c', `import ${requires}`] : ['-c', 'pass'];
      const t = spawnSync(p, probe, { timeout: timeoutMs });
      tried.push({ bin: p, status: t.status });
      if (t.status === 0) {
        const r = { bin: p, proven: true, tried };
        _cache.set(key, r);
        return r;
      }
    } catch { tried.push({ bin: p, status: 'threw' }); }
  }
  // Nothing could import it. Return the first interpreter that at least EXISTS, and say plainly that
  // the dependency is unproven — a wrong answer that announces itself beats a silent one.
  const first = list.find((p) => !p.includes('/') || fs.existsSync(p)) || 'python3';
  const r = { bin: first, proven: false, tried,
    why: requires ? `no interpreter could "import ${requires}" — install it, or set config.pythonBin` : 'no interpreter found' };
  _cache.set(key, r);
  return r;
}

/** Forget what was resolved — for tests, and after a config change. */
function reset() { _cache.clear(); }

module.exports = { resolve, reset, candidates };
