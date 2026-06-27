'use strict';
// Browser tools — agent-driven Playwright actions (browserAction) + workflow record/replay
// (browserWorkflow). Extracted from main.js (SPLIT_PLAN step 6). The browser ROOT state
// (page/browser/context/launching) and `ensureBrowser` stay in main.js as the single source
// of truth; this module reaches them only through injected accessor/reset closures, so there is
// no second copy of the state to drift. `recordingSteps` is likewise main-owned (the page-event
// handler onUserBrowserEvent also writes it) and reached via rec* closures.
//   ctx = { getPage, resetBrowser, closeBrowser, ensureBrowser, saveBrowserState,
//           dismissInterruptions, visionClickByText, scheduleSaveBounds, agentActing,
//           waitForUserIdle, sendToActivity, openActivityWindow, loadConfig,
//           recGet, recPush, recStart, recStop, WORKFLOW_DIR, wfPath }
const fs = require('fs');
const { textHintFromSelector } = require('../lib/pure');

module.exports = function makeBrowserTools(ctx) {
  const {
    getPage, resetBrowser, closeBrowser, ensureBrowser, saveBrowserState,
    dismissInterruptions, visionClickByText, scheduleSaveBounds, agentActing,
    waitForUserIdle, sendToActivity, openActivityWindow, loadConfig,
    recGet, recPush, recStart, recStop, WORKFLOW_DIR, wfPath,
  } = ctx;

async function browserAction(input) {
  openActivityWindow();
  try { await ensureBrowser(); }
  catch (e) {
    resetBrowser();
    return { success: false, error: `Browser failed to launch: ${e.message.split('\n')[0]}. Fix: run \`cd ~/bhatbot && npx playwright install chromium\` once.` };
  }
  const page = getPage();
  // Screenshots stream to the activity window AND are returned as `_image`
  // (base64). agentLoop turns `_image` into a real vision image block so Claude
  // sees the page, then evicts old images so we don't re-bomb the rate limit.
  const shot = async () => {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
    const b64 = buf.toString('base64');
    sendToActivity('screenshot', { data: b64 });
    return b64;
  };
  // While recording a workflow, capture the replayable mutating steps (not screenshots/reads).
  const rec = (step) => recPush(step);
  // Watch-my-mouse: before any action that changes the page, YIELD until Siddhant has finished
  // interacting, then mark our own action so the observer doesn't log it as his.
  const isMut = ['navigate', 'click', 'type', 'login', 'evaluate'].includes(input.action);
  if (isMut && loadConfig().browserYield !== false) await waitForUserIdle(loadConfig().browserYieldMs || 1500);
  if (isMut) await agentActing(true);
  scheduleSaveBounds();                          // remember where the window is, debounced
  try {
    switch (input.action) {
      case 'navigate':
        await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await dismissInterruptions(page);        // clear cookie/consent banners that cover content
        rec({ action: 'navigate', url: input.url });
        return { success: true, url: page.url(), title: await page.title(), _image: await shot() };
      case 'click': {
        let via;
        try { await page.click(input.selector, { timeout: 15000 }); }
        catch (e) {
          if (!await visionClickByText(textHintFromSelector(input.selector))) throw e;
          via = 'vision-fallback';                // selector drifted → recovered via OmniParser
        }
        rec({ action: 'click', selector: input.selector });
        return { success: true, via, _image: await shot() };
      }
      case 'type': {
        let via;
        try { await page.fill(input.selector, input.text); }
        catch (e) {
          if (!await visionClickByText(textHintFromSelector(input.selector))) throw e;
          await page.keyboard.type(String(input.text || ''), { delay: 20 });
          via = 'vision-fallback';
        }
        rec({ action: 'type', selector: input.selector, text: input.text });
        return { success: true, via, _image: await shot() };
      }
      case 'screenshot':
        return { success: true, note: 'Screenshot captured.', _image: await shot() };
      case 'get_text': {
        const txt = await page.innerText(input.selector || 'body');
        return { success: true, text: txt.slice(0, 6 * 1024) };
      }
      case 'evaluate':
        rec({ action: 'evaluate', js: input.js });
        return { success: true, result: await page.evaluate(input.js) };
      case 'login': {
        // credRef has already been resolved to the real password by executeTool's
        // CRED_REF auto-resolution before we get here; never logged or recorded.
        if (input.url) await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const pw = String(input.credRef || input.password || '');
        const USER_SEL = 'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[type="text"]:not([type="hidden"])';
        const NEXT_SEL = 'button[type="submit"], input[type="submit"], button[id*="next" i], button[id*="continue" i], button[name*="next" i], [aria-label*="next" i], button:has-text("Next"), button:has-text("Continue"), button:has-text("Sign in")';
        const SUBMIT_SEL = 'button[type="submit"], input[type="submit"], button[name*="log" i], button[id*="log" i], button[name*="sign" i], button:has-text("Sign in"), button:has-text("Log in")';
        let passField = await page.$('input[type="password"]:not([type="hidden"])');
        // Two-step flow (Google / Microsoft / GitHub-style): the password field isn't on the
        // first page — fill the username, click Next/Continue, then wait for it to appear.
        if (!passField && input.username) {
          const uf = await page.$(USER_SEL);
          if (uf) {
            await uf.fill(String(input.username));
            const next = await page.$(NEXT_SEL);
            if (next) await next.click().catch(() => {}); else await uf.press('Enter').catch(() => {});
            // Password field can render on a new page or be revealed in place.
            passField = await page.waitForSelector('input[type="password"]:not([type="hidden"])', { state: 'visible', timeout: 12000 }).catch(() => null);
          }
        }
        if (!passField) return { success: false, error: 'No password field found (single- or two-step). The page may use a captcha, passkey, or an unrecognized form.', _image: await shot() };
        // Single-step page that still has a username field → fill it before the password.
        if (input.username) { const uf2 = await page.$(USER_SEL); if (uf2) { const v = await uf2.inputValue().catch(() => ''); if (!v) await uf2.fill(String(input.username)).catch(() => {}); } }
        await passField.fill(pw);
        let submitted = false;
        const btn = await page.$(SUBMIT_SEL);
        if (btn) { await btn.click().catch(() => {}); submitted = true; }
        else { await passField.press('Enter').catch(() => {}); submitted = true; }
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        // Heuristic success check: a remaining visible password field usually means the
        // credentials were rejected (or a 2FA/captcha step is now required).
        const stillPw = await page.$('input[type="password"]:not([type="hidden"])').catch(() => null);
        const likelyFailed = !!stillPw;
        if (!likelyFailed) saveBrowserState();   // persist the session so this login survives next launch
        // Do NOT rec() — would persist the secret into a workflow file.
        return { success: true, submitted, loginLikelyComplete: !likelyFailed, note: likelyFailed ? 'A password field is still visible — login may have failed, or a 2FA/captcha step is now required (try generate_totp).' : undefined, url: page.url(), title: await page.title().catch(() => ''), _image: await shot() };
      }
      default:
        return { success: false, error: 'Unknown browser action' };
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    // A dead/crashed page can't recover in place — reset so the next call relaunches clean.
    if (/Target closed|crashed|Browser has been closed|Execution context was destroyed/i.test(msg)) { await saveBrowserState(); await closeBrowser(); resetBrowser(); }
    return { success: false, error: `Browser ${input.action} failed: ${msg.split('\n')[0]}` };
  } finally {
    if (isMut) await agentActing(false);
  }
}

async function browserWorkflow(input) {
  const a = input.action;
  try {
    if (a === 'start_recording') { recStart(); return { success: true, result: 'Recording browser steps. Perform the task, then save_workflow.' }; }
    if (a === 'save_workflow') {
      const rs = recGet();
      if (!rs || !rs.length) return { success: false, error: 'Nothing recorded — start_recording first, then do browser actions.' };
      if (!input.name) return { success: false, error: 'name required' };
      fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
      const wf = { name: input.name, description: input.description || '', created: new Date().toISOString(), steps: rs };
      fs.writeFileSync(wfPath(input.name), JSON.stringify(wf, null, 2));
      const n = rs.length; recStop();
      return { success: true, result: `Saved workflow "${input.name}" (${n} steps).` };
    }
    if (a === 'cancel_recording') { recStop(); return { success: true, result: 'Recording cancelled.' }; }
    if (a === 'list_workflows') {
      if (!fs.existsSync(WORKFLOW_DIR)) return { success: true, result: 'No workflows yet.' };
      const items = fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.json')).map((f) => {
        try { const w = JSON.parse(fs.readFileSync(require('path').join(WORKFLOW_DIR, f), 'utf8')); return `• ${w.name} (${(w.steps || []).length} steps)${w.description ? ' — ' + w.description : ''}`; } catch { return '• ' + f; }
      });
      return { success: true, result: items.length ? items.join('\n') : 'No workflows yet.' };
    }
    if (a === 'show_workflow') {
      if (!input.name || !fs.existsSync(wfPath(input.name))) return { success: false, error: 'workflow not found' };
      return { success: true, result: fs.readFileSync(wfPath(input.name), 'utf8') };
    }
    if (a === 'delete_workflow') {
      if (!input.name || !fs.existsSync(wfPath(input.name))) return { success: false, error: 'workflow not found' };
      fs.unlinkSync(wfPath(input.name)); return { success: true, result: `Deleted "${input.name}".` };
    }
    if (a === 'replay_workflow') {
      if (!input.name || !fs.existsSync(wfPath(input.name))) return { success: false, error: 'workflow not found' };
      const wf = JSON.parse(fs.readFileSync(wfPath(input.name), 'utf8'));
      const log = []; let lastImage;
      for (let i = 0; i < (wf.steps || []).length; i++) {
        const step = wf.steps[i];
        const r = await browserAction(step);
        if (r._image) lastImage = r._image;
        if (r.success === false) { log.push(`✗ step ${i + 1} ${step.action}: ${r.error}`); return { success: false, error: `Workflow "${input.name}" failed at step ${i + 1}`, result: log.join('\n'), _image: lastImage }; }
        log.push(`✓ ${step.action}${step.url ? ' ' + step.url : step.selector ? ' ' + step.selector : ''}`);
      }
      return { success: true, result: `Replayed "${input.name}" (${wf.steps.length} steps):\n` + log.join('\n'), _image: lastImage };
    }
    return { success: false, error: `Unknown action: ${a}` };
  } catch (e) { return { success: false, error: e.message }; }
}

  return { browserAction, browserWorkflow };
};
