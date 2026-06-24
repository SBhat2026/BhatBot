'use strict';
// Creation tools (B-b decomposition): image generation, image→3D, and printable-mesh export —
// extracted from main.js as a DI factory (same pattern as lib/audit.js, lib/molecule.js).
// Pure logic + network/subprocess calls live here; Electron window glue stays in main.js and is
// injected (openStudioWindow / openInteractive3D). Behavior is identical to the inline versions.
//
//   const creation = require('./tools/creation')({ loadConfig, sleep, sendToActivity,
//       openStudioWindow, openInteractive3D, getLastImagePath, runChild, studioDir, studioIndex,
//       meshPy, meshScript });
//   → { generateImage, generate3D, makePrintable }
const fs = require('fs');
const os = require('os');
const path = require('path');

const IMG_ASPECT = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' };

module.exports = function makeCreation(ctx = {}) {
  const {
    loadConfig, sleep, sendToActivity = () => {}, openStudioWindow = () => {},
    openInteractive3D = () => {}, getLastImagePath = () => null, runChild,
    studioDir, studioIndex, meshPy, meshScript,
  } = ctx;

  async function imageViaOpenAI(cfg, input, quality, size) {
    let model = cfg.imageGenModel || 'gpt-image-2';
    const call = (m) => fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.openaiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, prompt: input.prompt, n: 1, size, quality }),
      signal: AbortSignal.timeout(120000),
    });
    let ir = await call(model);
    // Account may not yet have gpt-image-2 access → transparently fall back to gpt-image-1.
    if (!ir.ok && /gpt-image-2/.test(model) && [400, 403, 404].includes(ir.status)) { model = 'gpt-image-1'; ir = await call(model); }
    if (!ir.ok) return { error: `OpenAI Images ${ir.status}: ${(await ir.text()).slice(0, 300)}` };
    const b64 = (await ir.json()).data?.[0]?.b64_json;
    if (!b64) return { error: 'No image in OpenAI response.' };
    return { b64, mime: 'image/png', via: 'openai:' + model };
  }

  async function imageViaReplicate(cfg, slug, input, size) {
    if (!cfg.replicateKey) return { error: 'No replicateKey in config — needed for the flux providers. Get one at replicate.com (or use provider:"openai").' };
    let pred;
    try {
      const cr = await fetch(`https://api.replicate.com/v1/models/${slug}/predictions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.replicateKey, 'Content-Type': 'application/json', 'Prefer': 'wait' },
        body: JSON.stringify({ input: { prompt: input.prompt, aspect_ratio: IMG_ASPECT[size] || '1:1', output_format: 'png', safety_tolerance: 2, disable_safety_checker: false } }),
        signal: AbortSignal.timeout(120000),
      });
      if (cr.status === 401) return { error: 'Replicate 401 — invalid replicateKey.' };
      if (cr.status === 402) return { error: 'Replicate is out of credit. Add credit at replicate.com/account/billing.' };
      if (!cr.ok) return { error: `Replicate ${cr.status}: ${(await cr.text()).slice(0, 300)}` };
      pred = await cr.json();
    } catch (e) { return { error: 'Replicate request failed: ' + e.message }; }
    const getUrl = pred.urls && pred.urls.get;
    let tries = 0;
    while (pred.status && !['succeeded', 'failed', 'canceled'].includes(pred.status) && tries < 90) {
      await sleep(2000); tries++;
      if (tries % 5 === 0) sendToActivity('tool-update', { type: 'thinking', text: `🎨 image generating… ${tries * 2}s (${pred.status})` });
      try { pred = await (await fetch(getUrl || `https://api.replicate.com/v1/predictions/${pred.id}`, { headers: { 'Authorization': 'Bearer ' + cfg.replicateKey }, signal: AbortSignal.timeout(20000) })).json(); }
      catch { /* transient — keep polling */ }
    }
    if (pred.status !== 'succeeded') return { error: `Flux ${pred.status || 'timeout'}: ${pred.error || 'no detail'}` };
    const o = pred.output;
    const url = Array.isArray(o) ? o[0] : (typeof o === 'string' ? o : (o && (o.image || o.url)));
    if (!url) return { error: 'No image URL in Replicate output: ' + JSON.stringify(o).slice(0, 200) };
    try {
      const gr = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!gr.ok) return { error: `Flux image download failed: ${gr.status}` };
      return { b64: Buffer.from(await gr.arrayBuffer()).toString('base64'), mime: 'image/png', via: 'replicate:' + slug };
    } catch (e) { return { error: 'Flux download failed: ' + e.message }; }
  }

  // generate_image — pluggable provider (openai | flux | flux-fast), auto-routed by quality.
  async function generateImage(input) {
    const cfg = loadConfig();
    const quality = input.quality || cfg.imageGenQuality || 'medium';
    const size = input.size || cfg.imageGenSize || '1024x1024';
    const haveFlux = !!cfg.replicateKey;
    let provider = input.provider || cfg.imageProvider || 'auto';
    if (provider === 'auto') {
      if (haveFlux && quality === 'high') provider = 'flux';
      else if (haveFlux && quality === 'low') provider = 'flux-fast';
      else provider = 'openai';
    }
    if ((provider === 'flux' || provider === 'flux-fast') && !haveFlux) provider = 'openai';
    if (provider === 'openai' && !cfg.openaiKey) return { success: false, error: 'No openaiKey in config (and no replicateKey for flux).' };

    let r;
    if (provider === 'flux') r = await imageViaReplicate(cfg, cfg.fluxModel || 'black-forest-labs/flux-1.1-pro', input, size);
    else if (provider === 'flux-fast') r = await imageViaReplicate(cfg, cfg.fluxFastModel || 'black-forest-labs/flux-schnell', input, size);
    else r = await imageViaOpenAI(cfg, input, quality, size);
    if (r.error) return { success: false, error: r.error, provider };

    const fname = (input.filename || `img_${Date.now()}`).replace(/[^\w.-]/g, '_');
    const outDir = (cfg.imageOutputDir || '~/.bhatbot/generated').replace(/^~/, os.homedir());
    fs.mkdirSync(outDir, { recursive: true });
    const ext = r.mime === 'image/png' ? 'png' : 'jpg';
    const outPath = path.join(outDir, `${fname}.${ext}`);
    fs.writeFileSync(outPath, Buffer.from(r.b64, 'base64'));
    if (cfg.imageAutoStudio) {
      fs.mkdirSync(studioDir, { recursive: true });
      fs.writeFileSync(studioIndex, `<!doctype html><html><body style="margin:0;background:#090d13;display:flex;align-items:center;justify-content:center;height:100vh"><img src="file://${outPath}?t=${Date.now()}" style="max-width:100%;max-height:100vh;object-fit:contain"></body></html>`);
      openStudioWindow();
    }
    return { success: true, path: outPath, size, quality, provider, via: r.via, _image: r.b64, _imageMime: r.mime,
      message: `Generated via ${r.via} → ${outPath}. Inspecting the result; critique and regenerate with fixes if needed.` };
  }

  // image → 3D model (GLB) via Replicate firtoz/trellis. ~5-min poll budget.
  async function generate3D(input) {
    const cfg = loadConfig();
    if (!cfg.replicateKey) return { success: false, error: 'No replicateKey in ~/.bhatbot/config.json. Get one free at replicate.com.' };
    if (!input.image_path || !fs.existsSync(input.image_path)) return { success: false, error: `Image not found: ${input.image_path}` };

    let dataUrl;
    try {
      const { nativeImage } = require('electron');
      let img = nativeImage.createFromPath(input.image_path);
      if (img.isEmpty()) throw new Error('unreadable image');
      const sz = img.getSize();
      const max = 1024;
      if (sz.width > max || sz.height > max) {
        const scale = max / Math.max(sz.width, sz.height);
        img = img.resize({ width: Math.round(sz.width * scale), height: Math.round(sz.height * scale), quality: 'best' });
      }
      dataUrl = 'data:image/png;base64,' + img.toPNG().toString('base64');
    } catch (e) {
      const mime = input.image_path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      dataUrl = `data:${mime};base64,${fs.readFileSync(input.image_path).toString('base64')}`;
    }

    const outDir = (cfg.imageOutputDir || '~/.bhatbot/generated').replace(/^~/, os.homedir());
    fs.mkdirSync(outDir, { recursive: true });
    const fname = (input.filename || `3d_${Date.now()}`).replace(/[^\w.-]/g, '_');

    const PINNED_VERSION = 'e8f6c45206993f297372f5436b90350817bd9b4a0d52d2a76df50c1c8afa2b3c';
    let version = cfg.trellisVersion || PINNED_VERSION;
    try {
      const mr = await fetch('https://api.replicate.com/v1/models/firtoz/trellis', { headers: { 'Authorization': 'Bearer ' + cfg.replicateKey }, signal: AbortSignal.timeout(15000) });
      if (mr.ok) { const mj = await mr.json(); if (mj.latest_version && mj.latest_version.id) version = mj.latest_version.id; }
    } catch { /* offline → use pinned */ }

    const body = { version, input: {
      images: [dataUrl],
      texture_size: input.texture_size || 1024,
      mesh_simplify: 0.9,
      generate_color: true, generate_model: true, generate_normal: false,
      save_gaussian_ply: false, return_no_background: true,
      ss_sampling_steps: 12, slat_sampling_steps: 12,
      ss_guidance_strength: 7.5, slat_guidance_strength: 3,
      randomize_seed: true,
    } };

    let pred;
    try {
      const cr = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.replicateKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      if (cr.status === 422) return { success: false, error: 'Replicate 422 (bad input — image may be too large/unreadable, or bad version): ' + (await cr.text()).slice(0, 200) };
      if (cr.status === 401) return { success: false, error: 'Replicate 401 — invalid replicateKey.' };
      if (cr.status === 402) return { success: false, error: 'Replicate is out of credit. Add credit at replicate.com/account/billing, then retry (wait a few minutes after purchase).' };
      if (!cr.ok) return { success: false, error: `Replicate ${cr.status}: ${(await cr.text()).slice(0, 300)}` };
      pred = await cr.json();
    } catch (e) { return { success: false, error: 'Replicate request failed: ' + e.message }; }

    const getUrl = pred.urls && pred.urls.get;
    let tries = 0; const MAX = 100;
    while (pred.status && !['succeeded', 'failed', 'canceled'].includes(pred.status) && tries < MAX) {
      await sleep(3000); tries++;
      if (tries % 5 === 0) sendToActivity('tool-update', { type: 'thinking', text: `🧊 3D generating… ${tries * 3}s (${pred.status})` });
      try {
        const pr = await fetch(getUrl || `https://api.replicate.com/v1/predictions/${pred.id}`, { headers: { 'Authorization': 'Bearer ' + cfg.replicateKey }, signal: AbortSignal.timeout(20000) });
        pred = await pr.json();
      } catch { /* transient network — keep polling */ }
    }
    if (pred.status !== 'succeeded') {
      const logTail = (pred.logs || '').split('\n').filter(Boolean).slice(-3).join(' | ');
      return { success: false, error: `3D ${pred.status || 'timeout'}: ${pred.error || logTail || 'no detail'}` };
    }

    const o = pred.output || {};
    const glbUrl = o.model_file || o.glb || o.model || (typeof o === 'string' ? o : null) || (Array.isArray(o) ? o.find((x) => String(x).includes('.glb')) : null);
    if (!glbUrl) return { success: false, error: 'No GLB URL in output: ' + JSON.stringify(o).slice(0, 200) };
    try {
      const gr = await fetch(glbUrl, { signal: AbortSignal.timeout(60000) });
      if (!gr.ok) return { success: false, error: `GLB download failed: ${gr.status}` };
      const gbuf = Buffer.from(await gr.arrayBuffer());
      const outPath = path.join(outDir, `${fname}.glb`);
      fs.writeFileSync(outPath, gbuf);
      if (input.preview !== false) openInteractive3D(outPath);
      return { success: true, path: outPath, size_mb: (gbuf.length / 1048576).toFixed(2), seconds: tries * 3, message: `3D model → ${outPath}. Opened an interactive 3D preview. Import into Blender, Unity, or Three.js (or run make_printable mode convert to get a printable STL).` };
    } catch (e) { return { success: false, error: 'GLB download error: ' + e.message }; }
  }

  // 2D image → printable STL (extrude/relief), or existing model → STL (convert). Local, offline.
  async function makePrintable(input) {
    if (!fs.existsSync(meshPy)) return { success: false, error: 'Mesh toolchain not installed (~/.bhatbot/mesh-venv missing).' };
    const mode = ['extrude', 'relief', 'convert'].includes(input.mode) ? input.mode : 'extrude';
    let src = input.path;
    const lastImg = getLastImagePath();
    if ((!src || !fs.existsSync(src)) && mode !== 'convert' && lastImg && fs.existsSync(lastImg)) src = lastImg;
    if (!src || !fs.existsSync(src)) return { success: false, error: `Source not found: ${input.path || '(none)'} — import/drag an image first or pass an absolute path.` };
    const outDir = (loadConfig().imageOutputDir || '~/.bhatbot/generated').replace(/^~/, os.homedir());
    fs.mkdirSync(outDir, { recursive: true });
    const fname = (input.filename || `print_${Date.now()}`).replace(/[^\w.-]/g, '_');
    const outPath = path.join(outDir, `${fname}.stl`);
    const args = [meshScript, mode, src, '--out', outPath];
    if (mode === 'extrude' || mode === 'relief') {
      if (input.height_mm != null) args.push('--height', String(input.height_mm));
      if (input.base_mm != null) args.push('--base', String(input.base_mm));
      if (input.size_mm != null) args.push('--size', String(input.size_mm));
      if (input.invert) args.push('--invert');
    }
    const r = await runChild(meshPy, args, { timeoutMs: 180000 });
    let j = null; try { j = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch {}
    if (j && j.ok) {
      if (input.preview !== false) openInteractive3D(j.path);
      return { success: true, path: j.path, mode, dims_mm: j.dims_mm, volume_cm3: j.volume_cm3, watertight: j.watertight,
        message: `STL → ${j.path} (${j.dims_mm.join('×')} mm${j.volume_cm3 != null ? `, ${j.volume_cm3} cm³` : ''}${j.watertight ? ', watertight' : ', printable (auto-repair in slicer)'}). Opened an interactive 3D preview. Ready to slice for 3D printing.` };
    }
    return { success: false, error: (j && j.error) || (r.stderr || '').slice(-300) || 'mesh_tool failed' };
  }

  return { generateImage, generate3D, makePrintable };
};
