#!/usr/bin/env node
'use strict';
// A 40-line static server so the 3D office can be watched WITHOUT launching Electron.
//
// src/presence.html is an ordinary ES-module page: three.js, the GLBs and the draco decoder are all
// vendored locally and every path in it is relative. The only thing it needs from the app is a
// roster, which it takes over postMessage. So serving src/ over http and posting the roster from a
// parent frame is the whole of the integration — the scene file itself is untouched, which matters,
// because a scene that only renders inside Electron cannot be checked against a headless run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SRC = path.join(__dirname, '..', '..', 'src');
const LIVE = path.join(os.homedir(), '.bhatbot', 'experiments', 'live.json');
const PORT = Number(process.env.PORT || 7391);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  // The live roster is the one thing not on disk under src/ — it is written by the experiment runner.
  if (url === '/live.json') {
    let body = '{"agents":[],"transcript":[]}';
    try { body = fs.readFileSync(LIVE, 'utf8'); } catch {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(body);
  }
  const rel = url === '/' ? '/proto/experiment.html' : url;
  const file = path.join(SRC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(SRC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found: ' + rel);
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`office → http://localhost:${PORT}/`));
