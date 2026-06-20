'use strict';
// Mac-executor relay. The cloud is the always-on brain; the Mac is an OPTIONAL executor for
// the tools that can only run on the computer (shell, AppleScript, the local browser, screen).
//
// Transport: the MAC dials OUT to the cloud over a WebSocket (so it works even though the Mac
// is tailnet-only / has no public inbound). The cloud keeps the live socket and, when the agent
// calls a Mac-only tool, sends an exec request over it and awaits the reply. If no Mac is
// connected, Mac-only tools resolve to a graceful "computer is offline" instead of hanging.
const crypto = require('crypto');

let macSocket = null;          // the single connected Mac executor (single-user)
let macInfo = null;            // { connectedAt, host }
const pending = new Map();     // reqId → { resolve, timer }
let queue = [];                // commands captured while the Mac is asleep → drained on reconnect
let onDrained = null;          // optional notifier(results[]) — wired to SMS in server.js

function macOnline() { return !!(macSocket && macSocket.readyState === 1); }
function macStatus() { return macOnline() ? { online: true, since: macInfo && macInfo.connectedAt, queued: queue.length } : { online: false, queued: queue.length }; }
function setDrainNotifier(fn) { onDrained = fn; }

// Capture a command for a sleeping Mac so it isn't lost — it runs the moment the Mac reconnects.
function queueExec(tool, input) {
  queue.push({ tool, input, queuedAt: Date.now() });
  return { success: true, queued: true, queueLen: queue.length,
    result: 'Your computer is asleep — I queued this; it will run automatically when the Mac wakes, and I\'ll text you the result.' };
}
async function drainQueue() {
  if (!macOnline() || !queue.length) return;
  const items = queue.splice(0);
  const results = [];
  for (const it of items) {
    const r = await macExec(it.tool, it.input).catch((e) => ({ success: false, error: String(e) }));
    results.push({ tool: it.tool, ok: !!(r && r.success !== false), summary: String((r && (r.result || r.error)) || '').slice(0, 160) });
  }
  if (onDrained && results.length) { try { onDrained(results); } catch {} }
}

// Called by the WS server when a Mac connects on /mac/:token (token already verified).
function attachMac(ws, meta = {}) {
  if (macSocket && macSocket !== ws) { try { macSocket.close(4000, 'replaced'); } catch {} }
  macSocket = ws;
  macInfo = { connectedAt: Date.now(), host: meta.host || '' };
  setTimeout(() => { drainQueue().catch(() => {}); }, 1500);   // run anything queued while it slept
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'result' && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
      p.resolve(msg.result);
    }
    // msg.type === 'pong' / 'hello' → keepalive, ignore
  });
  ws.on('close', () => { if (macSocket === ws) { macSocket = null; macInfo = null; } rejectAll('Mac disconnected'); });
  ws.on('error', () => {});
}
function rejectAll(reason) {
  for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ success: false, error: reason }); pending.delete(id); }
}

// Dispatch a tool to the Mac and await its result (or a graceful offline/timeout error).
function macExec(tool, input, timeoutMs = 60000) {
  if (!macOnline()) return Promise.resolve({ success: false, error: 'Your computer is offline — this needs the Mac awake and connected. I can do it the moment it’s back.', offline: true });
  const id = crypto.randomBytes(8).toString('hex');
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ success: false, error: `Mac timed out after ${Math.round(timeoutMs / 1000)}s on ${tool}.` }); }, timeoutMs);
    pending.set(id, { resolve, timer });
    try { macSocket.send(JSON.stringify({ type: 'exec', id, tool, input })); }
    catch (e) { clearTimeout(timer); pending.delete(id); resolve({ success: false, error: 'Failed to reach Mac: ' + e.message }); }
  });
}

module.exports = { attachMac, macExec, macOnline, macStatus, queueExec, drainQueue, setDrainNotifier };
