#!/usr/bin/env node
'use strict';
// Fast, dependency-light functional tests for the extracted tool factories tools/system.js and
// tools/media.js (browser has its own Playwright-backed test: scripts/test-browser-extract.js).
// Mocks osa/spawn so it runs offline in <1s. Guards the DI-factory contracts + core action paths
// so a future edit can't silently break systemControl / mediaControl. Wired into `npm run verify`.
//   node scripts/test-tools-extract.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

// ---- shared mocks ----
function fakeSpawn(code = 0, stderr = '') {
  return () => {
    const handlers = {};
    const child = {
      stdout: { on: () => {} },
      stderr: { on: (ev, fn) => { if (ev === 'data' && stderr) fn(Buffer.from(stderr)); } },
      on: (ev, fn) => { handlers[ev] = fn; if (ev === 'close') setImmediate(() => fn(code)); },
    };
    return child;
  };
}
const osaTrace = [];
const osaOk = async (args) => { osaTrace.push(args.join(' ')); return { ok: true, out: 'mock-out' }; };
const osaFail = async (args) => { osaTrace.push(args.join(' ')); return { ok: false, out: '', err: 'mock-fail' }; };
const osaErr = (r) => r.err || 'osascript failed';

(async () => {
  // ================= tools/system.js =================
  {
    const make = require('../tools/system');
    ok(typeof make === 'function', 'system: module exports a factory function');
    const sys = make({ spawn: fakeSpawn(0), osa: osaOk, osaErr, EXEC_PATH: '/usr/bin' });
    ok(typeof sys.systemControl === 'function', 'system: factory returns systemControl');

    osaTrace.length = 0;
    let r = await sys.systemControl({ action: 'notification', title: 'T', text: 'hi' });
    ok(r.success && /display notification/.test(osaTrace.join('')), 'system: notification → osa display notification');

    r = await sys.systemControl({ action: 'keystroke', text: 'x' });
    ok(r.success && /keystroke "x"/.test(osaTrace.join('')), 'system: keystroke → osa keystroke');

    r = await sys.systemControl({ action: 'clipboard_get' });
    ok(r.success, 'system: clipboard_get → success');

    r = await sys.systemControl({ action: 'open_app', app: 'Safari' });
    ok(r.success && /Opened Safari/.test(r.result), 'system: open_app → uses spawn(open -a), success on exit 0');

    r = await sys.systemControl({ action: 'menu', app: 'X', menuPath: ['File'] });
    ok(r.success === false && /menuPath/.test(r.error), 'system: menu w/ short path → graceful error');

    r = await sys.systemControl({ action: 'bogus' });
    ok(r.success === false && /Unknown action/.test(r.error), 'system: unknown action → graceful error');

    // open_app failure path (spawn exits non-zero)
    const sysFail = make({ spawn: fakeSpawn(1, 'nope'), osa: osaOk, osaErr, EXEC_PATH: '/usr/bin' });
    r = await sysFail.systemControl({ action: 'open_app', app: 'Nope' });
    ok(r.success === false && /Unable to open|nope/.test(r.error), 'system: open_app non-zero exit → error surfaced');

    // osa failure path
    const sysOsaFail = make({ spawn: fakeSpawn(0), osa: osaFail, osaErr, EXEC_PATH: '/usr/bin' });
    r = await sysOsaFail.systemControl({ action: 'notification', text: 'x' });
    ok(r.success === false && r.error === 'mock-fail', 'system: osa failure → osaErr surfaced');
  }

  // ================= tools/media.js =================
  {
    const make = require('../tools/media');
    ok(typeof make === 'function', 'media: module exports a factory function');
    let savedPatch = null;
    const mk = (cfg) => make({ loadConfig: () => cfg, saveConfig: (p) => { savedPatch = p; }, osa: osaOk, osaErr });
    const m = mk({});
    ok(typeof m.mediaControl === 'function', 'media: factory returns mediaControl');

    osaTrace.length = 0;
    let r = await m.mediaControl({ action: 'set_system_volume', volume: 30 });
    ok(r.success && /set volume output volume 30/.test(osaTrace.join('')), 'media: set_system_volume → osa volume');

    r = await m.mediaControl({ action: 'pause' });
    ok(r.success && /pause/.test(osaTrace.join('')), 'media: pause → osa Spotify pause');

    // no creds → play by name falls back to opening in-app search (graceful, no throw)
    r = await m.mediaControl({ action: 'play_track', query: 'some song' });
    ok(r.success && /Opened Spotify search/.test(r.result), 'media: play_track w/o creds → in-app search fallback');

    r = await m.mediaControl({ action: 'list_devices' });
    ok(r.success === false && /not linked/.test(r.error), 'media: list_devices w/o Connect → graceful error');

    r = await m.mediaControl({ action: 'make_playlist', name: 'X' });
    ok(r.success === false && /not linked/.test(r.error), 'media: make_playlist w/o Connect → graceful error');

    r = await m.mediaControl({ action: 'bogus' });
    ok(r.success === false && /Unknown action/.test(r.error), 'media: unknown action → graceful error');
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
