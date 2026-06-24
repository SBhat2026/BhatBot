'use strict';
// Vision tools (B-c decomposition): screen_parse (OmniParser element map), vision_click (click by
// coordinate, closed-loop verify), and vision_local (Ollama screenshot describe) — extracted from
// main.js as a DI factory. The heavy OmniParser worker + screen-capture + Playwright `page` stay in
// main.js and are injected; behavior is identical to the inline versions.
//
//   const vision = require('./tools/vision')({ getPage, ensureBrowser, captureScreenPng,
//       screenPoints, omniRequest, omniAvailable, sleep, sendToActivity, loadConfig,
//       ollamaUrl, visionModelDefault });
//   → { screenParse, visionClick, visionLocal }

module.exports = function makeVision(ctx = {}) {
  const {
    getPage = () => null, ensureBrowser, captureScreenPng, screenPoints, omniRequest,
    omniAvailable = () => false, sleep, sendToActivity = () => {}, loadConfig,
    ollamaUrl, visionModelDefault,
  } = ctx;

  // Capture (screen or Playwright page) → OmniParser → structured elements with click coords.
  async function screenParse(input) {
    const target = input.target === 'browser' ? 'browser' : 'screen';
    let b64, space;
    if (target === 'browser') {
      try {
        await ensureBrowser(); const page = getPage();
        const buf = await page.screenshot({ type: 'png' }); b64 = buf.toString('base64');
        const vp = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        space = { w: vp.width, h: vp.height };
      } catch (e) { return { success: false, error: 'browser capture failed: ' + e.message }; }
    } else {
      const cap = await captureScreenPng();
      if (cap.error) return { success: false, error: 'screen capture failed (' + cap.error + ') — grant Screen Recording permission to BhatBot.' };
      b64 = cap.b64; space = screenPoints();
    }
    const res = await omniRequest({ cmd: 'parse', image_b64: b64, semantics: !!input.semantics }, input.semantics ? 180000 : 60000);
    if (!res.ok) return { success: false, error: 'parse failed: ' + (res.error || 'unknown') + (omniAvailable() ? '' : ' (OmniParser not installed)') };
    // Attach click coordinates in the right space (screen points / browser CSS px).
    let elements = (res.elements || []).map((e) => ({ i: e.i, type: e.type, content: e.content, interactive: e.interactivity,
      click: { x: Math.round(e.center[0] * space.w), y: Math.round(e.center[1] * space.h) } }));
    if (input.query) { const q = String(input.query).toLowerCase(); elements = elements.filter((e) => (e.content || '').toLowerCase().includes(q)); }
    const trimmed = elements.filter((e) => e.content || e.interactive).slice(0, 60);
    return { success: true, target, space, count: trimmed.length, elements: trimmed,
      note: `Parsed ${res.elements.length} elements. To click one, call vision_click with its click.x/click.y (target:"${target}").`,
      _image: b64, _imageMime: 'image/png' };
  }

  async function visionClick(input) {
    const target = input.target === 'browser' ? 'browser' : 'screen';
    const x = Number(input.x), y = Number(input.y);
    if (!isFinite(x) || !isFinite(y)) return { success: false, error: 'numeric x,y required (from screen_parse click coords)' };
    if (target === 'browser') {
      try {
        await ensureBrowser(); const page = getPage();
        if (input.double) await page.mouse.dblclick(x, y); else await page.mouse.click(x, y);
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        // Closed loop: re-screenshot so the model SEES the result; verify `expect` if given.
        let verified, note;
        if (input.expect) { try { verified = (await page.content()).toLowerCase().includes(String(input.expect).toLowerCase()); note = verified ? `Verified: "${input.expect}" present after click.` : `Could not confirm "${input.expect}" after click — re-read the page and replan.`; } catch {} }
        return { success: true, clicked: { x, y }, target, verified, note, _image: await page.screenshot({ type: 'jpeg', quality: 60 }).then((b) => b.toString('base64')).catch(() => undefined), _imageMime: 'image/jpeg' };
      } catch (e) { return { success: false, error: 'browser click failed: ' + e.message }; }
    }
    const res = await omniRequest({ cmd: 'click', x, y, double: !!input.double }, 10000);
    if (!res.ok) return { success: false, error: 'click failed: ' + (res.error || 'unknown') + ' — grant Accessibility permission to BhatBot.' };
    // Closed loop on native GUIs: after the OS click, settle then re-capture so the model can
    // confirm the action landed. If `expect` is given, OmniParser-verify it is now on screen.
    await sleep(400);
    let b64, verified, note;
    if (input.expect) {
      try { const p = await screenParse({ target: 'screen', query: input.expect, semantics: false }); if (p.success) { b64 = p._image; verified = (p.elements || []).length > 0; note = verified ? `Verified: "${input.expect}" visible after click.` : `Could not confirm "${input.expect}" after click — it may not have landed; re-parse and replan.`; } } catch {}
    }
    if (!b64) { try { const cap = await captureScreenPng(); if (!cap.error) b64 = cap.b64; } catch {} }
    if (b64) sendToActivity('screenshot', { data: b64 });
    return { success: true, clicked: { x, y }, target, verified, note, _image: b64, _imageMime: b64 ? 'image/png' : undefined };
  }

  // Local second-opinion vision: describe the current browser page via an Ollama vision model.
  async function visionLocal(input) {
    const page = getPage();
    if (!page) return { success: false, error: 'No active browser page — navigate somewhere first.' };
    const model = loadConfig().visionModel || visionModelDefault;
    const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
    sendToActivity('screenshot', { data: buf.toString('base64') });
    try {
      const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, stream: false,
          prompt: input.prompt || 'Describe this screenshot in detail: layout, UI quality, readability, and any broken elements, errors, or empty states.',
          images: [buf.toString('base64')],
        }),
      });
      if (!res.ok) return { success: false, error: `Ollama ${res.status} — is it running with ${model}?` };
      const j = await res.json();
      return { success: true, model, description: j.response };
    } catch (e) {
      return { success: false, error: `Ollama unreachable at ${ollamaUrl}: ${e.message}` };
    }
  }

  return { screenParse, visionClick, visionLocal };
};
