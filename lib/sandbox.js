'use strict';
// Plugin sandboxing (W6). self_heal currently changes BhatBot's own code through a git + verify
// gate (safe). But community-contributed or dynamically-generated TOOLS need to RUN untrusted JS,
// and that must never touch the Electron main process directly. This runs such code in a
// worker_threads Worker: a separate V8 context with no reference to main-process globals, a
// require() restricted to an explicit allowlist, a hard wall-clock timeout (terminate on hang),
// and clean capture of the return value / errors. Mirrors Samuel's (screen-voice-agent) pattern.
//
// runSandboxed(code, input, opts) → Promise<{success:true,result}|{success:false,error}>
//   code   : a JS function BODY. It receives `input` and may `return` (sync or via await) a value.
//   input  : a JSON-serializable argument object.
//   opts   : { timeoutMs=5000, allow:[modules], memoryMb=128 }
//
// Only JSON-serializable values cross the boundary (structured clone). Nothing here can read the
// vault, config, filesystem, or network unless the caller explicitly allowlists 'fs'/'net'/etc —
// the default allowlist is pure-compute only.
const { Worker } = require('worker_threads');

// Safe-by-default: pure-compute built-ins with no ambient authority. fs/net/http/child_process/os
// are intentionally EXCLUDED — a caller must opt in per plugin, and should almost never need to.
const SAFE_DEFAULT = ['crypto', 'path', 'url', 'querystring', 'util', 'buffer', 'string_decoder', 'zlib', 'assert', 'punycode'];

// The worker bootstrap (runs INSIDE the isolated context). It builds a guarded require, runs the
// user body as an async function, and posts back exactly one {ok,result|error} message.
const BOOTSTRAP = `
const { parentPort, workerData } = require('worker_threads');
const { code, input, allow } = workerData;
const Module = require('module');
const realRequire = require;
function guardedRequire(name) {
  const base = String(name).replace(/^node:/, '');
  if (!allow.includes(base)) throw new Error('module not allowed in sandbox: ' + name);
  return realRequire(base);
}
// Remove ambient authority from the worker's globals.
try { delete process.env; } catch {}
try { process.exit = () => { throw new Error('process.exit blocked in sandbox'); }; } catch {}
(async () => {
  try {
    const fn = new Function('input', 'require', 'module', 'process', 'global',
      '"use strict";return (async () => {\\n' + code + '\\n})();');
    const result = await fn(input, guardedRequire, undefined, undefined, undefined);
    // enforce JSON-serializability (also strips functions/cycles before clone)
    parentPort.postMessage({ ok: true, result: JSON.parse(JSON.stringify(result === undefined ? null : result)) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e && e.message ? e.message : e) });
  }
})();
`;

function runSandboxed(code, input = {}, opts = {}) {
  const timeoutMs = Math.max(100, Math.min(60000, opts.timeoutMs || 5000));
  const memoryMb = Math.max(16, Math.min(512, opts.memoryMb || 128));
  const allow = Array.from(new Set([...SAFE_DEFAULT, ...((opts.allow || []).map(String))]));
  if (typeof code !== 'string' || !code.trim()) return Promise.resolve({ success: false, error: 'empty code' });

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { worker.terminate(); } catch {} resolve(v); };
    let worker;
    try {
      worker = new Worker(BOOTSTRAP, {
        eval: true,
        workerData: { code, input: JSON.parse(JSON.stringify(input || {})), allow },
        resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: Math.ceil(memoryMb / 4) },
      });
    } catch (e) { return resolve({ success: false, error: 'spawn failed: ' + (e && e.message) }); }

    const timer = setTimeout(() => finish({ success: false, error: `sandbox timeout after ${timeoutMs}ms` }), timeoutMs);
    worker.on('message', (m) => finish(m && m.ok ? { success: true, result: m.result } : { success: false, error: (m && m.error) || 'unknown error' }));
    worker.on('error', (e) => finish({ success: false, error: 'worker error: ' + (e && e.message) }));
    worker.on('exit', (codeNum) => { if (!done) finish({ success: false, error: 'worker exited (' + codeNum + ') before returning' }); });
  });
}

// Run a registered plugin tool: a {name, code, allow, timeoutMs} descriptor (e.g. from config.plugins
// or a community manifest) against `input`. Thin wrapper so main.js dispatches plugins uniformly.
function runPlugin(plugin, input) {
  if (!plugin || typeof plugin.code !== 'string') return Promise.resolve({ success: false, error: 'invalid plugin' });
  return runSandboxed(plugin.code, input, { allow: plugin.allow, timeoutMs: plugin.timeoutMs, memoryMb: plugin.memoryMb });
}

module.exports = { runSandboxed, runPlugin, SAFE_DEFAULT };
