'use strict';
// Boot. Loads a local .env (dev convenience; on Fly/Railway use real env/secrets), then
// starts the HTTP+WS server and the proactive scheduler.
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency) — only for local dev. Never commit .env.
(function loadEnv() {
  const f = path.join(__dirname, '..', '.env');
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    console.log('[bhatbot-cloud] loaded .env');
  } catch { /* no .env — using real env vars */ }
})();

require('./server').start();
