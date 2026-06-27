#!/usr/bin/env node
'use strict';
// Functional test for tools/browser.js WITHOUT Electron — drives the extracted browserAction /
// browserWorkflow against a real headless Playwright Chromium, using stub ctx closures that mirror
// what main.js injects. Verifies the relocated logic (navigate/get_text/screenshot/evaluate +
// workflow record/save/list/show/replay/delete + the page/recording accessor wiring) end-to-end.
// Runs in plain node, so it sidesteps the macOS keychain modal that blocks dev Electron boots.
//   node scripts/test-browser-extract.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

(async () => {
  const WORKFLOW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-wf-'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // recording state mirrors main's module-scoped `let recordingSteps` + rec* closures
  let recordingSteps = null;
  let resetCalls = 0, closeCalls = 0;

  const ctx = {
    getPage: () => page,
    resetBrowser: () => { resetCalls++; },
    closeBrowser: async () => { closeCalls++; },
    ensureBrowser: async () => {},          // page already created in the test
    saveBrowserState: () => {},
    dismissInterruptions: async () => {},
    visionClickByText: async () => false,
    scheduleSaveBounds: () => {},
    agentActing: async () => {},
    waitForUserIdle: async () => {},
    sendToActivity: () => {},
    openActivityWindow: () => {},
    loadConfig: () => ({ browserYield: false }),
    recGet: () => recordingSteps,
    recPush: (s) => { if (recordingSteps) recordingSteps.push(s); },
    recStart: () => { recordingSteps = []; },
    recStop: () => { recordingSteps = null; },
    WORKFLOW_DIR,
    wfPath: (name) => path.join(WORKFLOW_DIR, String(name).replace(/[^\w.-]/g, '_') + '.json'),
  };

  const { browserAction, browserWorkflow } = require('../tools/browser')(ctx);

  const HTML = 'data:text/html,<title>BB Test</title><body><h1 id="h">hello world</h1><input id="box"></body>';

  // --- browserAction ---
  const nav = await browserAction({ action: 'navigate', url: HTML });
  ok(nav.success && /BB Test/.test(nav.title), 'navigate → success + page title');
  ok(typeof nav._image === 'string' && nav._image.length > 100, 'navigate → returns base64 screenshot (_image)');

  const txt = await browserAction({ action: 'get_text', selector: '#h' });
  ok(txt.success && txt.text.includes('hello world'), 'get_text → reads element text');

  const ss = await browserAction({ action: 'screenshot' });
  ok(ss.success && typeof ss._image === 'string', 'screenshot → returns _image');

  const ev = await browserAction({ action: 'evaluate', js: '1 + 1' });
  ok(ev.success && ev.result === 2, 'evaluate → returns computed value');

  const typed = await browserAction({ action: 'type', selector: '#box', text: 'abc' });
  const boxVal = await page.inputValue('#box').catch(() => '');
  ok(typed.success && boxVal === 'abc', 'type → fills input (real page mutated)');

  const bad = await browserAction({ action: 'frobnicate' });
  ok(bad.success === false && /Unknown browser action/.test(bad.error), 'unknown action → graceful error');

  // --- browserWorkflow record/replay (exercises rec* closures + page accessor) ---
  let r = await browserWorkflow({ action: 'start_recording' });
  ok(r.success && Array.isArray(recordingSteps), 'start_recording → recStart sets array');

  await browserAction({ action: 'navigate', url: HTML });   // rec() pushes a navigate step
  ok(recordingSteps && recordingSteps.length === 1 && recordingSteps[0].action === 'navigate',
    'browserAction during recording → recPush captured the step');

  r = await browserWorkflow({ action: 'save_workflow', name: 'bb test wf', description: 'unit' });
  ok(r.success && recordingSteps === null, 'save_workflow → writes file + recStop nulls recording');
  ok(fs.existsSync(ctx.wfPath('bb test wf')), 'save_workflow → workflow JSON exists on disk');

  r = await browserWorkflow({ action: 'list_workflows' });
  ok(r.success && /bb test wf/.test(r.result), 'list_workflows → lists saved workflow');

  r = await browserWorkflow({ action: 'show_workflow', name: 'bb test wf' });
  ok(r.success && /navigate/.test(r.result), 'show_workflow → returns saved steps');

  r = await browserWorkflow({ action: 'replay_workflow', name: 'bb test wf' });
  ok(r.success && /Replayed/.test(r.result), 'replay_workflow → re-runs browserAction steps');

  r = await browserWorkflow({ action: 'save_workflow' });   // nothing recorded now
  ok(r.success === false && /Nothing recorded/.test(r.error), 'save_workflow w/o recording → graceful error');

  r = await browserWorkflow({ action: 'delete_workflow', name: 'bb test wf' });
  ok(r.success && !fs.existsSync(ctx.wfPath('bb test wf')), 'delete_workflow → removes file');

  r = await browserWorkflow({ action: 'replay_workflow', name: 'nope' });
  ok(r.success === false && /not found/.test(r.error), 'replay missing workflow → graceful error');

  await browser.close();
  try { fs.rmSync(WORKFLOW_DIR, { recursive: true, force: true }); } catch {}

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
