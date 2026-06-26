'use strict';
// Mac → Cloud executor bridge. The cloud is the always-on brain; this makes the Mac its
// OPTIONAL executor for computer-only tools (shell, AppleScript, local browser, screen, etc.).
//
// The Mac dials OUT to the cloud over a WebSocket (so it works even though the Mac is
// tailnet-only / has no public inbound). The cloud sends {type:'exec', id, tool, input}; we
// run it through the SAME executeTool the desktop/phone use and reply {type:'result', id, result}.
// Auto-reconnects with backoff so it self-heals across sleep/wake and redeploys.
let WebSocket;
try { WebSocket = require('ws'); } catch { /* ws not installed → bridge disabled */ }

let ws = null, stopped = false, backoff = 1000, pingTimer = null;

// url: the cloud base (https://bhatbot-cloud.fly.dev) — converted to wss automatically.
function start({ url, token, executeTool, log = () => {} }) {
  if (!WebSocket) { log('[cloud-bridge] ws module missing — bridge disabled'); return { stop() {} }; }
  if (!url || !token) { log('[cloud-bridge] not configured (need cloudUrl + cloudToken)'); return { stop() {} }; }
  stopped = false;
  const wsUrl = url.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/mac/' + token;

  function connect() {
    if (stopped) return;
    log('[cloud-bridge] connecting → ' + wsUrl.replace(token, token.slice(0, 6) + '…'));
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      backoff = 1000;
      log('[cloud-bridge] connected — Mac is now the cloud executor');
      try { ws.send(JSON.stringify({ type: 'hello', host: require('os').hostname() })); } catch {}
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.readyState === 1 && ws.ping(); } catch {} }, 25000);
    });

    ws.on('message', async (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== 'exec' || !msg.id) return;
      let result;
      try { result = await executeTool(msg.tool, msg.input || {}); }
      catch (e) { result = { success: false, error: String(e && e.message ? e.message : e) }; }
      // Strip heavy inline image payloads — the cloud only needs the structured result text.
      if (result && result._image) { const { _image, _imageMime, ...rest } = result; result = { ...rest, _imageOmitted: true }; }
      try { ws.send(JSON.stringify({ type: 'result', id: msg.id, result })); } catch {}
    });

    ws.on('close', () => { clearInterval(pingTimer); if (!stopped) scheduleReconnect(); });
    ws.on('error', (e) => { log('[cloud-bridge] error: ' + e.message); try { ws.close(); } catch {} });
  }
  function scheduleReconnect() {
    backoff = Math.min(backoff * 2, 30000);
    setTimeout(connect, backoff + Math.random() * 500);
  }

  connect();
  // send(obj): fire-and-forget push to the cloud brain (e.g. agent-log relay). No-op until the
  // socket is open — agent logs are ephemeral situational data, not worth buffering across reconnects.
  function send(obj) { try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } } catch {} return false; }
  return { stop() { stopped = true; clearInterval(pingTimer); try { ws && ws.close(); } catch {} }, send };
}

module.exports = { start };
